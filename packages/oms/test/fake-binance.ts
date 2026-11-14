import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * A stand-in for the Binance Spot API, as far as the adapter uses it: signed REST endpoints for
 * orders, order lists and account reads, a matching engine driven by `setPrice`, and the
 * WebSocket API's user data stream. It checks every signature. It lets a test drop connections,
 * trade while the adapter is not listening, and refuse requests the way the exchange does.
 * It mirrors the documented protocol; it is not the exchange.
 */

interface FakeOrder {
    orderId: number;
    symbol: string;
    clientOrderId: string;
    side: 'BUY' | 'SELL';
    type: string;
    origQty: number;
    price: number;
    stopPrice: number;
    trailingDelta?: number;
    executedQty: number;
    cummulativeQuoteQty: number;
    status: string;
    time: number;
    updateTime: number;
    list?: string;
    timeInForce?: string;
}

const FEE = 0.001;

export class FakeBinance {
    readonly apiKey = 'test-key';
    readonly secret = 'test-secret';
    url = '';
    wsUrl = '';
    balances = new Map<string, { free: number; locked: number }>([['USDT', { free: 10_000, locked: 0 }]]);
    orders: FakeOrder[] = [];
    trades: {
        id: number;
        orderId: number;
        symbol: string;
        price: number;
        qty: number;
        commission: number;
        commissionAsset: string;
        isBuyer: boolean;
        time: number;
    }[] = [];
    prices = new Map<string, number>([['BTCUSDT', 100]]);
    requests: { method: string; path: string; params: Record<string, string> }[] = [];
    /** Answer the next request to this path with an exchange error. */
    refuse: { path: string; code: number; msg: string } | null = null;
    private server!: Server;
    private wss!: WebSocketServer;
    private sockets = new Set<WebSocket>();
    private nextOrder = 1000;
    private nextTrade = 1;
    private clock = Date.UTC(2026, 10, 1);

    async start(): Promise<void> {
        this.server = createServer((req, res) => this.http(req, res));
        this.wss = new WebSocketServer({ server: this.server, path: '/ws-api/v3' });
        this.wss.on('connection', (ws) => this.socket(ws));
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        const port = (this.server.address() as AddressInfo).port;
        this.url = `http://127.0.0.1:${port}`;
        this.wsUrl = `ws://127.0.0.1:${port}/ws-api/v3`;
    }

