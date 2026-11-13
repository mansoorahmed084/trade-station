import type { Bar } from '@ts/core';
import { RSI, series } from '@ts/indicators';
import { describe, expect, it } from 'vitest';
import { ConditionEvaluator, lineValue, plotKey, scriptAlertKey, scriptRefs, warmupBars } from '../src/evaluate.ts';
import { describeCondition, renderMessage } from '../src/template.ts';
import type { Condition } from '../src/types.ts';

const MIN = 60_000;
const bar = (i: number, close: number, extra: Partial<Bar> = {}): Bar => ({
    time: i * MIN,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    ...extra,
});
const price = { type: 'price' } as const;
const level = (value: number) => ({ type: 'value', value }) as const;

/** Feed closes as closed bars; return the indexes at which `close()` reported true. */
function closes(condition: Condition, values: number[]): number[] {
    const ev = new ConditionEvaluator(condition);
    const out: number[] = [];
    values.forEach((v, i) => {
        if (ev.close(bar(i, v))) out.push(i);
    });
    return out;
}

describe('comparisons at bar close', () => {
    it('crossing up, down and either way', () => {
        const values = [9, 10, 11, 10.5, 9.5, 10, 10.2, 9];
        expect(closes({ left: price, op: 'crossing_up', right: level(10) }, values)).toEqual([2, 6]);
        expect(closes({ left: price, op: 'crossing_down', right: level(10) }, values)).toEqual([4, 7]);
        expect(closes({ left: price, op: 'crossing', right: level(10) }, values)).toEqual([2, 4, 6, 7]);
    });

    it('follows Pine: a bar that closed exactly on the level counts as the starting side', () => {
        // same rule as ta.crossunder (`x < y and x[1] >= y[1]`): 10 → 9 against a level of 10 is a cross down
        expect(closes({ left: price, op: 'crossing', right: level(10) }, [9, 10, 9, 10, 10, 9])).toEqual([2, 5]);
        expect(closes({ left: price, op: 'crossing_up', right: level(10) }, [9, 10, 9, 10, 10, 9])).toEqual([]);
        // reaching the level is not yet a cross; leaving it on the far side is
        expect(closes({ left: price, op: 'crossing_up', right: level(10) }, [9, 10, 11])).toEqual([2]);
    });

    it('greater and less are true for as long as they hold', () => {
        expect(closes({ left: price, op: 'greater', right: level(10) }, [9, 11, 12, 10, 13])).toEqual([1, 2, 4]);
        expect(closes({ left: price, op: 'less', right: level(10) }, [9, 11, 12, 10, 8])).toEqual([0, 4]);
    });

    it('channel operators', () => {
        const channel = { upper: level(12), lower: level(8) };
        const values = [5, 9, 11, 13, 12, 7, 8];
        expect(closes({ left: price, op: 'entering_channel', ...channel }, values)).toEqual([1, 4, 6]);
        expect(closes({ left: price, op: 'exiting_channel', ...channel }, values)).toEqual([3, 5]);
        expect(closes({ left: price, op: 'inside_channel', ...channel }, values)).toEqual([1, 2, 4, 6]);
        expect(closes({ left: price, op: 'outside_channel', ...channel }, values)).toEqual([0, 3, 5]);
    });

    it('moving up and down by an amount or a percentage within N bars', () => {
        const values = [100, 101, 103, 102, 106, 100];
        expect(closes({ left: price, op: 'moving_up', amount: 3, bars: 1 }, values)).toEqual([4]);
        expect(closes({ left: price, op: 'moving_up', amount: 3, bars: 2 }, values)).toEqual([2, 4]);
        expect(closes({ left: price, op: 'moving_down', amount: 5, bars: 1 }, values)).toEqual([5]);
        expect(closes({ left: price, op: 'moving_up_pct', amount: 2.9, bars: 2 }, values)).toEqual([2, 4]);
        expect(closes({ left: price, op: 'moving_down_pct', amount: 5, bars: 1 }, values)).toEqual([5]);
    });

    it('an undefined value never triggers and is not treated as a cross when it becomes defined', () => {
        const rsi = { type: 'indicator', study: 'rsi', params: { length: 3 } } as const;
        // RSI(3) is undefined for three bars, then 100 on a pure rise
        expect(closes({ left: rsi, op: 'crossing_up', right: level(50) }, [1, 2, 3, 4, 5, 6])).toEqual([]);
        expect(closes({ left: rsi, op: 'greater', right: level(50) }, [1, 2, 3, 4, 5, 6])).toEqual([3, 4, 5]);
    });
});

