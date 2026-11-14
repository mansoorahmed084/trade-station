import { createHmac } from 'node:crypto';
import { decimalsOf, Emitter, floorToLot, newId } from '@ts/core';
import type {
    AccountKind,
    AccountState,
    Bracket,
    BrokerEvents,
    BrokerPort,
    Execution,
    Instrument,
    ModifyOrderRequest,
    OrderState,
    PlaceOrderRequest,
    PositionState,
    Side,
} from './types.ts';
import { isOpen } from './types.ts';

/**
 * A Binance Spot account behind the BrokerPort. By default it talks to the Spot **testnet**, where
 * nothing is real money; the live exchange must be asked for explicitly.
 *
 * - Orders go out over the signed REST API; order and balance updates come back over the
 *   WebSocket API's user data stream (`userDataStream.subscribe.signature`).
 * - The exchange is the source of truth. After every (re)connection the adapter reads open
 *   orders, balances and fills back from the exchange and corrects its own state, reporting what
 *   changed while it was not listening.
 * - A spot account holds assets: a position is the base asset held; it can never be short.
 * - A bracket's exits are placed by this adapter as one OCO order list when the entry fills, so
 *   they need the server to be running then (or they are placed at the next reconciliation).
 */

export interface BinanceSpotOptions {
    id?: string;
    name?: string;
    apiKey: string;
    apiSecret: string;
    /** Trade on the live exchange. Without it the adapter only ever talks to the testnet. */
    live?: boolean;
    restBase?: string;
    wsApiBase?: string;
    /** Quote asset the account is valued in. Default USDT. */
    quoteAsset?: string;
    instrument(symbol: string): Instrument;
    fetch?: typeof fetch;
    WebSocket?: new (url: string) => WebSocketLike;
    now?(): number;
    recvWindow?: number;
    /** Exits waiting for their entry to fill, kept across restarts. */
    pending?: {
        load(): Record<string, { symbol: string; bracket: Bracket }>;
        save(v: Record<string, { symbol: string; bracket: Bracket }>): void;
    };
    log?(message: string): void;
}

/** The parts of a WebSocket the adapter uses (the browser-style API Node ships). */
export interface WebSocketLike {
    readyState: number;
    onopen: ((ev: any) => void) | null;
    onclose: ((ev: any) => void) | null;
    onerror: ((ev: any) => void) | null;
    onmessage: ((ev: { data: any }) => void) | null;
    send(data: string): void;
    close(): void;
}

export interface ReconcileReport {
    at: number;
    /** Orders whose status the exchange reported differently from what the adapter last knew. */
    changed: { id: string; from: string; to: string }[];
    /** Open orders on the exchange the adapter did not know about (placed elsewhere). */
    adopted: string[];
    /** Fills that happened while the adapter was not listening. */
    missedFills: number;
}

export const BINANCE_TESTNET = {
    rest: 'https://testnet.binance.vision',
    wsApi: 'wss://ws-api.testnet.binance.vision:443/ws-api/v3',
};
export const BINANCE_LIVE = {
    rest: 'https://api.binance.com',
    wsApi: 'wss://ws-api.binance.com:443/ws-api/v3',
};

const STATUS: Record<string, OrderState['status']> = {
    NEW: 'working',
    PARTIALLY_FILLED: 'working',
    PENDING_NEW: 'inactive',
    FILLED: 'filled',
    CANCELED: 'cancelled',
    PENDING_CANCEL: 'working',
    EXPIRED: 'cancelled',
    EXPIRED_IN_MATCH: 'cancelled',
    REJECTED: 'rejected',
};

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

interface Lot {
    qty: number;
    price: number;
}

export class BinanceSpotBroker implements BrokerPort {
    readonly id: string;
    readonly name: string;
    readonly kind: AccountKind;
    readonly events = new Emitter<BrokerEvents>();
    lastReconcile: ReconcileReport | null = null;
    private o: Required<Pick<BinanceSpotOptions, 'apiKey' | 'apiSecret' | 'quoteAsset' | 'recvWindow'>> &
        BinanceSpotOptions;
    private rest: string;
    private wsApi: string;
    private fetchFn: typeof fetch;
    private now: () => number;
    /** Orders by our id. The exchange knows each under a client id (which changes when the order is replaced). */
    private all = new Map<string, OrderState>();
    private exchangeId = new Map<string, string>();
    private ourId = new Map<string, string>();
    /** Our id by the exchange's numeric order id, to attribute fills read back from the exchange. */
    private byNumber = new Map<string, string>();
    private balances = new Map<string, { free: number; locked: number }>();
    private lots = new Map<string, Lot[]>();
    private realized = new Map<string, number>();
    private execs: Execution[] = [];
    private seenTrades = new Set<string>();
    private prices = new Map<string, number>();
    /** Exits waiting for their entry, by entry id. */
    private waiting: Record<string, { symbol: string; bracket: Bracket }>;
    /** Exit order lists by symbol: position protection, or a filled entry's bracket. */
    private exits = new Map<string, { list: string; tp?: string; sl?: string; qty: number }>();
    private ws: WebSocketLike | null = null;
    private connected = false;
    private closed = false;
    private attempts = 0;
    private reqId = 1;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private commissionPaid = 0;

