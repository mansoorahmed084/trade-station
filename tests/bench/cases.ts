import { ConditionEvaluator } from '@ts/alerts';
import { buildReport, intrabarLookup, runBacktest, strategyById } from '@ts/backtest';
import { aggregate, type Bar, BarSeries, seededRandom } from '@ts/core';
import {
    ATR,
    BollingerBands,
    CCI,
    DMI,
    Donchian,
    EMA,
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
    VWAP,
    VWMA,
    WMA,
} from '@ts/indicators';
import { PineTS } from 'pinets';
import type { BenchCase } from './run.ts';

const MIN = 60_000;

function bars(n: number): Bar[] {
    const rnd = seededRandom(3);
    const out: Bar[] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
        const o = p;
        const c = o * (1 + (rnd() - 0.5) * 0.004);
        out.push({
            time: i * MIN,
            open: o,
            high: Math.max(o, c) * 1.0005,
            low: Math.min(o, c) * 0.9995,
            close: c,
            volume: 10 + rnd() * 90,
        });
        p = c;
    }
    return out;
}

/** Twenty-five indicators, the Premium per-chart limit, each fed what it needs from a bar. */
function twentyFive(): { study: Study<any, any>; input: (b: Bar) => unknown }[] {
    const close = (b: Bar) => b.close;
    const whole = (b: Bar) => b;
    return [
        { study: new SMA(20), input: close },
        { study: new SMA(50), input: close },
        { study: new SMA(200), input: close },
        { study: new EMA(9), input: close },
        { study: new EMA(21), input: close },
        { study: new EMA(55), input: close },
        { study: new RMA(14), input: close },
        { study: new WMA(30), input: close },
        { study: new VWMA(20), input: (b) => ({ price: b.close, volume: b.volume }) },
        { study: new StdDev(20), input: close },
        { study: new BollingerBands(20, 2), input: close },
        { study: new RSI(14), input: close },
        { study: new RSI(7), input: close },
        { study: new MACD(), input: close },
        { study: new ROC(10), input: close },
        { study: new Stochastic(14), input: whole },
        { study: new CCI(20), input: close },
        { study: new ATR(14), input: whole },
        { study: new Supertrend(3, 10), input: whole },
        { study: new DMI(14, 14), input: whole },
        { study: new Donchian(20), input: whole },
        { study: new Donchian(55), input: whole },
        { study: new OBV(), input: whole },
        { study: new VWAP(), input: whole },
        { study: new EMA(200), input: close },
    ];
}

const history = bars(100_000);
const pineBars = bars(20_000).map((b) => ({
    openTime: b.time,
    closeTime: b.time + MIN - 1,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
}));

/** A thousand alerts on one series: price levels, indicator thresholds and two-condition groups. */
function thousandAlerts(): ConditionEvaluator[] {
    const out: ConditionEvaluator[] = [];
    for (let i = 0; i < 1000; i++) {
        const level = { type: 'value', value: 50 + i } as const;
        if (i % 4 === 0)
            out.push(
                new ConditionEvaluator({
                    left: { type: 'indicator', study: 'rsi', params: { length: 14 } },
                    op: 'crossing_up',
                    right: { type: 'value', value: 70 },
                }),
            );
        else if (i % 4 === 1)
            out.push(
                new ConditionEvaluator({
                    all: [
                        {
                            left: { type: 'price' },
                            op: 'greater',
                            right: { type: 'indicator', study: 'ema', params: { length: 50 } },
                        },
                        { left: { type: 'price' }, op: 'crossing', right: level },
                    ],
                }),
            );
        else
            out.push(
                new ConditionEvaluator({
                    left: { type: 'price' },
                    op: i % 2 === 0 ? 'crossing_up' : 'crossing_down',
                    right: level,
                }),
            );
    }
    return out;
}

/** Budgets added by later phases (backtests) register here too. */
let millionBars: BarSeries | null = null;
/** One million one-minute bars on a 0.01 grid, built once. */
function million(): BarSeries {
    if (millionBars) return millionBars;
    const rnd = seededRandom(21);
    const series = new BarSeries(1_000_000);
    let p = 100;
    const cents = (v: number) => Math.round(v * 100) / 100;
    for (let i = 0; i < 1_000_000; i++) {
        const o = p;
        const c = cents(Math.max(1, o * (1 + (rnd() - 0.5) * 0.004)));
        series.append(
            i * MIN,
            o,
            cents(Math.max(o, c) * (1 + rnd() * 0.001)),
            cents(Math.min(o, c) * (1 - rnd() * 0.001)),
            c,
            10,
        );
        p = c;
    }
    millionBars = series;
    return series;
}

