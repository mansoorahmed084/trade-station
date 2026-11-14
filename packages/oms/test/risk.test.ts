import { describe, expect, it } from 'vitest';
import { cleanRules, RiskManager } from '../src/risk.ts';
import type { AccountState } from '../src/types.ts';

const account = (over: Partial<AccountState> = {}): AccountState => ({
    id: 'paper',
    name: 'Paper',
    kind: 'paper',
    currency: 'USD',
    balance: 10_000,
    equity: 10_000,
    unrealizedPnl: 0,
    realizedPnl: 0,
    commissionPaid: 0,
    dayPnl: 0,
    ordersToday: 0,
    buyingPower: 10_000,
    connected: true,
    updatedAt: 0,
    ...over,
});
const buy = (qty: number, symbol = 'X:BTC') => ({ symbol, side: 'buy' as const, type: 'market' as const, qty });
const sell = (qty: number, symbol = 'X:BTC') => ({ symbol, side: 'sell' as const, type: 'market' as const, qty });

describe('risk manager', () => {
    it('caps the position per symbol, but always lets a position be reduced', () => {
        const risk = new RiskManager({ maxPosition: { 'X:BTC': 2 } });
        expect(risk.check({ order: buy(2), price: 100, position: 0, account: account() })).toBeNull();
        expect(risk.check({ order: buy(1), price: 100, position: 2, account: account() })).toMatch(
            /would be 3 units; the limit for X:BTC is 2/,
        );
        expect(risk.check({ order: sell(3), price: 100, position: 2, account: account() })).toBeNull(); // to −1: smaller
        expect(risk.check({ order: sell(5), price: 100, position: 2, account: account() })).toMatch(/would be 3 units/);
        expect(risk.check({ order: buy(9, 'X:ETH'), price: 1, position: 0, account: account() })).toBeNull();
    });

    it('limits order size and value, and position value', () => {
        const risk = new RiskManager({ maxOrderQty: 5, maxOrderValue: 400, maxPositionValue: 700 });
        expect(risk.check({ order: buy(6), price: 10, position: 0, account: account() })).toMatch(
            /6 units; the limit is 5/,
        );
        expect(risk.check({ order: buy(5), price: 100, position: 0, account: account() })).toMatch(
            /worth 500.00; the limit per automated order is 400/,
        );
        expect(risk.check({ order: buy(4), price: 100, position: 4, account: account() })).toMatch(
            /position would be worth 800.00/,
        );
        expect(risk.check({ order: buy(3), price: 100, position: 0, account: account() })).toBeNull();
    });

    it('stops adding after the daily loss limit and outside trading hours', () => {
        let now = Date.UTC(2026, 10, 2, 10, 30);
        const risk = new RiskManager({ maxDailyLoss: 200, tradingHours: { start: '22:00', end: '11:00' } }, () => now);
        expect(risk.check({ order: buy(1), price: 100, position: 0, account: account({ dayPnl: -250 }) })).toMatch(
            /only reduce/,
        );
        expect(risk.check({ order: sell(1), price: 100, position: 1, account: account({ dayPnl: -250 }) })).toBeNull();
        now = Date.UTC(2026, 10, 2, 12, 0);
        expect(risk.check({ order: sell(1), price: 100, position: 1, account: account() })).toMatch(
            /between 22:00 and 11:00 UTC/,
        );
        now = Date.UTC(2026, 10, 2, 23, 0); // the window wraps past midnight
        expect(risk.check({ order: buy(1), price: 100, position: 0, account: account() })).toBeNull();
    });

    it('limits the rate per account, keeps to the allow list, and refuses everything while halted', () => {
        let now = 0;
        const risk = new RiskManager({ maxOrdersPerMinute: 3, allowList: ['X:BTC'] }, () => now);
        for (let i = 0; i < 3; i++)
            expect(risk.check({ order: buy(1), price: 1, position: 0, account: account() })).toBeNull();
        expect(risk.check({ order: buy(1), price: 1, position: 0, account: account() })).toMatch(
            /more than 3 automated orders in a minute/,
        );
        expect(risk.check({ order: buy(1), price: 1, position: 0, account: account({ id: 'other' }) })).toBeNull();
        now = 61_000;
        expect(risk.check({ order: buy(1), price: 1, position: 0, account: account() })).toBeNull();
        expect(risk.check({ order: buy(1, 'X:ETH'), price: 1, position: 0, account: account() })).toMatch(
            /not on the list/,
        );
        risk.halt = { at: now, reason: 'kill switch', by: 'user' };
        expect(risk.check({ order: sell(1), price: 1, position: 1, account: account() })).toMatch(
            /halted \(kill switch\)/,
        );
    });

    it('checks rules before taking them', () => {
        expect(
            cleanRules({
                maxOrderValue: '1000',
                allowList: [' x:btc '],
                tradingHours: { start: '9:30', end: '16:00' },
            }),
        ).toEqual({
            maxOrderValue: 1000,
            allowList: ['X:BTC'],
            tradingHours: { start: '9:30', end: '16:00' },
        });
        expect(() => cleanRules({ maxOrderQty: -1 })).toThrow(/zero or more/);
        expect(() => cleanRules({ tradingHours: { start: '25:00', end: '1:00' } })).toThrow(/not a time of day/);
        expect(cleanRules({ maxPosition: { 'X:BTC': '2' } })).toEqual({ maxPosition: { 'X:BTC': 2 } });
    });
});
