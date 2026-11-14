import { type Bar, BarSeries, seededRandom } from '@ts/core';
import { PineTS } from 'pinets';
import { describe, expect, it } from 'vitest';
import {
    buildReport,
    equityCurve,
    expandGrid,
    gridSize,
    monteCarlo,
    type NativeStrategy,
    rangeValues,
    resolveInputs,
    runBacktest,
    STRATEGIES,
    sampleGrid,
    score,
    strategyById,
    type TradeRecord,
    walkForwardWindows,
} from '../src/index.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

function market(n: number, seed: number, vol = 0.02): { series: BarSeries; klines: any[] } {
    const rnd = seededRandom(seed);
    const series = new BarSeries();
    const klines: any[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
        const t = T0 + i * HOUR;
        const o = p;
        const c = Math.round(Math.max(1, o * (1 + (rnd() - 0.5) * vol)) * 100) / 100;
        const h = Math.round(Math.max(o, c) * (1 + rnd() * vol * 0.3) * 100) / 100;
        const l = Math.round(Math.min(o, c) * (1 - rnd() * vol * 0.3) * 100) / 100;
        series.append(t, o, h, l, c, 10);
        klines.push({ openTime: t, closeTime: t + HOUR - 1, open: o, high: h, low: l, close: c, volume: 10 });
        p = c;
    }
    return { series, klines };
}

const PINE_EMA_CROSS = (short: boolean) => `//@version=6
strategy("EMA Cross Strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.1)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
atr = ta.atr(14)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop=close - 2.0 * atr, limit=close + 3.0 * atr)
if ta.crossunder(fast, slow)
    ${short ? 'strategy.entry("Short", strategy.short)\n    strategy.exit("Short exit", "Short", stop=close + 2.0 * atr, limit=close - 3.0 * atr)' : 'strategy.close("Long")'}
`;

describe('parity with the Pine runtime’s broker', () => {
    for (const [name, seed, short] of [
        ['long only', 31, false],
        ['long only, another market', 77, false],
        ['long and short, reversing', 31, true],
    ] as const) {
        it(`EMA cross with ATR stop and target, ${name}: every trade matches`, async () => {
            const { series, klines } = market(4000, seed);
            // Through a provider, as the server runs it, so the script sees the symbol's real tick size.
            const provider = {
                getMarketData: async () => klines,
                getSymbolInfo: async () => ({
                    ticker: 'TEST',
                    tickerid: 'T:TEST',
                    mintick: 0.01,
                    pricescale: 100,
                    minmove: 1,
                    pointvalue: 1,
                    mincontract: 1e-6,
                    timezone: 'Etc/UTC',
                    session: '24x7',
                    type: 'crypto',
                    currency: 'USD',
                }),
                configure() {},
            };
            const ctx: any = await new PineTS(provider as any, 'T:TEST', '60', klines.length).run(
                PINE_EMA_CROSS(short),
            );
            const pine = ctx.strategy.closedtrades as any[];
            const native = runBacktest(strategyById('ema-cross')!, series, {
                broker: { commission: { type: 'percent', value: 0.1 }, tickSize: 0.01 },
                qty: { type: 'percent_of_equity', value: 10 },
                lotSize: 1e-6,
                inputs: { short },
            });
            const mine = native.trades.filter((t) => !t.open);
            expect(pine.length).toBeGreaterThan(60);
            expect(mine.length).toBe(pine.length);
            // exits by stop, by target and by the opposite signal must all occur for the comparison to mean something
            const exitKinds = new Set(
                mine.map((t) =>
                    t.exitId?.endsWith(':stop') ? 'stop' : t.exitId?.endsWith(':limit') ? 'target' : 'signal',
                ),
            );
            expect([...exitKinds].sort()).toEqual(['signal', 'stop', 'target']);
            for (let i = 0; i < pine.length; i++) {
                const a = pine[i];
                const b = mine[i];
                const where = `trade ${i}`;
                expect(b.entryTime, where).toBe(a.entry_time);
                expect(b.exitTime, where).toBe(a.exit_time);
                expect(b.entryPrice, where).toBeCloseTo(a.entry_price, 9);
                // both brokers move a stop or target onto the tick grid, in the same direction
                expect(b.exitPrice, where).toBeCloseTo(a.exit_price, 9);
                expect(b.side, where).toBe(a.size > 0 ? 'long' : 'short');
                expect(Math.abs(b.qty - Math.abs(a.size)) / Math.abs(a.size), where).toBeLessThan(2e-4);
            }
            const net = mine.reduce((sum, t) => sum + t.pnl, 0);
            expect(Math.abs(net - ctx.strategy.netprofit) / Math.abs(ctx.strategy.netprofit)).toBeLessThan(1e-3);
        });
    }
});

