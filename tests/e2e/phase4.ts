/**
 * Phase 4 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers the alerts panel, the create/edit dialog and its condition builder, toasts, the alert log,
 * levels drawn on the chart, a signed webhook, and the phase's exit criteria that involve the app:
 *   - alerts fire with the browser closed
 *   - alerts are still there, with their state, after the page is reopened
 * (The 1,000-alert delay budget and the restart replay are measured in the unit tests and benchmarks.)
 * Run: node tests/e2e/phase4.ts
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from 'playwright-core';

const url = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const api = (path: string) => new URL(path, url).toString();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const inPage = <T>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) =>
    page.evaluate(fn as any, arg) as Promise<T>;
const getJson = async (path: string) => (await fetch(api(path))).json() as Promise<any>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms;
    let last = await read();
    while (!done(last) && Date.now() < deadline) {
        await wait(100);
        last = await read();
    }
    return last;
}

// A local receiver for the webhook check.
const hooks: { signature?: string; body: string }[] = [];
const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
        body += c;
    });
    req.on('end', () => {
        hooks.push({ signature: req.headers['x-signature'] as string | undefined, body });
        res.end('ok');
    });
});
await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;

// Start clean: no alerts, empty log.
for (const a of (await getJson('/api/alerts')) as any[]) await fetch(api(`/api/alerts/${a.id}`), { method: 'DELETE' });
await fetch(api('/api/alerts/log'), { method: 'DELETE' });

const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--use-angle=metal',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
    ],
});

try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    let page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const boot = async () => {
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
        await inPage(page, async () => {
            const t = (window as any).__ts;
            await t.workspace.chart.ready();
            t.workspace.setLayout('1');
            if (t.ui.getState().bottomPanel) t.ui.getState().toggleBottomPanel('editor');
            await t.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '1' });
            for (const h of t.workspace.chart.indicators()) if (h.nativeType !== 'volume') h.remove();
            for (const d of t.workspace.chart.drawings.all()) t.workspace.chart.drawings.remove(d.id);
        });
    };
    await boot();

    // ── Panel and toolbar ──────────────────────────────────────────────────
    await page.click('#vela-action-ts\\.alerts');
    await page.waitForSelector('[data-testid="alerts-panel"]');
    const empty = await page.$eval('[data-testid="alerts-panel"]', (e) => (e as HTMLElement).innerText);
    const bells = await page.$$eval(
        '[aria-label="Alerts"], [title="Alerts"]',
        (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length,
    );
    check(
        'the toolbar bell opens the alerts panel, and there is only one bell',
        /No alerts yet/.test(empty) && bells === 1,
        `${bells} bell button(s)`,
    );

    // ── Create a price alert through the dialog ────────────────────────────
    await page.click('text=+ Create alert');
    await page.waitForSelector('.modal');
    const prefilled = await page.$eval('[aria-label="Symbol"]', (e) => (e as HTMLInputElement).value);
    // the level defaults to the current price, fetched when the dialog opens
    await page
        .waitForFunction(
            () => Number((document.querySelector('[aria-label="Right value"]') as HTMLInputElement)?.value) > 0,
            null,
            { timeout: 5_000 },
        )
        .catch(() => {});
    const defaultValue = await page.$eval('[aria-label="Right value"]', (e) => (e as HTMLInputElement).value);
    await page.selectOption('[aria-label="Operator"]', 'greater');
    await page.fill('[aria-label="Right value"]', '0');
    await page.selectOption('[aria-label="Trigger"]', 'once');
    await page.fill('[aria-label="Alert name"]', 'E2E price');
    await page.fill('[aria-label="Message"]', '{{ticker}} hit {{close}} on {{interval_label}}');
    await page.fill('[aria-label="Webhook URL"]', hookUrl);
    await page.fill('[aria-label="Webhook secret"]', 'e2e-secret');
    const summary = await page.$eval('[data-testid="condition-summary"]', (e) => e.textContent);
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="toast"]', { timeout: 10_000 });
    const toast = await page.$eval('[data-testid="toast"]', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' '));
    check(
        'an alert created in the dialog fires and shows a toast with its message',
        prefilled === 'SYNTH:ALPHA' &&
            Number(defaultValue) > 0 &&
            summary === 'Price greater than 0' &&
            /Alert: E2E price/.test(toast) &&
            /ALPHA hit \d+\.\d\d on 1m/.test(toast),
        toast.slice(0, 90),
    );
    await page.waitForSelector('[data-testid="alert-item"]:has-text("Triggered")', { timeout: 5_000 });
    const item = await page.$eval('[data-testid="alert-item"]', (e) =>
        (e as HTMLElement).innerText.replace(/\s+/g, ' '),
    );
    check(
        'the alert list shows it as triggered, with its symbol, timeframe and condition',
        /Triggered E2E price ALPHA · 1m · once Price greater than 0 Fired 1×/.test(item),
        item.slice(0, 110),
    );

    await until(
        async () => hooks,
        (h) => h.length > 0,
    );
    const signed =
        hooks[0] &&
        hooks[0].signature === `sha256=${createHmac('sha256', 'e2e-secret').update(hooks[0].body).digest('hex')}`;
    check(
        'the webhook received the alert, correctly signed',
        !!signed && JSON.parse(hooks[0]?.body ?? '{}').alert === 'E2E price',
        hooks[0]?.body.slice(0, 80),
    );

    await page.click('.tab:has-text("Log")');
    await page.waitForSelector('[data-testid="log-item"]');
    const logItem = await page.$eval('[data-testid="log-item"]', (e) =>
        (e as HTMLElement).innerText.replace(/\s+/g, ' '),
    );
    check(
        'the log lists the fire with its message and time',
        /E2E price ALPHA hit \d+\.\d\d on 1m ALPHA · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/.test(logItem),
        logItem.slice(0, 90),
    );
    await page.click('.tab:has-text("Alerts (")');

    // ── Condition builder: indicator, multi-condition, script alert ────────
    await page.click('text=+ Create alert');
    await page.selectOption('[aria-label="Left type"]', 'indicator');
    await page.selectOption('[aria-label="Left study"]', 'rsi');
    await page.selectOption('[aria-label="Operator"]', 'greater');
    await page.fill('[aria-label="Right value"]', '-1');
    await page.click('text=+ Add condition');
    const second = page.locator('[data-testid="condition-row"]').nth(1);
    await second.locator('[aria-label="Operator"]').selectOption('less');
    await second.locator('[aria-label="Right value"]').fill('1000000');
    const multi = await page.$eval('[data-testid="condition-summary"]', (e) => e.textContent);
    await page.selectOption('[aria-label="Combine with"]', 'any');
    const either = await page.$eval('[data-testid="condition-summary"]', (e) => e.textContent);
    await page.selectOption('[aria-label="Combine with"]', 'all');
    await page.selectOption('[aria-label="Trigger"]', 'once_per_bar');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector(
        '[data-testid="alert-item"]:has-text("RSI(14) greater than -1 and Price less than 1000000")',
        { timeout: 10_000 },
    );
    const firedIndicator = await until(
        async () => (await getJson('/api/alerts')).find((a: any) => a.name.startsWith('RSI(14)')),
        (a) => a?.state.fireCount >= 1,
    );
    check(
        'an indicator condition combined with a price condition (AND / OR) saves and fires',
        multi === 'RSI(14) greater than -1 and Price less than 1000000' &&
            either === 'RSI(14) greater than -1 or Price less than 1000000' &&
            firedIndicator?.state.fireCount >= 1,
        `${multi} → fired ${firedIndicator?.state.fireCount}×`,
    );

    await page.click('text=+ Create alert');
    await page.selectOption('[aria-label="Condition kind"]', 'script');
    await page.selectOption('[aria-label="Alert script"]', 'example-rsi-bands');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Which alert"] option').length >= 3);
    const titles = await page.$$eval('[aria-label="Which alert"] option', (els) => els.map((e) => e.textContent));
    await page.selectOption('[aria-label="Which alert"]', 'RSI entered oversold');
    await page.selectOption('[aria-label="Trigger"]', 'once_per_bar_close');
    await page.fill('[aria-label="Alert name"]', 'E2E script');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="alert-item"]:has-text("E2E script")', { timeout: 10_000 });
    const scriptAlert = (await getJson('/api/alerts')).find((a: any) => a.name === 'E2E script');
    check(
        'a script alert lists the script’s alertcondition titles and saves the chosen one',
        titles.join('|') === 'Any alert() call|RSI entered oversold|RSI entered overbought' &&
            scriptAlert?.condition?.scriptAlert?.title === 'RSI entered oversold' &&
            scriptAlert.active,
        titles.join(' | '),
    );

    // A plot of a library script as an operand.
    await page.click('text=+ Create alert');
    await page.selectOption('[aria-label="Left type"]', 'plot');
    await page.selectOption('[aria-label="Left script"]', 'example-rsi-bands');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Left plot"] option').length >= 3);
    await page.selectOption('[aria-label="Left plot"]', 'RSI');
    await page.selectOption('[aria-label="Operator"]', 'greater');
    await page.fill('[aria-label="Right value"]', '-5');
    await page.selectOption('[aria-label="Trigger"]', 'once');
    await page.fill('[aria-label="Alert name"]', 'E2E plot');
    await page.click('.modal button:text-is("Create")');
    const plotAlert = await until(
        async () => (await getJson('/api/alerts')).find((a: any) => a.name === 'E2E plot'),
        (a) => a?.state.fireCount >= 1,
        15_000,
    );
    check(
        'an alert on a Pine script plot fires from the server-side script',
        plotAlert?.state.fireCount === 1 && plotAlert.condition.left.plot === 'RSI',
        `fired ${plotAlert?.state.fireCount}×`,
    );

    // ── Validation ─────────────────────────────────────────────────────────
    await page.click('text=+ Create alert');
    await page.fill('[aria-label="Symbol"]', 'SYNTH:NOPE');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="alert-error"]');
    const invalid = await page.$eval('[data-testid="alert-error"]', (e) => e.textContent);
    await page.fill('[aria-label="Symbol"]', 'SYNTH:ALPHA');
    await page.fill('[aria-label="Right value"]', '');
    await page.click('.modal button:text-is("Create")');
    await page.waitForFunction(() =>
        /enter a number/.test(document.querySelector('[data-testid="alert-error"]')?.textContent ?? ''),
    );
    const blankValue = await page.$eval('[data-testid="alert-error"]', (e) => e.textContent);
    await page.keyboard.press('Escape');
    check(
        'a bad symbol or an empty value is explained in the dialog',
        /Unknown symbol/.test(invalid ?? '') && /enter a number/.test(blankValue ?? ''),
        `${invalid} / ${blankValue}`,
    );

    // ── Levels on the chart, right-click preset, drawing alerts ────────────
    const last = await inPage(
        page,
        async () => (await (await fetch('/api/quotes?symbols=SYNTH:ALPHA')).json())[0].last,
    );
    const level = Math.round(last * 2 * 100) / 100;
    await inPage(
        page,
        (value: number) =>
            (window as any).__ts.ui.getState().openAlertDialog({
                preset: { condition: { left: { type: 'price' }, op: 'crossing', right: { type: 'value', value } } },
            }),
        level,
    );
    await page.waitForSelector('.modal');
    const preset = await page.$eval('[aria-label="Right value"]', (e) => (e as HTMLInputElement).value);
    await page.fill('[aria-label="Alert name"]', 'E2E level');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="alert-item"]:has-text("E2E level")');
    const lines = await until(
        () => inPage(page, () => (window as any).__ts.chartLines((window as any).__ts.workspace.chart)),
        (l: any[]) => l.some((x) => /E2E level/.test(x.text)),
    );
    const levelLine = lines.find((x: any) => /E2E level/.test(x.text));
    await inPage(page, async () => (window as any).__ts.workspace.chart.setMarket({ symbol: 'SYNTH:BETA' }));
    const elsewhere = await inPage(
        page,
        () => (window as any).__ts.chartLines((window as any).__ts.workspace.chart).length,
    );
    await inPage(page, async () => (window as any).__ts.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA' }));
    check(
        'a price alert opens prefilled from the chart and its level is drawn on charts of that symbol only',
        Number(preset) === level && levelLine?.price === level && elsewhere === 0,
        `level ${level}; lines on ALPHA ${lines.length}, on BETA ${elsewhere}`,
    );

    const drawingId = await inPage(
        page,
        (price: number) => {
            const chart = (window as any).__ts.workspace.chart;
            const r = chart.getVisibleRange();
            return chart.drawings.add('trendline', {
                paneId: 'price',
                anchors: [
                    { time: r.from, price },
                    { time: r.to, price: price * 1.01 },
                ],
            }).id;
        },
        level * 1.5,
    );
    await page.click('text=+ Create alert');
    await page.selectOption('[aria-label="Right type"]', 'line');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Right drawing"] option').length >= 2);
    await page.selectOption('[aria-label="Right drawing"]', drawingId);
    await page.fill('[aria-label="Alert name"]', 'E2E line');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="alert-item"]:has-text("E2E line")');
    const lineAlert = (await getJson('/api/alerts')).find((a: any) => a.name === 'E2E line');
    const operand = lineAlert?.condition?.right;
    await inPage(page, (id: string) => (window as any).__ts.workspace.chart.drawings.remove(id), drawingId);
    const paused = await until(
        async () => (await getJson('/api/alerts')).find((a: any) => a.name === 'E2E line'),
        (a) => a && !a.active,
    );
    check(
        'an alert can follow a drawn trend line, and is paused when the drawing is removed',
        operand?.type === 'line' &&
            operand.drawingId === drawingId &&
            operand.extend === 'right' &&
            Math.abs(operand.a.price - level * 1.5) < 1e-6 &&
            paused?.active === false,
        `line ${operand?.a?.price?.toFixed(2)} → ${operand?.b?.price?.toFixed(2)}, active after removal: ${paused?.active}`,
    );

    // ── Watchlist alert ────────────────────────────────────────────────────
    await page.click('text=+ Create alert');
    await page.selectOption('[aria-label="Watch what"]', 'watchlist');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Watchlist"] option').length >= 1);
    const listLabel = await page.$eval('[aria-label="Watchlist"] option', (e) => e.textContent);
    await page.selectOption('[aria-label="Operator"]', 'less');
    await page.fill('[aria-label="Right value"]', '0');
    await page.fill('[aria-label="Alert name"]', 'E2E basket');
    await page.click('.modal button:text-is("Create")');
    await page.waitForSelector('[data-testid="alert-item"]:has-text("E2E basket")', { timeout: 20_000 });
    const basket = (await getJson('/api/alerts')).find((a: any) => a.name === 'E2E basket');
    check(
        'a watchlist alert watches every symbol of the list',
        basket?.symbols.length >= 3 && basket.active,
        `${listLabel}: ${basket?.symbols.length} symbols`,
    );

    // ── Pause, edit with a test notification, delete ───────────────────────
    const row = page.locator('[data-testid="alert-item"]:has-text("E2E basket")');
    await row.locator('text=Pause').click();
    await row.locator('text=Paused').waitFor();
    await row.locator('text=Resume').click();
    await row.locator('text=Active').waitFor();
    await row.locator('text=Edit').click();
    await page.waitForSelector('.modal:has-text("Edit alert")');
    await page.fill('[aria-label="Alert name"]', 'E2E basket renamed');
    await page.fill('[aria-label="Webhook URL"]', hookUrl);
    const before = hooks.length;
    await page.click('text=Save and send a test');
    await page.waitForSelector('.modal .out-info');
    const testLine = await page.$eval('.modal .out-info', (e) => e.textContent);
    await until(
        async () => hooks,
        (h) => h.length > before,
    );
    const testBody = JSON.parse(hooks[hooks.length - 1]?.body ?? '{}');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="alert-item"]:has-text("E2E basket renamed")');
    check(
        'an alert can be paused, resumed, edited and test-fired without counting as a real fire',
        /app: sent · webhook: sent/.test(testLine ?? '') && /^\[test\]/.test(testBody.message ?? ''),
        testLine ?? '',
    );
    page.once('dialog', (d) => void d.accept());
    await page.locator('[data-testid="alert-item"]:has-text("E2E basket renamed") >> text=Delete').click();
    await page.waitForFunction(() => !document.body.innerText.includes('E2E basket renamed'));
    check('an alert can be deleted', !(await getJson('/api/alerts')).some((a: any) => /basket/.test(a.name)));

    // ── Browser closed ─────────────────────────────────────────────────────
    const serious = errors.filter((e) => !/ResizeObserver|WebSocket connection/.test(e));
    const whileOpen = (await getJson('/api/health')).connections;
    await page.close();
    await wait(300);
    const connections = (await getJson('/api/health')).connections;
    const logBefore = (await getJson('/api/alerts/log')).length;
    await fetch(api('/api/alerts'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: 'E2E headless',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: { left: { type: 'price' }, op: 'greater', right: { type: 'value', value: 0 } },
            frequency: 'once',
        }),
    });
    const logAfter = await until(
        () => getJson('/api/alerts/log'),
        (l: any[]) => l.length > logBefore,
    );
    // Another viewer of the same server (a second window) may stay connected; what matters is that ours is gone.
    check(
        'an alert fires after this browser has closed',
        connections === whileOpen - 1 && logAfter[0]?.alertName === 'E2E headless',
        `connections ${whileOpen} → ${connections}; logged "${logAfter[0]?.message}"`,
    );

    // ── Reopen: everything is still there ──────────────────────────────────
    page = await context.newPage();
    page.on('pageerror', (err) => errors.push(err.message));
    await boot();
    await inPage(page, () => (window as any).__ts.ui.getState().showRightPanel('alerts'));
    await page.waitForSelector('[data-testid="alert-item"]');
    const names = await page.$$eval('[data-testid="alert-item"] .alert-name', (els) => els.map((e) => e.textContent));
    const tabLabel = await page.$eval('.tab:has-text("Log")', (e) => e.textContent);
    check(
        'reopening the app shows the alerts and the log as the server kept them',
        names.includes('E2E headless') &&
            names.includes('E2E price') &&
            names.includes('E2E script') &&
            Number(/\((\d+)\)/.exec(tabLabel ?? '')?.[1]) >= 3,
        `${names.length} alerts, ${tabLabel}`,
    );
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    for (const a of (await getJson('/api/alerts')) as any[])
        await fetch(api(`/api/alerts/${a.id}`), { method: 'DELETE' });
    await fetch(api('/api/alerts/log'), { method: 'DELETE' });
    await browser.close();
    hook.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
