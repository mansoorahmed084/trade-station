import { describe, expect, it } from 'vitest';
import { checkLimits } from '../src/limits.ts';
import { PaperBroker, type PaperOptions } from '../src/paper.ts';
import type { OrderState } from '../src/types.ts';

const T0 = Date.UTC(2026, 10, 2, 12);
const BTC = { symbol: 'X:BTC', tickSize: 0.01, lotSize: 0.001, minQty: 0.001, minNotional: 5 };
const ETH = { symbol: 'X:ETH', tickSize: 0.01, lotSize: 0.01, minQty: 0.01 };

function setup(options: Partial<PaperOptions> = {}) {
    let now = T0;
    const broker = new PaperBroker({
        initialBalance: 100_000,
        instrument: (symbol) => {
            if (symbol === BTC.symbol) return BTC;
            if (symbol === ETH.symbol) return ETH;
            throw new Error(`Unknown symbol ${symbol}`);
        },
        now: () => now,
        ...options,
    });
    const orders: OrderState[] = [];
    broker.events.on('order', (o) => orders.push(o));
    const tick = (price: number, symbol = BTC.symbol, dt = 1000) => {
        now += dt;
        broker.tick(symbol, price, now);
    };
    return {
        broker,
        orders,
        tick,
        at: (t: number) => {
            now = t;
        },
        get now() {
            return now;
        },
    };
}
const find = (b: PaperBroker, id: string) => b.orders().find((o) => o.id === id)!;

describe('order types', () => {
    it('a market order fills at once at the last price', async () => {
        const { broker, tick } = setup();
        tick(100);
        const o = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 2 });
        expect(o).toMatchObject({ status: 'filled', filledQty: 2, avgFillPrice: 100 });
        expect(broker.positions()).toMatchObject([{ symbol: BTC.symbol, qty: 2, avgPrice: 100 }]);
        tick(103);
        const account = broker.account();
        expect(account.unrealizedPnl).toBeCloseTo(6, 9);
        expect(account.equity).toBeCloseTo(100_006, 9);
        expect(account.balance).toBeCloseTo(100_000, 9);
        expect(broker.executions()).toMatchObject([{ orderId: o.id, side: 'buy', qty: 2, price: 100, realizedPnl: 0 }]);
    });

    it('charges commission and slippage, and realises the result net of both', async () => {
        const { broker, tick } = setup({ commission: { type: 'percent', value: 0.1 }, slippageTicks: 2 });
        tick(100);
        const buy = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 10 });
        expect(buy.avgFillPrice).toBeCloseTo(100.02, 9);
        tick(110);
        const sell = await broker.placeOrder({ symbol: BTC.symbol, side: 'sell', type: 'market', qty: 10 });
        expect(sell.avgFillPrice).toBeCloseTo(109.98, 9);
        const fees = 10 * 100.02 * 0.001 + 10 * 109.98 * 0.001;
        const net = (109.98 - 100.02) * 10 - fees;
        const account = broker.account();
        expect(account.commissionPaid).toBeCloseTo(fees, 9);
        expect(account.realizedPnl).toBeCloseTo(net, 9);
        expect(account.balance).toBeCloseTo(100_000 + net, 9);
        expect(account.equity).toBeCloseTo(account.balance, 9);
        expect(broker.executions()[0].realizedPnl).toBeCloseTo(net, 9);
        expect(broker.positions()).toEqual([]);
    });

    it('a limit order rests until the market trades at its price, then fills there', async () => {
        const { broker, tick } = setup();
        tick(100);
        const o = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'limit', qty: 1, limit: 97.5 });
        expect(o.status).toBe('working');
        tick(98);
        expect(find(broker, o.id).status).toBe('working');
        tick(96);
        expect(find(broker, o.id)).toMatchObject({ status: 'filled', avgFillPrice: 97.5 });
        // A limit already better than the market fills at once, at the market.
        const marketable = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 99,
        });
        expect(marketable).toMatchObject({ status: 'filled', avgFillPrice: 96 });
    });

    it('a stop must be beyond the market, and fires when the market trades through it', async () => {
        const { broker, tick } = setup();
        tick(100);
        const wrong = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'stop', qty: 1, stop: 99 });
        expect(wrong).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/above the last price/) });
        const o = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'stop', qty: 1, stop: 101.234 });
        // On the tick grid, rounded away from the market.
        expect(o).toMatchObject({ status: 'working', stop: 101.24 });
        tick(101);
        expect(find(broker, o.id).status).toBe('working');
        tick(102);
        expect(find(broker, o.id)).toMatchObject({ status: 'filled', avgFillPrice: 101.24 });
    });

    it('a stop-limit becomes a limit when its stop is reached', async () => {
        const { broker, tick } = setup();
        tick(100);
        // Sell: stop 98, limit 97.5. Trading down through 98 triggers it, and 98 already satisfies the limit.
        const o = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'sell',
            type: 'stop_limit',
            qty: 1,
            stop: 98,
            limit: 97.5,
        });
        tick(97.8);
        expect(find(broker, o.id)).toMatchObject({ status: 'filled', avgFillPrice: 98 });
        // Buy: stop 99, limit 98.8. Rising through 99 triggers it, but the market is above the limit: it waits.
        const p = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'stop_limit',
            qty: 1,
            stop: 99,
            limit: 98.8,
        });
        tick(100.5);
        expect(find(broker, p.id).status).toBe('working');
        tick(98.5);
        expect(find(broker, p.id)).toMatchObject({ status: 'filled', avgFillPrice: 98.8 });
    });

    it('a trailing stop follows the price and fires when it turns', async () => {
        const { broker, tick } = setup();
        tick(100);
        await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1 });
        const trail = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'sell',
            type: 'trailing_stop',
            qty: 1,
            trailDistance: 5,
            reduceOnly: true,
        });
        expect(trail).toMatchObject({ status: 'working', stop: 95 });
        for (const p of [102, 107, 110]) tick(p);
        expect(find(broker, trail.id).stop).toBe(105);
        tick(108); // falling does not move it back
        expect(find(broker, trail.id).stop).toBe(105);
        tick(104.5);
        expect(find(broker, trail.id)).toMatchObject({ status: 'filled', avgFillPrice: 105 });
        expect(broker.account().realizedPnl).toBeCloseTo(5, 9);
    });
});

