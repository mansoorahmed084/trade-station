/**
 * Phase 5 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers the strategy tester: running a built-in and a Pine strategy on the active chart, the
 * report views, fills marked on the chart, the trade list jumping the chart, settings that re-run
 * the test, the parameter search with live progress, walk-forward, Monte Carlo, testing an unsaved
 * strategy from the editor, and comparing a run with a TradingView trade-list export.
 * Run: node tests/e2e/phase5.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const post = async (path: string, body: unknown) =>
    (
        await fetch(api(path), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
    ).json() as Promise<any>;

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
    await page.addInitScript(() => localStorage.removeItem('ts.tester'));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await inPage(page, async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        t.workspace.setLayout('1');
        t.ui.getState().setBottomHeight(520);
        await t.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '60' });
        for (const h of t.workspace.chart.indicators()) if (h.nativeType !== 'volume') h.remove();
    });
    /** The tester's current result, once a run that started after `since` has landed. */
    const settled = async (since = 0) => {
        await page.waitForFunction(
            (min) => {
                const s = (window as any).__ts.tester.getState();
                return !s.running && (s.error || (s.result && s.result.__seen !== min));
            },
            since,
            { timeout: 30_000 },
        );
        return inPage<any>(page, () => {
            const s = (window as any).__ts.tester.getState();
            return { error: s.error, result: s.result };
        });
    };
    /** Wait for the next result after doing something that re-runs the test. */
    const rerun = async (action: () => Promise<unknown>) => {
        const stamp = Math.random();
        await inPage(
            page,
            (v) => {
                const r = (window as any).__ts.tester.getState().result;
                if (r) r.__seen = v;
            },
            stamp,
        );
        await action();
        return settled(stamp);
    };

    // ── Open the tester: it runs on the active chart ────────────────────────
    await page.click('#vela-action-ts\\.tester');
    await page.waitForSelector('[data-testid="tester"]');
    let state = await settled();
    const marketText = await page.textContent('[data-testid="tester-market"]');
    check(
        'the toolbar opens the tester, which runs the default strategy on the active chart',
        !state.error &&
            state.result?.engine === 'native' &&
            state.result.report.bars === 5000 &&
            /SYNTH:ALPHA · 1h/.test(marketText ?? ''),
        `${marketText}; ${state.result?.report.all.trades} trades over ${state.result?.report.bars} bars in ${Math.round(state.result?.ms)} ms`,
    );

    // ── Overview ───────────────────────────────────────────────────────────
    const overview = await page.$eval('[data-testid="tester-overview"]', (e) => (e as HTMLElement).innerText);
    const lines = await page.$$eval('[data-testid="tester-overview"] svg path[stroke-width="2"]', (els) =>
        els.map((e) => (e.getAttribute('d') ?? '').length),
    );
    check(
        'the overview shows the headline numbers, the equity curve against buy & hold, and the drawdown',
        /Net profit/.test(overview) &&
            /Max drawdown/.test(overview) &&
            /Profit factor/.test(overview) &&
            /Buy & hold/.test(overview) &&
            /Drawdown/.test(overview) &&
            lines.length === 2 &&
            lines.every((n) => n > 500),
        `${lines.length} lines`,
    );
    const box = await page.$eval('[data-testid="tester-overview"] svg', (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.4);
    const tip = await page.textContent('.viz-tip').catch(() => null);
    check(
        'hovering the curve reads the date, both series and the drawdown',
        /\d{4}-\d{2}-\d{2}/.test(tip ?? '') &&
            /Strategy/.test(tip ?? '') &&
            /Buy & hold/.test(tip ?? '') &&
            /Drawdown/.test(tip ?? ''),
        (tip ?? '').slice(0, 80),
    );
    await page.mouse.move(10, 10);

    // ── Fills on the chart ─────────────────────────────────────────────────
    await wait(800);
    const marked = await inPage<number>(page, () => {
        const t = (window as any).__ts;
        return t.chartMarkers(t.workspace.chart).length;
    });
    const closedTrades = state.result.report.trades.filter((t: any) => !t.open).length;
    const openTrades = state.result.report.trades.length - closedTrades;
    check(
        'entries and exits are marked on the chart',
        marked === closedTrades * 2 + openTrades && marked > 20,
        `${marked} markers for ${state.result.report.trades.length} trades`,
    );
    await page.screenshot({ path: 'tests/e2e/phase5-overview.png' });

    // ── Performance ────────────────────────────────────────────────────────
    await page.click('.tester .tab:text-is("Performance")');
    const perf = await page.$eval('[data-testid="tester-performance"]', (e) => (e as HTMLElement).innerText);
    check(
        'the performance tab breaks the result down by side and lists the account figures',
        /All\s+Long\s+Short/.test(perf) &&
            /Gross profit/.test(perf) &&
            /Sortino ratio/.test(perf) &&
            /Monthly returns/.test(perf) &&
            /Annual growth/.test(perf),
    );

    // ── Trades: the list jumps the chart ───────────────────────────────────
    await page.click('.tester .tab:text-is("List of trades")');
    await page.waitForSelector('[data-testid="tester-trades"] tbody tr');
    const rowCount = await page.$$eval('[data-testid="tester-trades"] tbody tr', (els) => els.length);
    const target = state.result.report.trades[5];
    await page.click(`[data-testid="tester-trades"] tbody tr:nth-child(${state.result.report.trades.length - 5})`);
    await wait(500);
    const range = await inPage<{ from: number; to: number }>(page, () =>
        (window as any).__ts.workspace.chart.getVisibleRange(),
    );
    check(
        'clicking a trade moves the chart to it',
        rowCount === Math.min(300, state.result.report.trades.length) &&
            range.from < target.entryTime &&
            range.to > (target.exitTime ?? target.entryTime) &&
            range.to - range.from < 400 * 3_600_000,
        `${rowCount} rows; chart now ${new Date(range.from).toISOString().slice(0, 16)} → ${new Date(range.to).toISOString().slice(0, 16)}`,
    );

    // ── Compare with a TradingView export ──────────────────────────────────
    const dir = mkdtempSync(join(tmpdir(), 'ts-e2e5-'));
    const rows = ['Trade #,Type,Signal,Date/Time,Price USD,Contracts,Profit USD,Profit %'];
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const closed = state.result.report.trades.filter((t: any) => !t.open);
    closed.forEach((t: any, i: number) => {
        const exit = i === 2 ? t.exitPrice * 1.01 : t.exitPrice; // one fill TradingView "disagrees" on
        rows.push(`${i + 1},Entry ${t.side},${t.entryId},${stamp(t.entryTime)},${t.entryPrice},${t.qty},,`);
        rows.push(`${i + 1},Exit ${t.side},x,${stamp(t.exitTime)},${exit},${t.qty},${t.pnl},`);
    });
    const csv = join(dir, 'tv.csv');
    writeFileSync(csv, rows.join('\n'));
    await page.setInputFiles('[data-testid="tv-file"]', csv);
    await page.waitForSelector('[data-testid="tv-comparison"]');
    const comparison = await page.$eval('[data-testid="tv-comparison"]', (e) => (e as HTMLElement).innerText);
    check(
        'a TradingView trade-list export is compared with the run, naming the trade that differs',
        new RegExp(
            `${closed.length} of ${closed.length} TradingView trades found here; ${closed.length - 1} identical`,
        ).test(comparison) && /Trade 3: exit price/.test(comparison),
        comparison.split('\n')[0].slice(0, 110),
    );

    // ── Settings re-run the test ───────────────────────────────────────────
    const before = state.result.report;
    await page.click('[data-testid="tester-settings-open"]');
    await page.waitForSelector('[data-testid="tester-settings"]');
    state = await rerun(async () => {
        await page.fill('[data-testid="tester-settings"] label:has-text("Fast EMA") input', '5');
    });
    const afterInput = state.result.report;
    state = await rerun(async () => {
        await page.fill('[data-testid="tester-settings"] label:has-text("Initial capital") input', '50000');
    });
    const afterCapital = state.result.report;
    state = await rerun(async () => {
        await page.check('[data-testid="tester-settings"] label:has-text("Bar magnifier") input');
    });
    check(
        'changing an input, the capital or the bar magnifier re-runs the test',
        afterInput.all.trades !== before.all.trades &&
            state.result.inputs.find((i: any) => i.name === 'fast')?.value === 5 &&
            afterCapital.initialCapital === 50_000 &&
            state.result.magnifier.applied === true &&
            state.result.magnifier.timeframe === '10',
        `trades ${before.all.trades} → ${afterInput.all.trades}; capital ${afterCapital.initialCapital}; magnifier read ${state.result.magnifier.bars} ${state.result.magnifier.timeframe}m bars`,
    );
    await page.click('[data-testid="tester-settings"] button:text-is("Reset properties")');
    state = await rerun(async () => {
        await page.click('[data-testid="tester-settings"] button:text-is("Reset inputs")');
    });
    await page.click('[data-testid="tester-settings"] button:text-is("Done")');
    check(
        'resetting the settings restores the first result',
        Math.abs(state.result.report.netProfit - before.netProfit) < 1e-9 &&
            state.result.report.initialCapital === 10_000,
    );

    // ── A Pine strategy from the library ───────────────────────────────────
    state = await rerun(async () => {
        await page.selectOption('[data-testid="tester-strategy"]', 'pine:example-ema-cross-strategy');
    });
    const pine = state.result;
    check(
        'a Pine strategy from the library runs with the settings its script declares',
        !state.error &&
            pine.engine === 'pine' &&
            pine.title === 'EMA Cross Strategy' &&
            pine.properties.commission.value === 0.1 &&
            pine.report.all.trades > 20,
        `${pine?.report.all.trades} trades, net ${pine?.report.netProfit.toFixed(2)}`,
    );
    // The same strategy written natively, with the script's settings, must agree with it.
    const native = await post('/api/backtest/run', {
        strategy: { kind: 'native', id: 'ema-cross' },
        symbol: 'SYNTH:ALPHA',
        timeframe: '60',
        bars: 5000,
        to: pine.report.to,
        properties: { commission: { type: 'percent', value: 0.1 } },
    });
    check(
        'the native and the Pine version of the same strategy agree trade for trade',
        native.report.all.trades === pine.report.all.trades &&
            Math.abs(native.report.netProfit - pine.report.netProfit) < 0.02,
        `native ${native.report.netProfit.toFixed(4)} vs Pine ${pine.report.netProfit.toFixed(4)} over ${pine.report.all.trades} trades`,
    );

    // ── Monte Carlo ────────────────────────────────────────────────────────
    await page.click('.tester .tab:text-is("Monte Carlo")');
    const mc = await page.$eval('[data-testid="tester-montecarlo"]', (e) => (e as HTMLElement).innerText);
    check(
        'Monte Carlo reshuffles the trades and shows the spread of drawdowns',
        /Worst 5%/.test(mc) && /Median/.test(mc) && /Max drawdown/.test(mc) && /Chance of losing everything/.test(mc),
    );

    // ── Parameter search ───────────────────────────────────────────────────
    await page.selectOption('[data-testid="tester-strategy"]', 'native:ema-cross');
    await settled();
    await page.click('.tester .tab:text-is("Optimise")');
    await page.waitForSelector('[data-testid="optimizer"]');
    for (const [name, from, to, step] of [
        ['Fast EMA', '4', '20', '2'],
        ['Slow EMA', '25', '85', '5'],
    ]) {
        await page.check(`[data-testid="optimizer"] label:has-text("${name}") input`);
        await page.fill(`[aria-label="${name} from"]`, from);
        await page.fill(`[aria-label="${name} to"]`, to);
        await page.fill(`[aria-label="${name} step"]`, step);
    }
    const planned = await page.$eval('[data-testid="optimizer"] .optimizer-setup', (e) => (e as HTMLElement).innerText);
    const t0 = Date.now();
    await page.click('[data-testid="optimize-start"]');
    await page.waitForSelector('[data-testid="optimize-progress"]');
    await page.waitForFunction(
        () => /done/.test(document.querySelector('[data-testid="optimize-progress"]')?.textContent ?? ''),
        null,
        { timeout: 60_000 },
    );
    const took = Date.now() - t0;
    const progress = await page.textContent('[data-testid="optimize-progress"]');
    const table = await page.$$eval('[data-testid="optimize-rows"] tbody tr', (els) =>
        els.map((e) => (e as HTMLElement).innerText.split('\t')),
    );
    const profits = table.map((r) => Number(r[3].replace(/,/g, '').replace('−', '-').replace('+', '')));
    check(
        'a parameter search runs every combination and ranks them best first',
        /117 runs/.test(planned) &&
            /117 \/ 117/.test(progress ?? '') &&
            table.length === 117 &&
            profits.every((p, i) => i === 0 || p <= profits[i - 1] + 1e-9),
        `${progress?.trim()} in ${took} ms; best ${table[0]?.slice(1, 4).join(' / ')}`,
    );
    const best = { fast: Number(table[0][1]), slow: Number(table[0][2]) };
    state = await rerun(async () => {
        await page.click('[data-testid="optimize-rows"] tbody tr:first-child button:text-is("Use")');
    });
    check(
        'using a row applies its inputs and shows that run',
        state.result.inputs.find((i: any) => i.name === 'fast')?.value === best.fast &&
            Math.abs(state.result.report.netProfit - profits[0]) < 0.01,
        `fast ${best.fast}, slow ${best.slow}: net ${state.result.report.netProfit.toFixed(2)}`,
    );

    // ── Walk-forward ───────────────────────────────────────────────────────
    await page.click('.tester .tab:text-is("Optimise")');
    await page.click('[data-testid="optimizer"] .seg button:text-is("Walk-forward")');
    await page.click('[data-testid="optimize-start"]');
    await page.waitForSelector('[data-testid="walkforward"]', { timeout: 60_000 });
    const wf = await page.$eval('[data-testid="walkforward"]', (e) => (e as HTMLElement).innerText);
    const folds = await page.$$eval('[data-testid="walkforward"] table tbody tr', (els) => els.length);
    check(
        'walk-forward fits on one window, tests on the next, and reports the out-of-sample result',
        folds === 4 &&
            /Out-of-sample net profit/.test(wf) &&
            /Walk-forward efficiency/.test(wf) &&
            /Fitted on/.test(wf),
        `${folds} folds`,
    );
    await page.screenshot({ path: 'tests/e2e/phase5-walkforward.png' });

    // ── An unsaved strategy straight from the editor ───────────────────────
    await page.click('[data-testid="bottom-tab-editor"]');
    // The editor opens the first library script once it has loaded: wait for that before typing over it.
    await page.waitForFunction(() => ((window as any).__tsEditor?.getValue() ?? '').length > 0, null, {
        timeout: 20_000,
    });
    await wait(400);
    await inPage(page, () => {
        (window as any).__tsEditor.setValue(
            [
                '//@version=6',
                'strategy("E2E breakout", overlay=true, initial_capital=20000, default_qty_type=strategy.percent_of_equity, default_qty_value=25)',
                'len = input.int(30, "Lookback", minval=5)',
                'if close > ta.highest(high, len)[1]',
                '    strategy.entry("Break", strategy.long)',
                'if close < ta.lowest(low, len / 2)[1]',
                '    strategy.close("Break")',
            ].join('\n'),
        );
    });
    await page.waitForSelector('[data-testid="test-strategy"]');
    state = await rerun(async () => {
        await page.click('[data-testid="test-strategy"]');
    });
    const picked = await page.$eval(
        '[data-testid="tester-strategy"]',
        (e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent,
    );
    check(
        'an unsaved strategy is tested straight from the editor',
        !state.error &&
            state.result?.title === 'E2E breakout' &&
            state.result.properties.initialCapital === 20_000 &&
            state.result.inputs[0]?.name === 'Lookback' &&
            /from the editor/.test(picked ?? ''),
        `${state.result?.report.all.trades} trades; "${picked}"`,
    );

    // ── A script that does not compile says where ──────────────────────────
    await page.click('[data-testid="bottom-tab-editor"]');
    // The editor opens the first library script once it has loaded: wait for that before typing over it.
    await page.waitForFunction(() => ((window as any).__tsEditor?.getValue() ?? '').length > 0, null, {
        timeout: 20_000,
    });
    await wait(400);
    await inPage(page, () =>
        (window as any).__tsEditor.setValue(
            '//@version=6\nstrategy("Broken")\nif close >\n    strategy.entry("x", strategy.long)',
        ),
    );
    await page.click('[data-testid="test-strategy"]');
    await page.waitForSelector('[data-testid="tester-error"]', { timeout: 15_000 });
    const message = await page.textContent('[data-testid="tester-error"]');
    check(
        'a strategy that does not compile reports the error instead of a result',
        (message ?? '').length > 5,
        (message ?? '').slice(0, 90),
    );

    // ── The server stays responsive during a deep run ──────────────────────
    const deep = post('/api/backtest/run', {
        strategy: { kind: 'native', id: 'supertrend' },
        symbol: 'SYNTH:BETA',
        timeframe: '1',
        bars: 500_000,
    });
    await wait(30);
    const laps: number[] = [];
    for (let i = 0; i < 10; i++) {
        const t = performance.now();
        await (await fetch(api('/api/health'))).json();
        laps.push(performance.now() - t);
        await wait(15);
    }
    const deepResult = await deep;
    laps.sort((a, b) => a - b);
    check(
        'a 500,000-bar run does not hold up the server',
        deepResult.report?.bars === 500_000 && laps[Math.floor(laps.length / 2)] < 100,
        `run ${Math.round(deepResult.ms)} ms (engine ${Math.round(deepResult.engineMs)} ms); health median ${laps[Math.floor(laps.length / 2)].toFixed(1)} ms, worst ${laps.at(-1)?.toFixed(1)} ms`,
    );

    const serious = errors.filter((e) => !/ResizeObserver/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
