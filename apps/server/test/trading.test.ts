import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@ts/core';
import { SyntheticAdapter } from '@ts/datafeed';
import type { BrokerEvents, BrokerPort, OrderState } from '@ts/oms';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type App, createApp } from '../src/app.ts';

let dir: string;
let app: App;
let base: string;
const events: any[] = [];
let ws: WebSocket;

const start = async () => {
    app = await createApp(
        { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'no-web'), notifier: {} },
        { adapters: [new SyntheticAdapter({ tickMs: 20 })], log: () => {}, lingerMs: 0, workers: 1 },
    );
    base = await app.listen();
    ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.op === 'event' && msg.topic === 'trading') events.push(msg.data);
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ op: 'listen', topics: ['trading'] }));
    await wait(50);
};
const stop = async () => {
    ws.close();
    await app.close();
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const state = async () => (await call('GET', '/api/trading/paper')).body;
const order = (o: Record<string, unknown>) =>
    call('POST', '/api/trading/paper/orders', { symbol: 'SYNTH:ALPHA', side: 'buy', type: 'market', qty: 1, ...o });

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-trading-'));
    await start();
}, 30_000);

afterAll(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
});

describe('paper trading over the API', () => {
    it('lists the paper account', async () => {
        const { body } = await call('GET', '/api/trading/accounts');
        expect(body).toMatchObject([{ id: 'paper', kind: 'paper', balance: 100_000, equity: 100_000 }]);
    });

    it('fills a market order at once and streams the order, the fill, the position and the account', {
        timeout: 15_000,
    }, async () => {
        events.length = 0;
        const { status, body } = await order({ qty: 2 });
        expect(status).toBe(201);
        expect(body).toMatchObject({ status: 'filled', filledQty: 2, symbol: 'SYNTH:ALPHA' });
        expect(body.avgFillPrice).toBeGreaterThan(0);
        const s = await state();
        expect(s.positions).toMatchObject([{ symbol: 'SYNTH:ALPHA', qty: 2, avgPrice: body.avgFillPrice }]);
        expect(s.executions[0]).toMatchObject({ orderId: body.id, qty: 2 });
        await wait(400);
        const kinds = new Set(events.map((e) => e.type));
        expect([...kinds].sort()).toEqual(['account', 'execution', 'order', 'position']);
        // The live feed keeps marking the position: its last price moves on. The synthetic venue
        // prints only when the price moves a whole tick, which can take a few seconds.
        const prices = new Set<number>();
        for (let waited = 0; waited < 8000 && prices.size < 2; waited += 100) {
            for (const e of events) if (e.type === 'position') prices.add(e.position.lastPrice);
            await wait(100);
        }
        expect(prices.size).toBeGreaterThan(1);
    });

    it('trades the underlying of a chart-type symbol, and refuses a formula', async () => {
        const { body } = await order({ symbol: 'SYNTH:ALPHA.RENKOXATR14', qty: 1 });
        expect(body.symbol).toBe('SYNTH:ALPHA');
        expect((await state()).positions[0].qty).toBe(3);
        const formula = await order({ symbol: 'SPREAD:SYNTH:ALPHA-SYNTH:BETA' });
        expect(formula.status).toBe(400);
        expect(formula.body.error).toMatch(/formula/);
        expect((await order({ symbol: 'SYNTH:NOPE' })).status).toBe(404);
    });

    it('rests, changes and cancels a limit order, and cancels everything at once', async () => {
        const last = (await state()).positions[0].lastPrice as number;
        const { status, body } = await order({ type: 'limit', limit: Math.round(last * 0.5 * 100) / 100 });
        expect(status).toBe(201);
        expect(body.status).toBe('working');
        const changed = await call('PATCH', `/api/trading/paper/orders/${body.id}`, {
            limit: Math.round(last * 0.6 * 100) / 100,
            qty: 1.5,
        });
        expect(changed.body).toMatchObject({ status: 'working', qty: 1.5, limit: Math.round(last * 0.6 * 100) / 100 });
        const cancelled = await call('DELETE', `/api/trading/paper/orders/${body.id}`);
        expect(cancelled.body.status).toBe('cancelled');
        expect((await call('DELETE', `/api/trading/paper/orders/${body.id}`)).status).toBe(400);
        expect((await call('DELETE', '/api/trading/paper/orders/nope')).status).toBe(404);
        await order({
            type: 'limit',
            limit: Math.round(last * 0.5 * 100) / 100,
            bracket: { stopLoss: Math.round(last * 0.4 * 100) / 100 },
        });
        await order({ side: 'sell', type: 'limit', limit: Math.round(last * 2 * 100) / 100, reduceOnly: true });
        const all = await call('POST', '/api/trading/paper/orders/cancel-all', {});
        expect(all.body.cancelled).toBe(2);
        expect(
            (await state()).orders.filter((o: OrderState) => o.status === 'working' || o.status === 'inactive'),
        ).toEqual([]);
    });

    it('protects, reverses and closes a position', async () => {
        const last = (await state()).positions[0].lastPrice as number;
        const brackets = await call('PUT', '/api/trading/paper/positions/brackets', {
            symbol: 'SYNTH:ALPHA',
            takeProfit: Math.round(last * 1.5 * 100) / 100,
            stopLoss: Math.round(last * 0.5 * 100) / 100,
        });
        expect(brackets.status).toBe(200);
        expect(brackets.body).toMatchObject({ qty: 3, takeProfit: Math.round(last * 1.5 * 100) / 100 });
        const wrong = await call('PUT', '/api/trading/paper/positions/brackets', {
            symbol: 'SYNTH:ALPHA',
            stopLoss: last * 2,
        });
        expect(wrong.status).toBe(400);
        const reversed = await call('POST', '/api/trading/paper/positions/reverse', { symbol: 'SYNTH:ALPHA' });
        expect(reversed.body).toMatchObject({ status: 'filled', side: 'sell', qty: 6 });
        expect((await state()).positions[0].qty).toBe(-3);
        const partly = await call('POST', '/api/trading/paper/positions/close', { symbol: 'SYNTH:ALPHA', qty: 1 });
        expect(partly.body.qty).toBe(1);
        await call('POST', '/api/trading/paper/positions/close', { symbol: 'SYNTH:ALPHA' });
        expect((await state()).positions).toEqual([]);
        expect((await call('POST', '/api/trading/paper/positions/close', { symbol: 'SYNTH:ALPHA' })).status).toBe(404);
    });

    it('answers a rejected order with its reason, and enforces the limits', async () => {
        const tiny = await order({ qty: 0.0001 });
        expect(tiny.status).toBe(422);
        expect(tiny.body.error).toMatch(/at least/);
        expect(tiny.body.order.status).toBe('rejected');
        expect((await call('PUT', '/api/trading/limits', { maxOrderValue: 10 })).body).toEqual({ maxOrderValue: 10 });
        const big = await order({ qty: 1 });
        expect(big.status).toBe(422);
        expect(big.body.error).toMatch(/limit per order is 10/);
        expect((await call('PUT', '/api/trading/limits', { maxOrderValue: -1 })).status).toBe(400);
        await call('PUT', '/api/trading/limits', { maxOrderValue: 1_000_000, maxOrdersPerDay: 500 });
        expect((await order({ qty: 0.01 })).status).toBe(201);
    });

    it('never sends an order to a real-money account from a screen not switched to it', async () => {
        const placed: unknown[] = [];
        const stub: BrokerPort = {
            id: 'live-test',
            name: 'Live test account',
            kind: 'live',
            events: new Emitter<BrokerEvents>(),
            account: () => ({
                ...app.trading.paper.account(),
                id: 'live-test',
                name: 'Live test account',
                kind: 'live',
            }),
            orders: () => [],
            positions: () => [],
            executions: () => [],
            placeOrder: async (req) => {
                placed.push(req);
                return {
                    ...(req as any),
                    id: 'x',
                    status: 'working',
                    filledQty: 0,
                    avgFillPrice: null,
                    accountId: 'live-test',
                };
            },
            modifyOrder: async () => Promise.reject(new Error('no')),
            cancelOrder: async () => Promise.reject(new Error('no')),
            closePosition: async () => null,
            reversePosition: async () => null,
            setPositionBrackets: async () => Promise.reject(new Error('no')),
        };
        app.trading.register(stub);
        const path = '/api/trading/live-test/orders';
        const body = { symbol: 'SYNTH:ALPHA', side: 'buy', type: 'market', qty: 0.01 };
        // A paper screen sends no account header, or names the paper account.
        expect((await call('POST', path, body)).status).toBe(403);
        expect((await call('POST', path, body, { 'x-ts-account': 'paper' })).status).toBe(403);
        expect((await call('POST', '/api/trading/live-test/orders/cancel-all', {})).status).toBe(403);
        expect((await call('POST', '/api/trading/live-test/positions/close', { symbol: 'SYNTH:ALPHA' })).status).toBe(
            403,
        );
        expect(placed).toHaveLength(0);
        // Only a screen switched to that very account gets through.
        expect((await call('POST', path, body, { 'x-ts-account': 'live-test' })).status).toBe(201);
        expect(placed).toHaveLength(1);
    });

    it('keeps the paper account, and its feeds, across a restart', async () => {
        await order({ qty: 2 });
        const last = (await state()).positions[0].lastPrice as number;
        const resting = (
            await order({
                type: 'limit',
                limit: Math.round(last * 0.5 * 100) / 100,
                bracket: { takeProfit: Math.round(last * 0.9 * 100) / 100 },
            })
        ).body;
        const before = await state();
        await stop();
        await start();
        const after = await state();
        expect(after.positions.map((p: any) => [p.symbol, p.qty, p.avgPrice])).toEqual(
            before.positions.map((p: any) => [p.symbol, p.qty, p.avgPrice]),
        );
        expect(after.orders.find((o: OrderState) => o.id === resting.id)).toMatchObject({
            status: 'working',
            limit: resting.limit,
        });
        expect(after.orders.find((o: OrderState) => o.id === `${resting.id}-tp`)).toMatchObject({ status: 'inactive' });
        expect(after.account.balance).toBeCloseTo(before.account.balance, 6);
        // The restarted server marks the position to live prices again.
        events.length = 0;
        await wait(700);
        expect(events.some((e) => e.type === 'position' && e.position.symbol === 'SYNTH:ALPHA')).toBe(true);
    }, 30_000);

    it('serves the order book behind a symbol', async () => {
        const { status, body } = await call('GET', '/api/depth?symbol=SYNTH:ALPHA.RENKOXATR14&levels=10');
        expect(status).toBe(200);
        expect(body.bids).toHaveLength(10);
        expect(body.asks).toHaveLength(10);
        const bids = body.bids.map((r: number[]) => r[0]);
        const asks = body.asks.map((r: number[]) => r[0]);
        expect(bids).toEqual([...bids].sort((a: number, b: number) => b - a));
        expect(asks).toEqual([...asks].sort((a: number, b: number) => a - b));
        expect(bids[0]).toBeLessThan(asks[0]);
        expect((await call('GET', '/api/depth?symbol=SYNTH:NOPE')).status).toBe(404);
    });

    it('starts the paper account over', async () => {
        events.length = 0;
        const { body } = await call('POST', '/api/trading/paper/reset', {
            initialBalance: 25_000,
            commission: { type: 'percent', value: 0.1 },
        });
        expect(body).toMatchObject({ balance: 25_000, equity: 25_000, commissionPaid: 0 });
        const s = await state();
        expect(s.positions).toEqual([]);
        expect(s.orders).toEqual([]);
        expect(events.some((e) => e.type === 'reset')).toBe(true);
        const fill = (await order({ qty: 1 })).body;
        expect((await state()).account.commissionPaid).toBeCloseTo(fill.avgFillPrice * 0.001, 6);
        expect((await call('POST', '/api/trading/paper/reset', { initialBalance: -5 })).status).toBe(400);
    });
});
