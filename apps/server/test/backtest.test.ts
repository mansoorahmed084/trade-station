import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BacktestResult, JobStatus } from '@ts/backtest';
import { SyntheticAdapter } from '@ts/datafeed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type App, createApp } from '../src/app.ts';

let dir: string;
let app: App;
let base: string;

const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
const run = async (body: Record<string, unknown>) => {
    const res = await post('/api/backtest/run', { symbol: 'SYNTH:ALPHA', timeframe: '60', bars: 2000, ...body });
    return { status: res.status, body: (await res.json()) as BacktestResult & { error?: string } };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function finished(id: string, ms = 60_000): Promise<JobStatus> {
    const deadline = Date.now() + ms;
    for (;;) {
        const status = (await (await fetch(`${base}/api/backtest/jobs/${id}`)).json()) as JobStatus;
        if (status.state !== 'running' || Date.now() > deadline) return status;
        await wait(30);
    }
}

const NATIVE = { kind: 'native', id: 'ema-cross' };
const PINE = { kind: 'pine', scriptId: 'example-ema-cross-strategy' };

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-backtest-api-'));
    app = await createApp(
        { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'no-web'), notifier: {} },
        { adapters: [new SyntheticAdapter({ tickMs: 1000 })], log: () => {}, lingerMs: 0, workers: 3 },
    );
    base = await app.listen();
}, 30_000);

afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('strategy descriptions', () => {
    it('lists the built-in strategies with their inputs', async () => {
        const list = (await (await fetch(`${base}/api/backtest/strategies`)).json()) as any[];
        expect(list.map((s) => s.id)).toEqual(['ema-cross', 'donchian-breakout', 'rsi-reversion', 'supertrend']);
        expect(list[0].inputs[0]).toMatchObject({ name: 'fast', type: 'int', defval: 9 });
    });

    it('reads the inputs of a Pine strategy without running it', async () => {
        const d = (await (await post('/api/backtest/describe', { strategy: PINE })).json()) as any;
        expect(d).toMatchObject({ engine: 'pine', title: 'EMA Cross Strategy' });
        expect(d.inputs.map((i: any) => i.name)).toEqual([
            'Fast EMA',
            'Slow EMA',
            'ATR length',
            'Stop (ATR)',
            'Target (ATR)',
            'Trade short side',
        ]);
    });

    it('refuses an indicator, and says where a broken script fails', async () => {
        const indicator = await post('/api/backtest/describe', {
            strategy: { kind: 'pine', scriptId: 'example-ema-ribbon' },
        });
        expect(indicator.status).toBe(400);
        expect(((await indicator.json()) as any).error).toMatch(/indicator/);
        const broken = await post('/api/backtest/describe', {
            strategy: { kind: 'pine', source: '//@version=6\nstrategy("x")\nif (\n' },
        });
        expect(broken.status).toBe(422);
        expect(((await broken.json()) as any).stage).toBe('compile');
    });
});

