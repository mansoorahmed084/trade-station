import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BarSeries } from '@ts/core';
import { SyntheticAdapter } from '@ts/datafeed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.ts';
import { measure, passes } from '../src/screener.ts';

let dir: string;
let app: App;
let base: string;
const run = async (body: unknown) => {
    const res = await fetch(`${base}/api/screener/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-screener-'));
    app = await createApp(
        { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'x'), notifier: {} },
        { adapters: [new SyntheticAdapter({ tickMs: 1000 })], log: () => {}, lingerMs: 0, workers: 1 },
    );
    base = await app.listen();
}, 30_000);

afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('screener measures', () => {
    it('works out change, averages, RSI and range from the bars', () => {
        const s = new BarSeries(300);
        for (let i = 0; i < 300; i++) s.append(i * 60_000, 100 + i, 101 + i, 99 + i, 100 + i, i === 299 ? 30 : 10);
        const m = measure(s);
        expect(m.price).toBe(399);
        expect(m.changePct).toBeCloseTo((1 / 398) * 100, 9);
        expect(m.change20Pct).toBeCloseTo((20 / 379) * 100, 9);
        expect(m.relVolume).toBeCloseTo(3, 9);
        expect(m.rsi14).toBeCloseTo(100, 6);
        expect(m.sma50DistPct).toBeCloseTo(((399 - 374.5) / 374.5) * 100, 6);
        expect(m.emaTrend).toBe(1);
        expect(m.highDistPct).toBeCloseTo(((399 - 400) / 400) * 100, 9);
        // Too little history leaves a measure empty rather than wrong.
        const short = new BarSeries(8);
        for (let i = 0; i < 8; i++) short.append(i, 1, 1, 1, 1, 1);
        expect(measure(short).sma200DistPct).toBeNull();
    });

    it('applies every filter, and a missing value fails it', () => {
        const v = { rsi14: 25, changePct: 3, sma200DistPct: null };
        expect(passes(v, [{ field: 'rsi14', op: '<', value: 30 }])).toBe(true);
        expect(
            passes(v, [
                { field: 'rsi14', op: '<', value: 30 },
                { field: 'changePct', op: 'between', value: 4, to: 2 },
            ]),
        ).toBe(true);
        expect(passes(v, [{ field: 'changePct', op: '>=', value: 3.5 }])).toBe(false);
        expect(passes(v, [{ field: 'sma200DistPct', op: '>', value: -100 }])).toBe(false);
    });
});

describe('screener API', () => {
    it('scans a provider, sorts, and filters', async () => {
        const all = await run({ provider: 'SYNTH', timeframe: '60' });
        expect(all.status).toBe(200);
        expect(all.body.scanned).toBe(3);
        expect(all.body.rows.map((r: any) => r.symbol).sort()).toEqual(['SYNTH:ALPHA', 'SYNTH:BETA', 'SYNTH:GAMMA']);
        const changes = all.body.rows.map((r: any) => r.values.changePct);
        expect(changes).toEqual([...changes].sort((a: number, b: number) => b - a));
        const top = all.body.rows[0];
        const only = await run({
            provider: 'SYNTH',
            timeframe: '60',
            filters: [{ field: 'changePct', op: '>=', value: top.values.changePct }],
        });
        expect(only.body.rows.map((r: any) => r.symbol)).toEqual([top.symbol]);
        expect(only.body.matched).toBe(1);
    });

    it('adds the columns of a Pine script and filters on them (Pine Screener)', async () => {
        const source =
            '//@version=6\nindicator("Screen")\nplot(ta.rsi(close, 14), "RSI")\nplot(close > ta.sma(close, 20) ? 1 : 0, "Above SMA20")';
        const r = await run({
            symbols: ['SYNTH:ALPHA', 'SYNTH:BETA'],
            timeframe: '60',
            pine: { source },
            filters: [{ field: 'pine:RSI', op: '>', value: 0 }],
        });
        expect(r.status).toBe(200);
        expect(r.body.columns.map((c: any) => c.id)).toContain('pine:Above SMA20');
        expect(r.body.rows.length).toBe(2);
        for (const row of r.body.rows) {
            expect(row.values['pine:RSI']).toBeCloseTo(row.values.rsi14, 6);
            expect([0, 1]).toContain(row.values['pine:Above SMA20']);
        }
    });

    it('reports a symbol it could not read instead of failing the scan, and refuses a bad request', async () => {
        const r = await run({ symbols: ['SYNTH:ALPHA', 'SYNTH:NOPE'], timeframe: '60' });
        expect(r.body.rows).toHaveLength(1);
        expect(r.body.errors).toMatchObject([{ symbol: 'SYNTH:NOPE' }]);
        expect((await run({ timeframe: '60' })).status).toBe(400);
        expect((await run({ provider: 'SYNTH', filters: [{ field: 'nope', op: '>', value: 1 }] })).status).toBe(400);
        expect((await run({ provider: 'SYNTH', pine: { scriptId: 'nope' } })).status).toBe(404);
    });
});
