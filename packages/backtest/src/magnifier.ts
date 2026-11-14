import { type Bar, type BarSeries, barCloseTime, canAggregate, timeframeMs } from '@ts/core';

const MIN = 60_000;
const DAY = 86_400_000;

/** Chart timeframe at or above the first number reads the second. After TradingView's bar-magnifier table. */
const TABLE: [atLeast: number, lower: string][] = [
    [7 * DAY, '1D'],
    [3 * DAY, '240'],
    [DAY, '60'],
    [240 * MIN, '30'],
    [60 * MIN, '10'],
    [30 * MIN, '5'],
    [15 * MIN, '2'],
    [2 * MIN, '1'],
];

/**
 * The smaller timeframe the bar magnifier walks through for a chart timeframe, or `null` when
 * there is nothing finer to read (the stored history starts at one minute).
 */
export function magnifierTimeframe(timeframe: string): string | null {
    const ms = timeframeMs(timeframe);
    for (const [atLeast, lower] of TABLE) {
        if (ms < atLeast) continue;
        if (canAggregate(lower, timeframe)) return lower;
        return canAggregate('1', timeframe) ? '1' : null;
    }
    return null;
}

/**
 * The bars of `lower` that fall inside each bar of the chart series, for `runBacktest`'s `intrabar`
 * option. Bars are asked for in order, so this keeps a cursor instead of searching.
 */
export function intrabarLookup(lower: BarSeries, timeframe: string): (bar: Bar, index: number) => Bar[] | undefined {
    let cursor = 0;
    return (bar) => {
        if (cursor >= lower.length || lower.time[cursor] > bar.time) cursor = lower.lowerBound(bar.time);
        while (cursor < lower.length && lower.time[cursor] < bar.time) cursor++;
        const end = barCloseTime(bar.time, timeframe);
        const out: Bar[] = [];
        while (cursor < lower.length && lower.time[cursor] < end) {
            out.push({
                time: lower.time[cursor],
                open: lower.open[cursor],
                high: lower.high[cursor],
                low: lower.low[cursor],
                close: lower.close[cursor],
                volume: lower.volume[cursor],
            });
            cursor++;
        }
        return out.length ? out : undefined;
    };
}