describe('native strategy runner', () => {
    const { series } = market(3000, 5);

    it('every built-in strategy trades and keeps its books consistent', () => {
        for (const strategy of STRATEGIES) {
            const run = runBacktest(strategy, series, { broker: { commission: { type: 'percent', value: 0.05 } } });
            const closed = run.trades.filter((t) => !t.open);
            expect(closed.length, strategy.id).toBeGreaterThan(5);
            const realized = closed.reduce((a, t) => a + t.pnl, 0);
            expect(realized, strategy.id).toBeCloseTo(run.broker.realizedPnl, 6);
            for (const t of closed) {
                expect(t.exitTime!, strategy.id).toBeGreaterThanOrEqual(t.entryTime);
                const gross = (t.exitPrice! - t.entryPrice) * t.qty * (t.side === 'long' ? 1 : -1);
                expect(t.pnl, strategy.id).toBeCloseTo(gross - t.commission, 6);
            }
            expect(run.broker.equity(series.close[series.length - 1])).toBeCloseTo(
                10_000 + run.trades.reduce((a, t) => a + t.pnl, 0),
                6,
            );
        }
    });

    it('orders fill on the bar after the signal, or at its close when asked', () => {
        const once: NativeStrategy = {
            id: 'once',
            name: 'once',
            description: '',
            inputs: [],
            create: () => (s) => {
                if (s.index === 10) s.entry('in', 'long', { qty: 1 });
                if (s.index === 20) s.close();
            },
        };
        const next = runBacktest(once, series);
        expect(next.trades[0]).toMatchObject({
            entryTime: series.time[11],
            entryPrice: series.open[11],
            exitTime: series.time[21],
            exitPrice: series.open[21],
        });
        const onClose = runBacktest(once, series, { processOrdersOnClose: true });
        expect(onClose.trades[0]).toMatchObject({
            entryTime: series.time[10],
            entryPrice: series.close[10],
            exitTime: series.time[20],
            exitPrice: series.close[20],
        });
    });

    it('sizes by fixed quantity, cash and percent of equity, and respects pyramiding', () => {
        const buyTwice: NativeStrategy = {
            id: 'twice',
            name: 'twice',
            description: '',
            inputs: [],
            create: () => (s) => {
                if (s.index === 5 || s.index === 8) s.entry(`in${s.index}`, 'long');
            },
        };
        const fixed = runBacktest(buyTwice, series, { qty: { type: 'fixed', value: 3 } });
        expect(fixed.broker.position).toBe(3); // the second entry is refused: pyramiding is 1
        const stacked = runBacktest(buyTwice, series, { qty: { type: 'fixed', value: 3 }, pyramiding: 2 });
        expect(stacked.broker.position).toBe(6);
        const cash = runBacktest(buyTwice, series, { qty: { type: 'cash', value: 500 }, lotSize: 0.001 });
        expect(cash.broker.position).toBeCloseTo(Math.floor((500 / series.close[5]) * 1000) / 1000, 9);
        const pct = runBacktest(buyTwice, series, { qty: { type: 'percent_of_equity', value: 25 } });
        expect(pct.broker.position * series.close[5]).toBeCloseTo(2500, 6);
        expect(fixed.trades[fixed.trades.length - 1]).toMatchObject({ open: true, side: 'long', qty: 3 });
    });

    it('the bar magnifier changes which of a stop and a target fills first', () => {
        const bars = new BarSeries();
        bars.append(0, 100, 100, 100, 100, 1);
        bars.append(HOUR, 100, 100, 100, 100, 1);
        bars.append(2 * HOUR, 100, 105, 96, 98, 1); // up 5, down 4: the assumption sends price down first
        const bracket: NativeStrategy = {
            id: 'bracket',
            name: 'bracket',
            description: '',
            inputs: [],
            create: () => (s) => {
                if (s.index === 0) {
                    s.entry('in', 'long', { qty: 1 });
                    s.exit('x', { stop: 97, limit: 104 });
                }
            },
        };
        const coarse = runBacktest(bracket, bars);
        expect(coarse.trades[0]).toMatchObject({ exitPrice: 97, pnl: -3 });
        // inside the bar, price in fact went up to the target first
        const inside: Bar[] = [
            { time: 2 * HOUR, open: 100, high: 105, low: 99.5, close: 104.5, volume: 1 },
            { time: 2 * HOUR + HOUR / 2, open: 104.5, high: 104.8, low: 96, close: 98, volume: 1 },
        ];
        const fine = runBacktest(bracket, bars, { intrabar: (_bar, i) => (i === 2 ? inside : undefined) });
        expect(fine.trades[0]).toMatchObject({ exitPrice: 104, pnl: 4 });
    });

    it('clamps and types inputs', () => {
        const s = strategyById('ema-cross')!;
        expect(resolveInputs(s, {})).toEqual({ fast: 9, slow: 21, atrLength: 14, stop: 2, target: 3, short: false });
        expect(resolveInputs(s, { fast: '12.6', slow: -4, 'Trade short side': 'true', stop: 'abc' })).toMatchObject({
            fast: 13,
            slow: 2,
            short: true,
            stop: 2,
        });
    });
});

