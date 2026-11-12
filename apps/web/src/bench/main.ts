/**
 * Phase 0 chart-engine benchmark: Vela vs Lightweight Charts v5 against the plan's frame budgets.
 * Open /bench.html and call `await window.runBench()`; results are returned and printed as JSON.
 */
import { Vela } from '@luxalgo/vela';
import { CandlestickSeries, createChart, LineSeries } from 'lightweight-charts';

interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface CaseResult {
    engine: string;
    bars: number;
    charts: number;
    indicators: number;
    loadMs: number;
    frames: number;
    p50: number;
    p95: number;
    max: number;
    over16: number;
    over33: number;
    note?: string;
}

const MIN = 60_000;
const VISIBLE = 300;

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function genBars(n: number, seed: number): Bar[] {
    const rnd = rng(seed);
    const out: Bar[] = new Array(n);
    let price = 30_000;
    const start = Date.UTC(2020, 0, 1);
    for (let i = 0; i < n; i++) {
        const open = price;
        const close = open * (1 + (rnd() - 0.5) * 0.004);
        const high = Math.max(open, close) * (1 + rnd() * 0.001);
        const low = Math.min(open, close) * (1 - rnd() * 0.001);
        out[i] = { time: start + i * MIN, open, high, low, close, volume: 10 + rnd() * 90 };
        price = close;
    }
    return out;
}

function sma(bars: Bar[], len: number): { time: number; value: number }[] {
    const out: { time: number; value: number }[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
        sum += bars[i].close;
        if (i >= len) sum -= bars[i - len].close;
        if (i >= len - 1) out.push({ time: bars[i].time / 1000, value: sum / len });
    }
    return out;
}

const raf = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** Drive `step` once per animation frame and record the frame-to-frame intervals. */
async function measure(frames: number, step: (i: number) => void): Promise<number[]> {
    const deltas: number[] = [];
    let prev = await raf();
    for (let i = 0; i < frames; i++) {
        step(i);
        const now = await raf();
        deltas.push(now - prev);
        prev = now;
    }
    return deltas;
}

function stats(deltas: number[]) {
    const sorted = [...deltas].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
        frames: deltas.length,
        p50: +q(0.5).toFixed(2),
        p95: +q(0.95).toFixed(2),
        max: +sorted[sorted.length - 1].toFixed(2),
        over16: deltas.filter((d) => d > 17.5).length,
        over33: deltas.filter((d) => d > 34).length,
    };
}

function stage(cells: number): HTMLElement[] {
    const root = document.getElementById('stage')!;
    root.innerHTML = '';
    const cols = cells <= 1 ? 1 : cells <= 4 ? 2 : 4;
    root.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    root.style.gridTemplateRows = `repeat(${Math.ceil(cells / cols)}, 1fr)`;
    return Array.from({ length: cells }, () => root.appendChild(document.createElement('div')));
}

const status = (text: string) => {
    document.getElementById('status')!.textContent = text;
};

/** Pan back and forth across history, then zoom in and out, one change per frame. */
function panPlan(total: number, frames: number) {
    return (i: number) => {
        const phase = i / frames;
        const span = phase < 0.7 ? VISIBLE : Math.round(VISIBLE * (1 + 6 * Math.sin(((phase - 0.7) / 0.3) * Math.PI)));
        const travel = total - span - 1;
        const pos = Math.round((0.5 - 0.5 * Math.cos(phase * Math.PI * 4)) * travel);
        return { from: travel - pos, to: travel - pos + span };
    };
}