describe('brackets', () => {
    it('exits wait for their entry, then cancel each other', async () => {
        const { broker, tick, orders } = setup();
        tick(100);
        const entry = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 2,
            limit: 99,
            bracket: { takeProfit: 105, stopLoss: 95 },
        });
        const tp = find(broker, `${entry.id}-tp`);
        const sl = find(broker, `${entry.id}-sl`);
        expect([entry.status, tp.status, sl.status]).toEqual(['working', 'inactive', 'inactive']);
        expect(tp).toMatchObject({ side: 'sell', type: 'limit', limit: 105, parentId: entry.id, role: 'take_profit' });
        tick(98.5);
        expect(find(broker, entry.id).status).toBe('filled');
        expect(find(broker, tp.id)).toMatchObject({ status: 'working', qty: 2 });
        expect(find(broker, sl.id).status).toBe('working');
        tick(106);
        expect(find(broker, tp.id)).toMatchObject({ status: 'filled', avgFillPrice: 105 });
        expect(find(broker, sl.id).status).toBe('cancelled');
        expect(broker.positions()).toEqual([]);
        expect(broker.account().realizedPnl).toBeCloseTo(12, 9);
        // Clients heard every step.
        const seen = orders.filter((o) => o.id === sl.id).map((o) => o.status);
        expect(seen).toContain('inactive');
        expect(seen).toContain('working');
        expect(seen.at(-1)).toBe('cancelled');
    });

    it('cancelling the entry cancels its exits; a bracket on the wrong side is refused', async () => {
        const { broker, tick } = setup();
        tick(100);
        const entry = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'sell',
            type: 'limit',
            qty: 1,
            limit: 102,
            bracket: { takeProfit: 98, stopLoss: 104 },
        });
        await broker.cancelOrder(entry.id);
        expect(
            broker
                .orders()
                .filter((o) => o.id.startsWith(entry.id))
                .map((o) => o.status),
        ).toEqual(['cancelled', 'cancelled', 'cancelled']);
        const bad = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'market',
            qty: 1,
            bracket: { takeProfit: 99 },
        });
        expect(bad).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/target must be above/) });
    });

    it('changing an entry moves it and its exits', async () => {
        const { broker, tick } = setup();
        tick(100);
        const entry = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 98,
            bracket: { stopLoss: 95 },
        });
        await broker.modifyOrder(entry.id, { limit: 97, bracket: { takeProfit: 104, stopLoss: 94 } });
        expect(find(broker, entry.id)).toMatchObject({ limit: 97, bracket: { takeProfit: 104, stopLoss: 94 } });
        expect(find(broker, `${entry.id}-tp`)).toMatchObject({ status: 'inactive', limit: 104 });
        expect(find(broker, `${entry.id}-sl`)).toMatchObject({ status: 'inactive', stop: 94 });
        await broker.modifyOrder(entry.id, { bracket: { takeProfit: null } });
        expect(find(broker, `${entry.id}-tp`).status).toBe('cancelled');
        await expect(broker.modifyOrder(entry.id, { limit: -1 })).rejects.toThrow(/limit price/);
        tick(96);
        expect(find(broker, `${entry.id}-sl`).status).toBe('working');
        await expect(broker.modifyOrder(entry.id, { limit: 90 })).rejects.toThrow(/filled/);
    });
});

