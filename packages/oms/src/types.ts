import type { Emitter } from '@ts/core';

/**
 * The trading model shared by every account, paper or real, and by the app. Shaped after
 * TradingView's Broker API: orders, positions, executions and an account summary, with streaming
 * updates. Types only — the app imports this file.
 */

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
/** Good till cancelled, until the end of the (UTC) day, or fill at once or not at all. */
export type TimeInForce = 'GTC' | 'DAY' | 'IOC';
/** `inactive`: a bracket exit waiting for its entry to fill. */
export type OrderStatus = 'working' | 'inactive' | 'filled' | 'cancelled' | 'rejected';
export type OrderRole = 'entry' | 'take_profit' | 'stop_loss' | 'close';
export type OrderSource = 'ticket' | 'chart' | 'dom' | 'api' | 'strategy' | 'webhook';
export type AccountKind = 'paper' | 'sandbox' | 'live';

export interface Bracket {
    takeProfit?: number;
    stopLoss?: number;
}

export interface PlaceOrderRequest {
    symbol: string;
    side: Side;
    type: OrderType;
    qty: number;
    limit?: number;
    stop?: number;
    /** For a trailing stop: how far behind the best price since it was placed the stop follows, in price. */
    trailDistance?: number;
    tif?: TimeInForce;
    /** Exits that wait for this order to fill and then protect what it opened (one cancels the other). */
    bracket?: Bracket;
    /** Never open or add to a position. */
    reduceOnly?: boolean;
    clientId?: string;
    source?: OrderSource;
    comment?: string;
}

export interface ModifyOrderRequest {
    qty?: number;
    limit?: number;
    stop?: number;
    trailDistance?: number;
    /** For an entry: change its bracket. `null` removes that leg. */
    bracket?: { takeProfit?: number | null; stopLoss?: number | null };
}

export interface OrderState {
    id: string;
    accountId: string;
    symbol: string;
    side: Side;
    type: OrderType;
    qty: number;
    filledQty: number;
    avgFillPrice: number | null;
    limit?: number;
    stop?: number;
    trailDistance?: number;
    tif: TimeInForce;
    status: OrderStatus;
    /** Why it was rejected or cancelled, when not by the user. */
    reason?: string;
    role: OrderRole;
    /** A bracket exit's entry. */
    parentId?: string;
    /** For an entry: the exits it will attach when it fills. */
    bracket?: Bracket;
    reduceOnly: boolean;
    source: OrderSource;
    clientId?: string;
    comment?: string;
    createdAt: number;
    updatedAt: number;
    filledAt?: number;
}

export interface PositionState {
    accountId: string;
    symbol: string;
    /** Signed: positive long, negative short. Zero means the position was just closed. */
    qty: number;
    avgPrice: number;
    lastPrice: number | null;
    unrealizedPnl: number;
    /** Realised on this symbol since the account started (net of commission). */
    realizedPnl: number;
    /** Exits protecting the whole position. */
    takeProfit?: number;
    stopLoss?: number;
    updatedAt: number;
}

export interface Execution {
    id: string;
    accountId: string;
    orderId: string;
    symbol: string;
    side: Side;
    qty: number;
    price: number;
    commission: number;
    /** What this fill realised, net of commission. Zero for a fill that only opened. */
    realizedPnl: number;
    time: number;
}

export interface AccountState {
    id: string;
    name: string;
    kind: AccountKind;
    currency: string;
    /** Cash: starting balance plus everything realised, less commission paid. */
    balance: number;
    /** Balance plus the open positions marked to the last price. */
    equity: number;
    unrealizedPnl: number;
    realizedPnl: number;
    commissionPaid: number;
    /** Equity change since the start of the UTC day. */
    dayPnl: number;
    ordersToday: number;
    /** What can still be committed to new positions. */
    buyingPower: number;
    connected: boolean;
    updatedAt: number;
}

export interface BrokerEvents {
    order: OrderState;
    position: PositionState;
    execution: Execution;
    account: AccountState;
    status: { connected: boolean; reason?: string };
}

/** Facts about a tradable symbol that an order must respect. */
export interface Instrument {
    symbol: string;
    tickSize: number;
    lotSize: number;
    minQty: number;
    minNotional?: number;
}

/** Thrown (or returned) when a request cannot be accepted at all, before an order exists. */
export interface OrderRejection {
    error: string;
    order?: OrderState;
}

/** One account at one broker. Paper and real accounts look the same to the rest of the system. */
export interface BrokerPort {
    readonly id: string;
    readonly name: string;
    readonly kind: AccountKind;
    readonly events: Emitter<BrokerEvents>;
    account(): AccountState;
    orders(): OrderState[];
    positions(): PositionState[];
    executions(limit?: number): Execution[];
    /** Accepts or rejects; a rejection comes back as an order with status `rejected` and a reason. */
    placeOrder(request: PlaceOrderRequest): Promise<OrderState>;
    modifyOrder(id: string, changes: ModifyOrderRequest): Promise<OrderState>;
    cancelOrder(id: string): Promise<OrderState>;
    /** Close all or part of a position at the market. Null when there is nothing to close. */
    closePosition(symbol: string, qty?: number): Promise<OrderState | null>;
    /** Turn a long into a short of the same size, or the other way round, at the market. */
    reversePosition(symbol: string): Promise<OrderState | null>;
    /** Cancel every working order at once (the kill switch). Returns how many were cancelled. */
    cancelAll?(): Promise<number>;
    /** A trade printed on the market, for accounts that value positions or fill orders themselves. */
    tick?(symbol: string, price: number, time?: number): void;
    /** Symbols the account needs live prices for. */
    watched?(): string[];
    /** Protect the whole position with a target and/or stop. `null` removes that leg. */
    setPositionBrackets(
        symbol: string,
        brackets: { takeProfit?: number | null; stopLoss?: number | null },
    ): Promise<PositionState>;
}

export const isOpen = (o: OrderState): boolean => o.status === 'working' || o.status === 'inactive';