    constructor(options: BinanceSpotOptions) {
        if (!options.apiKey || !options.apiSecret) throw new Error('a Binance account needs an API key and secret');
        this.o = { quoteAsset: 'USDT', recvWindow: 5000, ...options };
        this.kind = options.live ? 'live' : 'sandbox';
        this.id = options.id ?? (options.live ? 'binance' : 'binance-testnet');
        this.name = options.name ?? (options.live ? 'Binance (live)' : 'Binance testnet');
        const urls = options.live ? BINANCE_LIVE : BINANCE_TESTNET;
        this.rest = options.restBase ?? urls.rest;
        this.wsApi = options.wsApiBase ?? urls.wsApi;
        this.fetchFn = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.waiting = options.pending?.load() ?? {};
    }

    // ── Connection ──────────────────────────────────────────────────────────

    /** Connect the user data stream and read the account. Resolves once the account has been read. */
    async start(): Promise<void> {
        this.closed = false;
        await this.reconcile();
        this.connect();
    }

    close(): void {
        this.closed = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.ws?.close();
        this.ws = null;
        this.setConnected(false, 'closed');
    }

    get isConnected(): boolean {
        return this.connected;
    }

    private setConnected(on: boolean, reason?: string): void {
        if (this.connected === on) return;
        this.connected = on;
        this.events.emit('status', { connected: on, reason });
        this.events.emit('account', this.account());
    }