describe('indicator operands', () => {
    it('track the native indicator exactly, including through peeks', () => {
        const values = Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 7) + (i % 5));
        const rsi = series(new RSI(14), values);
        const expected: number[] = [];
        for (let i = 1; i < values.length; i++) if (rsi[i - 1] <= 60 && rsi[i] > 60) expected.push(i);
        expect(expected.length).toBeGreaterThan(3);

        const ev = new ConditionEvaluator({
            left: { type: 'indicator', study: 'rsi', params: { length: 14 } },
            op: 'crossing_up',
            right: level(60),
        });
        const fired: number[] = [];
        values.forEach((v, i) => {
            // forming-bar updates must not disturb the indicator
            ev.tick(bar(i, v * 1.5));
            ev.tick(bar(i, v * 0.5));
            if (ev.close(bar(i, v))) fired.push(i);
        });
        expect(fired).toEqual(expected);
    });

    it('supports every study and output', () => {
        const studies: Condition[] = [
            { left: price, op: 'greater', right: { type: 'indicator', study: 'sma', params: { length: 5 } } },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'ema', params: { length: 5 } } },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'wma', params: { length: 5 } } },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'vwma', params: { length: 5 } } },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'rma', params: { length: 5 } } },
            {
                left: price,
                op: 'greater',
                right: { type: 'indicator', study: 'bb', params: { length: 5, mult: 2 }, output: 'lower' },
            },
            {
                left: price,
                op: 'less',
                right: { type: 'indicator', study: 'bb', params: { length: 5, mult: 2 }, output: 'upper' },
            },
            {
                left: price,
                op: 'greater',
                right: { type: 'indicator', study: 'supertrend', params: { factor: 2, period: 5 } },
            },
            {
                left: price,
                op: 'greater',
                right: { type: 'indicator', study: 'donchian', params: { length: 5 }, output: 'lower' },
            },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'lowest', params: { length: 5 } } },
            { left: price, op: 'less', right: { type: 'indicator', study: 'highest', params: { length: 5 } } },
            { left: price, op: 'greater', right: { type: 'indicator', study: 'vwap' } },
            { left: { type: 'indicator', study: 'macd', output: 'hist' }, op: 'greater', right: level(-1e9) },
            { left: { type: 'indicator', study: 'atr', params: { length: 5 } }, op: 'greater', right: level(0) },
            { left: { type: 'indicator', study: 'stoch', params: { length: 5 } }, op: 'greater', right: level(-1) },
            { left: { type: 'indicator', study: 'cci', params: { length: 5 } }, op: 'greater', right: level(-1e9) },
            { left: { type: 'indicator', study: 'roc', params: { length: 5 } }, op: 'greater', right: level(-1e9) },
            { left: { type: 'indicator', study: 'stdev', params: { length: 5 } }, op: 'greater', right: level(-1) },
            { left: { type: 'indicator', study: 'dmi', output: 'adx' }, op: 'greater', right: level(-1) },
            { left: { type: 'indicator', study: 'obv' }, op: 'greater', right: level(-1e12) },
        ];
        for (const condition of studies) {
            const ev = new ConditionEvaluator(condition);
            let fired = 0;
            for (let i = 0; i < 120; i++) {
                const c = 100 + i * 0.5 + 3 * Math.sin(i / 3);
                if (ev.close({ time: i * MIN, open: c - 0.2, high: c + 1, low: c - 1, close: c, volume: 10 + (i % 4) }))
                    fired++;
            }
            expect(fired, describeCondition(condition)).toBeGreaterThan(10);
        }
    });
});

