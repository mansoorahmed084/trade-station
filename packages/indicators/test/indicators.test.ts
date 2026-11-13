import { type Bar, seededRandom } from '@ts/core';
import { PineTS } from 'pinets';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    ATR,
    BollingerBands,
    CCI,
    Cross,
    DMI,
    Donchian,
    EMA,
    Highest,
    Lowest,
    MACD,
    OBV,
    RMA,
    ROC,
    RSI,
    SMA,
    StdDev,
    Stochastic,
    type Study,
    Supertrend,
    series,
    VWAP,
    VWMA,
    WMA,
} from '../src/index.ts';

const MIN = 60_000;
const N = 3000;

function makeBars(n: number, seed: number): Bar[] {
    const rnd = seededRandom(seed);
    const out: Bar[] = [];
    let p = 250;
    const t0 = Date.UTC(2025, 2, 3);
    for (let i = 0; i < n; i++) {
        const open = p;
        // alternate calm and violent stretches so trends, reversals and flat spots all occur
        const vol = i % 400 < 60 ? 0.012 : 0.003;
        const close = Math.max(1, open * (1 + (rnd() - 0.5) * 2 * vol));
        const high = Math.max(open, close) * (1 + rnd() * vol * 0.6);
        const low = Math.min(open, close) * (1 - rnd() * vol * 0.6);
        out.push({ time: t0 + i * 15 * MIN, open, high, low, close, volume: Math.round(100 + rnd() * 900) });
        p = close;
    }
    return out;
}

const bars = makeBars(N, 77);
const closes = bars.map((b) => b.close);

/**
 * Compare against the Pine runtime on every bar. The runtime rounds its outputs to 10 decimal places,
 * so the bound is absolute for small values and relative for large ones: |Δ| ≤ tolerance × max(1, |value|).
 * Bars where one side is defined and the other is not are a failure.
 */
function compare(name: string, got: number[], want: number[], tolerance = 1e-9) {
    expect(got.length, name).toBe(want.length);
    let worst = 0;
    let defined = 0;
    for (let i = 0; i < got.length; i++) {
        const g = got[i];
        const w = want[i];
        const gNa = g === undefined || g === null || Number.isNaN(g);
        const wNa = w === undefined || w === null || Number.isNaN(w);
        if (gNa !== wNa)
            throw new Error(
                `${name}: bar ${i} is ${gNa ? 'undefined' : g} natively but ${wNa ? 'undefined' : w} in Pine`,
            );
        if (gNa) continue;
        defined++;
        worst = Math.max(worst, Math.abs(g - w) / Math.max(1, Math.abs(w)));
    }
    expect(defined, `${name}: nothing to compare`).toBeGreaterThan(N * 0.9);
    expect(worst, `${name}: max scaled difference ${worst}`).toBeLessThan(tolerance);
}

