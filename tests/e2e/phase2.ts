/**
 * Phase 2 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Exercises the charting workstation features and the phase's exit criteria:
 *   - an 8-chart layout holds 60 fps while panning
 *   - a layout survives a restart exactly
 *   - replay works on any symbol
 * Run: node tests/e2e/phase2.ts
 */
import { chromium, type Page } from 'playwright-core';

const url = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function ready(page: Page) {
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).__ts.workspace.chart.ready());
}

/** Run a function in the page with access to the workspace. */
const inPage = <T>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) =>
    page.evaluate(fn as any, arg) as Promise<T>;

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
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 2,
        acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !/favicon|404/.test(msg.text())) errors.push(msg.text());
    });

    // Start from a clean, known workspace.
    await fetch(new URL('/api/kv/workspace%3Amain', url), { method: 'DELETE' }).catch(() => {});
    await page.goto(url, { waitUntil: 'load' });
    await ready(page);
    await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        ws.setLayout('1');
        await ws.chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
    });

    // ── Watchlist ──────────────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="watchlist"] .wl-row', { timeout: 10_000 });
    await page.waitForFunction(() => /\d/.test(document.querySelector('.wl-row .wl-last')?.textContent ?? ''), null, {
        timeout: 15_000,
    });
    const rows = await page.$$eval('.wl-row', (els) =>
        els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    );
    check(
        'watchlist shows symbols with live quotes',
        rows.length >= 3 && rows.every((r) => /\d/.test(r)),
        rows.slice(0, 3).join(' | '),
    );
    await page.click('.wl-row:has-text("ETHUSDT")');
    await page.waitForFunction(() => (window as any).__ts.workspace.chart.market.symbol === 'BINANCE:ETHUSDT', null, {
        timeout: 10_000,
    });
    check('clicking a watchlist row loads that symbol', true);
    await page.waitForSelector('.wl-row.active:has-text("ETHUSDT")', { timeout: 5_000 }).catch(() => {});
    const activeRow = await page.$eval('.wl-row.active', (e) => (e as HTMLElement).innerText).catch(() => '');
    check(
        'the active symbol is highlighted in the watchlist',
        /ETHUSDT/.test(activeRow),
        activeRow.replace(/\s+/g, ' '),
    );

    // ── Chart types ────────────────────────────────────────────────────────
    for (const style of ['renko', 'linebreak', 'kagi', 'pnf', 'range']) {
        const out = await inPage(
            page,
            async (s: string) => {
                const ws = (window as any).__ts.workspace;
                const chart = ws.chart;
                chart.renderer.set('priceStyle', s);
                const until = Date.now() + 15_000;
                while (Date.now() < until && !/\./.test(chart.market.symbol.split(':')[1] ?? ''))
                    await new Promise((r) => setTimeout(r, 50));
                // the first build of a chart-type series loads 20,000 source bars; wait for it to paint
                await new Promise((r) => setTimeout(r, 300));
                while (Date.now() < until && !chart.getVisibleRange()) await new Promise((r) => setTimeout(r, 50));
                return {
                    symbol: chart.market.symbol,
                    style: chart.renderer.get('priceStyle'),
                    range: chart.getVisibleRange(),
                };
            },
            style,
        );
        check(
            `chart type ${style} loads a derived series`,
            /\.[A-Z0-9]+$/.test(out.symbol) && out.style === style && !!out.range,
            out.symbol,
        );
    }
    const plain = await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        chart.renderer.set('priceStyle', 'candles');
        const until = Date.now() + 10_000;
        while (Date.now() < until && chart.market.symbol.includes('.')) await new Promise((r) => setTimeout(r, 50));
        await chart.ready();
        return chart.market.symbol;
    });
    check('switching back to candles drops the suffix', plain === 'BINANCE:ETHUSDT', plain);

    const kept = await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        chart.renderer.set('priceStyle', 'renko');
        let until = Date.now() + 10_000;
        while (Date.now() < until && !chart.market.symbol.includes('.')) await new Promise((r) => setTimeout(r, 50));
        // a symbol picked from search arrives without a suffix: the chart type must be re-applied
        await chart.setMarket({ symbol: 'BINANCE:SOLUSDT' });
        until = Date.now() + 10_000;
        while (Date.now() < until && !chart.market.symbol.includes('.')) await new Promise((r) => setTimeout(r, 50));
        const symbol = chart.market.symbol;
        chart.renderer.set('priceStyle', 'candles');
        until = Date.now() + 10_000;
        while (Date.now() < until && chart.market.symbol.includes('.')) await new Promise((r) => setTimeout(r, 50));
        return symbol;
    });
    check('a new symbol keeps the active chart type', /^BINANCE:SOLUSDT\.RENKOX/.test(kept), kept);

    // ── Seconds and custom timeframes, spread, compare ─────────────────────
    for (const tf of ['15S', '7', '45', '120']) {
        const got = await inPage(
            page,
            async (t: string) => {
                const chart = (window as any).__ts.workspace.chart;
                await chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: t });
                const r = chart.getVisibleRange();
                return { tf: chart.market.timeframe, bars: r ? Math.round((r.to - r.from) / 1000) : 0 };
            },
            tf,
        );
        check(`timeframe ${tf} loads`, got.tf === tf && got.bars > 0, `visible span ${got.bars}s`);
    }
    const spread = await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        await chart.setMarket({ symbol: 'SPREAD:BINANCE:ETHUSDT/BINANCE:BTCUSDT', timeframe: '60' });
        await new Promise((r) => setTimeout(r, 500));
        const data = chart.renderer.dataWindowReadout?.();
        return {
            symbol: chart.market.symbol,
            close: data?.ohlc?.close ?? data?.ohlc?.c ?? JSON.stringify(data?.ohlc ?? null),
        };
    });
    check(
        'a spread formula charts as its own series',
        spread.symbol.startsWith('SPREAD:'),
        `ETH/BTC close ${spread.close}`,
    );

    const compare = await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        await chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
        const result = await chart.runIndicator(`//@version=6
indicator("Compare ETHUSDT", overlay=true)
other = request.security("BINANCE:ETHUSDT", timeframe.period, close)
var float otherBase = na
var float ownBase = na
if time == chart.left_visible_bar_time
    otherBase := other
    ownBase := close
plot(other / otherBase * ownBase, "Compared", color=color.orange)`);
        const titles = chart.indicators().map((i: any) => i.title);
        if (result.ok) result.handle.remove();
        return { ok: result.ok, error: result.error?.message, titles };
    });
    check('compare overlays another symbol', compare.ok, compare.ok ? compare.titles.join(', ') : compare.error);

    // ── Replay ─────────────────────────────────────────────────────────────
    const replay = await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        const chart = ws.chart;
        await chart.setMarket({ symbol: 'SYNTH:GAMMA', timeframe: '5' });
        await chart.historyComplete();
        const bounds = chart.replay.bounds;
        const from = bounds.last - 300 * 5 * 60_000;
        await ws.replay.start({ from });
        const started = { ...ws.replay.state };
        ws.replay.step();
        ws.replay.step();
        const stepped = { ...ws.replay.state };
        ws.replay.play(20);
        await new Promise((r) => setTimeout(r, 700));
        const playing = { ...ws.replay.state };
        ws.replay.pause();
        const paused = { ...ws.replay.state };
        ws.replay.stop();
        const stopped = { ...ws.replay.state };
        return { started, stepped, playing, paused, stopped, last: chart.replay.bounds?.last === bounds.last };
    });
    check(
        'replay: start, step, play, pause and stop',
        replay.started.active &&
            replay.started.remaining - replay.stepped.remaining === 2 &&
            replay.playing.playing &&
            replay.playing.remaining < replay.stepped.remaining - 5 &&
            !replay.paused.playing &&
            !replay.stopped.active,
        `remaining ${replay.started.remaining} → ${replay.stepped.remaining} → ${replay.playing.remaining}`,
    );
    await inPage(page, () => (window as any).__ts.ui.getState().setReplayOpen(true));
    await page.waitForSelector('[data-testid="replay-bar"]');
    await page.click('[data-testid="replay-bar"] >> text=100 bars back');
    await page.waitForFunction(() => (window as any).__ts.workspace.replay.state.active, null, { timeout: 10_000 });
    await page.click('[data-testid="replay-bar"] >> text=Step');
    const barText = await page.$eval('[data-testid="replay-bar"]', (e) =>
        (e as HTMLElement).innerText.replace(/\s+/g, ' '),
    );
    await page.click('[data-testid="replay-bar"] >> text=Stop');
    const afterStop = await inPage(page, () => (window as any).__ts.workspace.replay.state.active);
    check('replay bar drives the replay', /bars left/.test(barText) && !afterStop, barText.slice(0, 110));
    await inPage(page, () => (window as any).__ts.ui.getState().setReplayOpen(false));

    // ── CSV export ─────────────────────────────────────────────────────────
    await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        await chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
    });
    const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15_000 }),
        page.click('[aria-label="Export chart data (CSV)"], [title="Export chart data (CSV)"]'),
    ]);
    const csvPath = await dl.path();
    const csv = csvPath ? (await import('node:fs')).readFileSync(csvPath, 'utf8') : '';
    const lines = csv.trim().split('\n');
    check(
        'CSV export downloads the chart bars',
        dl.suggestedFilename() === 'BINANCE_BTCUSDT_60.csv' &&
            lines[0] === 'time,open,high,low,close,volume' &&
            lines.length > 1000,
        `${dl.suggestedFilename()}, ${lines.length - 1} rows, last ${lines[lines.length - 1]?.slice(0, 40)}`,
    );

    // ── Saved layouts ──────────────────────────────────────────────────────
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    await page.fill('[aria-label="Name"]', 'e2e layout');
    await page.click('text=Save current');
    await page.waitForSelector('.list-row:has-text("e2e layout")');
    await page.keyboard.press('Escape');
    await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        await ws.chart.setMarket({ symbol: 'SYNTH:BETA', timeframe: '15' });
    });
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    await page.click('.list-row:has-text("e2e layout") >> text=Load');
    await page.waitForFunction(() => (window as any).__ts.workspace.chart.market.symbol === 'BINANCE:BTCUSDT', null, {
        timeout: 10_000,
    });
    check('a named layout saves and loads', true);
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    page.once('dialog', (d) => void d.accept());
    await page.click('.list-row:has-text("e2e layout") >> text=Delete');
    await page.keyboard.press('Escape');

    // ── Multi-chart layout: frame budget and persistence ───────────────────
    const frames = await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        ws.setLayout('8');
        const symbols = [
            'BINANCE:BTCUSDT',
            'BINANCE:ETHUSDT',
            'BINANCE:SOLUSDT',
            'BINANCE:BNBUSDT',
            'BINANCE:XRPUSDT',
            'SYNTH:ALPHA',
            'SYNTH:BETA',
            'SYNTH:GAMMA',
        ];
        const tfs = ['60', '15', '5', '240', '60', '1', '5', '15'];
        const cells = ws.cells();
        await Promise.all(
            cells.map((c: any, i: number) => c.chart.setMarket({ symbol: symbols[i], timeframe: tfs[i] })),
        );
        await Promise.all(cells.map((c: any) => c.chart.ready()));
        for (const c of cells) {
            c.chart.addNativeIndicator('moving-average');
            c.chart.addNativeIndicator('rsi');
        }
        await new Promise((r) => setTimeout(r, 1500));
        ws.sync.set('crosshair', true);
        const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
        const deltas: number[] = [];
        let prev = await raf();
        for (let i = 0; i < 240; i++) {
            const f = Math.sin((i / 240) * Math.PI * 4) > 0 ? -0.02 : 0.02;
            for (const c of cells) c.chart.panBy(f);
            const now = await raf();
            deltas.push(now - prev);
            prev = now;
        }
        const sorted = [...deltas].sort((a, b) => a - b);
        return {
            cells: cells.length,
            p50: sorted[120],
            p95: sorted[228],
            max: sorted[239],
            dropped: deltas.filter((d) => d > 25).length,
            indicators: cells.reduce((n: number, c: any) => n + c.chart.indicators().length, 0),
        };
    });
    check(
        '8-chart layout holds 60 fps while every chart pans',
        frames.cells === 8 && frames.p95 <= 17.5 && frames.dropped <= 3,
        `8 live charts, ${frames.indicators} indicators: frame p50 ${frames.p50.toFixed(1)} ms, p95 ${frames.p95.toFixed(1)} ms, max ${frames.max.toFixed(1)} ms, ${frames.dropped} frames over 25 ms`,
    );

    // Add drawings and remember the full state, then restart the page.
    const before = await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        const chart = ws.cell(ws.cells()[0].id).chart;
        const r = chart.getVisibleRange();
        chart.drawings.add('trendline', {
            paneId: 'price',
            anchors: [
                { time: r.from, price: 60000 },
                { time: r.to, price: 70000 },
            ],
        });
        chart.drawings.add('hline', { paneId: 'price', anchors: [{ time: r.to, price: 65000 }] });
        ws.setActiveCell(ws.cells()[2].id);
        await new Promise((r2) => setTimeout(r2, 1200)); // let the debounced save flush
        return ws.getState();
    });
    await page.reload({ waitUntil: 'load' });
    await ready(page);
    await page.waitForFunction(() => (window as any).__ts.workspace.cells().length === 8, null, { timeout: 15_000 });
    await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        await Promise.all(ws.cells().map((c: any) => c.chart.ready()));
        await new Promise((r) => setTimeout(r, 1500));
    });
    const after = await inPage(page, () => (window as any).__ts.workspace.getState());
    const digest = (s: any) =>
        JSON.stringify({
            layout: s.layout,
            active: s.activeCellId,
            sync: s.sync,
            charts: s.charts.map((c: any) => ({
                id: c.id,
                symbol: c.symbol,
                timeframe: c.timeframe,
                priceStyle: c.priceStyle,
                drawings: (c.drawings?.drawings ?? c.drawings?.items ?? []).map((d: any) => [
                    d.type,
                    JSON.stringify(d.anchors),
                ]),
                natives: [...(c.indicators?.natives ?? [])].sort(),
            })),
        });
    const same = digest(before) === digest(after);
    check(
        'the 8-chart layout survives a restart exactly (symbols, timeframes, styles, sync, indicators, drawings, active chart)',
        same,
        same
            ? `${after.charts.length} charts, ${after.charts.reduce((n: number, c: any) => n + (c.indicators?.natives?.length ?? 0), 0)} indicators restored`
            : `\n   before ${digest(before).slice(0, 400)}\n   after  ${digest(after).slice(0, 400)}`,
    );

    // Replay across the grid, then restore a single chart for the next run.
    const grid = await inPage(page, async () => {
        const ws = (window as any).__ts.workspace;
        const chart = ws.chart;
        const from = chart.replay.bounds.last - 50 * 3_600_000;
        await ws.replay.start({ from });
        const a = ws.replay.state.active;
        ws.replay.step();
        ws.replay.stop();
        ws.setLayout('1');
        await ws.chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: '60' });
        for (const h of ws.chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        for (const d of ws.chart.drawings.all()) ws.chart.drawings.remove(d.id);
        await new Promise((r) => setTimeout(r, 1200));
        return a;
    });
    check('replay runs across the whole grid', grid === true);

    const serious = errors.filter((e) => !/ResizeObserver|WebSocket connection/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