describe('report', () => {
    const bars = new BarSeries();
    const closes = [100, 102, 104, 103, 101, 105, 110, 108];
    for (const [i, c] of closes.entries()) bars.append(T0 + i * 86_400_000, c, c + 1, c - 1, c, 1);
    const day = (i: number) => T0 + i * 86_400_000;
    const trades: TradeRecord[] = [
        {
            side: 'long',
            qty: 10,
            entryTime: day(0),
            entryPrice: 100,
            exitTime: day(2),
            exitPrice: 104,
            pnl: 39,
            commission: 1,
            open: false,
        },
        {
            side: 'short',
            qty: 5,
            entryTime: day(3),
            entryPrice: 103,
            exitTime: day(5),
            exitPrice: 105,
            pnl: -11,
            commission: 1,
            open: false,
        },
        { side: 'long', qty: 2, entryTime: day(6), entryPrice: 110, pnl: -4, commission: 0, open: true },
    ];

    it('marks equity to each bar close', () => {
        const { equity, inMarket } = equityCurve(trades, bars, 1000);
        expect(Array.from(equity)).toEqual([1000, 1020, 1039, 1039, 1049, 1028, 1028, 1024]);
        expect(inMarket).toBe(6);
    });

    it('computes the headline numbers', () => {
        const r = buildReport(trades, bars, 1000, 86_400_000);
        expect(r.finalEquity).toBe(1024);
        expect(r.netProfit).toBe(24);
        expect(r.netProfitPct).toBeCloseTo(2.4, 9);
        expect(r.maxDrawdown).toBe(-25); // 1049 → 1024
        expect(r.maxDrawdownPct).toBeCloseTo((-25 / 1049) * 100, 9);
        expect(r.buyHoldPct).toBeCloseTo(8, 9);
        expect(r.exposurePct).toBe(75);
        expect(r.commission).toBe(2);
        expect(r.all).toMatchObject({
            trades: 2,
            wins: 1,
            losses: 1,
            winRatePct: 50,
            netProfit: 28,
            grossProfit: 39,
            grossLoss: 11,
            avgTrade: 14,
            avgWin: 39,
            avgLoss: 11,
            largestWin: 39,
            largestLoss: -11,
            avgBarsInTrade: 2,
        });
        expect(r.all.profitFactor).toBeCloseTo(39 / 11, 9);
        expect(r.long).toMatchObject({ trades: 1, wins: 1, profitFactor: null });
        expect(r.short).toMatchObject({ trades: 1, losses: 1, netProfit: -11 });
        expect(r.monthly).toEqual([{ month: '2025-01', pnl: 24, returnPct: expect.closeTo(2.4, 9) }]);
        expect(r.equity.value[r.equity.value.length - 1]).toBe(1024);
        expect(Math.min(...r.equity.drawdown)).toBe(-25);
        expect(r.sharpe).not.toBeNull();
    });

    it('thins a long curve but keeps its last point and its deepest drawdown', () => {
        const { series } = market(20_000, 9);
        const run = runBacktest(strategyById('supertrend')!, series);
        const r = buildReport(run.trades, series, 10_000, HOUR);
        expect(r.equity.time.length).toBeLessThanOrEqual(1502);
        expect(r.equity.time[r.equity.time.length - 1]).toBe(series.time[series.length - 1]);
        expect(Math.min(...r.equity.drawdown)).toBeCloseTo(r.maxDrawdown, 9);
        expect(r.finalEquity).toBeCloseTo(run.broker.equity(series.close[series.length - 1]), 6);
    });

    it('an empty run is all zeros, not NaN', () => {
        const r = buildReport([], bars, 1000, 86_400_000);
        expect(r).toMatchObject({ finalEquity: 1000, netProfit: 0, maxDrawdown: 0, exposurePct: 0 });
        expect(r.all).toMatchObject({ trades: 0, winRatePct: 0, avgTrade: 0, profitFactor: null });
        expect(buildReport([], new BarSeries(), 1000, 1).finalEquity).toBe(1000);
    });
});