    private connect(): void {
        if (this.closed) return;
        const WS = this.o.WebSocket ?? (globalThis as any).WebSocket;
        const ws: WebSocketLike = new WS(this.wsApi);
        this.ws = ws;
        let subscribeId = 0;
        ws.onopen = () => {
            subscribeId = this.reqId++;
            const params: Record<string, string | number> = { apiKey: this.o.apiKey, timestamp: this.now() };
            params.signature = this.sign(
                new URLSearchParams(
                    Object.entries(params)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, v]) => [k, String(v)]),
                ).toString(),
            );
            ws.send(JSON.stringify({ id: subscribeId, method: 'userDataStream.subscribe.signature', params }));
        };
        ws.onmessage = (ev) => {
            let msg: any;
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.id === subscribeId && subscribeId) {
                if (msg.status === 200) {
                    this.attempts = 0;
                    this.setConnected(true);
                    // Whatever happened before the stream was listening (since the last read, or
                    // while disconnected) is read back from the exchange.
                    void this.reconcile().catch((err) => this.o.log?.(`reconciliation failed: ${err?.message ?? err}`));
                } else {
                    this.o.log?.(`user data stream refused: ${JSON.stringify(msg.error ?? msg)}`);
                    ws.close();
                }
                return;
            }
            const event = msg.event ?? (msg.e ? msg : null);
            if (event) this.onEvent(event);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.setConnected(false, 'connection lost');
            if (this.closed) return;
            const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
            this.retryTimer = setTimeout(() => this.connect(), delay);
            this.retryTimer.unref?.();
        };
        ws.onerror = () => {};
    }

    /** Read orders, balances and fills from the exchange and bring local state in line with them. */
    async reconcile(): Promise<ReconcileReport> {
        const report: ReconcileReport = { at: this.now(), changed: [], adopted: [], missedFills: 0 };
        const [account, open] = await Promise.all([
            this.signed('GET', '/api/v3/account'),
            this.signed('GET', '/api/v3/openOrders'),
        ]);
        this.balances.clear();
        for (const b of account.balances ?? []) {
            const free = Number(b.free);
            const locked = Number(b.locked);
            if (free || locked) this.balances.set(b.asset, { free, locked });
        }
        const openIds = new Set<string>();
        for (const row of open as any[]) {
            const id = this.ourId.get(row.clientOrderId) ?? row.clientOrderId;
            openIds.add(id);
            const known = this.all.get(id);
            if (!known) report.adopted.push(id);
            this.applyOrder(row, report);
        }
        // Orders we thought were working that the exchange no longer lists: ask how they ended.
        for (const order of [...this.all.values()]) {
            if (order.status !== 'working' || openIds.has(order.id)) continue;
            const row = await this.signed('GET', '/api/v3/order', {
                symbol: this.ticker(order.symbol),
                origClientOrderId: this.exchangeId.get(order.id) ?? order.id,
            }).catch(() => null);
            if (row) this.applyOrder(row, report);
        }
        // Fills on every symbol we trade or hold.
        const symbols = new Set<string>([...this.all.values()].map((o) => o.symbol));
        for (const asset of this.balances.keys()) {
            if (asset === this.o.quoteAsset) continue;
            const symbol = `BINANCE:${asset}${this.o.quoteAsset}`;
            try {
                this.o.instrument(symbol);
                symbols.add(symbol);
            } catch {}
        }
        for (const symbol of symbols) report.missedFills += await this.readTrades(symbol);
        // Entries that filled while nobody was listening still get their exits.
        for (const [entryId, w] of Object.entries(this.waiting)) {
            const entry = this.all.get(entryId);
            if (entry?.status === 'filled')
                await this.placeExits(w.symbol, entry.filledQty, w.bracket, entryId).catch(() => {});
            else if (entry && !isOpen(entry)) this.forget(entryId);
        }
        this.lastReconcile = report;
        if (report.changed.length || report.missedFills || report.adopted.length) {
            this.o.log?.(
                `reconciled ${this.name}: ${report.changed.length} order(s) changed, ${report.missedFills} missed fill(s), ${report.adopted.length} order(s) placed elsewhere`,
            );
        }
        this.events.emit('account', this.account());
        for (const p of this.positions()) this.events.emit('position', p);
        return report;
    }

    /** Read the account's fills on one symbol; returns how many were new. */
    private async readTrades(symbol: string): Promise<number> {
        const rows: any[] = await this.signed('GET', '/api/v3/myTrades', {
            symbol: this.ticker(symbol),
            limit: 1000,
        }).catch(() => []);
        let fresh = 0;
        // Cost basis is rebuilt from the full list, oldest first.
        const lots: Lot[] = [];
        let realized = 0;
        for (const t of [...rows].sort((a, b) => a.time - b.time || a.id - b.id)) {
            const qty = Number(t.qty);
            const price = Number(t.price);
            const commission = Number(t.commission);
            const side: Side = t.isBuyer ? 'buy' : 'sell';
            const gain = this.applyLots(lots, side, qty, price);
            realized += gain;
            const key = `${symbol}:${t.id}`;
            if (this.seenTrades.has(key)) continue;
            this.seenTrades.add(key);
            fresh++;
            const orderId = this.byExchangeOrder(t.orderId, symbol);
            this.recordExecution({
                id: key,
                accountId: this.id,
                orderId: orderId ?? String(t.orderId),
                symbol,
                side,
                qty,
                price,
                commission: t.commissionAsset === this.o.quoteAsset ? commission : commission * price,
                realizedPnl: gain,
                time: t.time,
            });
        }
        this.lots.set(symbol, lots);
        this.realized.set(symbol, realized);
        return fresh;
    }

    // ── State ───────────────────────────────────────────────────────────────

    tick(symbol: string, price: number): void {
        if (!(price > 0)) return;
        this.prices.set(symbol, price);
        if (this.held(symbol) > 0) {
            this.events.emit('position', this.position(symbol));
            this.events.emit('account', this.account());
        }
    }

    watched(): string[] {
        const out = new Set<string>();
        for (const o of this.all.values()) if (isOpen(o)) out.add(o.symbol);
        for (const p of this.positions()) out.add(p.symbol);
        return [...out];
    }

    lastPrice(symbol: string): number | undefined {
        return this.prices.get(symbol);
    }

    account(): AccountState {
        const quote = this.balances.get(this.o.quoteAsset) ?? { free: 0, locked: 0 };
        let held = 0;
        let unrealized = 0;
        let realized = 0;
        for (const p of this.positions()) {
            if (p.lastPrice !== null) held += p.qty * p.lastPrice;
            unrealized += p.unrealizedPnl;
        }
        for (const r of this.realized.values()) realized += r;
        const balance = quote.free + quote.locked;
        return {
            id: this.id,
            name: this.name,
            kind: this.kind,
            currency: this.o.quoteAsset,
            balance,
            equity: balance + held,
            unrealizedPnl: unrealized,
            realizedPnl: realized,
            commissionPaid: this.commissionPaid,
            dayPnl: 0,
            ordersToday: 0,
            buyingPower: quote.free,
            connected: this.connected,
            updatedAt: this.now(),
        };
    }

    orders(): OrderState[] {
        return [...this.all.values()].sort((a, b) => b.createdAt - a.createdAt).map((o) => ({ ...o }));
    }

    positions(): PositionState[] {
        const out: PositionState[] = [];
        for (const asset of this.balances.keys()) {
            if (asset === this.o.quoteAsset) continue;
            const symbol = `BINANCE:${asset}${this.o.quoteAsset}`;
            if (this.held(symbol) > 0) out.push(this.position(symbol));
        }
        return out;
    }

    executions(limit = 500): Execution[] {
        return this.execs.slice(-limit).reverse();
    }

    private held(symbol: string): number {
        const b = this.balances.get(this.base(symbol));
        return b ? b.free + b.locked : 0;
    }

    private position(symbol: string): PositionState {
        const qty = this.held(symbol);
        const lots = this.lots.get(symbol) ?? [];
        const costed = lots.reduce((a, l) => a + l.qty, 0);
        const avg = costed > 0 ? lots.reduce((a, l) => a + l.qty * l.price, 0) / costed : 0;
        const last = this.prices.get(symbol) ?? null;
        const exits = this.exits.get(symbol);
        const tp = exits?.tp ? this.all.get(exits.tp) : undefined;
        const sl = exits?.sl ? this.all.get(exits.sl) : undefined;
        return {
            accountId: this.id,
            symbol,
            qty,
            avgPrice: avg,
            lastPrice: last,
            // Only the part with a known cost (bought through this account) has a result.
            unrealizedPnl: last !== null && avg > 0 ? (last - avg) * Math.min(qty, costed) : 0,
            realizedPnl: this.realized.get(symbol) ?? 0,
            takeProfit: tp && isOpen(tp) ? tp.limit : undefined,
            stopLoss: sl && isOpen(sl) ? sl.stop : undefined,
            updatedAt: this.now(),
        };
    }

    // ── Orders ──────────────────────────────────────────────────────────────

    async placeOrder(request: PlaceOrderRequest): Promise<OrderState> {
        const now = this.now();
        const order: OrderState = {
            id: newId('bn'),
            accountId: this.id,
            symbol: request.symbol,
            side: request.side,
            type: request.type,
            qty: Number(request.qty),
            filledQty: 0,
            avgFillPrice: null,
            limit: request.limit,
            stop: request.stop,
            trailDistance: request.trailDistance,
            tif: request.tif ?? 'GTC',
            status: 'working',
            role: request.reduceOnly ? 'close' : 'entry',
            bracket:
                request.bracket && (request.bracket.takeProfit !== undefined || request.bracket.stopLoss !== undefined)
                    ? { ...request.bracket }
                    : undefined,
            reduceOnly: !!request.reduceOnly,
            source: request.source ?? 'api',
            clientId: request.clientId,
            comment: request.comment,
            createdAt: now,
            updatedAt: now,
        };
        let params: Record<string, string | number>;
        try {
            params = this.orderParams(order);
        } catch (err: any) {
            return this.reject(order, err.message);
        }
        this.all.set(order.id, order);
        this.exchangeId.set(order.id, order.id);
        this.ourId.set(order.id, order.id);
        if (order.bracket) {
            this.waiting[order.id] = { symbol: order.symbol, bracket: order.bracket };
            this.o.pending?.save(this.waiting);
        }
        try {
            const row = await this.signed('POST', '/api/v3/order', {
                ...params,
                newClientOrderId: order.id,
                newOrderRespType: 'FULL',
            });
            this.applyOrder(row);
            // A FULL response carries the fills of an order that traded at once.
            for (const f of row.fills ?? []) {
                this.recordExecution({
                    id: `${order.symbol}:${f.tradeId}`,
                    accountId: this.id,
                    orderId: order.id,
                    symbol: order.symbol,
                    side: order.side,
                    qty: Number(f.qty),
                    price: Number(f.price),
                    commission:
                        f.commissionAsset === this.o.quoteAsset
                            ? Number(f.commission)
                            : Number(f.commission) * Number(f.price),
                    realizedPnl: 0,
                    time: row.transactTime ?? now,
                });
                this.seenTrades.add(`${order.symbol}:${f.tradeId}`);
            }
        } catch (err: any) {
            this.forget(order.id);
            return this.reject(order, err.message);
        }
        return { ...this.all.get(order.id)! };
    }

    async modifyOrder(id: string, changes: ModifyOrderRequest): Promise<OrderState> {
        const order = this.all.get(id);
        if (!order) throw fail('order not found', 404);
        if (!isOpen(order)) throw fail(`the order is ${order.status} and can no longer be changed`);
        if (changes.bracket) {
            const b = { ...(order.bracket ?? {}) };
            for (const leg of ['takeProfit', 'stopLoss'] as const) {
                const v = changes.bracket[leg];
                if (v === null) delete b[leg];
                else if (v !== undefined) b[leg] = Number(v);
            }
            order.bracket = b.takeProfit === undefined && b.stopLoss === undefined ? undefined : b;
            if (order.bracket) this.waiting[id] = { symbol: order.symbol, bracket: order.bracket };
            else delete this.waiting[id];
            this.o.pending?.save(this.waiting);
        }
        const priceChange =
            changes.qty !== undefined ||
            changes.limit !== undefined ||
            changes.stop !== undefined ||
            changes.trailDistance !== undefined;
        if (priceChange) {
            const next: OrderState = { ...order };
            if (changes.qty !== undefined) next.qty = Number(changes.qty);
            if (changes.limit !== undefined) next.limit = Number(changes.limit);
            if (changes.stop !== undefined) next.stop = Number(changes.stop);
            if (changes.trailDistance !== undefined) next.trailDistance = Number(changes.trailDistance);
            const params = this.orderParams(next);
            // The exchange replaces an order with a new one; it must carry a new client id.
            const replacement = `${id.slice(0, 28)}-${(Math.random() * 1e6).toFixed(0)}`;
            const previous = this.exchangeId.get(id) ?? id;
            // Known before the request goes out: the stream may report the replacement before it answers.
            this.ourId.set(replacement, id);
            this.exchangeId.set(id, replacement);
            try {
                await this.signed('POST', '/api/v3/order/cancelReplace', {
                    ...params,
                    cancelReplaceMode: 'STOP_ON_FAILURE',
                    cancelOrigClientOrderId: previous,
                    newClientOrderId: replacement,
                });
            } catch (err) {
                this.exchangeId.set(id, previous);
                this.ourId.delete(replacement);
                throw err;
            }
            Object.assign(order, {
                qty: next.qty,
                limit: next.limit,
                stop: next.stop,
                trailDistance: next.trailDistance,
                updatedAt: this.now(),
            });
        }
        this.events.emit('order', { ...order });
        return { ...order };
    }

    async cancelOrder(id: string): Promise<OrderState> {
        const order = this.all.get(id);
        if (!order) throw fail('order not found', 404);
        if (!isOpen(order)) throw fail(`the order is already ${order.status}`);
        const exits = [...this.exits.entries()].find(([, e]) => e.tp === id || e.sl === id);
        if (exits) {
            // One leg of an order list: the exchange cancels the whole list; put the other leg back.
            const [symbol, e] = exits;
            await this.signed('DELETE', '/api/v3/orderList', {
                symbol: this.ticker(symbol),
                listClientOrderId: e.list,
            });
            this.exits.delete(symbol);
            const other = e.tp === id ? e.sl : e.tp;
            const otherOrder = other ? this.all.get(other) : undefined;
            this.markCancelled(id);
            if (other) this.markCancelled(other);
            if (otherOrder) {
                await this.placeExits(
                    symbol,
                    e.qty,
                    otherOrder.role === 'take_profit'
                        ? { takeProfit: otherOrder.limit }
                        : { stopLoss: otherOrder.stop },
                );
            }
        } else {
            await this.signed('DELETE', '/api/v3/order', {
                symbol: this.ticker(order.symbol),
                origClientOrderId: this.exchangeId.get(id) ?? id,
            });
            this.markCancelled(id);
        }
        this.forget(id);
        return { ...this.all.get(id)! };
    }

    async closePosition(symbol: string, qty?: number): Promise<OrderState | null> {
        const held = this.held(symbol);
        if (!(held > 0)) return null;
        const exits = this.exits.get(symbol);
        if (exits)
            await this.signed('DELETE', '/api/v3/orderList', {
                symbol: this.ticker(symbol),
                listClientOrderId: exits.list,
            }).catch(() => {});
        const free = this.balances.get(this.base(symbol))?.free ?? held;
        return this.placeOrder({
            symbol,
            side: 'sell',
            type: 'market',
            qty: Math.min(free, qty ?? held),
            reduceOnly: true,
            comment: 'close position',
        });
    }

    async reversePosition(): Promise<OrderState | null> {
        throw fail('a spot account cannot hold a short position, so a position cannot be reversed');
    }

    async setPositionBrackets(
        symbol: string,
        brackets: { takeProfit?: number | null; stopLoss?: number | null },
    ): Promise<PositionState> {
        const held = this.held(symbol);
        if (!(held > 0)) throw fail(`there is no ${symbol} position to protect`);
        const current = this.exits.get(symbol);
        const tpNow = current?.tp ? this.all.get(current.tp)?.limit : undefined;
        const slNow = current?.sl ? this.all.get(current.sl)?.stop : undefined;
        const want: Bracket = {
            takeProfit: brackets.takeProfit === null ? undefined : (brackets.takeProfit ?? tpNow),
            stopLoss: brackets.stopLoss === null ? undefined : (brackets.stopLoss ?? slNow),
        };
        if (current) {
            await this.signed('DELETE', '/api/v3/orderList', {
                symbol: this.ticker(symbol),
                listClientOrderId: current.list,
            }).catch(() => {});
            if (current.tp) this.markCancelled(current.tp);
            if (current.sl) this.markCancelled(current.sl);
            this.exits.delete(symbol);
        }
        if (want.takeProfit !== undefined || want.stopLoss !== undefined) await this.placeExits(symbol, held, want);
        return this.position(symbol);
    }

    // ── Exchange messages ───────────────────────────────────────────────────

    private onEvent(e: any): void {
        if (e.e === 'executionReport') {
            const report: ReconcileReport = { at: 0, changed: [], adopted: [], missedFills: 0 };
            this.applyOrder(
                {
                    symbol: e.s,
                    clientOrderId: e.X === 'CANCELED' && e.C ? e.C : e.c,
                    orderId: e.i,
                    side: e.S,
                    type: e.o,
                    origQty: e.q,
                    price: e.p,
                    stopPrice: e.P,
                    executedQty: e.z,
                    cummulativeQuoteQty: e.Z,
                    status: e.X,
                    time: e.O ?? e.E,
                    updateTime: e.T ?? e.E,
                    trailingDelta: e.d,
                    rejectReason: e.r,
                },
                report,
            );
            if (e.x === 'TRADE') {
                const symbol = `BINANCE:${e.s}`;
                const key = `${symbol}:${e.t}`;
                if (!this.seenTrades.has(key)) {
                    this.seenTrades.add(key);
                    const side: Side = e.S === 'BUY' ? 'buy' : 'sell';
                    const qty = Number(e.l);
                    const price = Number(e.L);
                    const lots = this.lots.get(symbol) ?? [];
                    const gain = this.applyLots(lots, side, qty, price);
                    this.lots.set(symbol, lots);
                    this.realized.set(symbol, (this.realized.get(symbol) ?? 0) + gain);
                    const id = this.ourId.get(e.c) ?? e.c;
                    this.recordExecution({
                        id: key,
                        accountId: this.id,
                        orderId: id,
                        symbol,
                        side,
                        qty,
                        price,
                        commission: e.N === this.o.quoteAsset ? Number(e.n) : Number(e.n) * price,
                        realizedPnl: gain,
                        time: e.T ?? e.E,
                    });
                }
            }
        } else if (e.e === 'outboundAccountPosition') {
            for (const b of e.B ?? []) {
                const free = Number(b.f);
                const locked = Number(b.l);
                if (free || locked) this.balances.set(b.a, { free, locked });
                else this.balances.delete(b.a);
            }
            this.events.emit('account', this.account());
            for (const p of this.positions()) this.events.emit('position', p);
        } else if (e.e === 'eventStreamTerminated') {
            this.ws?.close();
        }
    }

    /** Merge an order as the exchange reports it into local state. */
    private applyOrder(row: any, report?: ReconcileReport): void {
        const symbol = `BINANCE:${row.symbol}`;
        const id = this.ourId.get(row.clientOrderId) ?? row.clientOrderId;
        let order = this.all.get(id);
        const status = STATUS[row.status] ?? 'working';
        if (!order) {
            // Placed somewhere else (the exchange's own site, another program): adopt it.
            const type = String(row.type);
            order = {
                id,
                accountId: this.id,
                symbol,
                side: row.side === 'BUY' ? 'buy' : 'sell',
                type:
                    type === 'MARKET'
                        ? 'market'
                        : type.endsWith('_LIMIT')
                          ? 'stop_limit'
                          : type === 'LIMIT' || type === 'LIMIT_MAKER'
                            ? 'limit'
                            : row.trailingDelta
                              ? 'trailing_stop'
                              : 'stop',
                qty: Number(row.origQty),
                filledQty: 0,
                avgFillPrice: null,
                limit: Number(row.price) > 0 ? Number(row.price) : undefined,
                stop: Number(row.stopPrice) > 0 ? Number(row.stopPrice) : undefined,
                tif: 'GTC',
                status,
                role: 'entry',
                reduceOnly: false,
                source: 'api',
                comment: 'placed outside this app',
                createdAt: row.time ?? this.now(),
                updatedAt: row.updateTime ?? this.now(),
            };
            this.all.set(id, order);
            this.exchangeId.set(id, row.clientOrderId);
            this.ourId.set(row.clientOrderId, id);
        } else if (order.status !== status && report && report.at) {
            report.changed.push({ id, from: order.status, to: status });
        }
        if (row.orderId !== undefined) this.byNumber.set(`${symbol}:${row.orderId}`, id);
        // A report about a version of the order that has since been replaced says nothing about the order now.
        const current = this.exchangeId.get(id);
        if (current && current !== row.clientOrderId) return;
        const before = order.status;
        order.status = status;
        order.filledQty = Number(row.executedQty ?? order.filledQty);
        const quote = Number(row.cummulativeQuoteQty ?? 0);
        order.avgFillPrice = order.filledQty > 0 && quote > 0 ? quote / order.filledQty : order.avgFillPrice;
        order.updatedAt = row.updateTime ?? this.now();
        if (status === 'filled') order.filledAt ??= order.updatedAt;
        if (status === 'rejected' && row.rejectReason && row.rejectReason !== 'NONE')
            order.reason = String(row.rejectReason);
        if (before !== status || status === 'working') this.events.emit('order', { ...order });
        // An entry that filled now gets its exits; one that ended otherwise drops them.
        if (before !== 'filled' && status === 'filled' && this.waiting[id]) {
            const w = this.waiting[id];
            void this.placeExits(w.symbol, order.filledQty, w.bracket, id).catch((err) =>
                this.o.log?.(`could not place the exits of ${id}: ${err?.message ?? err}`),
            );
        } else if ((status === 'cancelled' || status === 'rejected') && this.waiting[id]) this.forget(id);
        // An exit list leg that filled or was cancelled ends the list.
        for (const [sym, e] of this.exits) {
            if ((e.tp === id || e.sl === id) && status !== 'working') {
                const other = e.tp === id ? e.sl : e.tp;
                if (other && status === 'filled') this.markCancelled(other, 'the other exit filled');
                this.exits.delete(sym);
            }
        }
    }

    /** Place the exits that protect `qty` of a symbol: one OCO list for two legs, or a single order. */
    private async placeExits(symbol: string, qty: number, bracket: Bracket, entryId?: string): Promise<void> {
        if (entryId) this.forget(entryId);
        const ticker = this.ticker(symbol);
        const ins = this.o.instrument(symbol);
        const q = this.qtyText(qty, ins);
        const px = (v: number) => this.priceText(v, ins);
        const base = entryId ? entryId.slice(0, 30) : newId('px').slice(0, 20);
        const now = this.now();
        const leg = (role: 'take_profit' | 'stop_loss', clientId: string, price: number): OrderState => ({
            id: clientId,
            accountId: this.id,
            symbol,
            side: 'sell',
            type: role === 'take_profit' ? 'limit' : 'stop',
            qty,
            filledQty: 0,
            avgFillPrice: null,
            limit: role === 'take_profit' ? price : undefined,
            stop: role === 'stop_loss' ? price : undefined,
            tif: 'GTC',
            status: 'working',
            role,
            parentId: entryId,
            reduceOnly: true,
            source: 'api',
            createdAt: now,
            updatedAt: now,
        });
        const tpId = `${base}-tp`;
        const slId = `${base}-sl`;
        const record = (o: OrderState) => {
            this.all.set(o.id, o);
            this.exchangeId.set(o.id, o.id);
            this.ourId.set(o.id, o.id);
            this.events.emit('order', { ...o });
        };
        if (bracket.takeProfit !== undefined && bracket.stopLoss !== undefined) {
            const list = `${base}-x`;
            await this.signed('POST', '/api/v3/orderList/oco', {
                symbol: ticker,
                side: 'SELL',
                quantity: q,
                aboveType: 'LIMIT_MAKER',
                abovePrice: px(bracket.takeProfit),
                aboveClientOrderId: tpId,
                belowType: 'STOP_LOSS',
                belowStopPrice: px(bracket.stopLoss),
                belowClientOrderId: slId,
                listClientOrderId: list,
            });
            record(leg('take_profit', tpId, bracket.takeProfit));
            record(leg('stop_loss', slId, bracket.stopLoss));
            this.exits.set(symbol, { list, tp: tpId, sl: slId, qty });
        } else if (bracket.takeProfit !== undefined) {
            await this.signed('POST', '/api/v3/order', {
                symbol: ticker,
                side: 'SELL',
                type: 'LIMIT',
                timeInForce: 'GTC',
                quantity: q,
                price: px(bracket.takeProfit),
                newClientOrderId: tpId,
            });
            record(leg('take_profit', tpId, bracket.takeProfit));
        } else if (bracket.stopLoss !== undefined) {
            await this.signed('POST', '/api/v3/order', {
                symbol: ticker,
                side: 'SELL',
                type: 'STOP_LOSS',
                quantity: q,
                stopPrice: px(bracket.stopLoss),
                newClientOrderId: slId,
            });
            record(leg('stop_loss', slId, bracket.stopLoss));
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** The exchange parameters for an order, after checking what a spot account can do. */
    private orderParams(order: OrderState): Record<string, string | number> {
        if (!order.symbol.startsWith('BINANCE:')) throw fail(`${this.name} trades Binance symbols only`);
        const ins = this.o.instrument(order.symbol);
        if (order.side !== 'buy' && order.side !== 'sell') throw fail('side must be buy or sell');
        if (!(order.qty > 0)) throw fail('quantity must be above zero');
        order.qty = floorToLot(order.qty, ins.lotSize);
        if (order.qty < ins.minQty - 1e-12)
            throw fail(`quantity must be at least ${ins.minQty} (in steps of ${ins.lotSize})`);
        if (order.tif === 'DAY')
            throw fail('Binance has no day orders: use good-till-cancelled or immediate-or-cancel');
        if (order.side === 'sell') {
            const free = this.balances.get(this.base(order.symbol))?.free ?? 0;
            if (order.qty > free + 1e-12)
                throw fail(`a spot account can only sell what it holds: ${free} ${this.base(order.symbol)} is free`);
        } else if (order.reduceOnly) throw fail('a spot account has no short position for a buy to reduce');
        if (order.bracket && order.side === 'sell')
            throw fail('a spot account cannot sell short, so a sell cannot open a bracketed position');
        const p: Record<string, string | number> = {
            symbol: this.ticker(order.symbol),
            side: order.side === 'buy' ? 'BUY' : 'SELL',
            quantity: this.qtyText(order.qty, ins),
        };
        const px = (v: number | undefined, name: string) => {
            if (v === undefined || !(v > 0)) throw fail(`a ${name} price is required`);
            return this.priceText(v, ins);
        };
        switch (order.type) {
            case 'market':
                p.type = 'MARKET';
                break;
            case 'limit':
                p.type = 'LIMIT';
                p.timeInForce = order.tif;
                p.price = px(order.limit, 'limit');
                break;
            case 'stop':
                p.type = 'STOP_LOSS';
                p.stopPrice = px(order.stop, 'stop');
                break;
            case 'stop_limit':
                p.type = 'STOP_LOSS_LIMIT';
                p.timeInForce = order.tif;
                p.stopPrice = px(order.stop, 'stop');
                p.price = px(order.limit, 'limit');
                break;
            case 'trailing_stop': {
                const last = this.prices.get(order.symbol);
                if (!(Number(order.trailDistance) > 0)) throw fail('a trailing stop needs a trail distance above zero');
                if (!last) throw fail(`there is no price for ${order.symbol} yet`);
                // Binance measures the trail in basis points of the price.
                const bips = Math.round((order.trailDistance! / last) * 10_000);
                if (bips < 10 || bips > 2000) throw fail('Binance accepts a trail of 0.1% to 20% of the price');
                p.type = 'STOP_LOSS';
                p.trailingDelta = bips;
                break;
            }
            default:
                throw fail('type must be market, limit, stop, stop_limit or trailing_stop');
        }
        return p;
    }

    private reject(order: OrderState, reason: string): OrderState {
        order.status = 'rejected';
        order.reason = reason;
        this.all.set(order.id, order);
        this.events.emit('order', { ...order });
        return { ...order };
    }

    private markCancelled(id: string, reason?: string): void {
        const o = this.all.get(id);
        if (!o || !isOpen(o)) return;
        o.status = 'cancelled';
        if (reason) o.reason = reason;
        o.updatedAt = this.now();
        this.events.emit('order', { ...o });
    }

    private forget(entryId: string): void {
        if (!this.waiting[entryId]) return;
        delete this.waiting[entryId];
        this.o.pending?.save(this.waiting);
    }

    private recordExecution(e: Execution): void {
        this.execs.push(e);
        if (this.execs.length > 4000) this.execs.splice(0, 2000);
        this.commissionPaid += e.commission;
        this.events.emit('execution', { ...e });
    }

    /** First-in first-out cost basis: returns what a sale realised. */
    private applyLots(lots: Lot[], side: Side, qty: number, price: number): number {
        if (side === 'buy') {
            lots.push({ qty, price });
            return 0;
        }
        let left = qty;
        let gain = 0;
        while (left > 1e-12 && lots.length) {
            const lot = lots[0];
            const take = Math.min(lot.qty, left);
            gain += (price - lot.price) * take;
            lot.qty -= take;
            left -= take;
            if (lot.qty <= 1e-12) lots.shift();
        }
        return gain;
    }

    private byExchangeOrder(orderId: number, symbol: string): string | undefined {
        return this.byNumber.get(`${symbol}:${orderId}`);
    }

    private ticker(symbol: string): string {
        return symbol.replace(/^BINANCE:/, '');
    }

    private base(symbol: string): string {
        const t = this.ticker(symbol);
        return t.endsWith(this.o.quoteAsset) ? t.slice(0, -this.o.quoteAsset.length) : t;
    }

    private qtyText(qty: number, ins: Instrument): string {
        return floorToLot(qty, ins.lotSize).toFixed(Math.min(8, decimalsOf(ins.lotSize)));
    }

    private priceText(price: number, ins: Instrument): string {
        return (Math.round(price / ins.tickSize) * ins.tickSize).toFixed(Math.min(8, decimalsOf(ins.tickSize)));
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.o.apiSecret).update(payload).digest('hex');
    }

    /** A signed REST call. Errors carry the exchange's message. */
    private async signed(
        method: string,
        path: string,
        params: Record<string, string | number | undefined> = {},
    ): Promise<any> {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
        query.set('recvWindow', String(this.o.recvWindow));
        query.set('timestamp', String(this.now()));
        query.set('signature', this.sign(query.toString()));
        const res = await this.fetchFn(`${this.rest}${path}?${query}`, {
            method,
            headers: { 'X-MBX-APIKEY': this.o.apiKey },
            signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let body: any;
        try {
            body = text ? JSON.parse(text) : {};
        } catch {
            body = { msg: text };
        }
        if (!res.ok)
            throw fail(
                `Binance: ${body?.msg ?? res.statusText}${body?.code ? ` (${body.code})` : ''}`,
                res.status === 401 ? 403 : 422,
            );
        return body;
    }
}
