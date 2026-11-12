import { describe, expect, it } from 'vitest';
import {
    aggregate,
    type Bar,
    BarSeries,
    barCloseTime,
    barOpenTime,
    canAggregate,
    decimalsOf,
    floorToLot,
    LiveAggregator,
    normalizeTimeframe,
    parseTimeframe,
    roundToTick,
    seededRandom,
    timeframeMs,
    toTicks,
} from '../src/index.ts';

const MIN = 60_000;
const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): Bar => ({
    time,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
});

describe('timeframe', () => {
    it('parses every accepted spelling', () => {
        expect(parseTimeframe('60')).toEqual({ n: 60, unit: 'm' });
        expect(parseTimeframe('4h')).toEqual({ n: 240, unit: 'm' });
        expect(parseTimeframe('15S')).toEqual({ n: 15, unit: 'S' });
        expect(parseTimeframe('D')).toEqual({ n: 1, unit: 'D' });
        expect(parseTimeframe('1w')).toEqual({ n: 1, unit: 'W' });
        expect(parseTimeframe('3M')).toEqual({ n: 3, unit: 'M' });
        expect(parseTimeframe('1m')).toEqual({ n: 1, unit: 'm' });
        expect(() => parseTimeframe('abc')).toThrow();
        expect(() => parseTimeframe('0')).toThrow();
        expect(() => parseTimeframe('')).toThrow();
    });

    it('normalises to canonical notation', () => {
        expect(normalizeTimeframe('1h')).toBe('60');
        expect(normalizeTimeframe('d')).toBe('1D');
        expect(normalizeTimeframe('30s')).toBe('30S');
    });

    it('aligns intraday and daily bars to UTC', () => {
        const t = Date.UTC(2024, 2, 15, 13, 47, 31, 250);
        expect(barOpenTime(t, '1')).toBe(Date.UTC(2024, 2, 15, 13, 47));
        expect(barOpenTime(t, '15')).toBe(Date.UTC(2024, 2, 15, 13, 45));
        expect(barOpenTime(t, '240')).toBe(Date.UTC(2024, 2, 15, 12));
        expect(barOpenTime(t, '1D')).toBe(Date.UTC(2024, 2, 15));
        expect(barOpenTime(t, '5S')).toBe(Date.UTC(2024, 2, 15, 13, 47, 30));
    });

    it('starts weeks on Monday and months on the 1st', () => {
        // 2024-03-15 is a Friday; its week opened Monday 2024-03-11.
        const t = Date.UTC(2024, 2, 15, 13);
        expect(barOpenTime(t, '1W')).toBe(Date.UTC(2024, 2, 11));
        expect(new Date(barOpenTime(t, '1W')).getUTCDay()).toBe(1);
        expect(barOpenTime(t, '1M')).toBe(Date.UTC(2024, 2, 1));
        expect(barOpenTime(t, '3M')).toBe(Date.UTC(2024, 0, 1));
        expect(barCloseTime(Date.UTC(2024, 1, 1), '1M')).toBe(Date.UTC(2024, 2, 1)); // leap February
        expect(barCloseTime(Date.UTC(2024, 11, 1), '1M')).toBe(Date.UTC(2025, 0, 1));
    });

    it('is idempotent: the open of a bar open is itself', () => {
        const rnd = seededRandom(7);
        for (const tf of ['1', '5', '45', '60', '240', '1D', '1W', '1M', '15S']) {
            for (let i = 0; i < 200; i++) {
                const t = Math.floor(rnd() * 1.8e12);
                const open = barOpenTime(t, tf);
                expect(open).toBeLessThanOrEqual(t);
                expect(barOpenTime(open, tf)).toBe(open);
                expect(barCloseTime(open, tf)).toBeGreaterThan(t);
            }
        }
    });

    it('knows which timeframes can be built from which', () => {
        expect(canAggregate('1', '5')).toBe(true);
        expect(canAggregate('1', '45')).toBe(true);
        expect(canAggregate('45', '240')).toBe(false);
        expect(canAggregate('60', '1D')).toBe(true);
        expect(canAggregate('1D', '1W')).toBe(true);
        expect(canAggregate('1D', '1M')).toBe(true);
        expect(canAggregate('1W', '1M')).toBe(false);
        expect(canAggregate('5', '1')).toBe(false);
        expect(canAggregate('1S', '1')).toBe(true);
        expect(timeframeMs('240')).toBe(240 * MIN);
    });
});

