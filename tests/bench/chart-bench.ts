/**
 * Runs the in-browser chart benchmark (apps/web/bench.html) in headless Chrome and prints the results.
 * Needs the web dev server on :5173 and a locally installed Chrome.
 * Run: node tests/bench/chart-bench.ts [frames]
 */
import { chromium } from 'playwright-core';

const frames = Number(process.argv[2] ?? 180);
const url = process.env.BENCH_URL ?? 'http://127.0.0.1:5173/bench.html';

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
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
    page.on('pageerror', (err) => console.error('[page error]', err.message));
    await page.goto(url, { waitUntil: 'load' });
    const gpu = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return 'no webgl2';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    const out: any = await page.evaluate((f) => (window as any).runBench({ frames: f }), frames);
    console.log(`GPU: ${gpu}`);
    console.log(`viewport ${out.viewport.join('x')} @${out.dpr}x, idle frame p50 ${out.baselineFrame.p50} ms\n`);
    console.log('engine                              bars  charts ind  load ms   p50   p95    max  >17.5ms >34ms');
    for (const r of out.results) {
        console.log(
            `${r.engine.padEnd(34)} ${String(r.bars).padStart(6)} ${String(r.charts).padStart(6)} ${String(r.indicators).padStart(4)} ${String(r.loadMs).padStart(8)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(5)} ${String(r.max).padStart(6)} ${String(r.over16).padStart(7)} ${String(r.over33).padStart(5)}${r.note?.startsWith('FAILED') ? `  ${r.note}` : ''}`,
        );
    }
} finally {
    await browser.close();
}