export const benches: BenchCase[] = [
    {
        // The plan allows 100 ms from a tick to the alert decision. This measures 100 ticks across 1,000 alerts.
        name: '1,000 alerts × 100 ticks',
        budgetMs: 100,
        run: () => {
            const alerts = thousandAlerts();
            for (const bar of history.slice(0, 400)) for (const a of alerts) a.seed(bar);
            const forming = history[400];
            const t0 = performance.now();
            for (let tick = 0; tick < 100; tick++) {
                const bar = { ...forming, close: forming.close * (1 + (tick % 9) * 1e-4) };
                for (const a of alerts) a.tick(bar);
            }
            return performance.now() - t0;
        },
    },
    {
        // The plan allows 2 ms per tick for 25 indicators (2,000 ms here). The budget below is a regression guard far inside that.
        name: '25 native indicators × 1,000 live ticks',
        budgetMs: 25,
        run: () => {
            const set = twentyFive();
            for (const bar of history.slice(0, 5000)) for (const s of set) s.study.push(s.input(bar));
            const forming = history[5000];
            const t0 = performance.now();
            for (let tick = 0; tick < 1000; tick++) {
                const bar = { ...forming, close: forming.close * (1 + (tick % 7) * 1e-5) };
                for (const s of set) s.study.peek(s.input(bar));
            }
            return performance.now() - t0;
        },
    },
    {
        name: '25 native indicators over 100K bars',
        budgetMs: 150,
        run: () => {
            const set = twentyFive();
            for (const bar of history) for (const s of set) s.study.push(s.input(bar));
        },
    },
    {
        name: 'Pine: 6-plot indicator over 20K bars',
        budgetMs: 400,
        runs: 3,
        run: async () => {
            await new PineTS(pineBars as any).run(
                '//@version=6\nindicator("b")\nplot(ta.ema(close, 21))\nplot(ta.rsi(close, 14))\n[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(h)\nplot(ta.atr(14))\n[u, v, w] = ta.bb(close, 20, 2.0)\nplot(v)\nplot(ta.sma(close, 200))',
            );
        },
    },
    {
        // The plan's budget is 5 s for a million bars; the limit below is a regression guard far inside it.
        name: 'Backtest: native EMA cross + report over 1M bars',
        budgetMs: 400,
        runs: 3,
        run: () => {
            const series = million();
            const t0 = performance.now();
            const run = runBacktest(strategyById('ema-cross')!, series, { broker: { tickSize: 0.01 } });
            buildReport(run.trades, series, 10_000, MIN);
            return performance.now() - t0;
        },
    },
    {
        name: 'Backtest: bar magnifier, 100K 10m bars read as 1M 1m bars',
        budgetMs: 500,
        runs: 3,
        run: () => {
            const fine = million();
            const coarse = aggregate(fine, '10');
            const t0 = performance.now();
            runBacktest(strategyById('donchian-breakout')!, coarse, {
                broker: { tickSize: 0.01 },
                intrabar: intrabarLookup(fine, '10'),
            });
            return performance.now() - t0;
        },
    },
    {
        name: 'Backtest: 200 parameter sets × 20K bars, one thread',
        budgetMs: 1200,
        runs: 2,
        run: () => {
            const series = million().slice(0, 20_000);
            const t0 = performance.now();
            for (let fast = 2; fast < 22; fast++) {
                for (let slow = 30; slow < 130; slow += 10) {
                    const run = runBacktest(strategyById('ema-cross')!, series, {
                        broker: { tickSize: 0.01 },
                        inputs: { fast, slow },
                    });
                    buildReport(run.trades, series, 10_000, MIN);
                }
            }
            return performance.now() - t0;
        },
    },
    {
        // The Pine runtime costs several microseconds a bar: a million bars takes it about 8 s,
        // which is over the plan's 5 s budget. This guards the speed it does have.
        name: 'Backtest: Pine EMA-cross strategy over 20K bars',
        budgetMs: 500,
        runs: 3,
        run: async () => {
            await new PineTS(pineBars as any).run(
                '//@version=6\nstrategy("b", default_qty_type=strategy.percent_of_equity, default_qty_value=10)\nf = ta.ema(close, 9)\ns = ta.ema(close, 21)\na = ta.atr(14)\nif ta.crossover(f, s)\n    strategy.entry("L", strategy.long)\n    strategy.exit("X", "L", stop=close - 2 * a, limit=close + 3 * a)\nif ta.crossunder(f, s)\n    strategy.close("L")',
            );
        },
    },
];