    async stop(): Promise<void> {
        for (const s of this.sockets) s.terminate();
        this.wss.close();
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** Cut every user data stream, as a network drop would. */
    dropConnections(): void {
        for (const s of this.sockets) s.terminate();
        this.sockets.clear();
    }

    get listening(): number {
        return this.sockets.size;
    }

    /** Move the market. Resting orders it reaches fill; order-list partners are cancelled. */
    setPrice(symbol: string, price: number): void {
        this.prices.set(symbol, price);
        for (const o of [...this.orders]) {
            if (o.symbol !== symbol || (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED')) continue;
            const buy = o.side === 'BUY';
            let fillAt: number | null = null;
            if (o.type === 'LIMIT' || o.type === 'LIMIT_MAKER') {
                if (buy ? price <= o.price : price >= o.price) fillAt = o.price;
            } else if (o.type === 'STOP_LOSS') {
                if (buy ? price >= o.stopPrice : price <= o.stopPrice) fillAt = price;
            } else if (o.type === 'STOP_LOSS_LIMIT') {
                if ((buy ? price >= o.stopPrice : price <= o.stopPrice) && (buy ? price <= o.price : price >= o.price))
                    fillAt = o.price;
            }
            if (fillAt !== null) this.fill(o, fillAt);
        }
    }

    /** Place an order directly, as if from the exchange's own site. */
    placeElsewhere(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): void {
        this.create({
            symbol,
            side,
            type: 'LIMIT',
            quantity: String(qty),
            price: String(price),
            newClientOrderId: `web_${this.nextOrder}`,
            timeInForce: 'GTC',
        });
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    private http(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
        const url = new URL(req.url ?? '/', 'http://x');
        const params = Object.fromEntries(url.searchParams);
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        this.requests.push({ method: req.method ?? '', path: url.pathname, params });
        const signature = url.searchParams.get('signature');
        url.searchParams.delete('signature');
        const expected = createHmac('sha256', this.secret).update(url.searchParams.toString()).digest('hex');
        if (req.headers['x-mbx-apikey'] !== this.apiKey)
            return send(401, { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' });
        if (signature !== expected) return send(400, { code: -1022, msg: 'Signature for this request is not valid.' });
        if (!params.timestamp) return send(400, { code: -1102, msg: "Mandatory parameter 'timestamp' was not sent." });
        if (this.refuse && this.refuse.path === url.pathname) {
            const r = this.refuse;
            this.refuse = null;
            return send(400, { code: r.code, msg: r.msg });
        }
        const key = `${req.method} ${url.pathname}`;
        try {
            switch (key) {
                case 'GET /api/v3/account':
                    return send(200, {
                        balances: [...this.balances].map(([asset, b]) => ({
                            asset,
                            free: String(b.free),
                            locked: String(b.locked),
                        })),
                    });
                case 'GET /api/v3/openOrders':
                    return send(
                        200,
                        this.orders
                            .filter(
                                (o) =>
                                    (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') &&
                                    (!params.symbol || o.symbol === params.symbol),
                            )
                            .map((o) => this.view(o)),
                    );
                case 'GET /api/v3/order': {
                    const o = this.find(params.symbol, params.origClientOrderId, params.orderId);
                    return o ? send(200, this.view(o)) : send(400, { code: -2013, msg: 'Order does not exist.' });
                }
                case 'GET /api/v3/myTrades':
                    return send(
                        200,
                        this.trades
                            .filter((t) => t.symbol === params.symbol)
                            .map((t) => ({
                                ...t,
                                price: String(t.price),
                                qty: String(t.qty),
                                commission: String(t.commission),
                            })),
                    );
                case 'POST /api/v3/order': {
                    const o = this.create(params);
                    return send(200, {
                        ...this.view(o),
                        transactTime: this.clock,
                        fills: this.trades
                            .filter((t) => t.orderId === o.orderId)
                            .map((t) => ({
                                price: String(t.price),
                                qty: String(t.qty),
                                commission: String(t.commission),
                                commissionAsset: t.commissionAsset,
                                tradeId: t.id,
                            })),
                    });
                }
                case 'DELETE /api/v3/order': {
                    const o = this.find(params.symbol, params.origClientOrderId, params.orderId);
                    if (!o || (o.status !== 'NEW' && o.status !== 'PARTIALLY_FILLED'))
                        return send(400, { code: -2011, msg: 'Unknown order sent.' });
                    this.cancel(o);
                    return send(200, this.view(o));
                }
                case 'POST /api/v3/order/cancelReplace': {
                    const old = this.find(params.symbol, params.cancelOrigClientOrderId, params.cancelOrderId);
                    if (!old || (old.status !== 'NEW' && old.status !== 'PARTIALLY_FILLED')) {
                        return send(400, {
                            code: -2022,
                            msg: 'Order cancel-replace failed.',
                            data: { cancelResult: 'FAILURE', newOrderResult: 'NOT_ATTEMPTED' },
                        });
                    }
                    this.cancel(old);
                    const fresh = this.create(params);
                    return send(200, {
                        cancelResult: 'SUCCESS',
                        newOrderResult: 'SUCCESS',
                        cancelResponse: this.view(old),
                        newOrderResponse: this.view(fresh),
                    });
                }
                case 'POST /api/v3/orderList/oco': {
                    const list = params.listClientOrderId ?? `list_${this.nextOrder}`;
                    const qty = params.quantity;
                    const above = this.create(
                        {
                            symbol: params.symbol,
                            side: params.side,
                            type: params.aboveType,
                            quantity: qty,
                            price: params.abovePrice,
                            stopPrice: params.aboveStopPrice,
                            newClientOrderId: params.aboveClientOrderId,
                        },
                        list,
                    );
                    // The two legs share one quantity: the second does not lock it again.
                    const below = this.create(
                        {
                            symbol: params.symbol,
                            side: params.side,
                            type: params.belowType,
                            quantity: qty,
                            price: params.belowPrice,
                            stopPrice: params.belowStopPrice,
                            newClientOrderId: params.belowClientOrderId,
                        },
                        list,
                        true,
                    );
                    return send(200, { listClientOrderId: list, orders: [this.view(above), this.view(below)] });
                }
                case 'DELETE /api/v3/openOrders': {
                    const open = this.orders.filter(
                        (o) => o.symbol === params.symbol && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'),
                    );
                    const lists = new Set<string>();
                    for (const o of open) {
                        // The second leg of a list shares its partner's lock.
                        this.cancel(o, !!o.list && lists.has(o.list));
                        if (o.list) lists.add(o.list);
                    }
                    return send(
                        200,
                        open.map((o) => this.view(o)),
                    );
                }
                case 'DELETE /api/v3/orderList': {
                    const legs = this.orders.filter(
                        (o) =>
                            o.list === params.listClientOrderId &&
                            (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'),
                    );
                    if (legs.length === 0) return send(400, { code: -2011, msg: 'Unknown order list sent.' });
                    legs.forEach((o, i) => this.cancel(o, i > 0));
                    return send(200, { listClientOrderId: params.listClientOrderId });
                }
                default:
                    return send(404, { code: -1, msg: `no ${key}` });
            }
        } catch (err: any) {
            return send(400, { code: err.code ?? -1013, msg: err.message });
        }
    }

    private find(symbol: string, clientId?: string, orderId?: string): FakeOrder | undefined {
        return [...this.orders]
            .reverse()
            .find(
                (o) => o.symbol === symbol && (clientId ? o.clientOrderId === clientId : String(o.orderId) === orderId),
            );
    }

    private view(o: FakeOrder) {
        return {
            symbol: o.symbol,
            orderId: o.orderId,
            clientOrderId: o.clientOrderId,
            price: o.price.toFixed(8),
            origQty: o.origQty.toFixed(8),
            executedQty: o.executedQty.toFixed(8),
            cummulativeQuoteQty: o.cummulativeQuoteQty.toFixed(8),
            status: o.status,
            type: o.type,
            side: o.side,
            stopPrice: o.stopPrice.toFixed(8),
            time: o.time,
            updateTime: o.updateTime,
            trailingDelta: o.trailingDelta,
        };
    }

    private base(symbol: string) {
        return symbol.replace(/USDT$/, '');
    }

    private wallet(asset: string) {
        let w = this.balances.get(asset);
        if (!w) {
            w = { free: 0, locked: 0 };
            this.balances.set(asset, w);
        }
        return w;
    }

    private create(p: Record<string, string | undefined>, list?: string, sharedLock = false): FakeOrder {
        this.clock += 1000;
        const symbol = p.symbol!;
        const side = p.side as 'BUY' | 'SELL';
        const qty = Number(p.quantity);
        const market = this.prices.get(symbol) ?? 0;
        const price = Number(p.price ?? 0);
        const o: FakeOrder = {
            orderId: this.nextOrder++,
            symbol,
            clientOrderId: p.newClientOrderId ?? `auto_${this.nextOrder}`,
            side,
            type: p.type!,
            origQty: qty,
            price,
            stopPrice: Number(p.stopPrice ?? 0),
            trailingDelta: p.trailingDelta ? Number(p.trailingDelta) : undefined,
            executedQty: 0,
            cummulativeQuoteQty: 0,
            status: 'NEW',
            time: this.clock,
            updateTime: this.clock,
            list,
            timeInForce: p.timeInForce,
        };
        if (
            this.orders.some(
                (x) => x.clientOrderId === o.clientOrderId && (x.status === 'NEW' || x.status === 'PARTIALLY_FILLED'),
            )
        ) {
            throw Object.assign(new Error('Duplicate order sent.'), { code: -2010 });
        }
        if (o.type === 'LIMIT_MAKER' && (side === 'BUY' ? market <= price : market >= price)) {
            throw Object.assign(new Error('Order would immediately match and take.'), { code: -2010 });
        }
        // Funds are locked while an order rests: quote for a buy, base for a sell.
        const quote = this.wallet('USDT');
        const baseW = this.wallet(this.base(symbol));
        const cost = qty * (o.type === 'MARKET' || o.type === 'STOP_LOSS' ? market : price || market) * (1 + FEE);
        if (!sharedLock) {
            if (side === 'BUY') {
                if (quote.free + 1e-9 < cost)
                    throw Object.assign(new Error('Account has insufficient balance for requested action.'), {
                        code: -2010,
                    });
                quote.free -= cost;
                quote.locked += cost;
            } else {
                if (baseW.free + 1e-12 < qty)
                    throw Object.assign(new Error('Account has insufficient balance for requested action.'), {
                        code: -2010,
                    });
                baseW.free -= qty;
                baseW.locked += qty;
            }
        }
        (o as any).lockedCost = side === 'BUY' ? cost : qty;
        (o as any).sharedLock = sharedLock;
        this.orders.push(o);
        this.report(o, 'NEW');
        if (o.type === 'MARKET') this.fill(o, market);
        else if (o.type === 'LIMIT' && (side === 'BUY' ? market <= price : market >= price)) this.fill(o, market);
        else if (o.timeInForce === 'IOC') this.cancel(o);
        return o;
    }

    private unlock(o: FakeOrder) {
        if ((o as any).sharedLock) return;
        const locked = (o as any).lockedCost as number;
        const w = o.side === 'BUY' ? this.wallet('USDT') : this.wallet(this.base(o.symbol));
        w.locked -= locked;
        w.free += locked;
    }

    private cancel(o: FakeOrder, partnerOfList = false) {
        this.clock += 1000;
        o.status = 'CANCELED';
        o.updateTime = this.clock;
        if (!partnerOfList) this.unlock(o);
        this.report(o, 'CANCELED');
        this.account();
    }

    private fill(o: FakeOrder, price: number) {
        this.clock += 1000;
        const qty = o.origQty - o.executedQty;
        const notional = qty * price;
        const quote = this.wallet('USDT');
        const baseW = this.wallet(this.base(o.symbol));
        // A shared-lock leg of an order list uses the lock its partner took.
        const owner =
            o.list && (o as any).sharedLock ? this.orders.find((x) => x.list === o.list && !(x as any).sharedLock) : o;
        if (owner && owner !== o) {
            (o as any).lockedCost = (owner as any).lockedCost;
            (o as any).sharedLock = false;
            (owner as any).sharedLock = true;
        }
        this.unlock(o);
        const commission = notional * FEE;
        if (o.side === 'BUY') {
            quote.free -= notional + commission;
            baseW.free += qty;
        } else {
            baseW.free -= qty;
            quote.free += notional - commission;
        }
        o.executedQty += qty;
        o.cummulativeQuoteQty += notional;
        o.status = 'FILLED';
        o.updateTime = this.clock;
        const trade = {
            id: this.nextTrade++,
            orderId: o.orderId,
            symbol: o.symbol,
            price,
            qty,
            commission,
            commissionAsset: 'USDT',
            isBuyer: o.side === 'BUY',
            time: this.clock,
        };
        this.trades.push(trade);
        this.report(o, 'TRADE', trade);
        // One leg of a list filled: the other is cancelled.
        if (o.list)
            for (const x of this.orders) if (x !== o && x.list === o.list && x.status === 'NEW') this.cancel(x, true);
        this.account();
    }

    // ── User data stream ────────────────────────────────────────────────────

    private socket(ws: WebSocket): void {
        ws.on('message', (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method !== 'userDataStream.subscribe.signature') {
                ws.send(JSON.stringify({ id: msg.id, status: 400, error: { code: -1, msg: 'unknown method' } }));
                return;
            }
            const { signature, ...rest } = msg.params ?? {};
            const payload = new URLSearchParams(
                Object.entries(rest)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => [k, String(v)]),
            ).toString();
            const expected = createHmac('sha256', this.secret).update(payload).digest('hex');
            if (rest.apiKey !== this.apiKey || signature !== expected) {
                ws.send(
                    JSON.stringify({
                        id: msg.id,
                        status: 400,
                        error: { code: -1022, msg: 'Signature for this request is not valid.' },
                    }),
                );
                return;
            }
            this.sockets.add(ws);
            ws.send(JSON.stringify({ id: msg.id, status: 200, result: { subscriptionId: 0 } }));
        });
        ws.on('close', () => this.sockets.delete(ws));
    }

    private push(event: Record<string, unknown>): void {
        const text = JSON.stringify({ subscriptionId: 0, event });
        for (const s of this.sockets) s.send(text);
    }

    private report(
        o: FakeOrder,
        x: string,
        trade?: { id: number; price: number; qty: number; commission: number },
    ): void {
        const cancel = x === 'CANCELED';
        this.push({
            e: 'executionReport',
            E: this.clock,
            s: o.symbol,
            // A cancellation carries the cancel request's own id in `c` and the order's in `C`.
            c: cancel ? `cancel_${o.orderId}` : o.clientOrderId,
            C: cancel ? o.clientOrderId : '',
            S: o.side,
            o: o.type,
            q: o.origQty.toFixed(8),
            p: o.price.toFixed(8),
            P: o.stopPrice.toFixed(8),
            x,
            X: o.status,
            r: 'NONE',
            i: o.orderId,
            l: trade ? trade.qty.toFixed(8) : '0',
            z: o.executedQty.toFixed(8),
            L: trade ? trade.price.toFixed(8) : '0',
            n: trade ? trade.commission.toFixed(8) : '0',
            N: trade ? 'USDT' : null,
            T: this.clock,
            t: trade ? trade.id : -1,
            O: o.time,
            Z: o.cummulativeQuoteQty.toFixed(8),
        });
    }

    private account(): void {
        this.push({
            e: 'outboundAccountPosition',
            E: this.clock,
            u: this.clock,
            B: [...this.balances].map(([a, b]) => ({ a, f: b.free.toFixed(8), l: b.locked.toFixed(8) })),
        });
    }
}
