import type { Bar } from '@ts/core';
import { describe, expect, it } from 'vitest';
import { BrokerEmulator } from '../src/broker.ts';

const MIN = 60_000;
const bar = (i: number, open: number, high: number, low: number, close: number): Bar => ({
    time: i * MIN,
    open,
    high,
    low,
    close,
    volume: 1,
});

describe('fill rules', () => {
    it('a market order fills at the next bar’s open', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 101, 99, 100.5));
        b.submit({ id: 'buy', side: 'buy', qty: 2, type: 'market' });
        expect(b.position).toBe(0);
        b.processBar(bar(1, 102, 103, 101, 102.5));
        expect(b.fills).toEqual([{ orderId: 'buy', time: MIN, price: 102, qty: 2, commission: 0, comment: undefined }]);
        expect(b.position).toBe(2);
        expect(b.avgPrice).toBe(102);
        expect(b.equity()).toBeCloseTo(10_000 + 2 * 0.5, 9);
    });

    it('a limit order fills at its price when the bar trades through it', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 98 });
        b.processBar(bar(1, 100, 101, 99, 100)); // never reaches 98
        expect(b.position).toBe(0);
        b.processBar(bar(2, 100, 100.5, 97, 99));
        expect(b.fills[0]).toMatchObject({ price: 98, qty: 1, time: 2 * MIN });
    });

    it('a stop order fills at its price when the bar trades through it', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'breakout', side: 'buy', qty: 1, type: 'stop', stop: 103 });
        b.processBar(bar(1, 100, 104, 99.5, 103.5));
        expect(b.fills[0]).toMatchObject({ price: 103, qty: 1 });
    });

    it('a gap fills at the open: better for a limit, worse for a stop', () => {
        const limit = new BrokerEmulator();
        limit.processBar(bar(0, 100, 100, 100, 100));
        limit.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 98 });
        limit.processBar(bar(1, 95, 96, 94, 95.5)); // opens below the limit
        expect(limit.fills[0].price).toBe(95);

        const stop = new BrokerEmulator();
        stop.processBar(bar(0, 100, 100, 100, 100));
        stop.submit({ id: 'sl', side: 'sell', qty: 1, type: 'stop', stop: 98 });
        stop.processBar(bar(1, 95, 96, 94, 95.5)); // opens below the stop
        expect(stop.fills[0].price).toBe(95);
    });

    it('a stop-limit waits for the stop, then fills only at the limit or better', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'sl', side: 'buy', qty: 1, type: 'stop_limit', stop: 102, limit: 101 });
        // dips, runs up through the stop, then closes back down through the limit
        b.processBar(bar(1, 100, 103, 99.8, 100.9));
        expect(b.fills).toEqual([expect.objectContaining({ price: 101, qty: 1 })]);

        const never = new BrokerEmulator();
        never.processBar(bar(0, 100, 100, 100, 100));
        never.submit({ id: 'sl', side: 'buy', qty: 1, type: 'stop_limit', stop: 102, limit: 101 });
        never.processBar(bar(1, 101.5, 103, 101.2, 102.8)); // stop reached, price never returns to 101
        expect(never.fills).toEqual([]);
        expect(never.orders.get('sl')).toMatchObject({ status: 'pending', triggered: true });
    });

    it('assumes open → nearer extreme → farther extreme → close inside a bar', () => {
        expect(BrokerEmulator.path(bar(0, 100, 101, 95, 99))).toEqual([100, 101, 95, 99]); // high is nearer
        expect(BrokerEmulator.path(bar(0, 100, 106, 99, 104))).toEqual([100, 99, 106, 104]); // low is nearer

        // Both a stop and a target sit inside one bar: which fills depends on that path.
        const run = (candle: Bar) => {
            const b = new BrokerEmulator();
            b.processBar(bar(0, 100, 100, 100, 100));
            b.submit({ id: 'in', side: 'buy', qty: 1, type: 'market' });
            b.processBar(bar(1, 100, 100, 100, 100));
            b.submit({ id: 'tp', side: 'sell', qty: 1, type: 'limit', limit: 104, reduceOnly: true, ocaGroup: 'x' });
            b.submit({ id: 'sl', side: 'sell', qty: 1, type: 'stop', stop: 97, reduceOnly: true, ocaGroup: 'x' });
            b.processBar(candle);
            return b;
        };
        const targetFirst = run(bar(2, 100, 105, 96, 98)); // 5 up, 4 down: low is nearer, so the stop fills first
        expect(targetFirst.trades[0]).toMatchObject({ exitId: 'sl', exitPrice: 97, pnl: -3 });
        const stopLater = run(bar(2, 100, 105, 94, 98)); // 5 up, 6 down: high is nearer, so the target fills first
        expect(stopLater.trades[0]).toMatchObject({ exitId: 'tp', exitPrice: 104, pnl: 4 });
        // one-cancels-the-other: the survivor is cancelled, the position is flat
        expect(stopLater.orders.get('sl')!.status).toBe('cancelled');
        expect(stopLater.position).toBe(0);
    });

    it('the bar magnifier resolves the same bar from its smaller bars', () => {
        const setup = () => {
            const b = new BrokerEmulator();
            b.processBar(bar(0, 100, 100, 100, 100));
            b.submit({ id: 'in', side: 'buy', qty: 1, type: 'market' });
            b.processBar(bar(1, 100, 100, 100, 100));
            b.submit({ id: 'tp', side: 'sell', qty: 1, type: 'limit', limit: 104, reduceOnly: true, ocaGroup: 'x' });
            b.submit({ id: 'sl', side: 'sell', qty: 1, type: 'stop', stop: 97, reduceOnly: true, ocaGroup: 'x' });
            return b;
        };
        const whole = bar(2, 100, 105, 96, 98);
        // What really happened inside: up to the target first, then down through the stop.
        const inside = [bar(2, 100, 105, 99.5, 104.5), { ...bar(2, 104.5, 104.8, 96, 98), time: 2 * MIN + 30_000 }];
        const coarse = setup();
        coarse.processBar(whole);
        expect(coarse.trades[0].exitId).toBe('sl'); // the assumption got it wrong
        const fine = setup();
        fine.processBar(whole, inside);
        expect(fine.trades[0]).toMatchObject({ exitId: 'tp', exitPrice: 104, pnl: 4 });
    });

    it('fills several orders in the order the price reaches them, and an entry before the exit it arms', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'entry', side: 'buy', qty: 1, type: 'stop', stop: 102 });
        b.submit({ id: 'target', side: 'sell', qty: 1, type: 'limit', limit: 105, reduceOnly: true });
        // one bar runs 100 → 99.8 → 106: entry at 102, then target at 105
        b.processBar(bar(1, 100, 106, 99.8, 105.5));
        expect(b.fills.map((f) => [f.orderId, f.price])).toEqual([
            ['entry', 102],
            ['target', 105],
        ]);
        expect(b.trades[0].pnl).toBe(3);
    });

    it('a reduce-only order never opens a position', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'x', side: 'sell', qty: 5, type: 'market', reduceOnly: true });
        b.processBar(bar(1, 100, 101, 99, 100));
        expect(b.position).toBe(0);
        expect(b.orders.get('x')).toMatchObject({ status: 'cancelled', reason: 'nothing to reduce' });
    });
});

