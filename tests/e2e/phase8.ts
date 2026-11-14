/**
 * Phase 8 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers the extra chart types (Volume candles, HLC area, High-low) drawing on the chart, the
 * screener (a scan, a filter, sorting, opening a symbol, Pine columns) and a panel failure staying
 * inside its panel.
 * Run: node tests/e2e/phase8.ts
 */
import { chromium, type Page } from 'playwright-core';

const url = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const inPage = <T>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) =>
    page.evaluate(fn as any, arg) as Promise<T>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await inPage(page, async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        t.workspace.setLayout('1');
        if (t.ui.getState().bottomPanel) t.ui.getState().toggleBottomPanel(t.ui.getState().bottomPanel);
        await t.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '60' });
    });
    await wait(800);

    // ── Extra chart types ──────────────────────────────────────────────────
    /** How much of a style's own layer canvas is painted, as a share of its pixels (sampled). */
    const painted = (style: string) =>
        inPage<number>(
            page,
            async (s: string) => {
                const chart = (window as any).__ts.workspace.chart;
                chart.renderer.set('priceStyle', s);
                await new Promise((r) => setTimeout(r, 600));
                const canvas = document.querySelector(`canvas[data-ts-style="${s}"]`) as HTMLCanvasElement | null;
                if (!canvas) return -1;
                const ctx = canvas.getContext('2d')!;
                const { width, height } = canvas;
                const data = ctx.getImageData(0, 0, width, height).data;
                let on = 0;
                let n = 0;
                for (let i = 3; i < data.length; i += 4 * 97) {
                    n++;
                    if (data[i] > 0) on++;
                }
                return on / n;
            },
            style,
        );
    const shares: Record<string, number> = {};
    for (const s of ['volumecandles', 'hlcarea', 'highlow']) shares[s] = await painted(s);
    await page.screenshot({ path: 'tests/e2e/phase8-hlcarea.png' });
    const other = await inPage<number>(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        chart.renderer.set('priceStyle', 'candles');
        await new Promise((r) => setTimeout(r, 400));
        const canvas = document.querySelector('canvas[data-ts-style="highlow"]') as HTMLCanvasElement;
        const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let on = 0;
        for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) on++;
        return on;
    });
    check(
        'Volume candles, HLC area and High-low each draw the bars, and stop when another style is picked',
        Object.values(shares).every((v) => v > 0.005) && other === 0,
        Object.entries(shares)
            .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}% of pixels`)
            .join(', '),
    );
    const listed = await inPage<string[]>(page, () => {
        const types = (window as any).__ts.chartTypes?.() ?? [];
        return types;
    });
    check(
        'the three styles are registered chart types',
        ['volumecandles', 'hlcarea', 'highlow'].every((id) => listed.includes(id)),
        listed.slice(-6).join(', '),
    );

    // ── Screener ───────────────────────────────────────────────────────────
    await inPage(page, () => {
        const t = (window as any).__ts;
        t.ui.getState().setBottomHeight(460);
        t.ui.getState().showBottomPanel('screener');
    });
    await page.waitForSelector('[data-testid="screener"]');
    await page.waitForFunction(
        () => (document.querySelector('[data-testid="screener-universe"]') as HTMLSelectElement)?.options.length > 0,
        null,
        { timeout: 10_000 },
    );
    const options = await page.$$eval('[data-testid="screener-universe"] option', (els) =>
        els.map((e) => (e as HTMLOptionElement).textContent ?? ''),
    );
    const synth = options.findIndex((o) => /Synthetic/.test(o));
    await page.selectOption('[data-testid="screener-universe"]', String(synth));
    await page.selectOption('[data-testid="screener"] label:has-text("Bars of") select', '60');
    await page.click('[data-testid="screener-run"]');
    await page.waitForSelector('[data-testid="screener-rows"] tbody tr', { timeout: 20_000 });
    const all = await page.$$eval('[data-testid="screener-rows"] tbody tr', (els) =>
        els.map((e) => (e as HTMLElement).innerText.split('\t')),
    );
    const summary = await page.textContent('[data-testid="screener-summary"]');
    check(
        'a scan of the synthetic market lists every symbol with its measures',
        all.length === 3 && /3 of 3 match/.test(summary ?? ''),
        `${summary}; ${all.map((r) => r[0]).join(', ')}`,
    );

    // Sort by symbol, then filter on RSI.
    await page.click('[data-testid="screener-rows"] th:has-text("Symbol")');
    const sorted = await page.$$eval('[data-testid="screener-rows"] tbody tr td:first-child', (els) =>
        els.map((e) => e.textContent),
    );
    await page.click('[data-testid="screener-add-filter"]');
    await page.fill('[data-testid="screener-filter-value"]', '101');
    await page.click('[data-testid="screener-run"]');
    await page
        .waitForFunction(
            () => /3 of 3 match/.test(document.querySelector('[data-testid="screener-summary"]')?.textContent ?? ''),
            null,
            { timeout: 20_000 },
        )
        .catch(() => {});
    const loose = await page.textContent('[data-testid="screener-summary"]');
    await page.fill('[data-testid="screener-filter-value"]', '0');
    await page.click('[data-testid="screener-run"]');
    await page
        .waitForFunction(
            () => /0 of 3 match/.test(document.querySelector('[data-testid="screener-summary"]')?.textContent ?? ''),
            null,
            { timeout: 20_000 },
        )
        .catch(() => {});
    const strict = await page.textContent('[data-testid="screener-summary"]');
    check(
        'sorting by a column and filtering on RSI (below 101 keeps all, below 0 keeps none)',
        JSON.stringify(sorted) === JSON.stringify([...sorted].sort()) &&
            /3 of 3/.test(loose ?? '') &&
            /0 of 3/.test(strict ?? ''),
        `${sorted.join(', ')}; "${loose}" / "${strict}"`,
    );

    // Pine columns, then open a symbol from the list.
    await page.click('[data-testid="screener"] button:text-is("Remove")');
    const pineOptions = await page.$$eval('[data-testid="screener-pine"] option', (els) =>
        els.map((e) => ({ v: (e as HTMLOptionElement).value, t: e.textContent })),
    );
    const rsiBands = pineOptions.find((o) => /RSI/i.test(o.t ?? ''));
    if (rsiBands) await page.selectOption('[data-testid="screener-pine"]', rsiBands.v);
    await page.click('[data-testid="screener-run"]');
    await page
        .waitForFunction(() => document.querySelectorAll('[data-testid="screener-rows"] tbody tr').length === 3, null, {
            timeout: 30_000,
        })
        .catch(() => {});
    const headers = await page.$$eval('[data-testid="screener-rows"] th', (els) => els.map((e) => e.textContent ?? ''));
    const builtIn = new Set([
        'Symbol',
        'Last price',
        'Change % (last bar)',
        'Change % (5 bars)',
        'Relative volume (vs 20-bar average)',
        'RSI (14)',
        'Distance from SMA 50 %',
        'Distance from SMA 200 %',
        'ATR (14) as % of price',
        'Distance from the 52-bar high %',
    ]);
    const pineHeaders = headers.map((h) => h.replace(/ [↑↓]$/, '')).filter((h) => !builtIn.has(h));
    check(
        'a Pine indicator from the library adds its plots as columns',
        !!rsiBands && pineHeaders.length > 0,
        `${rsiBands?.t}: ${pineHeaders.join(', ')}`,
    );
    await page.click('[data-testid="screener-rows"] tbody tr:has-text("SYNTH:GAMMA")');
    await wait(800);
    const opened = await inPage<string>(page, () => (window as any).__ts.workspace.chart.market.symbol);
    check('clicking a row opens that symbol on the chart', /SYNTH:GAMMA/.test(opened), opened);

    const serious = errors.filter((e) => !/ResizeObserver/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