describe('positions', () => {
    it('protects a whole position, follows its size, and drops the exits when it closes', async () => {
        const { broker, tick } = setup();
        tick(100);
        await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1 });
        await expect(broker.setPositionBrackets(BTC.symbol, { takeProfit: 99 })).rejects.toThrow(
            /above the last price/,
        );
        const p = await broker.setPositionBrackets(BTC.symbol, { takeProfit: 110, stopLoss: 90 });
        expect(p).toMatchObject({ qty: 1, takeProfit: 110, stopLoss: 90 });
        await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 2 });
        const exits = broker.orders().filter((o) => o.status === 'working');
        expect(exits.map((o) => o.qty)).toEqual([3, 3]);
        await broker.setPositionBrackets(BTC.symbol, { stopLoss: 92 });
        expect(broker.positions()[0]).toMatchObject({ stopLoss: 92, takeProfit: 110 });
        await broker.closePosition(BTC.symbol, 1);
        expect(broker.positions()[0].qty).toBe(2);
        expect(
            broker
                .orders()
                .filter((o) => o.status === 'working')
                .map((o) => o.qty),
        ).toEqual([2, 2]);
        await broker.closePosition(BTC.symbol);
        expect(broker.positions()).toEqual([]);
        expect(broker.orders().filter((o) => o.status === 'working')).toEqual([]);
        expect(await broker.closePosition(BTC.symbol)).toBeNull();
    });

    it('reverses a position in one order', async () => {
        const { broker, tick } = setup();
        tick(100);
        await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1.5 });
        await broker.setPositionBrackets(BTC.symbol, { stopLoss: 95 });
        tick(104);
        const r = await broker.reversePosition(BTC.symbol);
        expect(r).toMatchObject({ status: 'filled', qty: 3, side: 'sell' });
        expect(broker.positions()[0]).toMatchObject({ qty: -1.5, avgPrice: 104 });
        // The long's stop would now add to the short: it is gone.
        expect(broker.orders().filter((o) => o.status === 'working')).toEqual([]);
        expect(broker.account().realizedPnl).toBeCloseTo(6, 9);
    });

    it('keeps symbols apart', async () => {
        const { broker, tick } = setup();
        tick(100);
        tick(2000, ETH.symbol);
        await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1 });
        await broker.placeOrder({ symbol: ETH.symbol, side: 'sell', type: 'market', qty: 0.5 });
        tick(1900, ETH.symbol);
        tick(101);
        expect(broker.positions().map((p) => [p.symbol, p.qty, p.unrealizedPnl])).toEqual([
            [BTC.symbol, 1, 1],
            [ETH.symbol, -0.5, 50],
        ]);
        expect(broker.account().unrealizedPnl).toBeCloseTo(51, 9);
        expect(broker.watched().sort()).toEqual([BTC.symbol, ETH.symbol]);
    });
});

describe('time in force', () => {
    it('immediate-or-cancel cancels what does not fill at once', async () => {
        const { broker, tick } = setup();
        tick(100);
        const o = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 99,
            tif: 'IOC',
        });
        expect(o).toMatchObject({ status: 'cancelled', reason: expect.stringMatching(/immediate/) });
        const f = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 101,
            tif: 'IOC',
        });
        expect(f.status).toBe('filled');
    });

    it('a day order expires at the end of the UTC day; good-till-cancelled stays', async () => {
        const { broker, tick, at } = setup();
        tick(100);
        const day = await broker.placeOrder({
            symbol: BTC.symbol,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 90,
            tif: 'DAY',
        });
        const gtc = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'limit', qty: 1, limit: 90 });
        at(Date.UTC(2026, 10, 3, 0, 0, 1));
        tick(100, BTC.symbol, 0);
        expect(find(broker, day.id)).toMatchObject({
            status: 'cancelled',
            reason: expect.stringMatching(/end of the day/),
        });
        expect(find(broker, gtc.id).status).toBe('working');
        expect(broker.account().ordersToday).toBe(0);
    });
});

