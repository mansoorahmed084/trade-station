/**
 * Phase 3 end-to-end check in headless Chrome against the running app (server :8787, web :5173).
 * Covers the Pine editor, the script library, the import flow with its compatibility report,
 * indicator sets, and the phase's exit criteria:
 *   - scripts render, and the chart's engine, the server's engine and the native library agree
 *   - 25 indicators on one live chart stay within the frame budget
 * Run: node tests/e2e/phase3.ts
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
const post = (path: string, body: unknown) =>
    fetch(api(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => r.json());

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

const created: string[] = [];
try {
    const page = await (
        await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    ).newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as any).__ts?.workspace, null, { timeout: 20_000 });
    await inPage(page, async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        t.workspace.setLayout('1');
        const chart = t.workspace.chart;
        await chart.setMarket({ symbol: 'SYNTH:GAMMA', timeframe: '15' });
        for (const h of chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        if (t.ui.getState().bottomPanel !== 'editor') t.ui.getState().toggleBottomPanel('editor');
    });

    // ── Editor and library ─────────────────────────────────────────────────
    await page.waitForSelector('[data-testid="script-panel"] .script-item', { timeout: 15_000 });
    await page.waitForSelector('[data-testid="pine-editor"] .monaco-editor', { timeout: 30_000 });
    const names = await page.$$eval('.script-item .script-name', (els) => els.map((e) => e.textContent));
    check(
        'the library lists the example scripts',
        names.length >= 7 && names.includes('EMA Ribbon'),
        `${names.length} scripts`,
    );

    const tokens = await inPage(page, async () => {
        const monaco = (window as any).__tsMonaco;
        const html: string = await monaco.editor.colorize(
            '//@version=6\nlen = input.int(20)\nplot(ta.ema(close, len), color=color.red)',
            'pine',
            {},
        );
        const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].map((m) => m[1]));
        const builtins = await (await fetch('/api/scripts/builtins')).json();
        return {
            classes: classes.size,
            ta: builtins.ta.length,
            hasEma: builtins.ta.includes('ema'),
            hasCtor: builtins.ta.includes('constructor'),
        };
    });
    check(
        'Pine is syntax-coloured and completion knows the runtime built-ins',
        tokens.classes >= 5 && tokens.hasEma && !tokens.hasCtor,
        `${tokens.classes} token colours, ${tokens.ta} ta.* functions`,
    );

    await page.click('.script-item:has-text("EMA Ribbon")');
    await page.waitForFunction(() => (window as any).__tsEditor?.getValue().includes('EMA Ribbon'));
    await page.click('text=Add to chart');
    await page.waitForFunction(
        () => (window as any).__ts.workspace.chart.indicators().some((h: any) => h.id === 'lib:example-ema-ribbon'),
        null,
        { timeout: 15_000 },
    );
    await page.waitForSelector('text=Update on chart');
    check('a library script is added to the chart from the editor', true);

    // Edit: break it, and the chart must keep the working version.
    const original = await inPage(page, () => (window as any).__tsEditor.getValue());
    await inPage(
        page,
        (src: string) => (window as any).__tsEditor.setValue(src.replace('ta.ema(src, base)', 'ta.ema(src, base')),
        original,
    );
    await page.click('text=Update on chart');
    await page.waitForSelector('[data-testid="script-output"] .out-error', { timeout: 15_000 });
    const broken = await inPage(page, () => ({
        still: (window as any).__ts.workspace.chart.indicators().some((h: any) => h.id === 'lib:example-ema-ribbon'),
        markers: (window as any).__tsMonaco.editor.getModelMarkers({}).length,
        text: (document.querySelector('[data-testid="script-output"]') as HTMLElement).innerText,
    }));
    check(
        'a broken edit is reported with its line and the chart keeps the previous version',
        broken.still && broken.markers >= 1 && /previous version/.test(broken.text),
        broken.text.replace(/\s+/g, ' ').slice(0, 140),
    );

    // A working edit replaces the code in place.
    await inPage(
        page,
        (src: string) =>
            (window as any).__tsEditor.setValue(
                src.replace('input.int(8, "Fastest length"', 'input.int(5, "Fastest length"'),
            ),
        original,
    );
    await page.click('text=Update on chart');
    await page.waitForSelector('[data-testid="script-output"] .out-ok:has-text("Updated")', { timeout: 15_000 });
    const updated = await inPage(page, () => {
        const h = (window as any).__ts.workspace.chart.indicators().find((x: any) => x.id === 'lib:example-ema-ribbon');
        return {
            source: h.source.includes('input.int(5,'),
            defval: h.inputs.find((i: any) => /Fastest/.test(i.title))?.defval,
        };
    });
    check(
        'a working edit updates the indicator in place',
        updated.source && updated.defval === 5,
        `Fastest length default is now ${updated.defval}`,
    );

    // Compatibility check from the editor.
    await inPage(
        page,
        (src: string) =>
            (window as any).__tsEditor.setValue(
                `${src}\nextra = ta.nope(close, 3) + request.financial(syminfo.tickerid, "EPS", "FQ")\n`,
            ),
        original,
    );
    await page.click('text=Check compatibility');
    await page.waitForSelector('[data-testid="compat-report"]', { timeout: 15_000 });
    const reportText = await page.$eval('[data-testid="compat-report"]', (e) =>
        (e as HTMLElement).innerText.replace(/\s+/g, ' '),
    );
    check(
        'the compatibility check names the missing built-in',
        /Not available: ta\.nope/.test(reportText),
        reportText.slice(0, 150),
    );

    // Saving an example makes a copy rather than overwriting it.
    await inPage(page, (src: string) => (window as any).__tsEditor.setValue(`${src}\n// edited`), original);
    await page.click('.script-bar button:text-is("Save")');
    await page.waitForSelector('.script-item:has-text("EMA Ribbon (copy)")', { timeout: 10_000 });
    const lib = (await (await fetch(api('/api/scripts'))).json()) as any[];
    const copy = lib.find((s) => s.name === 'EMA Ribbon (copy)');
    if (copy) created.push(copy.id);
    const example = await (await fetch(api('/api/scripts/example-ema-ribbon'))).json();
    check(
        'saving an example creates a copy and leaves the example untouched',
        !!copy && !copy.builtin && !example.source.includes('// edited'),
    );
    const moved = await inPage(
        page,
        (id: string) =>
            (window as any).__ts.workspace.chart
                .indicators()
                .map((h: any) => h.id)
                .filter((x: string) => x.startsWith('lib:')),
        copy?.id,
    );
    check(
        'the chart indicator follows the saved copy',
        moved.length === 1 && moved[0] === `lib:${copy?.id}`,
        moved.join(', '),
    );
    await page.click('text=Remove from chart');

    // ── Import flow ────────────────────────────────────────────────────────
    await page.click('text=Import…');
    await page.fill(
        '[aria-label="Script source"]',
        '//@version=5\nindicator("Imported Donchian", overlay=true)\nlen = input.int(20, "Length")\nplot(ta.highest(high, len), "Upper")\nplot(ta.lowest(low, len), "Lower")\n',
    );
    await page.fill('input[placeholder="e.g. LuxAlgo"]', 'A. Author');
    await page.fill('input[placeholder="e.g. CC BY-NC-SA 4.0"]', 'CC BY-NC-SA 4.0');
    await page.fill('input[placeholder="https://…"]', 'https://example.com/donchian');
    await page.click('.modal >> text=Check compatibility');
    await page.waitForSelector('.modal [data-testid="compat-report"] .out-ok', { timeout: 15_000 });
    await page.click('text=Save to library');
    await page.waitForSelector('.script-item:has-text("Imported Donchian")', { timeout: 10_000 });
    await page.waitForSelector('.script-attribution:has-text("A. Author")');
    const attribution = await page.$eval('.script-attribution', (e) =>
        (e as HTMLElement).innerText.replace(/\s+/g, ' '),
    );
    const imported = ((await (await fetch(api('/api/scripts'))).json()) as any[]).find(
        (s) => s.name === 'Imported Donchian',
    );
    if (imported) created.push(imported.id);
    check(
        'an imported script is checked, saved and shown with its attribution',
        /A\. Author/.test(attribution) &&
            /CC BY-NC-SA 4\.0/.test(attribution) &&
            imported?.origin === 'https://example.com/donchian',
        attribution,
    );

    // ── Every example renders on the chart ─────────────────────────────────
    const rendered = await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        const list = await (await fetch('/api/scripts')).json();
        const out: { name: string; ok: boolean; error?: string; strategy?: boolean }[] = [];
        for (const meta of list.filter((s: any) => s.builtin)) {
            const script = await (await fetch(`/api/scripts/${meta.id}`)).json();
            const result = await chart.runScript(script.source);
            out.push({
                name: meta.name,
                ok: result.ok,
                error: result.error?.message?.split('\n')[0],
                strategy: !!result.run?.strategy,
            });
            if (result.ok) result.remove();
        }
        return out;
    });
    check(
        'every example script runs on the chart engine',
        rendered.length >= 7 && rendered.every((r) => r.ok),
        rendered.map((r) => `${r.name}${r.ok ? '' : ` FAILED (${r.error})`}`).join('; '),
    );
    check('strategies report results on the chart', rendered.filter((r) => r.strategy).length === 2);

    // ── Golden values: chart engine = server engine (= native library, by the unit tests) ──
    const source =
        '//@version=6\nindicator("Golden")\nplot(ta.ema(close, 21), "EMA")\nplot(ta.rsi(close, 14), "RSI")\n[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(h, "HIST")\nplot(ta.atr(14), "ATR")';
    const chartSide = await inPage(
        page,
        async (src: string) => {
            const chart = (window as any).__ts.workspace.chart;
            await chart.setMarket({ symbol: 'SYNTH:GAMMA', timeframe: '15', bars: 1500 });
            await chart.historyComplete();
            const result = await chart.runScript(src);
            if (!result.ok) return { error: result.error?.message };
            const read = async (name: string) => {
                const raw: any = await result.run.series(name);
                const rows: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.values ?? []);
                return rows.map((r) => (typeof r === 'number' ? { value: r } : r));
            };
            const out = {
                EMA: await read('EMA'),
                RSI: await read('RSI'),
                HIST: await read('HIST'),
                ATR: await read('ATR'),
            };
            result.remove();
            return out;
        },
        source,
    );
    const serverSide = await post('/api/scripts/run', { source, symbol: 'SYNTH:GAMMA', timeframe: '15', bars: 1500 });
    let worst = 0;
    let compared = 0;
    let goldenDetail = '';
    if ('error' in chartSide) goldenDetail = `chart run failed: ${chartSide.error}`;
    else {
        for (const name of ['EMA', 'RSI', 'HIST', 'ATR'] as const) {
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
                const isLast =
                    row.time !== undefined
                        ? row.time === serverSide.times[serverSide.times.length - 1]
                        : i === rows.length - 1;
                if (
                    isLast ||
                    want === undefined ||
                    want === null ||
                    row.value === null ||
                    row.value === undefined ||
                    Number.isNaN(row.value)
                )
                    return;
                compared++;
                worst = Math.max(worst, Math.abs(row.value - want) / Math.max(1, Math.abs(want)));
            });
        }
        goldenDetail = `${compared} values compared across EMA, RSI, MACD histogram and ATR; largest scaled difference ${worst.toExponential(1)}`;
    }
    check(
        'the chart engine and the server engine compute identical values',
        compared > 4000 && worst < 1e-8,
        goldenDetail,
    );

    // ── Indicator on indicator ─────────────────────────────────────────────
    await inPage(page, () => {
        const t = (window as any).__ts;
        if (t.ui.getState().bottomPanel !== 'editor') t.ui.getState().toggleBottomPanel('editor');
    });
    await page.click('.script-item:has-text("RSI with Bands and Alerts")');
    await page.waitForFunction(() => (window as any).__tsEditor?.getValue().includes('RSI with Bands'));
    await page.click('text=Study on plot…');
    await page.selectOption('[aria-label="Study"]', 'ema');
    await page.fill('[aria-label="Length"]', '9');
    const plotOptions = await page.$$eval('[aria-label="Plot"] option', (els) => els.map((e) => e.textContent));
    await page.click('.modal >> text=Add to chart');
    await page
        .waitForFunction(
            () =>
                (window as any).__ts.workspace.chart
                    .indicators()
                    .some((h: any) => /EMA 9 of RSI with Bands and Alerts: RSI/.test(h.title)),
            null,
            { timeout: 15_000 },
        )
        .catch(async () => {
            const shown = await page
                .$eval('.modal', (e) => (e as HTMLElement).innerText)
                .catch(() => '(dialog closed)');
            const titles = await inPage(page, () =>
                (window as any).__ts.workspace.chart.indicators().map((h: any) => h.title),
            );
            console.log(
                `   study-on-plot did not appear. Dialog: ${shown.replace(/\s+/g, ' ').slice(-200)} | indicators: ${titles.join(', ')}`,
            );
        });
    const ioi = await inPage(page, () => {
        const chart = (window as any).__ts.workspace.chart;
        const h = chart.indicators().find((x: any) => /EMA 9 of/.test(x.title));
        const title = h?.title ?? '';
        h?.remove();
        return title;
    });
    check(
        'a study is applied to another indicator’s plot',
        /^EMA 9 of RSI with Bands and Alerts: RSI$/.test(ioi) && plotOptions.length === 2,
        `${ioi} (plots offered: ${plotOptions.map((o) => o?.split(' — ')[0]).join(', ')})`,
    );

    // ── Indicator sets ─────────────────────────────────────────────────────
    const setResult = await inPage(page, async () => {
        const t = (window as any).__ts;
        const chart = t.workspace.chart;
        chart.addNativeIndicator('rsi');
        chart.addNativeIndicator('macd');
        const r = await chart.runIndicator(
            '//@version=6\nindicator("Set member", overlay=true)\nplot(ta.sma(close, 50))',
        );
        await new Promise((res) => setTimeout(res, 800));
        return { ok: r.ok, count: chart.indicators().length };
    });
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    await page.click('text=Indicator sets');
    await page.fill('[aria-label="Name"]', 'e2e set');
    await page.click('text=Save current');
    await page.waitForSelector('.list-row:has-text("e2e set")');
    await page.keyboard.press('Escape');
    await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        for (const h of chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        await new Promise((res) => setTimeout(res, 300));
    });
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    await page.click('text=Indicator sets');
    await page.click('.list-row:has-text("e2e set") >> text=Load');
    await page
        .waitForFunction((n) => (window as any).__ts.workspace.chart.indicators().length === n, setResult.count, {
            timeout: 15_000,
        })
        .catch(() => {});
    const restored = await inPage(page, () =>
        (window as any).__ts.workspace.chart.indicators().map((h: any) => h.nativeType ?? h.title),
    );
    check(
        'an indicator set saves and re-applies',
        setResult.ok && restored.length === setResult.count,
        restored.join(', '),
    );
    await inPage(page, () => (window as any).__ts.ui.getState().setDialog('layouts'));
    await page.click('text=Indicator sets');
    page.once('dialog', (d) => void d.accept());
    await page.click('.list-row:has-text("e2e set") >> text=Delete');
    await page.keyboard.press('Escape');

    // ── 25 indicators on one live chart ────────────────────────────────────
    const load = await inPage(page, async () => {
        const t = (window as any).__ts;
        const chart = t.workspace.chart;
        if (t.ui.getState().bottomPanel) t.ui.getState().toggleBottomPanel('editor');
        await chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '1', bars: 5000 });
        await chart.historyComplete();
        for (const h of chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        const catalog = await chart.availableNativeIndicators();
        const types: string[] = catalog
            .map((x: any) => x.type ?? x.id)
            .filter((x: string) => x && x !== 'volume' && x !== 'vpvr');
        for (let i = 0; i < 15; i++) chart.addNativeIndicator(types[i % types.length]);
        const scripts = [
            'plot(ta.ema(close, 9))',
            'plot(ta.ema(close, 21))',
            'plot(ta.sma(close, 50))',
            'plot(ta.wma(close, 30))',
            'plot(ta.vwma(close, 20))',
            '[a, b, c] = ta.bb(close, 20, 2.0)\nplot(b)\nplot(c)',
            '[s, d] = ta.supertrend(3.0, 10)\nplot(s)',
            'plot(ta.highest(high, 55))\nplot(ta.lowest(low, 55))',
            'plot(ta.linreg(close, 40, 0))',
            'plot(ta.hma(close, 34))',
        ];
        let failed = 0;
        for (const [i, body] of scripts.entries()) {
            const r = await chart.runIndicator(`//@version=6\nindicator("Load ${i}", overlay=true)\n${body}`);
            if (!r.ok) failed++;
        }
        await new Promise((r) => setTimeout(r, 2500));
        let runs = 0;
        let ticks = 0;
        const offRun = chart.on('script:run', () => runs++);
        const offBar = chart.on('bar', () => ticks++);
        const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
        const measure = async (frames: number, step: (i: number) => void) => {
            const deltas: number[] = [];
            let prev = await raf();
            for (let i = 0; i < frames; i++) {
                step(i);
                const now = await raf();
                deltas.push(now - prev);
                prev = now;
            }
            const sorted = [...deltas].sort((a, b) => a - b);
            return {
                p50: sorted[Math.floor(frames / 2)],
                p95: sorted[Math.floor(frames * 0.95)],
                max: sorted[frames - 1],
                dropped: deltas.filter((d) => d > 25).length,
            };
        };
        // live only: ticks arrive every 250 ms and every indicator recomputes
        const live = await measure(360, () => {});
        // live and panning at once
        const panning = await measure(240, (i) => chart.panBy(Math.sin((i / 240) * Math.PI * 4) > 0 ? -0.02 : 0.02));
        offRun();
        offBar();
        const count = chart.indicators().length;
        for (const h of chart.indicators()) if (h.nativeType !== 'volume') h.remove();
        return { count, failed, runs, ticks, live, panning };
    });
    check(
        '25 indicators on a live chart stay within the frame budget',
        load.count >= 25 &&
            load.failed === 0 &&
            load.ticks > 10 &&
            load.live.p95 <= 17.5 &&
            load.panning.p95 <= 17.5 &&
            load.live.dropped + load.panning.dropped <= 3,
        `${load.count} indicators (15 native, 10 Pine), ${load.ticks} live ticks, ${load.runs} script recomputes; frames live p95 ${load.live.p95.toFixed(1)} ms max ${load.live.max.toFixed(1)} ms; while panning p95 ${load.panning.p95.toFixed(1)} ms max ${load.panning.max.toFixed(1)} ms; ${load.live.dropped + load.panning.dropped} frames over 25 ms`,
    );

    await inPage(page, async () => {
        const chart = (window as any).__ts.workspace.chart;
        await chart.setMarket({ symbol: 'BINANCE:BTCUSDT', timeframe: '60', bars: 5000 });
        await new Promise((r) => setTimeout(r, 1200));
    });
    const serious = errors.filter((e) => !/ResizeObserver|WebSocket connection/.test(e));
    check('no page errors', serious.length === 0, serious.slice(0, 3).join(' | '));
} finally {
    for (const id of created) await fetch(api(`/api/scripts/${id}`), { method: 'DELETE' }).catch(() => {});
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
