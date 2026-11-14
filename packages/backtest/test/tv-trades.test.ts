import { describe, expect, it } from 'vitest';
import type { TradeRecord } from '../src/report.ts';
import { compareTrades, parseTvTrades, tradesToCsv } from '../src/tv-trades.ts';

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 2, 8);
const trade = (i: number, side: 'long' | 'short', entry: number, exit: number, qty = 1): TradeRecord => ({
    side,
    qty,
    entryTime: T0 + i * 10 * HOUR,
    entryPrice: entry,
    entryId: side === 'long' ? 'Long' : 'Short',
    exitTime: T0 + (i * 10 + 4) * HOUR,
    exitPrice: exit,
    exitId: 'Exit',
    pnl: (exit - entry) * qty * (side === 'long' ? 1 : -1),
    commission: 0,
    open: false,
});
const OURS = [
    trade(0, 'long', 100, 104),
    trade(1, 'short', 105, 101, 2),
    trade(2, 'long', 99.5, 98.25),
    trade(3, 'long', 98, 103),
];

describe('TradingView trade lists', () => {
    it('reads the classic export: entry row, then exit row', () => {
        const csv = [
            'Trade #,Type,Signal,Date/Time,Price USDT,Contracts,Profit USDT,Profit %,Cum. Profit USDT,Cum. Profit %,Run-up USDT,Run-up %,Drawdown USDT,Drawdown %',
            '1,Entry long,Long,2024-01-02 08:00,42000.5,0.25,,,,,,,,',
            '1,Exit long,Long exit,2024-01-02 20:00,42400.5,0.25,89.5,0.85,89.5,0.9,120,1.1,−30,−0.3',
            '2,Entry short,Short,2024-01-03 04:00,42100,0.25,,,,,,,,',
            '2,Exit short,Open,,,0.25,−12.5,,,,,,,',
        ].join('\n');
        const trades = parseTvTrades(csv);
        expect(trades).toHaveLength(2);
        expect(trades[0]).toEqual({
            number: 1,
            side: 'long',
            entryTime: Date.UTC(2024, 0, 2, 8),
            entryPrice: 42000.5,
            exitTime: Date.UTC(2024, 0, 2, 20),
            exitPrice: 42400.5,
            qty: 0.25,
            profit: 89.5,
            open: false,
        });
        expect(trades[1]).toMatchObject({ side: 'short', open: true, profit: -12.5 });
    });

    it('reads the newer export: exit row first, renamed columns, a chart time zone', () => {
        const csv = [
            '﻿Trade #,Type,Date/Time,Signal,Price USD,Position size (qty),Position size (value),Net P&L USD,Net P&L %,Run-up USD,Run-up %,Drawdown USD,Drawdown %,Cumulative P&L USD,Cumulative P&L %',
            '1,Exit long,2024-03-05 16:30,"Target, hit",185.2,10,"1,852",31.5,1.73,40,2.2,-8,-0.4,31.5,0.3',
            '1,Entry long,2024-03-05 09:30,Buy,182.05,10,"1,820.5",31.5,1.73,40,2.2,-8,-0.4,31.5,0.3',
        ].join('\r\n');
        const [t] = parseTvTrades(csv, { utcOffsetMinutes: -300 });
        expect(t).toMatchObject({
            side: 'long',
            entryPrice: 182.05,
            exitPrice: 185.2,
            qty: 10,
            profit: 31.5,
            open: false,
        });
        expect(t.entryTime).toBe(Date.UTC(2024, 2, 5, 14, 30));
        expect(t.exitTime).toBe(Date.UTC(2024, 2, 5, 21, 30));
    });

    it('refuses a file that is not a trade list', () => {
        expect(() => parseTvTrades('time,open,high,low,close\n1,2,3,4,5')).toThrow(/List of trades/);
        expect(parseTvTrades('')).toEqual([]);
    });

    it('a run compared with its own export agrees completely', () => {
        const theirs = parseTvTrades(tradesToCsv(OURS));
        const c = compareTrades(OURS, theirs, { barMs: HOUR });
        expect(c).toMatchObject({ ours: 4, theirs: 4, matched: 4, identical: 4, agreementPct: 100, mismatches: [] });
        expect(c.netProfit.diffPct).toBeCloseTo(0, 9);
    });

    it('names every difference', () => {
        const theirs = parseTvTrades(tradesToCsv(OURS));
        theirs[0].exitPrice = 104.5; // a different fill
        theirs[1].qty = 2.5; // a different size
        theirs.splice(2, 1); // a trade TradingView did not take
        theirs.push({
            number: 9,
            side: 'short',
            entryTime: T0 + 90 * HOUR,
            entryPrice: 50,
            exitTime: T0 + 91 * HOUR,
            exitPrice: 49,
            qty: 1,
            profit: 1,
            open: false,
        });
        const c = compareTrades(OURS, theirs, { barMs: HOUR });
        expect(c.matched).toBe(3);
        expect(c.identical).toBe(1);
        expect(c.extra).toHaveLength(1);
        expect(c.extra[0].entryPrice).toBe(99.5);
        expect(c.missing.map((t) => t.number)).toEqual([9]);
        expect(c.mismatches.map((m) => `${m.number}:${m.field}`)).toEqual(['1:exit price', '2:quantity']);
        expect(c.maxPriceDiffPct).toBeCloseTo((0.5 / 104.5) * 100, 6);
        expect(c.agreementPct).toBe(25);
    });

    it('matches a trade entered one bar apart, but not two', () => {
        const theirs = parseTvTrades(tradesToCsv(OURS));
        theirs[0].entryTime += HOUR;
        theirs[3].entryTime += 2 * HOUR;
        const c = compareTrades(OURS, theirs, { barMs: HOUR });
        expect(c.matched).toBe(3);
        expect(c.missing).toHaveLength(1);
    });
});