describe('BarSeries', () => {
    it('appends, updates and inserts in order', () => {
        const s = new BarSeries(2);
        expect(s.upsert(bar(2 * MIN, 1, 2, 0, 1))).toBe('appended');
        expect(s.upsert(bar(4 * MIN, 1, 2, 0, 1))).toBe('appended');
        expect(s.upsert(bar(4 * MIN, 1, 5, 0, 3))).toBe('updated');
        expect(s.upsert(bar(3 * MIN, 9, 9, 9, 9))).toBe('inserted');
        expect(s.upsert(bar(1 * MIN, 7, 7, 7, 7))).toBe('inserted');
        expect(s.length).toBe(4);
        expect(Array.from(s.time.subarray(0, 4))).toEqual([1 * MIN, 2 * MIN, 3 * MIN, 4 * MIN]);
        expect(s.at(3).high).toBe(5);
        expect(() => s.append(4 * MIN, 0, 0, 0, 0, 0)).toThrow();
    });

    it('searches by time', () => {
        const s = BarSeries.fromBars([1, 2, 4, 5].map((m) => bar(m * MIN, 1, 1, 1, 1)));
        expect(s.indexOf(4 * MIN)).toBe(2);
        expect(s.indexOf(3 * MIN)).toBe(-1);
        expect(s.indexAtOrBefore(3 * MIN)).toBe(1);
        expect(s.indexAtOrBefore(0)).toBe(-1);
        expect(s.lowerBound(99 * MIN)).toBe(4);
        expect(s.range(2 * MIN, 5 * MIN).length).toBe(2);
    });

    it('round-trips through the binary encoding, including from an unaligned Node Buffer', () => {
        const rnd = seededRandom(1);
        const s = new BarSeries();
        for (let i = 0; i < 5000; i++) s.append(i * MIN, rnd(), rnd(), rnd(), rnd(), rnd() * 1e6);
        const buf = s.encode();
        expect(buf.byteLength).toBe(8 + 6 * 5000 * 8);
        const back = BarSeries.decode(buf);
        expect(back.length).toBe(5000);
        expect(back.toBars()).toEqual(s.toBars());

        const shifted = new Uint8Array(buf.byteLength + 3);
        shifted.set(new Uint8Array(buf), 3);
        expect(BarSeries.decode(shifted.subarray(3)).toBars(4990)).toEqual(s.toBars(4990));
        expect(() => BarSeries.decode(new ArrayBuffer(4))).toThrow();
        expect(() => BarSeries.decode(new ArrayBuffer(16))).toThrow();
    });

    it('merges overlapping series with the newer data winning', () => {
        const a = BarSeries.fromBars([1, 2, 3].map((m) => bar(m * MIN, 1, 1, 1, 1)));
        const b = BarSeries.fromBars([3, 4].map((m) => bar(m * MIN, 2, 2, 2, 2)));
        a.merge(b);
        expect(a.length).toBe(4);
        expect(a.at(2).close).toBe(2);
        const older = BarSeries.fromBars([bar(0, 5, 5, 5, 5)]);
        a.merge(older);
        expect(a.time[0]).toBe(0);
        expect(a.length).toBe(5);
    });
});

describe('aggregation', () => {
    const base = BarSeries.fromBars([
        bar(0 * MIN, 10, 12, 9, 11, 5),
        bar(1 * MIN, 11, 15, 10, 14, 3),
        bar(2 * MIN, 14, 14, 8, 9, 2),
        bar(5 * MIN, 9, 10, 9, 10, 1),
        bar(6 * MIN, 10, 20, 10, 18, 4),
    ]);

    it('builds coarse bars with correct OHLCV', () => {
        const five = aggregate(base, '5');
        expect(five.toBars()).toEqual([bar(0, 10, 15, 8, 9, 10), bar(5 * MIN, 9, 20, 9, 18, 5)]);
    });

    it('live aggregation equals batch aggregation at every step, even with forming-bar updates', () => {
        const rnd = seededRandom(42);
        const closed = new BarSeries();
        const live = new LiveAggregator('15');
        let price = 100;
        for (let i = 0; i < 400; i++) {
            const t = i * MIN;
            const open = price;
            let high = open;
            let low = open;
            let close = open;
            let vol = 0;
            // each base bar forms over several ticks
            for (let k = 0; k < 4; k++) {
                close += (rnd() - 0.5) * 2;
                high = Math.max(high, close);
                low = Math.min(low, close);
                vol += rnd() * 10;
                const forming = bar(t, open, high, low, close, vol);
                const update = live.push(forming)!;
                const reference = closed.slice();
                reference.upsert(forming);
                const batch = aggregate(reference, '15');
                const want = batch.last()!;
                expect(update.bar.time).toBe(want.time);
                expect(update.bar.open).toBe(want.open);
                expect(update.bar.high).toBe(want.high);
                expect(update.bar.low).toBe(want.low);
                expect(update.bar.close).toBe(want.close);
                expect(update.bar.volume).toBeCloseTo(want.volume, 9);
                expect(update.opened).toBe(k === 0 && i % 15 === 0);
            }
            closed.append(t, open, high, low, close, vol);
            price = close;
        }
    });

    it('ignores stale base bars', () => {
        const live = new LiveAggregator('5');
        live.push(bar(5 * MIN, 1, 1, 1, 1));
        live.push(bar(6 * MIN, 1, 2, 1, 2));
        expect(live.push(bar(5 * MIN, 9, 9, 9, 9))).toBeNull();
        expect(live.push(bar(0, 9, 9, 9, 9))).toBeNull();
        expect(live.current()!.high).toBe(2);
    });
});

describe('price maths', () => {
    it('counts decimals for tick sizes', () => {
        expect(decimalsOf(0.01)).toBe(2);
        expect(decimalsOf(0.00000001)).toBe(8);
        expect(decimalsOf(1e-8)).toBe(8);
        expect(decimalsOf(5)).toBe(0);
        expect(decimalsOf(0.25)).toBe(2);
    });

    it('snaps prices to the tick grid without float drift', () => {
        expect(roundToTick(0.1 + 0.2, 0.01)).toBe(0.3);
        expect(roundToTick(71560.014, 0.01)).toBe(71560.01);
        expect(roundToTick(4512.37, 0.25)).toBe(4512.25);
        expect(toTicks(71560.01, 0.01)).toBe(7156001);
    });

    it('floors quantities to the lot grid', () => {
        expect(floorToLot(0.123456, 0.001)).toBe(0.123);
        expect(floorToLot(0.3, 0.1)).toBe(0.3);
        expect(floorToLot(5.99, 1)).toBe(5);
    });
});