describe('native indicators match the Pine runtime bar for bar', () => {
    let pine: Record<string, number[]>;

    beforeAll(async () => {
        const klines = bars.map((b) => ({
            openTime: b.time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            closeTime: b.time + 15 * MIN - 1,
        }));
        const ctx: any = await new PineTS(klines as any).run(`//@version=6
indicator("cross-check")
plot(ta.sma(close, 20), "sma")
plot(ta.ema(close, 21), "ema")
plot(ta.rma(close, 14), "rma")
plot(ta.wma(close, 9), "wma")
plot(ta.vwma(close, 20), "vwma")
plot(ta.stdev(close, 20), "stdev")
[mid, up, lo] = ta.bb(close, 20, 2.0)
plot(up, "bbu")
plot(lo, "bbl")
plot(ta.rsi(close, 14), "rsi")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(m, "macd")
plot(s, "signal")
plot(h, "hist")
plot(ta.roc(close, 10), "roc")
plot(ta.stoch(close, high, low, 14), "stoch")
plot(ta.cci(close, 20), "cci")
plot(ta.atr(14), "atr")
[st, dir] = ta.supertrend(3.0, 10)
plot(st, "st")
plot(dir, "dir")
[dp, dm, adx] = ta.dmi(14, 14)
plot(dp, "dip")
plot(dm, "dim")
plot(adx, "adx")
plot(ta.highest(high, 20), "hh")
plot(ta.lowest(low, 20), "ll")
plot(ta.obv, "obv")
plot(ta.crossover(ta.ema(close, 9), ta.ema(close, 21)) ? 1 : 0, "xo")
plot(ta.crossunder(ta.ema(close, 9), ta.ema(close, 21)) ? 1 : 0, "xu")`);
        pine = {};
        for (const [name, plot] of Object.entries<any>(ctx.plots)) pine[name] = plot.data.map((d: any) => d.value);
    });

    const cases: [string, () => number[]][] = [
        ['sma', () => series(new SMA(20), closes)],
        ['ema', () => series(new EMA(21), closes)],
        ['rma', () => series(new RMA(14), closes)],
        ['wma', () => series(new WMA(9), closes)],
        [
            'vwma',
            () =>
                series(
                    new VWMA(20),
                    bars.map((b) => ({ price: b.close, volume: b.volume })),
                ),
        ],
        ['stdev', () => series(new StdDev(20), closes)],
        ['bbu', () => series(new BollingerBands(20, 2), closes).map((b) => b.upper)],
        ['bbl', () => series(new BollingerBands(20, 2), closes).map((b) => b.lower)],
        ['rsi', () => series(new RSI(14), closes)],
        ['macd', () => series(new MACD(12, 26, 9), closes).map((v) => v.macd)],
        ['signal', () => series(new MACD(12, 26, 9), closes).map((v) => v.signal)],
        ['hist', () => series(new MACD(12, 26, 9), closes).map((v) => v.hist)],
        ['roc', () => series(new ROC(10), closes)],
        ['stoch', () => series(new Stochastic(14), bars)],
        ['cci', () => series(new CCI(20), closes)],
        ['atr', () => series(new ATR(14), bars)],
        ['st', () => series(new Supertrend(3, 10), bars).map((v) => v.value)],
        ['dir', () => series(new Supertrend(3, 10), bars).map((v) => v.direction)],
        ['dip', () => series(new DMI(14, 14), bars).map((v) => v.plus)],
        ['dim', () => series(new DMI(14, 14), bars).map((v) => v.minus)],
        ['adx', () => series(new DMI(14, 14), bars).map((v) => v.adx)],
        [
            'hh',
            () =>
                series(
                    new Highest(20),
                    bars.map((b) => b.high),
                ),
        ],
        [
            'll',
            () =>
                series(
                    new Lowest(20),
                    bars.map((b) => b.low),
                ),
        ],
        ['obv', () => series(new OBV(), bars)],
    ];

    for (const [name, native] of cases) {
        it(name, () => {
            compare(name, native(), pine[name]);
        });
    }

    it('crossover and crossunder', () => {
        const fast = series(new EMA(9), closes);
        const slow = series(new EMA(21), closes);
        const cross = new Cross();
        const over: number[] = [];
        const under: number[] = [];
        for (let i = 0; i < N; i++) {
            const c = cross.push(fast[i], slow[i]);
            over.push(c.over ? 1 : 0);
            under.push(c.under ? 1 : 0);
        }
        expect(over).toEqual(pine.xo.map((v) => (v ? 1 : 0)));
        expect(under).toEqual(pine.xu.map((v) => (v ? 1 : 0)));
        expect(over.reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
    });
});

describe('peek', () => {
    const studies: [string, () => Study<any, any>, (b: Bar) => unknown][] = [
        ['SMA', () => new SMA(20), (b) => b.close],
        ['EMA', () => new EMA(21), (b) => b.close],
        ['RMA', () => new RMA(14), (b) => b.close],
        ['WMA', () => new WMA(9), (b) => b.close],
        ['VWMA', () => new VWMA(20), (b) => ({ price: b.close, volume: b.volume })],
        ['StdDev', () => new StdDev(20), (b) => b.close],
        ['BollingerBands', () => new BollingerBands(20, 2), (b) => b.close],
        ['RSI', () => new RSI(14), (b) => b.close],
        ['MACD', () => new MACD(), (b) => b.close],
        ['ROC', () => new ROC(10), (b) => b.close],
        ['Stochastic', () => new Stochastic(14), (b) => b],
        ['CCI', () => new CCI(20), (b) => b.close],
        ['ATR', () => new ATR(14), (b) => b],
        ['Supertrend', () => new Supertrend(3, 10), (b) => b],
        ['DMI', () => new DMI(14, 14), (b) => b],
        ['Donchian', () => new Donchian(20), (b) => b],
        ['Highest', () => new Highest(20), (b) => b.high],
        ['Lowest', () => new Lowest(20), (b) => b.low],
        ['OBV', () => new OBV(), (b) => b],
        ['VWAP', () => new VWAP(), (b) => b],
    ];
    const sample = bars.slice(0, 600);
    const same = (a: unknown, b: unknown) => {
        if (typeof a === 'number') {
            if (Number.isNaN(a)) expect(b).toBeNaN();
            else expect(b).toBeCloseTo(a, 9);
            return;
        }
        for (const key of Object.keys(a as object)) same((a as any)[key], (b as any)[key]);
    };

    for (const [name, make, input] of studies) {
        it(`${name}: previews the next value exactly and never changes state`, () => {
            const live = make();
            const reference = make();
            for (let i = 0; i < sample.length; i++) {
                const bar = sample[i];
                // a forming bar is previewed with other values first; none of that may leak into the result
                live.peek(input({ ...bar, close: bar.close * 1.01, high: bar.high * 1.02, low: bar.low * 0.98 }));
                live.peek(input({ ...bar, close: bar.open }));
                const previewed = live.peek(input(bar));
                const committed = live.push(input(bar));
                same(committed, previewed);
                same(reference.push(input(bar)), committed);
            }
        });
    }
});

describe('edge cases', () => {
    it('rejects invalid lengths', () => {
        expect(() => new SMA(0)).toThrow();
        expect(() => new EMA(2.5)).toThrow();
        expect(() => new Highest(-1)).toThrow();
    });

    it('a length of one returns the input', () => {
        expect(series(new SMA(1), [3, 5, 4])).toEqual([3, 5, 4]);
        expect(series(new EMA(1), [3, 5, 4])).toEqual([3, 5, 4]);
        expect(series(new Highest(1), [3, 5, 4])).toEqual([3, 5, 4]);
    });

    it('RSI is 100 when price only rises and 0 when it only falls', () => {
        expect(series(new RSI(3), [1, 2, 3, 4, 5, 6]).slice(3)).toEqual([100, 100, 100]);
        expect(series(new RSI(3), [6, 5, 4, 3, 2, 1]).slice(3)).toEqual([0, 0, 0]);
    });

    it('VWAP restarts each UTC day', () => {
        const day = 86_400_000;
        const mk = (time: number, price: number, volume: number): Bar => ({
            time,
            open: price,
            high: price,
            low: price,
            close: price,
            volume,
        });
        const vwap = new VWAP();
        expect(vwap.push(mk(0, 10, 1))).toBe(10);
        expect(vwap.push(mk(3_600_000, 20, 3))).toBe(17.5);
        expect(vwap.peek(mk(day, 99, 5))).toBe(99);
        expect(vwap.push(mk(day, 30, 2))).toBe(30);
    });

    it('rolling extremes stay correct over a long monotonic run', () => {
        const up = Array.from({ length: 500 }, (_, i) => i);
        expect(series(new Highest(50), up).slice(49)).toEqual(up.slice(49));
        expect(series(new Lowest(50), up).slice(49)).toEqual(up.slice(0, 451));
    });
});