async function benchVela(n: number, charts: number, indicators: number, frames: number): Promise<CaseResult> {
    status(`vela: ${n} bars × ${charts} charts, ${indicators} indicators`);
    const els = stage(charts);
    const t0 = performance.now();
    const instances: any[] = [];
    const data = Array.from({ length: charts }, (_, c) => genBars(n, 100 + c));
    for (let c = 0; c < charts; c++) {
        instances.push(new Vela(els[c], { data: data[c], timeframe: '1', theme: 'dark', drawings: false } as any));
    }
    await Promise.all(instances.map((ch) => ch.ready()));
    let added = 0;
    let note: string | undefined;
    if (indicators > 0) {
        const catalog = await instances[0].availableNativeIndicators();
        const types: string[] = catalog
            .map((x: any) => x.type ?? x.id)
            .filter((t: string) => t && t !== 'volume' && t !== 'vpvr');
        for (const ch of instances) {
            const handles = [];
            for (let k = 0; k < indicators; k++) handles.push(ch.addNativeIndicator(types[k % types.length]));
            await Promise.all(
                handles.map(
                    (h: any) =>
                        new Promise<void>((resolve) => {
                            h.on('ready', () => resolve());
                            h.on('error', () => resolve());
                            setTimeout(resolve, 4000);
                        }),
                ),
            );
            added = ch.indicators().length;
        }
        note = `indicator types: ${types.slice(0, indicators).join(',')}`;
    }
    const loadMs = performance.now() - t0;
    await raf();
    await raf();
    const plan = panPlan(n, frames);
    const deltas = await measure(frames, (i) => {
        const { from, to } = plan(i);
        for (let c = 0; c < charts; c++) {
            instances[c].setVisibleRange({ from: data[c][from].time, to: data[c][Math.min(n - 1, to)].time });
        }
    });
    const renderer = instances[0].renderer?.get?.('backend') ?? instances[0].renderer?.name;
    for (const ch of instances) ch.destroy();
    return {
        engine: `vela (${renderer})`,
        bars: n,
        charts,
        indicators: added || indicators,
        loadMs: +loadMs.toFixed(0),
        ...stats(deltas),
        note,
    };
}

async function benchLwc(n: number, charts: number, indicators: number, frames: number): Promise<CaseResult> {
    status(`lightweight-charts: ${n} bars × ${charts} charts, ${indicators} indicators`);
    const els = stage(charts);
    const t0 = performance.now();
    const instances: any[] = [];
    for (let c = 0; c < charts; c++) {
        const bars = genBars(n, 100 + c);
        const chart = createChart(els[c], {
            autoSize: true,
            layout: { background: { color: '#0e1116' }, textColor: '#c9d1d9' },
            grid: { vertLines: { color: '#1c2128' }, horzLines: { color: '#1c2128' } },
        });
        const series = chart.addSeries(CandlestickSeries);
        series.setData(
            bars.map((b) => ({ time: (b.time / 1000) as any, open: b.open, high: b.high, low: b.low, close: b.close })),
        );
        for (let k = 0; k < indicators; k++) {
            const line = chart.addSeries(LineSeries, {
                lineWidth: 1,
                color: `hsl(${k * 36},70%,60%)`,
                priceLineVisible: false,
                lastValueVisible: false,
            });
            line.setData(sma(bars, 10 + k * 10) as any);
        }
        instances.push(chart);
    }
    const loadMs = performance.now() - t0;
    await raf();
    await raf();
    const plan = panPlan(n, frames);
    const deltas = await measure(frames, (i) => {
        const { from, to } = plan(i);
        for (const chart of instances) chart.timeScale().setVisibleLogicalRange({ from, to });
    });
    for (const chart of instances) chart.remove();
    return {
        engine: 'lightweight-charts v5 (canvas2d)',
        bars: n,
        charts,
        indicators,
        loadMs: +loadMs.toFixed(0),
        ...stats(deltas),
    };
}

async function runBench(opts: { frames?: number; quick?: boolean } = {}) {
    const frames = opts.frames ?? 240;
    const cases: [number, number, number][] = opts.quick
        ? [[20_000, 1, 10]]
        : [
              [20_000, 1, 0],
              [20_000, 1, 10],
              [200_000, 1, 10],
              [20_000, 8, 2],
          ];
    const results: CaseResult[] = [];
    const baseline = stats(await measure(60, () => {}));
    for (const [n, charts, indicators] of cases) {
        for (const fn of [benchVela, benchLwc]) {
            try {
                results.push(await fn(n, charts, indicators, frames));
            } catch (err: any) {
                results.push({
                    engine: fn.name,
                    bars: n,
                    charts,
                    indicators,
                    loadMs: -1,
                    frames: 0,
                    p50: -1,
                    p95: -1,
                    max: -1,
                    over16: -1,
                    over33: -1,
                    note: `FAILED: ${err?.message ?? err}`,
                });
            }
        }
    }
    const out = {
        visible: document.visibilityState,
        dpr: devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        baselineFrame: baseline,
        results,
    };
    status('done');
    (window as any).benchResults = out;
    console.log(JSON.stringify(out, null, 1));
    return out;
}

(window as any).runBench = runBench;
if (new URLSearchParams(location.search).has('auto')) void runBench();