describe('ticks inside a bar', () => {
    it('catches a level crossed mid-bar and compares bar close against the previous close', () => {
        const ev = new ConditionEvaluator({ left: price, op: 'crossing_up', right: level(100) });
        ev.seed(bar(0, 98));
        expect(ev.tick(bar(1, 99))).toBe(false);
        expect(ev.tick(bar(1, 100.5))).toBe(true); // crossed on this tick
        expect(ev.tick(bar(1, 101))).toBe(false); // already above
        expect(ev.tick(bar(1, 99.5))).toBe(false);
        expect(ev.tick(bar(1, 100.2))).toBe(true); // crossed again
        // the bar closes back below: close-to-close there was no cross
        expect(ev.close(bar(1, 99))).toBe(false);
        expect(ev.close(bar(2, 101))).toBe(true);
    });

    it('seeding never reports, and gives the first live tick something to compare against', () => {
        const ev = new ConditionEvaluator({ left: price, op: 'crossing_down', right: level(50) });
        for (let i = 0; i < 5; i++) ev.seed(bar(i, 60 - i));
        expect(ev.tick(bar(5, 49))).toBe(true);
        expect(ev.values()).toEqual({ left: 49, right: 50 });
    });
});

describe('multi-condition alerts', () => {
    const above = { left: price, op: 'greater', right: level(100) } as const;
    const volume = { left: { type: 'price', field: 'volume' }, op: 'greater', right: level(50) } as const;
    const data: [number, number][] = [
        [99, 80],
        [101, 20],
        [102, 70],
        [98, 90],
        [105, 10],
    ];
    const run = (c: Condition) => {
        const ev = new ConditionEvaluator(c);
        return data.flatMap(([p, v], i) => (ev.close(bar(i, p, { volume: v })) ? [i] : []));
    };

    it('all, any and nested groups', () => {
        expect(run({ all: [above, volume] })).toEqual([2]);
        expect(run({ any: [above, volume] })).toEqual([0, 1, 2, 3, 4]);
        expect(run({ all: [{ any: [above, volume] }, { left: price, op: 'less', right: level(102) }] })).toEqual([
            0, 1, 3,
        ]);
        expect(run({ all: [] })).toEqual([]);
    });

    it('a crossing combined with a state fires only on the bar of the cross', () => {
        expect(run({ all: [{ left: price, op: 'crossing_up', right: level(100) }, volume] })).toEqual([]);
        expect(run({ all: [{ left: price, op: 'crossing_down', right: level(100) }, volume] })).toEqual([3]);
    });
});

describe('drawn lines', () => {
    const line = { type: 'line', a: { time: 10 * MIN, price: 100 }, b: { time: 20 * MIN, price: 110 } } as const;

    it('interpolates between anchors and extends only where asked', () => {
        expect(lineValue({ ...line, extend: 'none' }, 15 * MIN)).toBe(105);
        expect(lineValue({ ...line, extend: 'none' }, 25 * MIN)).toBeNaN();
        expect(lineValue({ ...line, extend: 'right' }, 30 * MIN)).toBe(120);
        expect(lineValue({ ...line, extend: 'right' }, 5 * MIN)).toBeNaN();
        expect(lineValue({ ...line, extend: 'both' }, 0)).toBe(90);
        // anchors given right-to-left, and a horizontal line
        expect(lineValue({ type: 'line', a: line.b, b: line.a, extend: 'none' }, 15 * MIN)).toBe(105);
        expect(
            lineValue({ type: 'line', a: { time: 5, price: 42 }, b: { time: 5, price: 42 }, extend: 'none' }, 1e15),
        ).toBe(42);
    });

    it('fires when price crosses a rising trend line', () => {
        const ev = new ConditionEvaluator({ left: price, op: 'crossing_down', right: { ...line, extend: 'right' } });
        const fired: number[] = [];
        // price stays flat at 108 while the line rises through it at bar 18
        for (let i = 10; i < 26; i++) if (ev.close(bar(i, 108))) fired.push(i);
        expect(fired).toEqual([19]);
    });
});

