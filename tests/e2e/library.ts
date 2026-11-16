/**
 * Bundled indicators check in headless Chrome: Technical Sentiment Composite and Wave & Flow Matrix
 * are in the script library, go onto a chart from the editor, draw the same values the server
 * computes, and work as screener columns.
 *
 * Unlike the phase suites this starts its own server, on a spare port with its own data folder, and
 * serves the built web app from it, so the running app and its data are not touched.
 * Needs `npm run build` first. Run: node tests/e2e/library.ts
 *   LIBRARY_DB=data/app.db  start from a copy of that library instead of an empty one, to check that
 *                           an existing library is given the indicators
 *   SHOT=/path/shot.png     save a screenshot of both indicators on the chart
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SyntheticAdapter } from '@ts/datafeed';
import { chromium, type Page } from 'playwright-core';
import { createApp } from '../../apps/server/src/app.ts';
import { INDICATORS } from '../../apps/server/src/library/index.ts';

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const inPage = <T>(page: Page, fn: (arg: any) => T | Promise<T>, arg?: unknown) =>
    page.evaluate(fn as any, arg) as Promise<T>;

const webDir = resolve('apps/web/dist');
if (!existsSync(join(webDir, 'index.html'))) throw new Error('apps/web/dist is missing: run `npm run build` first');

const dataDir = mkdtempSync(join(tmpdir(), 'ts-library-'));
let before: string[] = [];
if (process.env.LIBRARY_DB) {
    // A consistent copy of a library that may be open in a running server.
    const from = new DatabaseSync(resolve(process.env.LIBRARY_DB), { readOnly: true });
    before = from
        .prepare('SELECT id FROM scripts')
        .all()
        .map((r: any) => r.id);
    from.prepare('VACUUM INTO ?').run(join(dataDir, 'app.db'));
    from.close();
}

const app = await createApp(
    { host: '127.0.0.1', port: 0, dataDir, providers: [], webDir, notifier: {} },
    { adapters: [new SyntheticAdapter()], log: () => {} },
);
const base = await app.listen();
const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => r.json());

const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});

try {
    const page = await (
        await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    ).newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // ── The library ────────────────────────────────────────────────────────
    const library = (await (await fetch(`${base}/api/scripts`)).json()) as any[];
    const ids = library.map((s) => s.id);
    if (process.env.LIBRARY_DB) {
        check(
            'an existing library is given the two indicators, at the top, and keeps everything it had',
            INDICATORS.every((s, i) => ids[i] === s.id) && before.every((id) => ids.includes(id)),
            `${before.length} scripts before, ${ids.length} after`,
        );
    } else {
        check(
            'a new library holds the examples and the two indicators',
            INDICATORS.every((s) => ids.includes(s.id)) && ids[0] === 'example-ema-ribbon',
            `${ids.length} scripts`,
        );
    }

    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await inPage(page, async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        t.workspace.setLayout('1');
        const chart = t.workspace.chart;
        await chart.setMarket({ symbol: 'SYNTH:GAMMA', timeframe: '15', bars: 1500 });
        await chart.historyComplete();
        for (const h of chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        if (t.ui.getState().bottomPanel !== 'editor') t.ui.getState().toggleBottomPanel('editor');
    });
    await page.waitForSelector('[data-testid="script-panel"] .script-item', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="pine-editor"] .monaco-editor', { timeout: 30_000 });
    const tags = await page.$$eval('.script-item', (els) =>
        els.map((e) => [
            e.querySelector('.script-name')?.textContent ?? '',
            [...e.querySelectorAll('.tag')].map((t) => t.textContent).join(' '),
        ]),
    );
    check(
        'the editor lists both indicators as built-in',
        INDICATORS.every((s) => tags.some(([name, tag]) => name === s.name && /built-in/.test(tag))),
        tags
            .filter(([, tag]) => /built-in/.test(tag))
            .map(([name]) => name)
            .join('; '),
    );

    // ── Onto the chart from the editor ─────────────────────────────────────
    for (const script of INDICATORS) {
        await page.click(`.script-item:has-text("${script.name}")`);
        await page.waitForFunction(
            (title: string) => (window as any).__tsEditor?.getValue().includes(`indicator("${title}"`),
            script.name,
        );
        await page.click('text=Add to chart');
        const added = await page
            .waitForFunction(
                (id: string) => (window as any).__ts.workspace.chart.indicators().some((h: any) => h.id === id),
                `lib:${script.id}`,
                { timeout: 20_000 },
            )
            .then(
                () => true,
                () => false,
            );
        const output = await page.$eval('[data-testid="script-output"]', (e) => e.textContent ?? '');
        check(
            `${script.name} is added to the chart from the editor`,
            added && !(await page.$('[data-testid="script-output"] .out-error')),
            output.replace(/\s+/g, ' ').slice(0, 120),
        );
    }

    // ── The chart draws what the server computes ───────────────────────────
    const plots: Record<string, string[]> = {
        'indicator-technical-sentiment-composite': ['Sentiment', 'Momentum average', 'Trend average'],
        'indicator-wave-flow-matrix': ['Wave', 'Signal', 'Money flow', 'Confluence meter'],
    };
    for (const script of INDICATORS) {
        const names = plots[script.id];
        const chartSide = await inPage(
            page,
            async ({ source, names }: { source: string; names: string[] }) => {
                const result = await (window as any).__ts.workspace.chart.runScript(source);
                if (!result.ok) return { error: result.error?.message as string };
                const out: Record<string, { time?: number; value: number | null }[]> = {};
                for (const name of names) {
                    const raw: any = await result.run.series(name);
                    const rows: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.values ?? []);
                    out[name] = rows.map((r) => (typeof r === 'number' ? { value: r } : r));
                }
                result.remove();
                return out;
            },
            { source: script.source, names },
        );
        const serverSide = await post('/api/scripts/run', {
            source: script.source,
            symbol: 'SYNTH:GAMMA',
            timeframe: '15',
            bars: 1500,
        });
        let worst = 0;
        let compared = 0;
        let detail = '';
        if ('error' in chartSide) detail = `chart run failed: ${chartSide.error}`;
        else {
            const lastTime = serverSide.times[serverSide.times.length - 1];
            for (const name of names) {
                const rows = chartSide[name] as { time?: number; value: number | null }[];
                const byTime = new Map<number, number | null>(
                    serverSide.times.map((t: number, i: number) => [t, serverSide.plots[name][i]]),
                );
                rows.forEach((row, i) => {
                    // align by time when the chart reports it, else by position from the end; skip the forming bar
                    const want =
                        row.time !== undefined
                            ? byTime.get(row.time)
                            : serverSide.plots[name][serverSide.plots[name].length - rows.length + i];
                    const isLast = row.time !== undefined ? row.time === lastTime : i === rows.length - 1;
                    if (isLast || want === undefined || want === null) return;
                    if (row.value === null || row.value === undefined || Number.isNaN(row.value)) return;
                    compared++;
                    worst = Math.max(worst, Math.abs(row.value - want));
                });
            }
            detail = `${compared} values compared across ${names.join(', ')}; largest difference ${worst.toExponential(1)}`;
        }
        check(
            `${script.name}: the chart and the server compute the same values`,
            compared > 3000 && worst < 1e-6,
            detail,
        );
    }

    // ── As screener columns ────────────────────────────────────────────────
    for (const script of INDICATORS) {
        const column = plots[script.id][0];
        const screen = await post('/api/screener/run', {
            symbols: ['SYNTH:ALPHA', 'SYNTH:BETA', 'SYNTH:GAMMA'],
            timeframe: '60',
            pine: { scriptId: script.id },
        });
        const values = (screen.rows ?? []).map((r: any) => r.values[`pine:${column}`]);
        check(
            `${script.name} gives the screener a "${column}" column`,
            values.length === 3 && values.every((v: unknown) => typeof v === 'number' && v >= 0 && v <= 100),
            values.map((v: number) => v?.toFixed(1)).join(', '),
        );
    }

    if (process.env.SHOT) {
        await inPage(page, () => {
            const t = (window as any).__ts;
            if (t.ui.getState().bottomPanel === 'editor') t.ui.getState().toggleBottomPanel('editor');
        });
        await page.waitForTimeout(1500);
        await page.screenshot({ path: process.env.SHOT });
        console.log(`screenshot saved to ${process.env.SHOT}`);
    }

    const serious = errors.filter((e) => !/ResizeObserver|WebSocket connection/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    await browser.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
