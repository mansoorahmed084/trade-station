import { describe, expect, it } from 'vitest';
import { footprints, niceStep, tpoLetter, tpoProfiles } from '../src/profile.ts';

const H = 3_600_000;
const M30 = 30 * 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const bar = (time: number, low: number, high: number) => ({ time, low, high, close: (low + high) / 2 });

describe('TPO profiles', () => {
    it('marks each band with the letters of the periods that traded there', () => {
        // Three 30-minute periods: A trades 100–102, B 101–104, C 103–103.5.
        const s = tpoProfiles([bar(T0, 100, 102), bar(T0 + M30, 101, 104), bar(T0 + 2 * M30, 103, 103.5)], {
            rowSize: 1,
        })[0];
        expect(s.rows).toEqual([
            { price: 100, letters: 'A' },
            { price: 101, letters: 'AB' },
            { price: 102, letters: 'AB' },
            { price: 103, letters: 'BC' },
            { price: 104, letters: 'B' },
        ]);
        expect(s).toMatchObject({ start: T0, end: T0 + DAY, count: 8, periods: 3, high: 104, low: 100 });
        // Initial balance: the first hour (A and B).
        expect([s.ibLow, s.ibHigh]).toEqual([100, 104]);
    });

    it('finds the point of control and a value area holding 70% of the letters', () => {
        // Letters per band, bottom to top: 1, 2, 5, 3, 1 (12 in all).
        const bars: ReturnType<typeof bar>[] = [];
        const ranges: [number, number][] = [
            [100, 104], // A: every band
            [101, 103], // B
            [102, 103], // C
            [102, 102], // D
            [102, 102], // E
        ];
        for (const [i, [lo, hi]] of ranges.entries()) bars.push(bar(T0 + i * M30, lo, hi));
        const s = tpoProfiles(bars, { rowSize: 1 })[0];
        expect(s.rows.map((r) => r.letters.length)).toEqual([1, 2, 5, 3, 1]);
        expect(s.poc).toBe(102);
        // From 102 (5): take 103 (3) over 101 (2) → 8; then 101 (2) over 104 (1) → 10 ≥ 0.7 × 12.
        expect([s.val, s.vah]).toEqual([101, 103]);
    });

    it('starts a new profile each session, and keeps bands exact on fractional rows', () => {
        const bars = [bar(T0, 0.3, 0.5), bar(T0 + DAY + H, 0.6, 0.7)];
        const sessions = tpoProfiles(bars, { rowSize: 0.1 });
        expect(sessions.map((s) => s.start)).toEqual([T0, T0 + DAY]);
        expect(sessions[0].rows.map((r) => r.price)).toEqual([0.3, 0.4, 0.5]);
        expect(sessions[1].rows.map((r) => r.letters)).toEqual(['C', 'C']);
    });

    it('names periods A–Z then a–z, and picks round row sizes', () => {
        expect([tpoLetter(0), tpoLetter(25), tpoLetter(26), tpoLetter(51), tpoLetter(52)]).toEqual([
            'A',
            'Z',
            'a',
            'z',
            'A',
        ]);
        expect([niceStep(0.37), niceStep(3), niceStep(13), niceStep(240)]).toEqual([0.5, 5, 20, 250]);
        expect(() => tpoProfiles([bar(T0, 1, 2)], { rowSize: 0 })).toThrow(/row size/);
    });
});

describe('volume footprints', () => {
    it('splits each bar’s trades by level and by side, with delta and the busiest level', () => {
        const M = 60_000;
        const trades = [
            { time: 0, price: 100.04, size: 1, side: 'buy' as const },
            { time: 10, price: 100.11, size: 2, side: 'buy' as const },
            { time: 20, price: 100.12, size: 0.5, side: 'sell' as const },
            { time: M + 5, price: 99.95, size: 3, side: 'sell' as const },
            { time: 3 * M, price: 99, size: 9, side: 'buy' as const }, // after the last bar closed
        ];
        const [a, b] = footprints([0, M], M, trades, 0.1);
        expect(a.levels).toEqual([
            { price: 100, buy: 1, sell: 0 },
            { price: 100.1, buy: 2, sell: 0.5 },
        ]);
        expect(a).toMatchObject({ buy: 3, sell: 0.5, delta: 2.5, poc: 100.1, trades: 3 });
        expect(b).toMatchObject({ buy: 0, sell: 3, delta: -3, poc: 99.9, trades: 1 });
    });
});