describe('Monte Carlo', () => {
    it('keeps the total and varies the path', () => {
        const trades: TradeRecord[] = [50, -30, 80, -60, 20, -10, 40, -70, 90, -20].map((pnl, i) => ({
            side: 'long',
            qty: 1,
            entryTime: i,
            entryPrice: 1,
            exitTime: i + 1,
            exitPrice: 1,
            pnl,
            commission: 0,
            open: false,
        }));
        const mc = monteCarlo(trades, 1000, 500, 3);
        expect(mc.runs).toBe(500);
        for (const v of Object.values(mc.finalEquity)) expect(v).toBe(1090);
        expect(mc.maxDrawdownPct.p5).toBeLessThan(mc.maxDrawdownPct.p95);
        expect(mc.maxDrawdownPct.p95).toBeLessThanOrEqual(0);
        expect(mc.ruinPct).toBe(0);
        expect(monteCarlo(trades, 1000, 500, 3)).toEqual(mc); // seeded: repeatable
        expect(monteCarlo(trades, 50, 200, 1).ruinPct).toBeGreaterThan(0);
    });
});

describe('parameter search', () => {
    it('expands ranges without float drift', () => {
        expect(rangeValues({ name: 'x', from: 0.1, to: 0.5, step: 0.1 })).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
        expect(rangeValues({ name: 'x', from: 5, to: 20, step: 5 })).toEqual([5, 10, 15, 20]);
        expect(rangeValues({ name: 'b', values: [true, false] })).toEqual([true, false]);
    });

    it('builds a full grid and refuses one that is too large', () => {
        const ranges = [
            { name: 'fast', from: 5, to: 15, step: 5 },
            { name: 'slow', from: 20, to: 40, step: 10 },
            { name: 'short', values: [false, true] },
        ];
        expect(gridSize(ranges)).toBe(18);
        const grid = expandGrid(ranges);
        expect(grid.length).toBe(18);
        expect(grid[0]).toEqual({ fast: 5, slow: 20, short: false });
        expect(new Set(grid.map((g) => JSON.stringify(g))).size).toBe(18);
        expect(() => expandGrid(ranges, 10)).toThrow(/18 combinations/);
    });

    it('samples distinct combinations and returns the whole grid when it is small', () => {
        const ranges = [
            { name: 'a', from: 1, to: 50, step: 1 },
            { name: 'b', from: 1, to: 50, step: 1 },
        ];
        const sample = sampleGrid(ranges, 100, 7);
        expect(sample.length).toBe(100);
        expect(new Set(sample.map((s) => JSON.stringify(s))).size).toBe(100);
        expect(sampleGrid(ranges, 100, 7)).toEqual(sample);
        expect(sampleGrid([{ name: 'a', from: 1, to: 3, step: 1 }], 100).length).toBe(3);
    });

    it('ranks runs so that larger is better for every objective', () => {
        const good = {
            netProfit: 500,
            netProfitPct: 5,
            maxDrawdownPct: -2,
            profitFactor: 2,
            sharpe: 1.5,
            winRatePct: 60,
            trades: 40,
        };
        const bad = {
            netProfit: -100,
            netProfitPct: -1,
            maxDrawdownPct: -9,
            profitFactor: 0.8,
            sharpe: -0.2,
            winRatePct: 40,
            trades: 40,
        };
        const idle = {
            netProfit: 0,
            netProfitPct: 0,
            maxDrawdownPct: 0,
            profitFactor: null,
            sharpe: null,
            winRatePct: 0,
            trades: 0,
        };
        for (const objective of [
            'netProfit',
            'profitFactor',
            'sharpe',
            'maxDrawdown',
            'winRate',
            'returnOverDrawdown',
        ] as const) {
            expect(score(good, objective), objective).toBeGreaterThan(score(bad, objective));
        }
        // a run that never traded must not win on drawdown, win rate or profit factor
        for (const objective of ['profitFactor', 'maxDrawdown', 'winRate', 'sharpe'] as const)
            expect(score(idle, objective), objective).toBeLessThan(score(bad, objective));
    });

    it('walk-forward windows never test on data they were tuned on', () => {
        const windows = walkForwardWindows(0, 1000, 4, 0.6);
        expect(windows.length).toBe(4);
        for (const w of windows) {
            expect(w.inSample[1]).toBe(w.outOfSample[0]);
            expect(w.inSample[1] - w.inSample[0]).toBeGreaterThan(0);
        }
        for (let i = 1; i < windows.length; i++) expect(windows[i].outOfSample[0]).toBe(windows[i - 1].outOfSample[1]);
        expect(windows[0].inSample[0]).toBe(0);
        expect(windows[3].outOfSample[1]).toBe(1000);
    });
});

describe('order size', () => {
    it('is a whole number of lots, written without floating-point noise', () => {
        const { series } = market(1500, 9);
        const run = runBacktest(strategyById('ema-cross')!, series, {
            qty: { type: 'percent_of_equity', value: 10 },
            lotSize: 0.00001,
        });
        expect(run.trades.length).toBeGreaterThan(10);
        for (const t of run.trades) {
            expect(String(t.qty).length, String(t.qty)).toBeLessThanOrEqual(8);
            expect(Math.abs(t.qty / 0.00001 - Math.round(t.qty / 0.00001))).toBeLessThan(1e-6);
        }
    });
});
