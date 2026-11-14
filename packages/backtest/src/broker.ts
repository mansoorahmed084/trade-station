import { type Bar, decimalsOf } from '@ts/core';

/**
 * A simulated broker. The same engine fills orders in a backtest (bar by bar) and in paper trading
 * (tick by tick), so a strategy sees one set of fill rules everywhere.
 *
 * Fill rules, following TradingView's documented broker emulator:
 *  - a market order fills at the next price the broker sees (the next bar's open in a backtest);
 *  - a limit order fills at its price or better; a stop order at its price or worse;
 *  - when a bar opens beyond an order's price (a gap), the order fills at the open;
 *  - inside a bar the price is assumed to travel open → nearer extreme → farther extreme → close,
 *    or, with intrabar data (the bar magnifier), along the same path through each smaller bar.
 */

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderSide = 'buy' | 'sell';

export interface OrderRequest {
    /** Caller's id. Submitting an order with the id of a pending one replaces it. */
    id: string;
    side: OrderSide;
    qty: number;
    type: OrderType;
    limit?: number;
    stop?: number;
    /** Never open or increase a position: the quantity is capped at what closes the current one. */
    reduceOnly?: boolean;
    /** Orders sharing a group cancel each other when one fills (one-cancels-the-other). */
    ocaGroup?: string;
    comment?: string;
}

export interface Order extends OrderRequest {
    status: 'pending' | 'filled' | 'cancelled' | 'rejected';
    createdAt: number;
    /** A stop-limit whose stop has been reached and now rests as a limit. */
    triggered?: boolean;
    filledAt?: number;
    fillPrice?: number;
    filledQty?: number;
    reason?: string;
}

export interface Fill {
    orderId: string;
    time: number;
    price: number;
    /** Signed: positive bought, negative sold. */
    qty: number;
    commission: number;
    comment?: string;
}

export interface Trade {
    side: 'long' | 'short';
    qty: number;
    entryId: string;
    entryTime: number;
    entryPrice: number;
    exitId: string;
    exitTime: number;
    exitPrice: number;
    /** Net of commission on both sides. */
    pnl: number;
    commission: number;
    /** Best and worst unrealised result while the trade was open, in currency. */
    maxRunup: number;
    maxDrawdown: number;
    entryComment?: string;
    exitComment?: string;
}

export type Commission =
    | { type: 'percent'; value: number }
    | { type: 'cash_per_order'; value: number }
    | { type: 'cash_per_contract'; value: number };

export interface BrokerOptions {
    initialCapital: number;
    commission: Commission;
    /** Adverse ticks added to market and stop fills. */
    slippageTicks: number;
    tickSize: number;
    /** Reject an order that would take the account's equity below zero. */
    checkFunds: boolean;
}

export const DEFAULT_BROKER: BrokerOptions = {
    initialCapital: 10_000,
    commission: { type: 'percent', value: 0 },
    slippageTicks: 0,
    tickSize: 0.01,
    checkFunds: false,
};

interface Lot {
    qty: number;
    price: number;
    time: number;
    orderId: string;
    comment?: string;
    /** Commission paid to open what is left of this lot. */
    commission: number;
    best: number;
    worst: number;
}

const EPS = 1e-12;

export class BrokerEmulator {
    readonly options: BrokerOptions;
    readonly orders = new Map<string, Order>();
    /** Orders still waiting, in the order they were placed. Kept apart so a long run never rescans its whole history. */
    private active: Order[] = [];
    readonly fills: Fill[] = [];
    readonly trades: Trade[] = [];
    /** Open lots, oldest first: positions close first-in first-out, as TradingView's default does. */
    private lots: Lot[] = [];
    private dir: 1 | -1 | 0 = 0;
    private realized = 0;
    private last = Number.NaN;
    private clock = 0;
    onFill?: (fill: Fill, order: Order) => void;

    private tickDecimals: number;

    constructor(options: Partial<BrokerOptions> = {}) {
        this.options = { ...DEFAULT_BROKER, ...options };
        this.tickDecimals = Math.min(12, decimalsOf(this.options.tickSize));
    }

    // ── State ───────────────────────────────────────────────────────────────

    /** Signed position: positive long, negative short. */
    get position(): number {
        let q = 0;
        for (const lot of this.lots) q += lot.qty;
        return q * this.dir;
    }

    get avgPrice(): number {
        let q = 0;
        let v = 0;
        for (const lot of this.lots) {
            q += lot.qty;
            v += lot.qty * lot.price;
        }
        return q > 0 ? v / q : Number.NaN;
    }

    /** Number of separate entries making up the open position. */
    get openEntries(): number {
        return this.lots.length;
    }

    get lastPrice(): number {
        return this.last;
    }

    unrealized(price = this.last): number {
        if (Number.isNaN(price)) return 0;
        let pnl = 0;
        for (const lot of this.lots) pnl += (price - lot.price) * lot.qty * this.dir - lot.commission;
        return pnl;
    }

    get realizedPnl(): number {
        return this.realized;
    }

    equity(price = this.last): number {
        return this.options.initialCapital + this.realized + this.unrealized(price);
    }

