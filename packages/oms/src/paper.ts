import { BrokerEmulator, type Commission, type EmulatorState, type Order as EmuOrder } from '@ts/backtest';
import { Emitter, floorToLot, newId } from '@ts/core';
import type {
    AccountState,
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
 * A paper account. Fills come from the same emulator the backtester uses, fed with live trade
 * prices instead of bars, so a strategy's paper fills follow the rules its backtest did.
 *
 * Fill rules on live prices: a market order fills at the last price (plus slippage); a limit fills
 * at its price once the market trades there (or at the market at once if it is already better); a
 * stop triggers when the market trades through it and fills at the market. Every fill is complete.
 */

export interface PaperSettings {
    initialBalance: number;
    currency: string;
    commission: Commission;
    slippageTicks: number;
    /** Gross exposure allowed as a multiple of equity. 1 means no borrowing. */
    leverage: number;
}

export interface PaperOptions extends Partial<PaperSettings> {
    id?: string;
    name?: string;
    instrument(symbol: string): Instrument;
    now?(): number;
}

interface Book {
    symbol: string;
    instrument: Instrument;
    emu: BrokerEmulator;
    /** The emulator's realised result after the last fill, to measure each fill's share. */
    realized: number;
    /** Orders protecting the whole position. */
    tp?: string;
    sl?: string;
    /** Best price seen by each trailing stop since it was placed. */
    trail: Map<string, number>;
    /** Which way the position pointed after the last fill: to recognise a reversal. */
    side: -1 | 0 | 1;
}

export interface PaperSnapshot {
    version: 1;
    settings: PaperSettings;
    books: {
        symbol: string;
        instrument: Instrument;
        emu: EmulatorState;
        realized: number;
        tp?: string;
        sl?: string;
        trail: [string, number][];
        side: -1 | 0 | 1;
    }[];
    orders: OrderState[];
    executions: Execution[];
    commissionPaid: number;
    prices: [string, { price: number; time: number }][];
    day: { key: number; startEquity: number; orders: number };
}

const DAY = 86_400_000;
const MAX_HISTORY = 2000;
const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export const DEFAULT_PAPER: PaperSettings = {
    initialBalance: 100_000,
    currency: 'USD',
    commission: { type: 'percent', value: 0 },
    slippageTicks: 0,
    leverage: 1,
};

export class PaperBroker implements BrokerPort {
    readonly id: string;
    readonly name: string;
    readonly kind = 'paper' as const;
    readonly events = new Emitter<BrokerEvents>();
    settings: PaperSettings;
    private instrumentOf: (symbol: string) => Instrument;
    private now: () => number;
    private books = new Map<string, Book>();
    private all = new Map<string, OrderState>();
    private execs: Execution[] = [];
    private prices = new Map<string, { price: number; time: number }>();
    private commissionPaid = 0;
    private day = { key: -1, startEquity: 0, orders: 0 };

    constructor(options: PaperOptions) {
        this.id = options.id ?? 'paper';
        this.name = options.name ?? 'Paper trading';
        this.instrumentOf = options.instrument;
        this.now = options.now ?? Date.now;
        this.settings = {
            initialBalance: options.initialBalance ?? DEFAULT_PAPER.initialBalance,
            currency: options.currency ?? DEFAULT_PAPER.currency,
            commission: options.commission ?? DEFAULT_PAPER.commission,
            slippageTicks: options.slippageTicks ?? DEFAULT_PAPER.slippageTicks,
            leverage: options.leverage ?? DEFAULT_PAPER.leverage,
        };
    }

    // ── Prices ──────────────────────────────────────────────────────────────

    /** Symbols that need live prices: an open position or an order still waiting. */
    watched(): string[] {
        const out = new Set<string>();
        for (const book of this.books.values()) if (book.emu.position !== 0) out.add(book.symbol);
        for (const o of this.all.values()) if (isOpen(o)) out.add(o.symbol);
        return [...out];
    }

    lastPrice(symbol: string): number | undefined {
        return this.prices.get(symbol)?.price;
    }

    /** A trade printed on the market. Waiting orders it reaches fill; positions are marked to it. */
    tick(symbol: string, price: number, time = this.now()): void {
        if (!(price > 0)) return;
        this.prices.set(symbol, { price, time });
        this.rollDay(time);
        const book = this.books.get(symbol);
        if (!book) return;
        book.emu.processTick(price, time);
        this.trailAfter(book, price, time);
        this.sync(book, time);
        this.emitPosition(book, time);
        this.emitAccount(time);
    }

    // ── State ───────────────────────────────────────────────────────────────

    account(): AccountState {
        const now = this.now();
        let closed = 0;
        let openCommission = 0;
        let unrealized = 0;
        let exposure = 0;
        for (const book of this.books.values()) {
            const price = this.prices.get(book.symbol)?.price ?? book.emu.lastPrice;
            closed += book.emu.realizedPnl;
            const state = book.emu.exportState();
            for (const lot of state.lots) {
                openCommission += lot.commission;
                if (Number.isFinite(price)) unrealized += (price - lot.price) * lot.qty * state.dir;
            }
            if (Number.isFinite(price)) exposure += Math.abs(book.emu.position) * price;
        }
        // The commission paid to open what is still held has already left the cash.
        const balance = this.settings.initialBalance + closed - openCommission;
        const equity = balance + unrealized;
        return {
            id: this.id,
            name: this.name,
            kind: this.kind,
            currency: this.settings.currency,
            balance,
            equity,
            unrealizedPnl: unrealized,
            realizedPnl: closed,
            commissionPaid: this.commissionPaid,
            dayPnl: this.day.key >= 0 ? equity - this.day.startEquity : 0,
            ordersToday: this.day.orders,
            buyingPower: Math.max(0, equity * this.settings.leverage - exposure),
            connected: true,
            updatedAt: now,
        };
    }

    orders(): OrderState[] {
        return [...this.all.values()].sort((a, b) => b.createdAt - a.createdAt).map((o) => ({ ...o }));
    }

    positions(): PositionState[] {
        const out: PositionState[] = [];
        for (const book of this.books.values()) if (book.emu.position !== 0) out.push(this.position(book, this.now()));
        return out;
    }

    executions(limit = 500): Execution[] {
        return this.execs.slice(-limit).reverse();
    }

    private position(book: Book, now: number): PositionState {
        const price = this.prices.get(book.symbol)?.price;
        const tp = book.tp ? this.all.get(book.tp) : undefined;
        const sl = book.sl ? this.all.get(book.sl) : undefined;
        return {
            accountId: this.id,
            symbol: book.symbol,
            qty: book.emu.position,
            avgPrice: book.emu.position === 0 ? 0 : book.emu.avgPrice,
            lastPrice: price ?? null,
            unrealizedPnl: price === undefined ? 0 : book.emu.unrealized(price) + this.lotCommission(book),
            realizedPnl: book.emu.realizedPnl,
            takeProfit: tp && isOpen(tp) ? tp.limit : undefined,
            stopLoss: sl && isOpen(sl) ? sl.stop : undefined,
            updatedAt: now,
        };
    }

    /** The emulator's unrealised figure is net of the entry commission; positions show it gross. */
    private lotCommission(book: Book): number {
        let c = 0;
        for (const lot of book.emu.exportState().lots) c += lot.commission;
        return c;
    }

    // ── Orders ──────────────────────────────────────────────────────────────

    async placeOrder(request: PlaceOrderRequest): Promise<OrderState> {
        const now = this.now();
        this.rollDay(now);
        const order: OrderState = {
            id: newId('ord'),
            accountId: this.id,
            symbol: String(request.symbol ?? ''),
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
        let book: Book;
        try {
            book = this.book(order.symbol);
            this.validate(order, book);
        } catch (err: any) {
            return this.reject(order, err.message);
        }
        this.day.orders++;
        this.all.set(order.id, order);
        if (order.bracket) {
            for (const [role, price] of [
                ['take_profit', order.bracket.takeProfit],
                ['stop_loss', order.bracket.stopLoss],
            ] as const) {
                if (price === undefined) continue;
                const child = this.exitOrder(order, role, price, now);
                child.status = 'inactive';
                this.all.set(child.id, child);
            }
        }
        this.submit(book, order);
        // Whatever is already in reach fills now, at the last price.
        this.poke(book, now);
        if (order.tif === 'IOC' && order.status === 'working' && book.emu.orders.get(order.id)?.status === 'pending') {
            book.emu.cancel(order.id);
            order.reason = 'not filled at once (immediate or cancel)';
        }
        this.sync(book, now);
        this.emitOrder(order);
        for (const child of this.children(order.id)) this.emitOrder(child);
        this.emitPosition(book, now);
        this.emitAccount(now);
        return { ...order };
    }

    async modifyOrder(id: string, changes: ModifyOrderRequest): Promise<OrderState> {
        const order = this.all.get(id);
        if (!order) throw Object.assign(new Error('order not found'), { statusCode: 404 });
        if (!isOpen(order)) throw fail(`the order is ${order.status} and can no longer be changed`);
        const now = this.now();
        const book = this.book(order.symbol);
        const next: OrderState = { ...order };
        if (changes.qty !== undefined) next.qty = Number(changes.qty);
        // A position exit always covers the whole position.
        if (order.parentId === undefined && (order.role === 'take_profit' || order.role === 'stop_loss')) {
            next.qty = Math.abs(book.emu.position);
        }
        if (changes.limit !== undefined) next.limit = Number(changes.limit);
        if (changes.stop !== undefined) next.stop = Number(changes.stop);
        if (changes.trailDistance !== undefined) next.trailDistance = Number(changes.trailDistance);
        if (changes.bracket) {
            const b = { ...(order.bracket ?? {}) };
            for (const leg of ['takeProfit', 'stopLoss'] as const) {
                const v = changes.bracket[leg];
                if (v === null) delete b[leg];
                else if (v !== undefined) b[leg] = Number(v);
            }
            next.bracket = b.takeProfit === undefined && b.stopLoss === undefined ? undefined : b;
        }
        // A trailing stop moved by hand starts trailing again from where it was put.
        if (order.type === 'trailing_stop' && changes.stop !== undefined) book.trail.delete(id);
        this.validate(next, book, order);
        Object.assign(order, next, { updatedAt: now });
        if (order.status === 'working') this.submit(book, order);
        if (changes.bracket && order.role === 'entry') this.rebracket(book, order, now);
        this.poke(book, now);
        this.sync(book, now);
        this.emitOrder(order);
        for (const child of this.children(order.id)) this.emitOrder(child);
        this.emitPosition(book, now);
        this.emitAccount(now);
        return { ...order };
    }

    async cancelOrder(id: string): Promise<OrderState> {
        const order = this.all.get(id);
        if (!order) throw Object.assign(new Error('order not found'), { statusCode: 404 });
        if (!isOpen(order)) throw fail(`the order is already ${order.status}`);
        const now = this.now();
        const book = this.book(order.symbol);
        this.drop(book, order, now);
        for (const child of this.children(order.id)) if (isOpen(child)) this.drop(book, child, now);
        if (book.tp === id) book.tp = undefined;
        if (book.sl === id) book.sl = undefined;
        this.emitPosition(book, now);
        return { ...order };
    }

    async closePosition(symbol: string, qty?: number): Promise<OrderState | null> {
        const book = this.books.get(symbol);
        const position = book?.emu.position ?? 0;
        if (position === 0) return null;
        const size = Math.min(Math.abs(position), qty === undefined ? Number.POSITIVE_INFINITY : Math.abs(qty));
        return this.placeOrder({
            symbol,
            side: position > 0 ? 'sell' : 'buy',
            type: 'market',
            qty: size,
            reduceOnly: true,
            source: 'api',
            comment: 'close position',
        });
    }

    async reversePosition(symbol: string): Promise<OrderState | null> {
        const position = this.books.get(symbol)?.emu.position ?? 0;
        if (position === 0) return null;
        return this.placeOrder({
            symbol,
            side: position > 0 ? 'sell' : 'buy',
            type: 'market',
            qty: Math.abs(position) * 2,
            source: 'api',
            comment: 'reverse position',
        });
    }

    async setPositionBrackets(
        symbol: string,
        brackets: { takeProfit?: number | null; stopLoss?: number | null },
    ): Promise<PositionState> {
        const book = this.books.get(symbol);
        const position = book?.emu.position ?? 0;
        if (!book || position === 0) throw fail(`there is no ${symbol} position to protect`);
        const now = this.now();
        const last = book.emu.lastPrice;
        const long = position > 0;
        for (const [leg, role] of [
            ['takeProfit', 'take_profit'],
            ['stopLoss', 'stop_loss'],
        ] as const) {
            const value = brackets[leg];
            if (value === undefined) continue;
            const key = leg === 'takeProfit' ? 'tp' : 'sl';
            const current = book[key] ? this.all.get(book[key]!) : undefined;
            if (value === null) {
                if (current && isOpen(current)) this.drop(book, current, now);
                book[key] = undefined;
                continue;
            }
            const price = Number(value);
            if (!(price > 0)) throw fail(`the ${role === 'take_profit' ? 'target' : 'stop'} price must be above zero`);
            const target = role === 'take_profit';
            // A long's target sits above the market and its stop below; the other way round for a short.
            const above = target === long;
            if (Number.isFinite(last) && (above ? price <= last : price >= last)) {
                throw fail(
                    `a ${long ? 'long' : 'short'} position's ${target ? 'target' : 'stop'} must be ${above ? 'above' : 'below'} the last price (${last})`,
                );
            }
            if (current && isOpen(current)) {
                if (target) current.limit = price;
                else current.stop = price;
                current.qty = Math.abs(position);
                current.updatedAt = now;
                this.submit(book, current);
                this.emitOrder(current);
            } else {
                const exit: OrderState = {
                    ...this.exitOrder(
                        { symbol, side: long ? 'buy' : 'sell', qty: Math.abs(position), id: '' } as OrderState,
                        role,
                        price,
                        now,
                    ),
                    parentId: undefined,
                    comment: 'position bracket',
                };
                this.all.set(exit.id, exit);
                book[key] = exit.id;
                this.submit(book, exit);
                this.emitOrder(exit);
            }
        }
        this.poke(book, now);
        this.sync(book, now);
        this.emitPosition(book, now);
        this.emitAccount(now);
        return this.position(book, now);
    }

    /** Start again with a clean account. */
    reset(settings: Partial<PaperSettings> = {}): void {
        this.settings = { ...this.settings, ...settings };
        this.books.clear();
        this.all.clear();
        this.execs = [];
        this.commissionPaid = 0;
        this.day = { key: -1, startEquity: 0, orders: 0 };
        this.rollDay(this.now());
        this.emitAccount(this.now());
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    snapshot(): PaperSnapshot {
        const finished = [...this.all.values()].filter((o) => !isOpen(o)).sort((a, b) => b.updatedAt - a.updatedAt);
        const keep = new Set(finished.slice(0, MAX_HISTORY).map((o) => o.id));
        return {
            version: 1,
            settings: { ...this.settings },
            books: [...this.books.values()].map((b) => ({
                symbol: b.symbol,
                instrument: b.instrument,
                emu: b.emu.exportState(),
                realized: b.realized,
                tp: b.tp,
                sl: b.sl,
                trail: [...b.trail],
                side: b.side,
            })),
            orders: [...this.all.values()].filter((o) => isOpen(o) || keep.has(o.id)),
            executions: this.execs.slice(-MAX_HISTORY),
            commissionPaid: this.commissionPaid,
            prices: [...this.prices],
            day: { ...this.day },
        };
    }

    restore(snapshot: PaperSnapshot): void {
        if (snapshot?.version !== 1) throw new Error('unknown paper account format');
        this.settings = { ...DEFAULT_PAPER, ...snapshot.settings };
        this.books.clear();
        for (const b of snapshot.books) {
            const book = this.newBook(b.symbol, b.instrument);
            book.emu.importState(b.emu);
            book.realized = b.realized;
            book.tp = b.tp;
            book.sl = b.sl;
            book.trail = new Map(b.trail);
            book.side = b.side ?? (Math.sign(book.emu.position) as -1 | 0 | 1);
        }
        this.all = new Map(snapshot.orders.map((o) => [o.id, { ...o }]));
        this.execs = [...snapshot.executions];
        this.commissionPaid = snapshot.commissionPaid;
        this.prices = new Map(snapshot.prices);
        this.day = { ...snapshot.day };
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private newBook(symbol: string, instrument: Instrument): Book {
        const emu = new BrokerEmulator({
            initialCapital: 0,
            commission: this.settings.commission,
            slippageTicks: this.settings.slippageTicks,
            tickSize: instrument.tickSize,
        });
        const book: Book = { symbol, instrument, emu, realized: 0, trail: new Map(), side: 0 };
        emu.onFill = (fill, emuOrder) => this.onFill(book, fill, emuOrder);
        this.books.set(symbol, book);
        return book;
    }

    private book(symbol: string): Book {
        const existing = this.books.get(symbol);
        if (existing) return existing;
        const instrument = this.instrumentOf(symbol);
        const book = this.newBook(symbol, instrument);
        const price = this.prices.get(symbol);
        if (price) book.emu.processTick(price.price, price.time);
        return book;
    }

    /** Let the emulator act on the last price again, after orders changed. */
    private poke(book: Book, now: number): void {
        const last = book.emu.lastPrice;
        if (Number.isFinite(last)) book.emu.processTick(last, now);
    }

    private reject(order: OrderState, reason: string): OrderState {
        order.status = 'rejected';
        order.reason = reason;
        this.all.set(order.id, order);
        this.emitOrder(order);
        return { ...order };
    }

    private children(parentId: string): OrderState[] {
        const out: OrderState[] = [];
        for (const o of this.all.values()) if (o.parentId === parentId) out.push(o);
        return out;
    }

    /** A bracket exit for `parent`: opposite side, same size, reduce-only. */
    private exitOrder(parent: OrderState, role: 'take_profit' | 'stop_loss', price: number, now: number): OrderState {
        const target = role === 'take_profit';
        return {
            id: parent.id ? `${parent.id}-${target ? 'tp' : 'sl'}` : newId(target ? 'tp' : 'sl'),
            accountId: this.id,
            symbol: parent.symbol,
            side: parent.side === 'buy' ? 'sell' : 'buy',
            type: target ? 'limit' : 'stop',
            qty: parent.qty,
            filledQty: 0,
            avgFillPrice: null,
            limit: target ? price : undefined,
            stop: target ? undefined : price,
            tif: 'GTC',
            status: 'working',
            role,
            parentId: parent.id || undefined,
            reduceOnly: true,
            source: parent.source ?? 'api',
            createdAt: now,
            updatedAt: now,
        };
    }

    /** Check an order (new, or a change to `before`) against the instrument, the market and the account. */
    private validate(order: OrderState, book: Book, before?: OrderState): void {
        const { instrument } = book;
        if (order.side !== 'buy' && order.side !== 'sell') throw fail('side must be buy or sell');
        if (!['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'].includes(order.type)) {
            throw fail('type must be market, limit, stop, stop_limit or trailing_stop');
        }
        if (!['GTC', 'DAY', 'IOC'].includes(order.tif)) throw fail('time in force must be GTC, DAY or IOC');
        if (!(order.qty > 0) || !Number.isFinite(order.qty)) throw fail('quantity must be above zero');
        order.qty = floorToLot(order.qty, instrument.lotSize);
        if (order.qty < instrument.minQty - 1e-12) {
            throw fail(`quantity must be at least ${instrument.minQty} (in steps of ${instrument.lotSize})`);
        }
        const last = book.emu.lastPrice;
        const known = Number.isFinite(last);
        const needs = (field: 'limit' | 'stop') => {
            const v = order[field];
            if (v === undefined || !(v > 0) || !Number.isFinite(v)) throw fail(`a ${field} price is required`);
        };
        if (order.type === 'limit' || order.type === 'stop_limit') needs('limit');
        if (order.type === 'stop' || order.type === 'stop_limit') needs('stop');
        if (order.type === 'market' && !known) throw fail(`there is no price for ${order.symbol} yet`);
        if (order.type === 'trailing_stop') {
            if (!(Number(order.trailDistance) > 0)) throw fail('a trailing stop needs a trail distance above zero');
            if (!known) throw fail(`there is no price for ${order.symbol} yet`);
            if (order.stop === undefined || (before && order.trailDistance !== before.trailDistance)) {
                order.stop = order.side === 'sell' ? last - order.trailDistance! : last + order.trailDistance!;
            }
        } else if (order.type !== 'stop' && order.type !== 'stop_limit') order.stop = undefined;
        if (order.type !== 'limit' && order.type !== 'stop_limit') order.limit = undefined;
        if (order.type !== 'trailing_stop') order.trailDistance = undefined;
        // A stop that is already through the market would fire at once: almost always a mistake.
        const triggered = before?.status === 'working' && book.emu.orders.get(before.id)?.triggered;
        if (order.stop !== undefined && known && !triggered) {
            if (order.side === 'buy' && order.stop <= last)
                throw fail(`a buy stop must be above the last price (${last})`);
            if (order.side === 'sell' && order.stop >= last)
                throw fail(`a sell stop must be below the last price (${last})`);
        }
        const ref = order.limit ?? order.stop ?? last;
        if (instrument.minNotional && known && order.qty * ref < instrument.minNotional - 1e-9) {
            throw fail(`the order is worth ${(order.qty * ref).toFixed(2)}; the minimum is ${instrument.minNotional}`);
        }
        if (order.bracket) {
            const long = order.side === 'buy';
            const { takeProfit, stopLoss } = order.bracket;
            if (takeProfit !== undefined && (!(takeProfit > 0) || (long ? takeProfit <= ref : takeProfit >= ref))) {
                throw fail(`the target must be ${long ? 'above' : 'below'} the entry price (${ref})`);
            }
            if (stopLoss !== undefined && (!(stopLoss > 0) || (long ? stopLoss >= ref : stopLoss <= ref))) {
                throw fail(`the stop loss must be ${long ? 'below' : 'above'} the entry price (${ref})`);
            }
        }
        // Buying power: only orders that would add exposure are checked.
        if (!order.reduceOnly && known && !before) {
            const sign = order.side === 'buy' ? 1 : -1;
            const position = book.emu.position;
            const after = Math.abs(position + sign * order.qty);
            const added = (after - Math.abs(position)) * ref;
            if (added > 0) {
                const account = this.account();
                if (added > account.buyingPower + 1e-6) {
                    throw fail(
                        `not enough buying power: the order needs ${added.toFixed(2)} ${this.settings.currency}, ${account.buyingPower.toFixed(2)} is available`,
                    );
                }
            }
        }
    }

    /** Hand an order to the emulator (replacing it there if it is already waiting). */
    private submit(book: Book, order: OrderState): void {
        const type = order.type === 'trailing_stop' ? 'stop' : order.type;
        const placed = book.emu.submit({
            id: order.id,
            side: order.side,
            qty: order.qty,
            type,
            limit: order.limit,
            stop: order.stop,
            reduceOnly: order.reduceOnly,
            ocaGroup: order.parentId
                ? `oca:${order.parentId}`
                : order.role === 'take_profit' || order.role === 'stop_loss'
                  ? `pos:${book.symbol}`
                  : undefined,
            comment: order.comment,
        });
        // The emulator puts prices on the tick grid; show the order as it rests.
        if (order.limit !== undefined) order.limit = placed.limit;
        if (order.stop !== undefined) order.stop = placed.stop;
        order.status = 'working';
    }

    /** Cancel an order on the user's (or the system's) behalf. */
    private drop(book: Book, order: OrderState, now: number, reason?: string): void {
        if (order.status === 'working') book.emu.cancel(order.id);
        order.status = 'cancelled';
        if (reason) order.reason = reason;
        order.updatedAt = now;
        book.trail.delete(order.id);
        this.emitOrder(order);
    }

    /** Re-create an entry's bracket exits after its bracket was changed. */
    private rebracket(book: Book, entry: OrderState, now: number): void {
        for (const role of ['take_profit', 'stop_loss'] as const) {
            const price = role === 'take_profit' ? entry.bracket?.takeProfit : entry.bracket?.stopLoss;
            const existing = this.children(entry.id).find((c) => c.role === role && isOpen(c));
            if (price === undefined) {
                if (existing) this.drop(book, existing, now);
                continue;
            }
            if (existing) {
                if (role === 'take_profit') existing.limit = price;
                else existing.stop = price;
                existing.updatedAt = now;
                if (existing.status === 'working') this.submit(book, existing);
            } else {
                const child = this.exitOrder(entry, role, price, now);
                child.status = entry.status === 'filled' ? 'working' : 'inactive';
                this.all.set(child.id, child);
                if (child.status === 'working') this.submit(book, child);
            }
        }
    }

    private onFill(
        book: Book,
        fill: { orderId: string; time: number; price: number; qty: number; commission: number },
        emuOrder: EmuOrder,
    ): void {
        const order = this.all.get(fill.orderId);
        const realized = book.emu.realizedPnl - book.realized;
        book.realized = book.emu.realizedPnl;
        this.commissionPaid += fill.commission;
        const fillSide: Side = fill.qty > 0 ? 'buy' : 'sell';
        const execution: Execution = {
            id: newId('exe'),
            accountId: this.id,
            orderId: fill.orderId,
            symbol: book.symbol,
            side: fillSide,
            qty: Math.abs(fill.qty),
            price: fill.price,
            commission: fill.commission,
            realizedPnl: realized,
            time: fill.time,
        };
        this.execs.push(execution);
        if (this.execs.length > MAX_HISTORY * 2) this.execs.splice(0, this.execs.length - MAX_HISTORY);
        if (order) {
            order.status = 'filled';
            order.filledQty = Math.abs(fill.qty);
            order.avgFillPrice = fill.price;
            order.filledAt = fill.time;
            order.updatedAt = fill.time;
            // A reduce-only order may fill less than asked when the position was smaller.
            if (emuOrder.filledQty !== undefined) order.filledQty = emuOrder.filledQty;
        }
        this.events.emit('execution', { ...execution });
        if (order) this.emitOrder(order);

        const position = book.emu.position;
        const side = Math.sign(position) as -1 | 0 | 1;
        if (side === 0 || (book.side !== 0 && side !== book.side)) {
            // The position closed or turned: the exits that protected it have nothing left to protect.
            for (const o of this.all.values()) {
                if (o.symbol !== book.symbol || o.status !== 'working' || !o.reduceOnly || o.id === fill.orderId)
                    continue;
                this.drop(book, o, fill.time, side === 0 ? 'position closed' : 'position reversed');
            }
            book.tp = undefined;
            book.sl = undefined;
        } else if (book.tp || book.sl) {
            // The position changed size: its protective orders follow it.
            for (const id of [book.tp, book.sl]) {
                const o = id ? this.all.get(id) : undefined;
                if (!o || o.status !== 'working' || o.qty === Math.abs(position)) continue;
                o.qty = Math.abs(position);
                o.updatedAt = fill.time;
                this.submit(book, o);
                this.emitOrder(o);
            }
        }
        book.side = side;
        // An entry filled: its bracket exits start working.
        if (order?.role === 'entry') {
            for (const child of this.children(order.id)) {
                if (child.status !== 'inactive') continue;
                child.qty = order.filledQty;
                child.updatedAt = fill.time;
                this.submit(book, child);
                this.emitOrder(child);
            }
        }
    }

    /** Move trailing stops behind the price. */
    private trailAfter(book: Book, price: number, now: number): void {
        for (const order of this.all.values()) {
            if (order.symbol !== book.symbol || order.type !== 'trailing_stop' || order.status !== 'working') continue;
            const sell = order.side === 'sell';
            const best = book.trail.get(order.id);
            const nextBest = best === undefined ? price : sell ? Math.max(best, price) : Math.min(best, price);
            book.trail.set(order.id, nextBest);
            const stop = sell ? nextBest - order.trailDistance! : nextBest + order.trailDistance!;
            if (order.stop === undefined || (sell ? stop > order.stop + 1e-12 : stop < order.stop - 1e-12)) {
                order.stop = stop;
                order.updatedAt = now;
                this.submit(book, order);
                if (order.stop !== undefined && (sell ? order.stop >= price : order.stop <= price)) {
                    // Rounding put the stop on the market: let it fire now.
                    book.emu.processTick(price, now);
                }
                this.emitOrder(order);
            }
        }
    }

    /** Bring order states in line with the emulator (fills, cancellations by one-cancels-the-other). */
    private sync(book: Book, now: number): void {
        for (const order of this.all.values()) {
            if (order.symbol !== book.symbol || order.status !== 'working') continue;
            const emu = book.emu.orders.get(order.id);
            if (!emu || emu.status === 'pending') continue;
            if (emu.status === 'cancelled' || emu.status === 'rejected') {
                order.status = emu.status;
                order.reason ??=
                    emu.reason ?? (order.parentId || order.reduceOnly ? 'the other exit filled' : undefined);
                order.updatedAt = now;
                book.trail.delete(order.id);
                this.emitOrder(order);
                if (order.role === 'entry') {
                    for (const child of this.children(order.id))
                        if (isOpen(child)) this.drop(book, child, now, 'entry cancelled');
                }
            }
        }
    }

    /** Start a new trading day: DAY orders expire and the day's figures restart. */
    private rollDay(now: number): void {
        const key = Math.floor(now / DAY);
        if (key === this.day.key) return;
        this.day.key = key;
        this.day.orders = 0;
        for (const order of this.all.values()) {
            if (order.tif !== 'DAY' || !isOpen(order) || Math.floor(order.createdAt / DAY) >= key) continue;
            const book = this.books.get(order.symbol);
            if (book) this.drop(book, order, now, 'expired at the end of the day');
        }
        this.day.startEquity = this.account().equity;
    }

    private emitOrder(order: OrderState): void {
        this.events.emit('order', { ...order });
    }

    private emitPosition(book: Book, now: number): void {
        this.events.emit('position', this.position(book, now));
    }

    private emitAccount(_now: number): void {
        this.events.emit('account', this.account());
    }
}