describe('positions and accounting', () => {
    it('closes first-in first-out and reverses through zero', () => {
        const b = new BrokerEmulator();
        const step = (i: number, price: number) => b.processBar(bar(i, price, price, price, price));
        step(0, 100);
        b.submit({ id: 'a', side: 'buy', qty: 1, type: 'market' });
        step(1, 100);
        b.submit({ id: 'b', side: 'buy', qty: 2, type: 'market' });
        step(2, 110);
        expect(b.position).toBe(3);
        expect(b.openEntries).toBe(2);
        expect(b.avgPrice).toBeCloseTo((100 + 2 * 110) / 3, 9);
        // sell 4: closes 1 @100, 2 @110, and opens a short of 1
        b.submit({ id: 'c', side: 'sell', qty: 4, type: 'market' });
        step(3, 120);
        expect(b.trades.map((t) => [t.side, t.qty, t.entryPrice, t.exitPrice, t.pnl])).toEqual([
            ['long', 1, 100, 120, 20],
            ['long', 2, 110, 120, 20],
        ]);
        expect(b.position).toBe(-1);
        expect(b.avgPrice).toBe(120);
        b.submit({ id: 'd', side: 'buy', qty: 1, type: 'market' });
        step(4, 115);
        expect(b.trades[2]).toMatchObject({ side: 'short', qty: 1, entryPrice: 120, exitPrice: 115, pnl: 5 });
        expect(b.position).toBe(0);
        expect(b.realizedPnl).toBe(45);
        expect(b.equity()).toBe(10_045);
    });

    it('charges commission on both sides and slippage on market and stop fills only', () => {
        const b = new BrokerEmulator({ commission: { type: 'percent', value: 0.1 }, slippageTicks: 2, tickSize: 0.5 });
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'in', side: 'buy', qty: 10, type: 'market' });
        b.processBar(bar(1, 100, 100, 100, 100));
        expect(b.fills[0].price).toBe(101); // 2 ticks of 0.5 against the buyer
        expect(b.fills[0].commission).toBeCloseTo(10 * 101 * 0.001, 9);
        b.submit({ id: 'out', side: 'sell', qty: 10, type: 'limit', limit: 110 });
        b.processBar(bar(2, 105, 111, 104, 110));
        expect(b.fills[1].price).toBe(110); // a limit never slips
        const commission = 10 * 101 * 0.001 + 10 * 110 * 0.001;
        expect(b.trades[0].commission).toBeCloseTo(commission, 9);
        expect(b.trades[0].pnl).toBeCloseTo(10 * (110 - 101) - commission, 9);
        expect(b.equity()).toBeCloseTo(10_000 + 90 - commission, 9);

        const flat = new BrokerEmulator({ commission: { type: 'cash_per_order', value: 1.5 } });
        flat.processBar(bar(0, 100, 100, 100, 100));
        flat.submit({ id: 'in', side: 'buy', qty: 3, type: 'market' });
        flat.processBar(bar(1, 100, 100, 100, 100));
        expect(flat.fills[0].commission).toBe(1.5);
        const perUnit = new BrokerEmulator({ commission: { type: 'cash_per_contract', value: 0.25 } });
        perUnit.processBar(bar(0, 100, 100, 100, 100));
        perUnit.submit({ id: 'in', side: 'buy', qty: 4, type: 'market' });
        perUnit.processBar(bar(1, 100, 100, 100, 100));
        expect(perUnit.fills[0].commission).toBe(1);
    });

    it('unrealised result includes the commission already paid to open', () => {
        const b = new BrokerEmulator({ commission: { type: 'cash_per_order', value: 2 } });
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'in', side: 'buy', qty: 1, type: 'market' });
        b.processBar(bar(1, 100, 105, 99, 103));
        expect(b.unrealized()).toBe(1); // +3 on price, −2 commission
        expect(b.equity()).toBe(10_001);
    });

    it('records the best and worst point of each trade', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'in', side: 'buy', qty: 2, type: 'market' });
        b.processBar(bar(1, 100, 104, 97, 101));
        b.processBar(bar(2, 101, 109, 100, 108));
        b.submit({ id: 'out', side: 'sell', qty: 2, type: 'market' });
        b.processBar(bar(3, 106, 107, 105, 106));
        expect(b.trades[0]).toMatchObject({ pnl: 12, maxRunup: 18, maxDrawdown: -6 });
    });

    it('replaces a pending order submitted again under the same id, and rejects bad ones', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 100, 100, 100));
        b.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 90 });
        b.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 99 });
        b.processBar(bar(1, 100, 100, 98, 99));
        expect(b.fills.length).toBe(1);
        expect(b.fills[0].price).toBe(99);
        expect(b.submit({ id: 'z', side: 'buy', qty: 0, type: 'market' })).toMatchObject({ status: 'rejected' });
        expect(b.submit({ id: 'y', side: 'buy', qty: 1, type: 'limit' })).toMatchObject({
            status: 'rejected',
            reason: 'a limit price is required',
        });
        expect(b.cancel('nope')).toBe(false);
        b.submit({ id: 'c', side: 'buy', qty: 1, type: 'limit', limit: 50 });
        expect(b.cancel('c')).toBe(true);
        expect(b.pending()).toEqual([]);
    });
});

