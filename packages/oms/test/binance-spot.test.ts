import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BinanceSpotBroker } from '../src/binance-spot.ts';
import type { OrderState } from '../src/types.ts';
import { FakeBinance } from './fake-binance.ts';

const SYMBOL = 'BINANCE:BTCUSDT';
const instrument = (symbol: string) => {
    if (symbol !== SYMBOL) throw new Error(`Unknown symbol ${symbol}`);
    return { symbol, tickSize: 0.01, lotSize: 0.0001, minQty: 0.0001, minNotional: 5 };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await wait(20);
    return check();
}

let venue: FakeBinance;
let broker: BinanceSpotBroker;
let saved: Record<string, any> = {};

const make = (secret?: string) =>
    new BinanceSpotBroker({
        apiKey: venue.apiKey,
        apiSecret: secret ?? venue.secret,
        restBase: venue.url,
        wsApiBase: venue.wsUrl,
        WebSocket: WebSocket as any,
        instrument,
        pending: { load: () => saved, save: (v) => (saved = JSON.parse(JSON.stringify(v))) },
    });
const find = (id: string) => broker.orders().find((o) => o.id === id)!;

beforeEach(async () => {
    saved = {};
    venue = new FakeBinance();
    await venue.start();
    broker = make();
    await broker.start();
    await until(() => broker.isConnected);
    broker.tick(SYMBOL, 100);
});

afterEach(async () => {
    broker.close();
    await venue.stop();
});

