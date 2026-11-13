/**
 * Live-path timings in headless Chrome against the running app (server :8787 + web :5173):
 * server-send → painted frame for live updates, and symbol/timeframe switch → history painted.
 * Run: node tests/bench/live-bench.ts [seconds]
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const dataDir = resolve(process.env.TS_DATA_DIR ?? 'data');
const CANDIDATES = [
    'SOLUSDT',
    'XRPUSDT',
    'ADAUSDT',
    'DOGEUSDT',
    'LINKUSDT',
    'AVAXUSDT',
    'DOTUSDT',
    'LTCUSDT',
    'TRXUSDT',
    'ATOMUSDT',
    'NEARUSDT',
    'UNIUSDT',
    'AAVEUSDT',
    'FILUSDT',
    'ETCUSDT',
    'XLMUSDT',
    'ALGOUSDT',
    'SUIUSDT',
    'APTUSDT',
    'ARBUSDT',
    'OPUSDT',
    'INJUSDT',
    'BCHUSDT',
    'ICPUSDT',
    'HBARUSDT',
    'VETUSDT',
    'SANDUSDT',
    'GRTUSDT',
    'EGLDUSDT',
    'THETAUSDT',
];

const seconds = Number(process.argv[2] ?? 20);
const url = process.env.APP_URL ?? 'http://127.0.0.1:5173/';

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
let failed = false;
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await page.evaluate(() => (window as any).__ts.workspace.chart.ready());
    const coldStart = Date.now() - t0;

    const switchTo = (symbol: string, timeframe: string) =>
        page.evaluate(
            async ([s, tf]) => {
                const chart = (window as any).__ts.workspace.chart;
                const start = performance.now();
                await chart.setMarket({ symbol: s, timeframe: tf });
                await new Promise((r) => requestAnimationFrame(() => r(null)));
                return performance.now() - start;
            },
            [symbol, timeframe],
        );

    // A symbol whose history is not on disk yet, so "first visit" really includes the venue fetch.
    const stamp = CANDIDATES.find((t) => !existsSync(join(dataDir, 'bars', 'BINANCE', t))) ?? CANDIDATES[0];
    const cold = !existsSync(join(dataDir, 'bars', 'BINANCE', stamp));
    console.log(
        `first-visit symbol: ${stamp} (${cold ? 'not cached — fetched from the venue' : 'already cached on disk; clear data/bars to re-measure cold'})`,
    );
    const uncached = await switchTo(`BINANCE:${stamp}`, '15');
    const back = await switchTo('BINANCE:BTCUSDT', '60');
    const cached = await switchTo(`BINANCE:${stamp}`, '15');
    const tfSwitch = await switchTo(`BINANCE:${stamp}`, '5');
    await switchTo('BINANCE:BTCUSDT', '1');

    await page.waitForTimeout(seconds * 1000);
    const perf: any = await page.evaluate(() => (window as any).__ts.client.perf());

    const rows: [string, number, number][] = [
        ['App cold start to interactive chart (ms)', coldStart, 1500],
        ['Symbol switch, first visit (ms)', uncached, 400],
        ['Symbol switch, revisited (ms)', cached, 100],
        ['Symbol switch back to first chart (ms)', back, 100],
        ['Timeframe switch, first visit (ms)', tfSwitch, 400],
        ['Live update: server send → page, p95 (ms)', perf.transitP95, 30],
        ['Live update: server send → painted frame, p95 (ms)', perf.pixelP95, 30],
    ];
    console.log(`live samples: ${perf.samples} over ${seconds}s, round trip ${perf.rttMs?.toFixed(2)} ms\n`);
    console.log('metric'.padEnd(54), 'measured'.padStart(9), 'budget'.padStart(8));
    for (const [name, value, budget] of rows) {
        const ok = value <= budget * 1.1;
        if (!ok) failed = true;
        console.log(
            name.padEnd(54),
            value.toFixed(0).padStart(9),
            String(budget).padStart(8),
            ok ? ' ok' : ' OVER BUDGET',
        );
    }
    if (errors.length) console.log(`\npage errors:\n${errors.join('\n')}`);
} finally {
    await browser.close();
}
if (failed) process.exitCode = 1;
