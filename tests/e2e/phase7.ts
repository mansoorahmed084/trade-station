/**
 * Phase 7 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers the automation dashboard: running a strategy live on the paper account from the app,
 * checking it against a backtest, risk rules, an inbound webhook, the kill switch (halting
 * everything, cancelling and closing, refusing automation) and resuming, and the audit log.
 * Following a strategy bar by bar is covered minute by minute in apps/server/test/automation.test.ts.
 * Run: node tests/e2e/phase7.ts
 */
import { chromium, type Page } from 'playwright-core';

const url = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const apiBase = process.env.API_URL ?? 'http://127.0.0.1:8787';
const api = (path: string) => new URL(path, url).toString();
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const inPage = <T>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) =>
    page.evaluate(fn as any, arg) as Promise<T>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
    const deadline = Date.now() + ms;
    let last = await read();
    while (!done(last) && Date.now() < deadline) {
        await wait(150);
        last = await read();
    }
    return last;
}
const send = async (method: string, path: string, body?: unknown) => {
    // A JSON content type with no body is refused by the server: send one only with a body.
    const res = await fetch(api(path), {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

// A clean start: paper account, no halt, generous rules, and a strategy that always wants one unit.
await send('POST', '/api/trading/resume');
await send('POST', '/api/trading/paper/reset', { initialBalance: 100_000 });
await send('PUT', '/api/trading/risk', { maxOrderValue: 50_000, maxPositionValue: 100_000, maxOrdersPerMinute: 30 });
for (const r of (await send('GET', '/api/automation/runners')).body)
    await send('DELETE', `/api/automation/runners/${r.id}`);
for (const h of (await send('GET', '/api/automation/webhooks')).body)
    await send('DELETE', `/api/automation/webhooks/${h.id}`);
const script = (
    await send('POST', '/api/scripts', {
        name: 'E2E always long',
        source: '//@version=6\nstrategy("E2E always long", default_qty_type=strategy.fixed, default_qty_value=1)\nif strategy.position_size == 0\n    strategy.entry("L", strategy.long)\n',
    })
).body;

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
    const context = await browser.newContext({ viewport: { width: 1700, height: 1100 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
        () => (window as any).__ts?.workspace && (window as any).__ts?.automation?.getState().ready,
        null,
        { timeout: 20_000 },
    );
    await inPage(page, async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        t.workspace.setLayout('1');
        await t.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '1' });
        t.ui.getState().setBottomHeight(560);
        t.ui.getState().showBottomPanel('automation');
    });
    await page.waitForSelector('[data-testid="automation"]');
    const paper = async () => (await send('GET', '/api/trading/paper')).body;

    // ── Run a strategy live ────────────────────────────────────────────────
    const form = await page.$('[data-testid="new-runner-form"]');
    if (!form) await page.click('[data-testid="new-runner"]');
    await page.waitForSelector('[data-testid="new-runner-form"]');
    await page.waitForFunction(
        (id) => !!document.querySelector(`[data-testid="runner-strategy"] option[value="pine:${id}"]`),
        script.id,
    );
    await page.selectOption('[data-testid="runner-strategy"]', `pine:${script.id}`);
    await page.selectOption('[data-testid="runner-mode"]', 'paper');
    await page.selectOption('[data-testid="new-runner-form"] label:has-text("Start") select', 'now');
    await page.click('[data-testid="runner-create"]');
    await page.waitForSelector('[data-testid="runner-row"]', { timeout: 15_000 });
    const rowText = await page.textContent('[data-testid="runner-row"]');
    check(
        'a Pine strategy from the library is set up to run live on the chart symbol, stopped',
        /E2E always long/.test(rowText ?? '') && /SYNTH:ALPHA/.test(rowText ?? '') && /stopped/.test(rowText ?? ''),
        rowText?.replace(/\s+/g, ' ').slice(0, 100),
    );

    await page.click('[data-testid="runner-start"]');
    const runner = async () => (await send('GET', '/api/automation/runners')).body[0];
    const started = await until(runner, (r) => r.state.decisions.length >= 1 && r.state.held === 1);
    const p = await until(paper, (x) => x.positions.some((q: any) => q.symbol === 'SYNTH:ALPHA'));
    const toast = await page
        .waitForSelector('[data-testid="toast"]:has-text("E2E always long")', { timeout: 5000 })
        .then((e) => e.textContent())
        .catch(() => null);
    check(
        'started, it takes on the strategy’s position on the paper account and announces the fill',
        started.state.status === 'running' &&
            started.state.held === 1 &&
            p.positions.find((q: any) => q.symbol === 'SYNTH:ALPHA')?.qty === 1 &&
            p.orders.some((o: any) => o.source === 'strategy' && o.status === 'filled') &&
            !!toast,
        `held ${started.state.held}; toast "${toast?.replace(/\s+/g, ' ').slice(0, 70)}"`,
    );
    await page.click('[data-testid="runner-row"]');
    const decisionRow = await page
        .waitForSelector('[data-testid="decisions"] tbody tr', { timeout: 10_000 })
        .catch(() => null);
    if (!decisionRow) {
        const panel = await page
            .$eval('[data-testid="automation"]', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 400))
            .catch(() => 'no panel');
        const store = await inPage<any>(page, () =>
            Object.values((window as any).__ts.automation.getState().runners).map((r: any) => [
                r.state.status,
                r.state.decisions.length,
            ]),
        );
        check(
            'the runner’s decisions are listed when its row is opened',
            false,
            `panel: ${panel}; store: ${JSON.stringify(store)}`,
        );
    }
    await page.click('[data-testid="runner-verify"]');
    const verdict = await page
        .waitForSelector('[data-testid="runner-check"]', { timeout: 20_000 })
        .then((e) => e.textContent());
    check(
        'its decisions match a backtest of the same bars',
        /All \d+ decisions want the same side as a backtest/.test(verdict ?? ''),
        verdict ?? '',
    );

    // ── Risk rules ─────────────────────────────────────────────────────────
    await page.click('[data-testid="automation"] .tab:has-text("Risk rules")');
    await page.fill('[data-testid="risk-maxOrderValue"]', '20000');
    await page.click('[data-testid="risk-save"]');
    const rules = await until(
        async () => (await send('GET', '/api/trading/risk')).body.rules,
        (r) => r.maxOrderValue === 20_000,
    );
    check(
        'risk rules are edited in the app and take effect on the server',
        rules.maxOrderValue === 20_000,
        JSON.stringify(rules),
    );

    // ── Webhook ────────────────────────────────────────────────────────────
    await page.click('[data-testid="automation"] .tab:has-text("Webhooks")');
    await page.click('[data-testid="webhook-create"]');
    await page.waitForSelector('[data-testid="webhook-url"]');
    const shown = await page.textContent('[data-testid="webhook-url"]');
    const hook = (await send('GET', '/api/automation/webhooks')).body[0];
    const inbound = await fetch(`${apiBase}/api/webhook/${hook.id}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
            passphrase: hook.passphrase,
            ticker: 'BETA',
            exchange: 'SYNTH',
            action: 'buy',
            contracts: 2,
        }),
    });
    const inboundBody: any = await inbound.json();
    check(
        'a webhook is created with its address, and a TradingView-style message to it trades the paper account',
        shown === `${apiBase}/api/webhook/${hook.id}` &&
            inbound.status === 200 &&
            inboundBody.order?.status === 'filled' &&
            inboundBody.order?.qty === 2,
        `${shown}; ${inbound.status} ${inboundBody.order?.side} ${inboundBody.order?.qty} ${inboundBody.order?.symbol}`,
    );

    // ── Kill switch ────────────────────────────────────────────────────────
    const lastBeta = (await paper()).positions.find((q: any) => q.symbol === 'SYNTH:BETA').lastPrice;
    await send('POST', '/api/trading/paper/orders', {
        symbol: 'SYNTH:BETA',
        side: 'buy',
        type: 'limit',
        qty: 1,
        limit: Math.round(lastBeta * 0.5 * 100) / 100,
    });
    await page.click('[data-testid="kill-switch"]');
    await page.waitForSelector('[data-testid="kill-dialog"]');
    await page.check('[data-testid="kill-flatten"]');
    await page.click('[data-testid="kill-confirm"]');
    await page.waitForSelector('[data-testid="halted"]', { timeout: 10_000 });
    const after = await until(
        paper,
        (x) => x.positions.length === 0 && x.orders.every((o: any) => o.status !== 'working'),
    );
    const halted = await runner();
    const banner = await page
        .waitForSelector('[data-testid="halt-banner"]', { timeout: 5000 })
        .then((e) => e.textContent())
        .catch(() => null);
    const refused = await fetch(`${apiBase}/api/webhook/${hook.id}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy' }),
    });
    const refusedBody: any = await refused.json();
    check(
        'the kill switch halts the strategy, closes every position, cancels every order and refuses webhooks',
        after.positions.length === 0 &&
            after.orders.every((o: any) => o.status !== 'working') &&
            halted.state.status === 'halted' &&
            !!banner &&
            refused.status === 422 &&
            /halted/.test(refusedBody.error),
        `runner ${halted.state.status}; webhook ${refused.status} "${refusedBody.error}"`,
    );
    await page.screenshot({ path: 'tests/e2e/phase7-automation.png' });

    await page.click('[data-testid="resume"]');
    await page.waitForSelector('[data-testid="kill-switch"]', { timeout: 5000 });
    check(
        'resuming clears the halt everywhere',
        (await send('GET', '/api/trading/risk')).body.halt === null && !(await page.$('[data-testid="halt-banner"]')),
    );

    // ── Audit log ──────────────────────────────────────────────────────────
    await page.click('[data-testid="automation"] .tab:has-text("Audit log")');
    await page.waitForSelector('[data-testid="audit-row"]');
    const rows = await page.$$eval('[data-testid="audit-row"]', (els) => els.map((e) => (e as HTMLElement).innerText));
    const has = (re: RegExp) => rows.some((r) => re.test(r));
    check(
        'the audit log shows the strategy’s order, the webhook’s order and its refusal, the kill switch and the resume',
        has(/strategy:run\S*\s+place/) &&
            has(/webhook:wh\S*\s+place.*\bok\b/) &&
            has(/webhook:wh\S*\s+place.*rejected/) &&
            has(/kill switch/) &&
            has(/resume/),
        `${rows.length} rows`,
    );

    const serious = errors.filter((e) => !/ResizeObserver/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    for (const r of (await send('GET', '/api/automation/runners')).body)
        await send('DELETE', `/api/automation/runners/${r.id}`);
    for (const h of (await send('GET', '/api/automation/webhooks')).body)
        await send('DELETE', `/api/automation/webhooks/${h.id}`);
    await send('DELETE', `/api/scripts/${script.id}`);
    await send('POST', '/api/trading/resume');
    await send('PUT', '/api/trading/risk', {
        maxOrderValue: 50_000,
        maxPositionValue: 100_000,
        maxOrdersPerMinute: 30,
    });
    await send('POST', '/api/trading/paper/reset', { initialBalance: 100_000 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
