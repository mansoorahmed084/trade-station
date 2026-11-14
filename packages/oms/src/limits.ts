import type { AccountState, PlaceOrderRequest } from './types.ts';

/**
 * Per-order and per-day limits, checked before an order reaches any account. They guard against
 * fat fingers and runaway days; Phase 7's risk manager builds on them for automated trading.
 */
export interface OrderLimits {
    /** Largest value of one order, in the account's currency. */
    maxOrderValue?: number;
    /** Most orders an account may place in one UTC day. */
    maxOrdersPerDay?: number;
    /** Stop accepting orders that add exposure once the day's loss reaches this (a positive number). */
    maxDailyLoss?: number;
}

export const DEFAULT_LIMITS: OrderLimits = {
    maxOrderValue: 1_000_000,
    maxOrdersPerDay: 500,
};

/** Why an order breaks a limit, or null when it does not. `price` values the order. */
export function checkLimits(
    limits: OrderLimits,
    account: AccountState,
    order: PlaceOrderRequest,
    price: number | undefined,
): string | null {
    if (limits.maxOrdersPerDay !== undefined && account.ordersToday >= limits.maxOrdersPerDay) {
        return `the daily limit of ${limits.maxOrdersPerDay} orders is reached`;
    }
    const value = price !== undefined && Number.isFinite(price) ? Math.abs(order.qty) * price : undefined;
    if (limits.maxOrderValue !== undefined && value !== undefined && value > limits.maxOrderValue + 1e-9) {
        return `the order is worth ${value.toFixed(2)} ${account.currency}; the limit per order is ${limits.maxOrderValue}`;
    }
    if (limits.maxDailyLoss !== undefined && !order.reduceOnly && account.dayPnl <= -Math.abs(limits.maxDailyLoss)) {
        return `today's loss (${account.dayPnl.toFixed(2)}) has reached the daily limit of ${Math.abs(limits.maxDailyLoss)}: only orders that reduce a position are accepted`;
    }
    return null;
}