describe('live ticks (paper trading)', () => {
    it('fills a resting order at its own price as the price moves through it', () => {
        const b = new BrokerEmulator();
        b.processTick(100, 1);
        b.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 99 });
        b.submit({ id: 'buy', side: 'buy', qty: 1, type: 'market' });
        b.processTick(100.2, 2);
        expect(b.fills.map((f) => [f.orderId, f.price, f.time])).toEqual([['buy', 100, 2]]); // the market order trades where the price was
        b.processTick(98.5, 3);
        expect(b.fills[1]).toMatchObject({ orderId: 'bid', price: 99, time: 3 });
        expect(b.position).toBe(2);
        expect(b.equity()).toBeCloseTo(10_000 + (98.5 - 100) + (98.5 - 99), 9);
    });

    it('a limit already in reach when placed trades at the current, better price', () => {
        const b = new BrokerEmulator();
        b.processTick(100, 1);
        b.submit({ id: 'bid', side: 'buy', qty: 1, type: 'limit', limit: 105 });
        b.processTick(100.5, 2);
        expect(b.fills[0]).toMatchObject({ orderId: 'bid', price: 100 });
    });

    it('fill on close trades resting market orders at the last price without moving it', () => {
        const b = new BrokerEmulator();
        b.processBar(bar(0, 100, 102, 99, 101));
        b.submit({ id: 'buy', side: 'buy', qty: 1, type: 'market' });
        b.processClose(0);
        expect(b.fills[0]).toMatchObject({ price: 101, time: 0 });
    });

    it('reports each fill to a listener', () => {
        const b = new BrokerEmulator();
        const seen: string[] = [];
        b.onFill = (fill, order) => seen.push(`${order.id}@${fill.price}`);
        b.processTick(10, 1);
        b.submit({ id: 'a', side: 'buy', qty: 1, type: 'market' });
        b.processTick(11, 2);
        expect(seen).toEqual(['a@10']);
    });
});