    pending(): Order[] {
        return [...this.active];
    }

    private retire(order: Order): void {
        const i = this.active.indexOf(order);
        if (i >= 0) this.active.splice(i, 1);
    }

    // ── Orders ──────────────────────────────────────────────────────────────

    submit(request: OrderRequest, time = this.clock): Order {
        const order: Order = { ...request, status: 'pending', createdAt: time };
        const reject = (reason: string): Order => {
            order.status = 'rejected';
            order.reason = reason;
            this.orders.set(order.id, order);
            return order;
        };
        if (!(order.qty > 0) || !Number.isFinite(order.qty)) return reject('quantity must be positive');
        if ((order.type === 'limit' || order.type === 'stop_limit') && !(order.limit! > 0))
            return reject('a limit price is required');
        if ((order.type === 'stop' || order.type === 'stop_limit') && !(order.stop! > 0))
            return reject('a stop price is required');
        // Order prices sit on the tick grid, moved away from the market as TradingView does: a buy
        // limit and a sell stop round down, a sell limit and a buy stop round up.
        const buy = order.side === 'buy';
        if (order.limit !== undefined) order.limit = this.snap(order.limit, !buy);
        if (order.stop !== undefined) order.stop = this.snap(order.stop, buy);
        const previous = this.orders.get(order.id);
        if (previous?.status === 'pending') {
            previous.status = 'cancelled';
            this.retire(previous);
        }
        this.orders.set(order.id, order);
        this.active.push(order);
        return order;
    }

    /** A price moved onto the tick grid, up or down. One already on a tick (within rounding noise) stays. */
    private snap(price: number, up: boolean): number {
        const tick = this.options.tickSize;
        if (!(tick > 0) || !Number.isFinite(price)) return price;
        const ticks = price / tick;
        const nearest = Math.round(ticks);
        const n = Math.abs(ticks - nearest) < 1e-6 ? nearest : up ? Math.ceil(ticks) : Math.floor(ticks);
        return Number((n * tick).toFixed(this.tickDecimals));
    }

    cancel(id: string): boolean {
        const order = this.orders.get(id);
        if (order?.status !== 'pending') return false;
        order.status = 'cancelled';
        this.retire(order);
        return true;
    }

    cancelAll(): void {
        for (const order of this.active) order.status = 'cancelled';
        this.active = [];
    }

    // ── Price feed ──────────────────────────────────────────────────────────

    /** The path price is assumed to take through a bar. */
    static path(bar: Bar): number[] {
        const upFirst = bar.high - bar.open <= bar.open - bar.low;
        return upFirst ? [bar.open, bar.high, bar.low, bar.close] : [bar.open, bar.low, bar.high, bar.close];
    }

    /**
     * Advance through one bar. With `intrabar` bars (the bar magnifier) the path follows them in
     * order; without, it follows the bar's own open, extremes and close.
     */
    processBar(bar: Bar, intrabar?: readonly Bar[]): void {
        this.clock = bar.time;
        const parts = intrabar?.length ? intrabar : [bar];
        let first = true;
        for (const part of parts) {
            const points = BrokerEmulator.path(part);
            // The first price of a bar is a jump from the previous close: orders it passes fill at it.
            this.jump(points[0], first ? bar.time : part.time);
            first = false;
            for (let i = 1; i < points.length; i++) this.move(points[i], part.time);
            this.track(part.high, part.low);
        }
    }

    /** Advance to a live price. Orders the move crosses fill at their own price. */
    processTick(price: number, time: number): void {
        this.clock = time;
        if (Number.isNaN(this.last)) this.jump(price, time);
        else this.move(price, time);
        this.track(price, price);
    }

    /** Fill resting market orders at the current price without moving it (used for "fill on close"). */
    processClose(time: number): void {
        if (Number.isNaN(this.last)) return;
        for (const order of [...this.active]) if (order.type === 'market') this.execute(order, this.last, time, true);
    }

    private track(high: number, low: number): void {
        for (const lot of this.lots) {
            const hi = (high - lot.price) * lot.qty * this.dir;
            const lo = (low - lot.price) * lot.qty * this.dir;
            lot.best = Math.max(lot.best, hi, lo);
            lot.worst = Math.min(lot.worst, hi, lo);
        }
    }

    /** The price at which a resting order would trade if the market is at `price`, or null. */
    private static reach(order: Order, price: number): boolean {
        const buy = order.side === 'buy';
        if (order.type === 'limit' || (order.type === 'stop_limit' && order.triggered))
            return buy ? price <= order.limit! + EPS : price >= order.limit! - EPS;
        if (order.type === 'stop' || order.type === 'stop_limit')
            return buy ? price >= order.stop! - EPS : price <= order.stop! + EPS;
        return true;
    }

    /** Trade every order that is in reach at the current price, in the order they were placed. */
    private drain(time: number): void {
        for (;;) {
            let order: Order | undefined;
            for (const o of this.active) {
                if (BrokerEmulator.reach(o, this.last)) {
                    order = o;
                    break;
                }
            }
            if (!order) return;
            if (order.type === 'stop_limit' && !order.triggered) {
                // The stop is reached: from here on it rests as a limit (and may fill at once).
                order.triggered = true;
                continue;
            }
            this.execute(order, this.last, time, order.type === 'market' || order.type === 'stop');
        }
    }