describe('script-backed conditions', () => {
    const ref = { scriptId: 'abc', inputs: { Length: 9 } };

    it('reads plot values and script alerts handed in from outside', () => {
        const ev = new ConditionEvaluator({
            all: [
                { left: { type: 'plot', ...ref, plot: 'Fast' }, op: 'greater', right: level(10) },
                { scriptAlert: { ...ref, title: 'Go' } },
            ],
        });
        const ext = (v: number, alert: boolean) => ({
            plots: new Map([[plotKey(ref, 'Fast'), v]]),
            scriptAlerts: new Set(alert ? [scriptAlertKey(ref, 'Go')] : []),
        });
        expect(ev.close(bar(0, 1), ext(11, false))).toBe(false);
        expect(ev.close(bar(1, 1), ext(9, true))).toBe(false);
        expect(ev.close(bar(2, 1), ext(11, true))).toBe(true);
        expect(ev.close(bar(3, 1))).toBe(false); // nothing handed in: undefined plot, no alert
    });

    it('lists each distinct script once, whatever the key order of its inputs', () => {
        const refs = scriptRefs({
            any: [
                {
                    left: { type: 'plot', scriptId: 'abc', inputs: { a: 1, b: 2 }, plot: 'X' },
                    op: 'greater',
                    right: { type: 'plot', scriptId: 'abc', inputs: { b: 2, a: 1 }, plot: 'Y' },
                },
                { scriptAlert: { scriptId: 'abc', inputs: { a: 1, b: 2 } } },
                { scriptAlert: { source: 'plot(close)' } },
            ],
        });
        expect(refs.length).toBe(2);
        expect(refs.map((r) => r.scriptId ?? 'inline')).toEqual(['abc', 'inline']);
    });
});

describe('warm-up', () => {
    it('asks for enough history for the slowest indicator', () => {
        expect(warmupBars({ left: price, op: 'crossing', right: level(1) })).toBeLessThan(10);
        expect(
            warmupBars({
                left: { type: 'indicator', study: 'ema', params: { length: 200 } },
                op: 'greater',
                right: level(1),
            }),
        ).toBeGreaterThanOrEqual(1000);
        expect(warmupBars({ left: price, op: 'moving_up', amount: 1, bars: 30 })).toBeGreaterThanOrEqual(32);
    });
});

describe('messages', () => {
    const ctx = {
        alertName: 'BTC breakout',
        symbol: 'BINANCE:BTCUSDT',
        timeframe: '60',
        bar: {
            time: Date.UTC(2026, 10, 13, 9),
            open: 69000.5,
            high: 69500,
            low: 68900.25,
            close: 69420.129,
            volume: 1234.5,
        },
        now: Date.UTC(2026, 10, 13, 9, 41, 7),
        tickSize: 0.01,
        left: 69420.129,
        right: 69400,
        plots: { Fast: 69111.1234567 },
    };

    it('fills TradingView-style placeholders and leaves unknown ones visible', () => {
        const out = renderMessage(
            '{{alert_name}} | {{ticker}} on {{exchange}} {{interval}} ({{interval_label}}) O {{open}} H {{high}} L {{low}} C {{close}} V {{volume}} @ {{time}} now {{ timenow }} | {{left}} vs {{right}} | {{plot("Fast")}} | {{plot("Nope")}} | {{mystery}}',
            ctx,
        );
        expect(out).toBe(
            'BTC breakout | BTCUSDT on BINANCE 60 (1h) O 69000.50 H 69500.00 L 68900.25 C 69420.13 V 1234.5 @ 2026-11-13T09:00:00Z now 2026-11-13T09:41:07Z | 69420.129 vs 69400 | 69111.12346 | {{plot("Nope")}} | {{mystery}}',
        );
    });

    it('describes conditions in plain words', () => {
        expect(describeCondition({ left: price, op: 'crossing', right: level(70000) })).toBe('Price crossing 70000');
        expect(
            describeCondition({
                left: { type: 'indicator', study: 'rsi', params: { length: 14 } },
                op: 'greater',
                right: level(70),
            }),
        ).toBe('RSI(14) greater than 70');
        expect(describeCondition({ left: price, op: 'entering_channel', upper: level(12), lower: level(8) })).toBe(
            'Price entering channel 8 – 12',
        );
        expect(describeCondition({ left: price, op: 'moving_up_pct', amount: 2, bars: 3 })).toBe(
            'Price moving up 2% in 3 bars',
        );
        expect(
            describeCondition({
                all: [
                    { left: price, op: 'greater', right: level(1) },
                    { any: [{ scriptAlert: { title: 'Go' } }, { scriptAlert: {} }] },
                ],
            }),
        ).toBe('Price greater than 1 and (script alert "Go" or any alert() call of the script)');
    });
});