describe('rejections', () => {
    it('says why an order cannot be accepted', async () => {
        const { broker, tick } = setup({ initialBalance: 1000 });
        const reason = async (req: any) =>
            (await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1, ...req })).reason;
        expect(await reason({})).toMatch(/no price/);
        tick(100);
        expect(await reason({ qty: 0.0004 })).toMatch(/at least 0.001/);
        expect(await reason({ qty: 0.04 })).toMatch(/minimum is 5/);
        expect(await reason({ qty: 20 })).toMatch(/buying power/);
        expect(await reason({ symbol: 'X:NOPE' })).toMatch(/Unknown symbol/);
        expect(await reason({ type: 'limit' })).toMatch(/limit price/);
        expect(await reason({ type: 'trailing_stop' })).toMatch(/trail distance/);
        expect(await reason({ side: 'hold' })).toMatch(/buy or sell/);
        // Quantities are rounded down to the lot.
        const o = await broker.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1.23456 });
        expect(o.qty).toBe(1.234);
        // Rejected orders still appear in the history, with their reason.
        expect(broker.orders().filter((x) => x.status === 'rejected')).toHaveLength(8);
    });

    it('checks per-order and per-day limits', () => {
        const account = setup().broker.account();
        const order = { symbol: BTC.symbol, side: 'buy' as const, type: 'market' as const, qty: 3 };
        expect(checkLimits({ maxOrderValue: 1000 }, account, order, 100)).toBeNull();
        expect(checkLimits({ maxOrderValue: 250 }, account, order, 100)).toMatch(/limit per order is 250/);
        expect(checkLimits({ maxOrdersPerDay: 0 }, account, order, 100)).toMatch(/daily limit of 0 orders/);
        const losing = { ...account, dayPnl: -600 };
        expect(checkLimits({ maxDailyLoss: 500 }, losing, order, 100)).toMatch(/daily limit of 500/);
        expect(checkLimits({ maxDailyLoss: 500 }, losing, { ...order, reduceOnly: true }, 100)).toBeNull();
    });
});

describe('persistence', () => {
    it('carries on after a restart exactly as if it had kept running', async () => {
        const script = async (b: PaperBroker, tick: (p: number) => void, from: number, to: number) => {
            const prices = [100, 101, 99.5, 98.8, 102, 104.5, 103, 106.2, 101, 96, 95.5, 99, 107, 111];
            for (let i = from; i < to; i++) {
                tick(prices[i]);
                if (i === 0) {
                    await b.placeOrder({
                        symbol: BTC.symbol,
                        side: 'buy',
                        type: 'limit',
                        qty: 2,
                        limit: 99,
                        bracket: { takeProfit: 106, stopLoss: 95.8 },
                    });
                    await b.placeOrder({
                        symbol: BTC.symbol,
                        side: 'sell',
                        type: 'trailing_stop',
                        qty: 1,
                        trailDistance: 3,
                        reduceOnly: true,
                    });
                }
                if (i === 9) await b.placeOrder({ symbol: BTC.symbol, side: 'buy', type: 'market', qty: 1 });
            }
        };
        const straight = setup({ commission: { type: 'percent', value: 0.05 } });
        await script(straight.broker, straight.tick, 0, 14);

        const first = setup({ commission: { type: 'percent', value: 0.05 } });
        await script(first.broker, first.tick, 0, 7);
        const saved = JSON.parse(JSON.stringify(first.broker.snapshot()));
        const second = setup({ commission: { type: 'percent', value: 0.05 } });
        second.at(first.now);
        second.broker.restore(saved);
        await script(second.broker, second.tick, 7, 14);

        const strip = (o: OrderState) => ({
            ...o,
            id: undefined,
            parentId: undefined,
            createdAt: undefined,
            updatedAt: undefined,
            filledAt: undefined,
        });
        expect(second.broker.positions()).toEqual(straight.broker.positions());
        expect(second.broker.account().equity).toBeCloseTo(straight.broker.account().equity, 9);
        expect(second.broker.orders().map(strip)).toEqual(straight.broker.orders().map(strip));
        expect(straight.broker.executions().length).toBeGreaterThanOrEqual(3);
    });
});