    /** A discontinuous move (a bar's open): every order now in reach trades at this price. */
    private jump(price: number, time: number): void {
        this.last = price;
        this.drain(time);
    }

    /**
     * A continuous move from the last price to `target`. The price visits each resting order's
     * level in turn, nearest first, so every order trades at its own price and a fill that arms
     * or cancels another order (a bracket) is seen before the move goes on.
     */
    private move(target: number, time: number): void {
        if (Number.isNaN(this.last)) {
            this.jump(target, time);
            return;
        }
        for (;;) {
            this.drain(time);
            const lo = Math.min(this.last, target);
            const hi = Math.max(this.last, target);
            let at = Number.NaN;
            for (const order of this.active) {
                const level = BrokerEmulator.level(order);
                if (level === null || level < lo - EPS || level > hi + EPS) continue;
                if (Number.isNaN(at) || Math.abs(level - this.last) < Math.abs(at - this.last)) at = level;
            }
            if (Number.isNaN(at)) break;
            this.last = at;
        }
        this.last = target;
    }

    /** The price a resting order waits for; null for a market order. */
    private static level(order: Order): number | null {
        if (order.type === 'market') return null;
        if (order.type === 'limit') return order.limit!;
        if (order.type === 'stop') return order.stop!;
        return order.triggered ? order.limit! : order.stop!;
    }

    private commissionFor(qty: number, price: number): number {
        const c = this.options.commission;
        if (c.type === 'percent') return (Math.abs(qty) * price * c.value) / 100;
        if (c.type === 'cash_per_order') return c.value;
        return Math.abs(qty) * c.value;
    }

    private execute(order: Order, rawPrice: number, time: number, slip: boolean): void {
        const sign = order.side === 'buy' ? 1 : -1;
        let qty = order.qty;
        if (order.reduceOnly) {
            const closable = this.dir === -sign ? Math.abs(this.position) : 0;
            qty = Math.min(qty, closable);
            if (!(qty > EPS)) {
                order.status = 'cancelled';
                order.reason = 'nothing to reduce';
                this.retire(order);
                return;
            }
        }
        const price = slip ? rawPrice + sign * this.options.slippageTicks * this.options.tickSize : rawPrice;
        if (this.options.checkFunds && this.dir !== -sign && this.equity(price) - qty * price < -EPS) {
            order.status = 'rejected';
            order.reason = 'insufficient funds';
            this.retire(order);
            return;
        }
        const commission = this.commissionFor(qty, price);
        order.status = 'filled';
        this.retire(order);
        order.filledAt = time;
        order.fillPrice = price;
        order.filledQty = qty;
        const fill: Fill = { orderId: order.id, time, price, qty: sign * qty, commission, comment: order.comment };
        this.fills.push(fill);
        this.apply(fill, order);
        if (order.ocaGroup) {
            for (const other of [...this.active]) {
                if (other.ocaGroup !== order.ocaGroup) continue;
                other.status = 'cancelled';
                this.retire(other);
            }
        }
        this.onFill?.(fill, order);
    }

    private apply(fill: Fill, order: Order): void {
        const sign = fill.qty > 0 ? 1 : -1;
        let qty = Math.abs(fill.qty);
        const perUnit = fill.commission / qty;
        // Close open lots first, oldest first.
        while (qty > EPS && this.dir === -sign && this.lots.length) {
            const lot = this.lots[0];
            const closed = Math.min(lot.qty, qty);
            const share = closed / lot.qty;
            const entryCommission = lot.commission * share;
            const exitCommission = perUnit * closed;
            const gross = (fill.price - lot.price) * closed * this.dir;
            const pnl = gross - entryCommission - exitCommission;
            this.realized += pnl;
            this.trades.push({
                side: this.dir === 1 ? 'long' : 'short',
                qty: closed,
                entryId: lot.orderId,
                entryTime: lot.time,
                entryPrice: lot.price,
                exitId: order.id,
                exitTime: fill.time,
                exitPrice: fill.price,
                pnl,
                commission: entryCommission + exitCommission,
                maxRunup: Math.max(lot.best * share, gross),
                maxDrawdown: Math.min(lot.worst * share, gross),
                entryComment: lot.comment,
                exitComment: order.comment,
            });
            lot.qty -= closed;
            lot.commission -= entryCommission;
            lot.best *= 1 - share;
            lot.worst *= 1 - share;
            qty -= closed;
            if (lot.qty <= EPS) this.lots.shift();
        }
        if (this.lots.length === 0) this.dir = 0;
        // Whatever is left opens (or adds to) a position in the fill's direction.
        if (qty > EPS) {
            this.dir = sign;
            this.lots.push({
                qty,
                price: fill.price,
                time: fill.time,
                orderId: order.id,
                comment: order.comment,
                commission: perUnit * qty,
                best: 0,
                worst: 0,
            });
        }
    }
}
