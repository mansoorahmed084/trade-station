/**
 * Phase 6 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers paper trading from every place an order can start: the order ticket (market, limit with a
 * bracket), lines on the chart (drag to modify, × to cancel or close), the one-click buttons, the
 * chart's right-click menu, the depth ladder and the account manager; confirmations; toasts; and
 * that every request from this screen names the paper account.
 * Run: node tests/e2e/phase6.ts
 */
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
const send = (method: string, path: string, body?: unknown) =>
    fetch(api(path), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const SYMBOL = 'SYNTH:ALPHA';
await send('POST', '/api/trading/paper/reset', { initialBalance: 100_000 });
await send('PUT', '/api/trading/limits', { maxOrderValue: 1_000_000, maxOrdersPerDay: 500 });

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
    const accountHeaders: (string | undefined)[] = [];
    page.on('request', (r) => {
        if (
            r.url().includes('/api/trading/') &&
            r.method() !== 'GET' &&
            !r.url().includes('/reset') &&
            !r.url().includes('/limits')
        ) {
            accountHeaders.push(r.headers()['x-ts-account']);
        }
    });
    await page.addInitScript(() => localStorage.removeItem('ts.trading'));
    const boot = async () => {
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForFunction(
            () => (window as any).__ts?.workspace && (window as any).__ts?.trading?.getState().ready,
            null,
            { timeout: 20_000 },
        );
        await inPage(
            page,
            async (symbol: string) => {
                const t = (window as any).__ts;
                await t.workspace.chart.ready();
                t.workspace.setLayout('1');
                if (t.ui.getState().bottomPanel) t.ui.getState().toggleBottomPanel(t.ui.getState().bottomPanel);
                await t.workspace.chart.setMarket({ symbol, timeframe: '1' });
                for (const h of t.workspace.chart.indicators()) if (h.nativeType !== 'volume') h.remove();
            },
            SYMBOL,
        );
    };
    await boot();
    const store = () =>
        inPage<any>(page, () => {
            const s = (window as any).__ts.trading.getState();
            return { orders: s.orders, positions: s.positions, account: s.account };
        });
    const tradingLines = () =>
        inPage<any[]>(page, () => (window as any).__ts.chartLines((window as any).__ts.workspace.chart, 'trading'));
    const boxes = () =>
        inPage<any[]>(page, () => (window as any).__ts.lineBoxes((window as any).__ts.workspace.cells()[0].host));
    const confirmSend = async () => {
        await page.waitForSelector('[data-testid="confirm-order"]', { timeout: 5000 });
        const text = await page.textContent('[data-testid="confirm-order"]');
        await page.click('[data-testid="confirm-send"]');
        await page.waitForSelector('[data-testid="confirm-order"]', { state: 'detached', timeout: 5000 });
        return text ?? '';
    };
    const last = async () => (await (await fetch(api(`/api/quotes?symbols=${SYMBOL}`))).json())[0].last as number;

    // ── Order ticket ───────────────────────────────────────────────────────
    await page.click('#vela-action-ts\\.trade');
    await page.waitForSelector('[data-testid="order-ticket"]');
    const ticketSymbol = await page.textContent('[data-testid="ticket-symbol"]');
    const badge = await page.textContent('[data-testid="order-ticket"] [data-testid="account-badge"]');
    check(
        'the toolbar opens the order ticket on the chart symbol, marked PAPER',
        ticketSymbol === SYMBOL && badge === 'PAPER',
        `${ticketSymbol} · ${badge}`,
    );

    await page.click('[data-testid="ticket-type-market"]');
    await page.click('[data-testid="ticket-buy"]');
    await page.fill('[data-testid="ticket-qty"]', '2');
    const label = await page.textContent('[data-testid="ticket-submit"]');
    await page.click('[data-testid="ticket-submit"]');
    let s = await until(store, (x) => x.positions[SYMBOL]?.qty === 2);
    const toast = await page
        .waitForSelector('[data-testid="toast"]:has-text("Bought 2")', { timeout: 5000 })
        .then((e) => e.textContent())
        .catch(() => null);
    let lines = await until(tradingLines, (l) => l.some((x) => x.id === `pos:${SYMBOL}`));
    const posLine = lines.find((x) => x.id === `pos:${SYMBOL}`);
    check(
        'a market buy from the ticket fills, announces itself and draws the position on the chart',
        s.positions[SYMBOL]?.qty === 2 &&
            !!toast &&
            /LONG 2/.test(posLine?.text ?? '') &&
            /Buy 2 ALPHA market/.test(label ?? ''),
        `"${label}"; toast "${toast?.trim()}"; line "${posLine?.text}" ${posLine?.badge?.text ?? ''}`,
    );

    await page.click('[data-testid="ticket-type-limit"]');
    await page.check('[data-testid="ticket-tp-on"]');
    await page.check('[data-testid="ticket-sl-on"]');
    await page.fill('[data-testid="ticket-qty"]', '1');
    const limitValue = Number(await page.inputValue('[data-testid="ticket-limit"]'));
    await page.click('[data-testid="ticket-submit"]');
    s = await until(store, (x) =>
        Object.values<any>(x.orders).some((o) => o.type === 'limit' && o.status === 'working' && o.bracket),
    );
    const entry = Object.values<any>(s.orders).find((o) => o.type === 'limit' && o.status === 'working' && o.bracket);
    lines = await until(
        tradingLines,
        (l) => l.some((x) => x.id === `${entry?.id}:limit`) && l.some((x) => x.id === `${entry?.id}-tp`),
    );
    const legs = lines.filter((x) => x.id.startsWith(entry?.id ?? '-')).map((x) => x.text);
    check(
        'a limit order with a target and a stop rests, with both exits drawn as waiting for it',
        !!entry &&
            Math.abs(entry.limit - limitValue) < 1e-9 &&
            legs.length === 3 &&
            legs.filter((t) => /waits for entry/.test(t)).length === 2,
        legs.join(' | '),
    );

    // ── Drag a line to change the order ────────────────────────────────────
    const lineBox = (await until(boxes, (b) => b.some((x) => x.id === `${entry.id}:limit`))).find(
        (x) => x.id === `${entry.id}:limit`,
    );
    const before = await inPage<any>(page, () => (window as any).__ts.workspace.chart.getVisibleRange());
    await page.mouse.move(lineBox.x, lineBox.y);
    await page.mouse.down();
    await page.mouse.move(lineBox.x, lineBox.y + 15, { steps: 3 });
    await page.mouse.move(lineBox.x, lineBox.y + 30, { steps: 3 });
    await page.mouse.up();
    s = await until(store, (x) => x.orders[entry.id]?.limit < entry.limit - 1e-9);
    const after = await inPage<any>(page, () => (window as any).__ts.workspace.chart.getVisibleRange());
    check(
        'dragging the order line down lowers the limit price, without panning the chart',
        s.orders[entry.id].limit < entry.limit &&
            s.orders[entry.id].status === 'working' &&
            before.from === after.from &&
            before.to === after.to,
        `limit ${entry.limit} → ${s.orders[entry.id].limit}`,
    );

    const tpBox = (await boxes()).find((x) => x.id === `${entry.id}-tp`);
    await page.mouse.click(tpBox.closeX, tpBox.y);
    s = await until(store, (x) => x.orders[`${entry.id}-tp`]?.status === 'cancelled');
    check(
        'the × on the target line removes that exit and keeps the stop',
        s.orders[`${entry.id}-tp`].status === 'cancelled' &&
            s.orders[`${entry.id}-sl`].status === 'inactive' &&
            s.orders[entry.id].bracket?.takeProfit === undefined,
    );

    // ── Account manager ────────────────────────────────────────────────────
    await inPage(page, () => (window as any).__ts.ui.getState().showBottomPanel('trading'));
    await page.waitForSelector('[data-testid="account-manager"]');
    const figures = await page.textContent('[data-testid="account-figures"]');
    const posRows = await page.$$eval('[data-testid="position-row"]', (els) => els.length);
    await page.click('[data-testid="account-manager"] .tab:has-text("Orders")');
    await page.waitForSelector('[data-testid="order-row"]');
    const newLimit = Math.round((s.orders[entry.id].limit - 0.05) * 100) / 100;
    await page.fill('[aria-label="SYNTH:ALPHA limit price"]', String(newLimit));
    await page.press('[aria-label="SYNTH:ALPHA limit price"]', 'Enter');
    s = await until(store, (x) => Math.abs(x.orders[entry.id]?.limit - newLimit) < 1e-9);
    check(
        'the account manager shows the figures and the position, and changes a limit price typed into the order row',
        /Balance/.test(figures ?? '') &&
            /Equity/.test(figures ?? '') &&
            posRows === 1 &&
            Math.abs(s.orders[entry.id].limit - newLimit) < 1e-9,
        `limit now ${s.orders[entry.id].limit}`,
    );
    await page.click('[data-testid="order-row"]:has-text("Limit") [data-testid="cancel-order"]');
    s = await until(
        store,
        (x) => x.orders[entry.id]?.status === 'cancelled' && x.orders[`${entry.id}-sl`]?.status === 'cancelled',
    );
    check(
        'cancelling the entry from the order row also cancels its waiting stop',
        s.orders[entry.id].status === 'cancelled' && s.orders[`${entry.id}-sl`].status === 'cancelled',
    );

    // ── One-click buttons, with confirmation ───────────────────────────────
    await page.fill('[data-testid="quick-qty"]', '0.5');
    await page.click('[data-testid="quick-sell"]');
    const asked = await confirmSend();
    s = await until(store, (x) => x.positions[SYMBOL]?.qty === 1.5);
    check(
        'the chart SELL button asks first, then sells at the market',
        /Sell 0.5 ALPHA market/.test(asked) && s.positions[SYMBOL]?.qty === 1.5,
        asked.replace(/\s+/g, ' ').slice(0, 80),
    );

    // ── Right-click "Buy here" ─────────────────────────────────────────────
    await page.fill('[data-testid="quick-qty"]', '1');
    const pos = (await boxes()).find((x) => x.id === `pos:${SYMBOL}`);
    const chartBox = await page.$eval('.vela-cell', (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, w: r.width };
    });
    const clickX = chartBox.x + chartBox.w * 0.6;
    await page.mouse.click(clickX, pos.y + 70, { button: 'right' });
    const menuItem = await page.waitForSelector('text=Buy here', { timeout: 4000 }).catch(() => null);
    let rightClick = 'menu item not found';
    if (menuItem) {
        await menuItem.click();
        rightClick = await confirmSend();
    }
    s = await until(store, (x) =>
        Object.values<any>(x.orders).some((o) => o.source === 'chart' && o.status === 'working' && o.type === 'limit'),
    );
    const hereOrder = Object.values<any>(s.orders).find(
        (o) => o.source === 'chart' && o.status === 'working' && o.type === 'limit',
    );
    check(
        "right-clicking below the market and choosing 'Buy here' places a buy limit at that price",
        !!hereOrder &&
            hereOrder.side === 'buy' &&
            hereOrder.limit < (await last()) &&
            /Buy 1 ALPHA limit at/.test(rightClick),
        rightClick.replace(/\s+/g, ' ').slice(0, 80),
    );

    // ── Depth ladder ───────────────────────────────────────────────────────
    await page.click('[data-testid="dock-tab-dom"]');
    await page.waitForSelector('[data-testid="dom"] .dom-row.is-last');
    await until(
        () => page.$$eval('[data-testid="dom"] .dom-size em', (els) => els.length),
        (n) => n > 10,
    );
    const ladder = await page.$$eval('[data-testid="dom-rows"] .dom-row[data-price]', (rows) =>
        rows.map((r) => ({ price: Number((r as HTMLElement).dataset.price), last: r.classList.contains('is-last') })),
    );
    const lastIndex = ladder.findIndex((r) => r.last);
    const target = ladder[lastIndex + 5];
    await page.click(`[data-testid="dom-rows"] .dom-row[data-price="${target.price}"] .dom-buy`);
    const domAsk = await confirmSend();
    s = await until(store, (x) =>
        Object.values<any>(x.orders).some((o) => o.source === 'dom' && o.status === 'working'),
    );
    const domOrder = Object.values<any>(s.orders).find((o) => o.source === 'dom' && o.status === 'working');
    const chip = await page
        .waitForSelector(`[data-testid="dom-rows"] .dom-row[data-price="${target.price}"] .dom-order.buy`, {
            timeout: 4000,
        })
        .catch(() => null);
    await page.screenshot({ path: 'tests/e2e/phase6-trading.png' });
    check(
        'a click on the buy side of the ladder below the market places a buy limit there, shown in its row',
        ladder.length === 41 && lastIndex > 0 && !!domOrder && Math.abs(domOrder.limit - target.price) < 1e-9 && !!chip,
        `${ladder.length} rows; ${domAsk.replace(/\s+/g, ' ').slice(0, 60)}`,
    );
    await chip?.click();
    s = await until(store, (x) => x.orders[domOrder.id]?.status === 'cancelled');
    check('clicking our order in the ladder cancels it', s.orders[domOrder.id]?.status === 'cancelled');

    // ── Close from the chart, reverse from the account manager ────────────
    const posBox = (await boxes()).find((x) => x.id === `pos:${SYMBOL}`);
    await page.mouse.click(posBox.closeX, posBox.y);
    const closeAsk = await confirmSend();
    s = await until(store, (x) => !x.positions[SYMBOL]);
    lines = await until(tradingLines, (l) => !l.some((x) => x.id === `pos:${SYMBOL}`));
    check(
        'the × on the position line closes the position after asking',
        !s.positions[SYMBOL] && !lines.some((x) => x.id === `pos:${SYMBOL}`) && /Sell 1.5/.test(closeAsk),
    );

    await page.click('[data-testid="quick-buy"]');
    await confirmSend();
    await until(store, (x) => x.positions[SYMBOL]?.qty === 1);
    await page.click('[data-testid="account-manager"] .tab:has-text("Positions")');
    await page.click('[data-testid="position-row"] button:text-is("Reverse")');
    await confirmSend();
    s = await until(store, (x) => x.positions[SYMBOL]?.qty === -1);
    check('reverse in the account manager turns a long of 1 into a short of 1', s.positions[SYMBOL]?.qty === -1);

    // ── Safety and persistence ─────────────────────────────────────────────
    check(
        'every order request from this screen names the paper account',
        accountHeaders.length >= 10 && accountHeaders.every((h) => h === 'paper'),
        `${accountHeaders.length} requests: ${[...new Set(accountHeaders)].join(', ')}`,
    );
    await boot();
    s = await until(store, (x) => x.positions[SYMBOL]?.qty === -1);
    const kept = s.orders[hereOrder.id];
    const linesAfter = await until(tradingLines, (l) => l.some((x) => x.id === `pos:${SYMBOL}`));
    check(
        'after a reload the position, the working order and their lines are all still there',
        s.positions[SYMBOL]?.qty === -1 &&
            kept?.status === 'working' &&
            linesAfter.some((x) => x.id === `${hereOrder.id}:limit`),
        `${Object.values<any>(s.orders).filter((o) => o.status === 'working').length} working orders`,
    );

    const serious = errors.filter((e) => !/ResizeObserver/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    await send('POST', '/api/trading/paper/reset', { initialBalance: 100_000 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