describe('a single run', () => {
    it('runs a native strategy over closed bars and reports on it', async () => {
        const { status, body } = await run({ strategy: NATIVE });
        expect(status).toBe(200);
        expect(body.engine).toBe('native');
        expect(body.report.bars).toBe(2000);
        expect(body.report.all.trades).toBeGreaterThan(10);
        expect(body.report.equity.value.length).toBeGreaterThan(100);
        expect(body.report.finalEquity).toBeCloseTo(10_000 + body.report.netProfit, 6);
        expect(body.properties).toMatchObject({
            initialCapital: 10_000,
            qty: { type: 'percent_of_equity', value: 10 },
        });
        expect(body.inputs.find((i) => i.name === 'fast')?.value).toBe(9);
        // The forming bar is never part of a run.
        expect(body.report.to).toBeLessThan(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    });

    it('gives the same answer every time', async () => {
        const a = await run({ strategy: NATIVE, inputs: { fast: 7 } });
        const b = await run({ strategy: NATIVE, inputs: { fast: 7 } });
        expect(a.body.report.netProfit).toBe(b.body.report.netProfit);
        expect(a.body.report.trades.length).toBe(b.body.report.trades.length);
        const other = await run({ strategy: NATIVE, inputs: { fast: 4 } });
        expect(other.body.report.netProfit).not.toBe(a.body.report.netProfit);
    });

    it('runs a Pine strategy with its own settings, and with overrides', async () => {
        const own = await run({ strategy: PINE });
        expect(own.status).toBe(200);
        expect(own.body.engine).toBe('pine');
        expect(own.body.title).toBe('EMA Cross Strategy');
        expect(own.body.properties).toMatchObject({
            initialCapital: 10_000,
            commission: { type: 'percent', value: 0.1 },
            qty: { type: 'percent_of_equity', value: 10 },
        });
        expect(own.body.report.all.trades).toBeGreaterThan(10);
        expect(own.body.report.commission).toBeGreaterThan(0);

        const changed = await run({
            strategy: PINE,
            properties: { initialCapital: 50_000, commission: { type: 'percent', value: 0 } },
        });
        expect(changed.body.properties).toMatchObject({ initialCapital: 50_000, commission: { value: 0 } });
        expect(changed.body.report.initialCapital).toBe(50_000);
        expect(changed.body.report.commission).toBe(0);
        expect(changed.body.report.all.trades).toBe(own.body.report.all.trades);
    });

    it('agrees with the Pine runtime when the same strategy is written both ways', async () => {
        const properties = {
            initialCapital: 10_000,
            commission: { type: 'percent', value: 0.1 },
            qty: { type: 'percent_of_equity', value: 10 },
        };
        const native = await run({ strategy: NATIVE, properties });
        const pine = await run({ strategy: PINE });
        expect(native.body.report.all.trades).toBe(pine.body.report.all.trades);
        // Trade for trade: same fills, so the same result to within rounding of the quantity.
        for (const [i, mine] of native.body.report.trades.entries()) {
            const theirs = pine.body.report.trades[i];
            expect(mine.entryPrice).toBeCloseTo(theirs.entryPrice, 8);
            expect(mine.exitPrice ?? 0).toBeCloseTo(theirs.exitPrice ?? 0, 8);
            expect(mine.pnl).toBeCloseTo(theirs.pnl, 3);
        }
        expect(native.body.report.netProfit).toBeCloseTo(pine.body.report.netProfit, 2);
        expect(native.body.report.maxDrawdownPct).toBeCloseTo(pine.body.report.maxDrawdownPct, 1);
    });

    it('takes an explicit window', async () => {
        const to = Date.UTC(2025, 2, 1);
        const from = Date.UTC(2025, 1, 1);
        const { body } = await run({ strategy: NATIVE, bars: undefined, from, to });
        expect(body.report.from).toBe(from);
        expect(body.report.to).toBe(to);
        expect(body.report.bars).toBe(28 * 24 + 1);
    });

    it('reads smaller bars inside each chart bar when the magnifier is on', async () => {
        const plain = await run({ strategy: NATIVE });
        const fine = await run({ strategy: NATIVE, properties: { barMagnifier: true } });
        expect(plain.body.magnifier).toMatchObject({ requested: false, applied: false });
        expect(fine.body.magnifier).toMatchObject({ requested: true, applied: true, timeframe: '10', bars: 12_000 });
        expect(fine.body.report.all.trades).toBeGreaterThan(10);
        // The Pine runtime cannot, and says so rather than pretending.
        const pine = await run({ strategy: PINE, properties: { barMagnifier: true } });
        expect(pine.body.magnifier.applied).toBe(false);
        expect(pine.body.magnifier.note).toMatch(/native/);
    });

    it('rejects what it cannot run', async () => {
        expect((await run({ strategy: NATIVE, symbol: 'SYNTH:NOPE' })).status).toBe(404);
        expect((await run({ strategy: { kind: 'native', id: 'nope' } })).status).toBe(404);
        expect((await run({})).status).toBe(400);
        expect((await run({ strategy: NATIVE, timeframe: 'soon' })).status).toBe(400);
        expect((await run({ strategy: NATIVE, properties: { commission: { type: 'tips', value: 1 } } })).status).toBe(
            400,
        );
        expect((await run({ strategy: { kind: 'pine', scriptId: 'example-ema-ribbon' } })).status).toBe(400);
        const huge = await run({ strategy: PINE, timeframe: '1', bars: undefined, from: Date.UTC(2020, 0, 1) });
        expect(huge.status === 200 || /at most/.test(huge.body.error ?? '')).toBe(true);
        const runtime = await run({
            strategy: { kind: 'pine', source: '//@version=6\nstrategy("x")\nplot(ta.nothing(close))' },
        });
        expect(runtime.status).toBe(422);
    });

    it('leaves the server answering while a long run is in progress', async () => {
        const long = run({ strategy: NATIVE, timeframe: '1', bars: 400_000 });
        await wait(20);
        const laps: number[] = [];
        for (let i = 0; i < 8; i++) {
            const t = performance.now();
            await (await fetch(`${base}/api/health`)).json();
            laps.push(performance.now() - t);
            await wait(10);
        }
        const done = await long;
        expect(done.body.report.bars).toBe(400_000);
        // Loading and encoding the bars happens on the main thread; the run itself must not.
        expect(laps.sort((a, b) => a - b)[Math.floor(laps.length / 2)]).toBeLessThan(100);
    }, 60_000);
});

describe('parameter search', () => {
    const body = {
        symbol: 'SYNTH:ALPHA',
        timeframe: '60',
        bars: 2000,
        strategy: NATIVE,
        objective: 'netProfit',
        ranges: [
            { name: 'fast', from: 5, to: 15, step: 5 },
            { name: 'slow', from: 20, to: 40, step: 10 },
        ],
    };

    it('tries every combination, ranks them and reports progress', async () => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        const events: any[] = [];
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.op === 'event' && msg.topic === 'backtest') events.push(msg.data);
        });
        await new Promise((resolve) => ws.once('open', resolve));
        ws.send(JSON.stringify({ op: 'listen', topics: ['backtest'] }));
        await wait(50);

        const res = await post('/api/backtest/optimize', body);
        expect(res.status).toBe(202);
        const started = (await res.json()) as JobStatus;
        expect(started).toMatchObject({ kind: 'optimize', total: 9 });
        const job = await finished(started.id);
        expect(job).toMatchObject({ state: 'done', done: 9, rowCount: 9 });
        const scores = job.rows.map((r) => r.summary.netProfit);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(new Set(job.rows.map((r) => JSON.stringify(r.inputs))).size).toBe(9);

        // The best row is exactly what a plain run with those inputs gives.
        const best = await run({ strategy: NATIVE, inputs: job.rows[0].inputs });
        expect(best.body.report.netProfit).toBeCloseTo(job.rows[0].summary.netProfit, 6);

        await wait(150);
        ws.close();
        expect(events.some((e) => e.type === 'progress' && e.id === job.id)).toBe(true);
        expect(events.at(-1)).toMatchObject({ type: 'finished', id: job.id, state: 'done' });
    }, 60_000);

    it('samples a grid too large to walk', async () => {
        const res = await post('/api/backtest/optimize', {
            ...body,
            method: 'random',
            samples: 12,
            ranges: [
                { name: 'fast', from: 2, to: 30, step: 1 },
                { name: 'slow', from: 31, to: 120, step: 1 },
                { name: 'stop', from: 1, to: 4, step: 0.1 },
            ],
        });
        const job = await finished(((await res.json()) as JobStatus).id);
        expect(job).toMatchObject({ state: 'done', rowCount: 12 });
        const tooBig = await post('/api/backtest/optimize', {
            ...body,
            ranges: [{ name: 'fast', from: 1, to: 9000, step: 1 }],
        });
        expect(tooBig.status).toBe(400);
        expect(((await tooBig.json()) as any).error).toMatch(/9000 combinations/);
    }, 60_000);

    it('searches the inputs of a Pine strategy', async () => {
        const res = await post('/api/backtest/optimize', {
            ...body,
            bars: 600,
            strategy: PINE,
            objective: 'profitFactor',
            ranges: [
                { name: 'Fast EMA', values: [5, 9] },
                { name: 'Slow EMA', values: [21, 34] },
            ],
        });
        const job = await finished(((await res.json()) as JobStatus).id);
        expect(job).toMatchObject({ state: 'done', rowCount: 4, objective: 'profitFactor' });
        const wrong = await post('/api/backtest/optimize', {
            ...body,
            strategy: PINE,
            ranges: [{ name: 'fast', values: [1, 2] }],
        });
        expect(wrong.status).toBe(400);
    }, 60_000);

    it('can be cancelled', async () => {
        const res = await post('/api/backtest/optimize', {
            ...body,
            bars: 20_000,
            ranges: [
                { name: 'fast', from: 2, to: 40, step: 1 },
                { name: 'slow', from: 41, to: 140, step: 1 },
            ],
        });
        const started = (await res.json()) as JobStatus;
        expect(started.total).toBe(3900);
        await wait(150);
        expect((await fetch(`${base}/api/backtest/jobs/${started.id}`, { method: 'DELETE' })).status).toBe(204);
        const job = await finished(started.id, 10_000);
        expect(job.state).toBe('cancelled');
        expect(job.done).toBeLessThan(3900);
        // The pool is usable straight away.
        expect((await run({ strategy: NATIVE })).status).toBe(200);
    }, 60_000);

    it('walks forward: parameters are chosen on one window and measured on the next', async () => {
        const res = await post('/api/backtest/walk-forward', { ...body, bars: 6000, folds: 3, inSampleShare: 0.6 });
        expect(res.status).toBe(202);
        const job = await finished(((await res.json()) as JobStatus).id);
        expect(job).toMatchObject({ state: 'done', kind: 'walkforward', total: 30, done: 30 });
        const wf = job.walkForward!;
        expect(wf.folds).toHaveLength(3);
        for (const [i, fold] of wf.folds.entries()) {
            expect(fold.inSample[1]).toBeLessThan(fold.outOfSample[0]);
            if (i > 0) expect(fold.outOfSample[0]).toBeGreaterThanOrEqual(wf.folds[i - 1].outOfSample[1] - 1);
            expect(Object.keys(fold.best).sort()).toEqual(['fast', 'slow']);
        }
        const sum = wf.folds.reduce((a, f) => a + f.outOfSampleSummary.netProfit, 0);
        expect(wf.outOfSample.netProfit).toBeCloseTo(sum, 6);
        expect(wf.equity.value.at(-1)).toBeCloseTo(10_000 + sum, 6);
        expect(wf.efficiency === null || Number.isFinite(wf.efficiency)).toBe(true);
    }, 60_000);
});
