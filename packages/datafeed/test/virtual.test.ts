import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Bar, barOpenTime, createTransform } from '@ts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarStore, MarketDataService, parseFormula, SyntheticAdapter } from '../src/index.ts';

const MIN = 60_000;
const GENESIS = Date.UTC(2025, 0, 1);

let dir: string;
let service: MarketDataService;

async function setup(nowMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    service = new MarketDataService({
        adapters: [new SyntheticAdapter({ genesis: GENESIS })],
        store: new BarStore(dir),
    });
    await service.init();
    return service;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-virtual-'));
});
afterEach(() => {
    service?.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

describe('formula parser', () => {
    const value = (text: string, env: Record<string, number>) => {
        const { ast } = parseFormula(text);
        const walk = (n: any): number =>
            n.t === 'num'
                ? n.v
                : n.t === 'sym'
                  ? env[n.s]
                  : n.t === 'neg'
                    ? -walk(n.a)
                    : n.op === '+'
                      ? walk(n.a) + walk(n.b)
                      : n.op === '-'
                        ? walk(n.a) - walk(n.b)
                        : n.op === '*'
                          ? walk(n.a) * walk(n.b)
                          : walk(n.a) / walk(n.b);
        return walk(ast);
    };

    it('honours precedence, parentheses and unary minus', () => {
        const env = { A: 10, B: 4, 'X:C': 2 };
        expect(value('A/B', env)).toBe(2.5);
        expect(value('A - B * 2', env)).toBe(2);
        expect(value('(A - B) * 2', env)).toBe(12);
        expect(value('-A + B', env)).toBe(-6);
        expect(value('A / X:C / 5', env)).toBe(1);
        expect(value('(A+B)/2', env)).toBe(7);
        expect(parseFormula('BINANCE:ETHUSDT/BINANCE:BTCUSDT').symbols).toEqual(['BINANCE:ETHUSDT', 'BINANCE:BTCUSDT']);
        expect(parseFormula('A*A+A').symbols).toEqual(['A']);
    });

    it('rejects malformed input', () => {
        for (const bad of ['', 'A +', '(A', 'A B', 'A ** B', '1 + 2', 'A $ B', ')', 'A/(B']) {
            expect(() => parseFormula(bad), bad).toThrow();
        }
        expect(() => parseFormula('A+B+C+D+E+F+G')).toThrow(/at most 6/);
    });
});

describe('chart-type series', () => {
    it('equals the transform applied to the source bars, forming bar included', async () => {
        const now = GENESIS + 6000 * MIN + 20_000;
        await setup(now);
        const source = await service.getBars('SYNTH:ALPHA', '1', { limit: 20_000 });
        const transform = createTransform({ kind: 'renko', box: 0.2 });
        const expected: Bar[] = [];
        for (let i = 0; i < source.length - 1; i++) expected.push(...transform.push(source.at(i)));
        const forming = transform.preview(source.at(source.length - 1));
        if (forming) expected.push(forming);

        const got = await service.getBars('SYNTH:ALPHA.RENKOX0P2', '1', { from: 0 });
        expect(got.length).toBeGreaterThan(100);
        expect(got.toBars()).toEqual(expected);
        // every completed brick is exactly one box tall
        for (let i = 0; i < got.length - 1; i++) expect(got.high[i] - got.low[i]).toBeCloseTo(0.2, 9);

        const recent = await service.getBars('synth:alpha.renkox0p2', '1', { limit: 25 });
        expect(recent.toBars()).toEqual(expected.slice(-25));
        const ranged = await service.getBars('SYNTH:ALPHA.RENKOX0P2', '1', {
            from: expected[10].time,
            to: expected[19].time,
        });
        expect(ranged.toBars()).toEqual(expected.slice(10, 20));
    });

    it('sizes boxes from ATR and works for every chart type and an aggregated timeframe', async () => {
        await setup(GENESIS + 9000 * MIN + 5_000);
        for (const suffix of ['RENKOXATR14', 'LBX3', 'KAGIXATR14', 'PNFXATR14X3', 'RANGEXATR14']) {
            const bars = await service.getBars(`SYNTH:GAMMA.${suffix}`, '5', { limit: 5000 });
            expect(bars.length, suffix).toBeGreaterThan(20);
            for (let i = 1; i < bars.length; i++) expect(bars.time[i], suffix).toBeGreaterThan(bars.time[i - 1]);
            for (let i = 0; i < bars.length; i++) {
                expect(bars.high[i]).toBeGreaterThanOrEqual(Math.max(bars.open[i], bars.close[i]) - 1e-9);
                expect(bars.low[i]).toBeLessThanOrEqual(Math.min(bars.open[i], bars.close[i]) + 1e-9);
            }
        }
        const renko = await service.getBars('SYNTH:GAMMA.RENKOXATR14', '5', { limit: 50 });
        const box = renko.high[0] - renko.low[0];
        expect(box).toBeGreaterThan(0.1 - 1e-9); // at least one tick (0.1) and on the tick grid
        expect(Math.abs(box / 0.1 - Math.round(box / 0.1))).toBeLessThan(1e-6);
    });

    it('describes itself and exposes the tradable symbol underneath', async () => {
        await setup(GENESIS + 500 * MIN);
        const info = await service.describe('SYNTH:ALPHA.LBX3');
        expect(info.symbol).toBe('SYNTH:ALPHA.LBX3');
        expect(info.ticker).toBe('ALPHA.LBX3');
        expect(info.tickSize).toBe(0.01);
        expect(service.underlying('SYNTH:ALPHA.LBX3').symbol).toBe('SYNTH:ALPHA');
        expect(service.underlying('ALPHA').symbol).toBe('SYNTH:ALPHA');
        await expect(service.getBars('SYNTH:ALPHA.NOPE', '1')).rejects.toThrow(/Unknown symbol/);
        await expect(service.getBars('SYNTH:NOPE.LBX3', '1')).rejects.toThrow(/Unknown symbol/);
    });

    it('live: bricks completed by the stream equal the bricks history reports afterwards', async () => {
        const start = GENESIS + 3000 * MIN + 4_000;
        await setup(start);
        const symbol = 'SYNTH:GAMMA.RENKOX2';
        const completed: Bar[] = [];
        let last: Bar | null = null;
        let updates = 0;
        const stop = service.subscribe(symbol, '1', (bar, opened) => {
            updates++;
            if (opened && last) completed.push(last);
            last = { ...bar };
        });
        await vi.advanceTimersByTimeAsync(90 * MIN);
        stop();
        expect(updates).toBeGreaterThan(1000);
        expect(completed.length).toBeGreaterThan(5);
        const history = await service.getBars(symbol, '1', {
            from: completed[0].time,
            to: completed[completed.length - 1].time,
        });
        expect(completed).toEqual(history.toBars());
        expect(service.stats().hubs).toBe(0);
    });
});

describe('spread series', () => {
    it('combines operands bar by bar', async () => {
        await setup(GENESIS + 800 * MIN + 1_000);
        const from = GENESIS + 600 * MIN;
        const [gamma, alpha, ratio, diff] = await Promise.all([
            service.getBars('SYNTH:GAMMA', '5', { from }),
            service.getBars('SYNTH:ALPHA', '5', { from }),
            service.getBars('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA', '5', { from }),
            service.getBars('SPREAD:(SYNTH:GAMMA - SYNTH:ALPHA*2)/10', '5', { from }),
        ]);
        expect(ratio.length).toBe(gamma.length);
        for (let i = 0; i < ratio.length; i++) {
            expect(ratio.time[i]).toBe(gamma.time[i]);
            expect(ratio.close[i]).toBeCloseTo(gamma.close[i] / alpha.close[i], 12);
            expect(ratio.open[i]).toBeCloseTo(gamma.open[i] / alpha.open[i], 12);
            expect(ratio.high[i]).toBeGreaterThanOrEqual(Math.max(ratio.open[i], ratio.close[i]));
            expect(ratio.low[i]).toBeLessThanOrEqual(Math.min(ratio.open[i], ratio.close[i]));
            expect(diff.close[i]).toBeCloseTo((gamma.close[i] - alpha.close[i] * 2) / 10, 12);
        }
        const limited = await service.getBars('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA', '5', { limit: 7 });
        expect(limited.length).toBe(7);
        expect(limited.lastTime).toBe(barOpenTime(GENESIS + 800 * MIN + 1_000, '5'));
    });

    it('streams a combined bar once every operand is on the same bar', async () => {
        await setup(GENESIS + 400 * MIN + 2_000);
        const seen: Bar[] = [];
        const opens: number[] = [];
        const stop = service.subscribe('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA', '1', (bar, opened) => {
            seen.push({ ...bar });
            if (opened) opens.push(bar.time);
        });
        await vi.advanceTimersByTimeAsync(5 * MIN);
        stop();
        expect(seen.length).toBeGreaterThan(100);
        expect(opens).toEqual([0, 1, 2, 3, 4, 5].map((m) => GENESIS + (400 + m) * MIN));
        for (const bar of seen) expect(Number.isFinite(bar.close)).toBe(true);
        // the stream's final state of a closed bar equals history
        const firstClosed = seen.filter((b) => b.time === opens[1]).pop()!;
        const history = await service.getBars('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA', '1', { from: opens[1], to: opens[1] });
        expect(history.at(0).close).toBeCloseTo(firstClosed.close, 12);
        expect(service.stats().hubs).toBe(0);
    });

    it('describes itself with a price grid sized to the value and rejects bad formulas', async () => {
        await setup(GENESIS + 3000 * MIN);
        const info = await service.describe('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA');
        expect(info.provider).toBe('SPREAD');
        expect(info.ticker).toBe('SYNTH:GAMMA/SYNTH:ALPHA');
        expect(info.tickSize).toBeLessThanOrEqual(0.001);
        expect(info.tickSize).toBeGreaterThan(0);
        await expect(service.getBars('SPREAD:SYNTH:GAMMA/', '1')).rejects.toThrow(/formula/i);
        await expect(service.getBars('SPREAD:SYNTH:GAMMA/NOPE', '1')).rejects.toThrow(/Unknown symbol/);
        expect(() => service.underlying('SPREAD:SYNTH:GAMMA/SYNTH:ALPHA')).toThrow();
    });
});