describe('Binance spot account', () => {
    it('is a sandbox account unless live trading is asked for, and reads the balance', () => {
        expect(broker.kind).toBe('sandbox');
        expect(broker.id).toBe('binance-testnet');
        expect(broker.account()).toMatchObject({
            kind: 'sandbox',
            currency: 'USDT',
            balance: 10_000,
            buyingPower: 10_000,
            connected: true,
        });
        expect(new BinanceSpotBroker({ apiKey: 'a', apiSecret: 'b', instrument, live: true }).kind).toBe('live');
        expect(() => new BinanceSpotBroker({ apiKey: '', apiSecret: '', instrument })).toThrow(/key and secret/);
    });

    it('signs every request: a wrong secret is refused by the exchange', async () => {
        const bad = make('wrong');
        await expect(bad.start()).rejects.toThrow(/Signature for this request is not valid/);
        bad.close();
        expect(venue.requests.every((r) => r.params.signature && r.params.timestamp)).toBe(true);
    });

    it('buys at the market and shows the position from the balance, with its cost', async () => {
        const o = await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'market', qty: 2 });
        expect(o).toMatchObject({ status: 'filled', filledQty: 2, avgFillPrice: 100 });
        await until(() => broker.positions().length === 1);
        expect(broker.positions()[0]).toMatchObject({ symbol: SYMBOL, qty: 2, avgPrice: 100 });
        expect(broker.executions()[0]).toMatchObject({
            orderId: o.id,
            side: 'buy',
            qty: 2,
            price: 100,
            commission: expect.closeTo(0.2, 9),
        });
        broker.tick(SYMBOL, 110);
        expect(broker.positions()[0].unrealizedPnl).toBeCloseTo(20, 9);
        expect(broker.account().equity).toBeCloseTo(10_000 - 200.2 + 220, 6);
    });

    it('rests a limit order, hears its fill over the stream, and keeps its id through a change', async () => {
        const o = await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', qty: 1, limit: 95 });
        expect(o.status).toBe('working');
        const moved = await broker.modifyOrder(o.id, { limit: 96.5 });
        expect(moved).toMatchObject({ id: o.id, limit: 96.5, status: 'working' });
        expect(
            venue.requests.some(
                (r) => r.path === '/api/v3/order/cancelReplace' && r.params.cancelReplaceMode === 'STOP_ON_FAILURE',
            ),
        ).toBe(true);
        venue.setPrice('BTCUSDT', 96);
        expect(await until(() => find(o.id).status === 'filled')).toBe(true);
        expect(find(o.id)).toMatchObject({ filledQty: 1, avgFillPrice: 96.5 });
        await until(() => broker.positions()[0]?.qty === 1);
        expect(broker.positions()[0].avgPrice).toBe(96.5);
    });

    it('cancels an order', async () => {
        const o = await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', qty: 1, limit: 90 });
        const c = await broker.cancelOrder(o.id);
        expect(c.status).toBe('cancelled');
        expect(broker.account().buyingPower).toBeCloseTo(10_000, 6);
    });

    it('places a filled entry’s exits as one order list, and the target cancels the stop', async () => {
        const o = await broker.placeOrder({
            symbol: SYMBOL,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 99,
            bracket: { takeProfit: 110, stopLoss: 92 },
        });
        expect(saved[o.id]).toBeDefined();
        venue.setPrice('BTCUSDT', 98.5);
        expect(await until(() => broker.orders().some((x) => x.id === `${o.id}-tp` && x.status === 'working'))).toBe(
            true,
        );
        const oco = venue.requests.find((r) => r.path === '/api/v3/orderList/oco')!;
        expect(oco.params).toMatchObject({
            side: 'SELL',
            aboveType: 'LIMIT_MAKER',
            abovePrice: '110.00',
            belowType: 'STOP_LOSS',
            belowStopPrice: '92.00',
        });
        expect(saved[o.id]).toBeUndefined();
        await until(() => broker.positions()[0]?.takeProfit === 110);
        expect(broker.positions()[0]).toMatchObject({ qty: 1, takeProfit: 110, stopLoss: 92 });
        venue.setPrice('BTCUSDT', 111);
        expect(
            await until(() => find(`${o.id}-tp`).status === 'filled' && find(`${o.id}-sl`).status === 'cancelled'),
        ).toBe(true);
        await until(() => broker.positions().length === 0);
        expect(broker.positions()).toEqual([]);
        expect(broker.account().realizedPnl).toBeCloseTo(11, 6);
    });

    it('protects a position, and cancelling one exit puts the other back on its own', async () => {
        await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'market', qty: 1 });
        await until(() => broker.positions().length === 1);
        await broker.setPositionBrackets(SYMBOL, { takeProfit: 120, stopLoss: 90 });
        const legs = broker.orders().filter((o) => o.status === 'working');
        expect(legs.map((o) => o.role).sort()).toEqual(['stop_loss', 'take_profit']);
        const tp = legs.find((o) => o.role === 'take_profit')!;
        await broker.cancelOrder(tp.id);
        const left = broker.orders().filter((o) => o.status === 'working');
        expect(left).toHaveLength(1);
        expect(left[0]).toMatchObject({ role: 'stop_loss', stop: 90 });
        expect(venue.orders.filter((o) => o.status === 'NEW').map((o) => o.type)).toEqual(['STOP_LOSS']);
    });

    it('keeps to what a spot account can do, and passes on the exchange’s refusals', async () => {
        const reason = async (req: any) =>
            (await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'market', qty: 1, ...req })).reason;
        expect(await reason({ side: 'sell' })).toMatch(/only sell what it holds/);
        expect(await reason({ tif: 'DAY', type: 'limit', limit: 90 })).toMatch(/no day orders/);
        expect(await reason({ symbol: 'SYNTH:ALPHA' })).toMatch(/Binance symbols only/);
        expect(await reason({ qty: 1000 })).toMatch(/insufficient balance/);
        await expect(broker.reversePosition()).rejects.toThrow(/cannot hold a short/);
        venue.refuse = { path: '/api/v3/order', code: -1013, msg: 'Filter failure: PRICE_FILTER' };
        expect(await reason({ type: 'limit', limit: 90 })).toMatch(/PRICE_FILTER/);
        // A trailing stop is sent as a share of the price, in basis points.
        await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'market', qty: 1 });
        await until(() => broker.positions().length === 1);
        const trail = await broker.placeOrder({
            symbol: SYMBOL,
            side: 'sell',
            type: 'trailing_stop',
            qty: 1,
            trailDistance: 2,
        });
        expect(trail.status).toBe('working');
        expect(venue.requests.at(-1)!.params).toMatchObject({ type: 'STOP_LOSS', trailingDelta: '200' });
    });

    it('after a dropped connection, learns what happened while it was not listening', async () => {
        const o = await broker.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', qty: 1, limit: 97 });
        const events: OrderState[] = [];
        broker.events.on('order', (e) => events.push(e));
        venue.dropConnections();
        expect(await until(() => !broker.isConnected)).toBe(true);
        expect(broker.account().connected).toBe(false);
        // The order fills while nobody is listening, and someone trades on the exchange's own site.
        venue.setPrice('BTCUSDT', 96);
        venue.placeElsewhere('BTCUSDT', 'BUY', 0.5, 80);
        expect(find(o.id).status).toBe('working');
        // The adapter reconnects by itself and reads everything back.
        expect(await until(() => broker.isConnected && find(o.id).status === 'filled', 8000)).toBe(true);
        const report = broker.lastReconcile!;
        expect(report.changed).toContainEqual({ id: o.id, from: 'working', to: 'filled' });
        expect(report.missedFills).toBe(1);
        expect(report.adopted).toHaveLength(1);
        expect(broker.executions().some((e) => e.orderId === o.id && e.price === 97)).toBe(true);
        expect(broker.positions()[0]).toMatchObject({ qty: 1, avgPrice: 97 });
        expect(broker.orders().find((x) => x.comment === 'placed outside this app')).toMatchObject({
            status: 'working',
            limit: 80,
            qty: 0.5,
        });
        expect(events.some((e) => e.id === o.id && e.status === 'filled')).toBe(true);
    }, 15_000);

    it('places the exits of an entry that filled while it was disconnected', async () => {
        const o = await broker.placeOrder({
            symbol: SYMBOL,
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: 99,
            bracket: { stopLoss: 90 },
        });
        venue.dropConnections();
        await until(() => !broker.isConnected);
        venue.setPrice('BTCUSDT', 98);
        expect(
            await until(() => broker.orders().some((x) => x.id === `${o.id}-sl` && x.status === 'working'), 8000),
        ).toBe(true);
        expect(venue.orders.find((x) => x.clientOrderId === `${o.id}-sl`)).toMatchObject({
            type: 'STOP_LOSS',
            status: 'NEW',
        });
    }, 15_000);
});
