import type { AccountState, PlaceOrderRequest } from './types.ts';

/**
 * Rules every automated order must pass: from a strategy, a webhook, anything that is not a
 * person at a screen. Strategies never hold an account themselves; the only way their orders reach
 * one is through `RiskManager.check`, so no strategy can get around these rules.
 */
export interface RiskRules {
    /** Largest position (in units, either side) a symbol may reach. A number applies to every symbol. */
    maxPosition?: number | Record<string, number>;
    /** Largest position value (units × price) any one symbol may reach, in the account's currency. */
    maxPositionValue?: number;
    /** Largest single order, in units and in value. */
    maxOrderQty?: number;
    maxOrderValue?: number;
    /** Stop opening or adding once the day's loss reaches this (positive number). */
    maxDailyLoss?: number;
    /** Most automated orders per minute, per account. */
    maxOrdersPerMinute?: number;
    /** UTC window automated orders may be sent in, `HH:MM`–`HH:MM` (may wrap past midnight). */
    tradingHours?: { start: string; end: string } | null;
    /** Symbols automated orders may trade. Empty or missing: any. */
    allowList?: string[];
}

export const DEFAULT_RISK: RiskRules = {
    maxOrderValue: 50_000,
    maxPositionValue: 100_000,
    maxOrdersPerMinute: 30,
};

export interface RiskContext {
    order: PlaceOrderRequest;
    /** Price the order is valued at. */
    price: number | undefined;
    /** The account's signed position in the symbol before this order. */
    position: number;
    account: AccountState;
}

export interface Halt {
    at: number;
    reason: string;
    by: string;
}

const minutes = (hhmm: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) throw new Error(`"${hhmm}" is not a time of day (HH:MM)`);
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) throw new Error(`"${hhmm}" is not a time of day (HH:MM)`);
    return h * 60 + min;
};

/** Check rules for internal consistency; returns them cleaned or throws. */
export function cleanRules(input: unknown): RiskRules {
    const r = (input ?? {}) as Record<string, unknown>;
    const out: RiskRules = {};
    const positive = (key: keyof RiskRules) => {
        const v = r[key];
        if (v === undefined || v === null || v === '') return;
        const n = Number(v);
        if (!(n >= 0) || !Number.isFinite(n))
            throw Object.assign(new Error(`${key} must be a number of zero or more`), { statusCode: 400 });
        (out as any)[key] = n;
    };
    if (r.maxPosition !== undefined && r.maxPosition !== null && r.maxPosition !== '') {
        if (typeof r.maxPosition === 'object') {
            const per: Record<string, number> = {};
            for (const [k, v] of Object.entries(r.maxPosition as Record<string, unknown>)) {
                const n = Number(v);
                if (!(n >= 0))
                    throw Object.assign(new Error(`maxPosition for ${k} must be zero or more`), { statusCode: 400 });
                per[k] = n;
            }
            out.maxPosition = per;
        } else positive('maxPosition');
    }
    for (const key of [
        'maxPositionValue',
        'maxOrderQty',
        'maxOrderValue',
        'maxDailyLoss',
        'maxOrdersPerMinute',
    ] as const)
        positive(key);
    if (r.tradingHours) {
        const t = r.tradingHours as { start?: string; end?: string };
        try {
            minutes(String(t.start));
            minutes(String(t.end));
        } catch (err: any) {
            throw Object.assign(err, { statusCode: 400 });
        }
        out.tradingHours = { start: String(t.start), end: String(t.end) };
    }
    if (Array.isArray(r.allowList))
        out.allowList = r.allowList.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    return out;
}

export class RiskManager {
    rules: RiskRules;
    halt: Halt | null = null;
    private now: () => number;
    /** Times of recent automated orders, per account. */
    private recent = new Map<string, number[]>();

    constructor(rules: RiskRules = DEFAULT_RISK, now: () => number = Date.now) {
        this.rules = rules;
        this.now = now;
    }

    /** Why an automated order may not be sent, or null when it may. Counts it toward the rate when it may. */
    check(ctx: RiskContext): string | null {
        const reason = this.reason(ctx);
        if (reason) return reason;
        const list = this.recent.get(ctx.account.id) ?? [];
        list.push(this.now());
        this.recent.set(ctx.account.id, list);
        return null;
    }

    private reason({ order, price, position, account }: RiskContext): string | null {
        const r = this.rules;
        if (this.halt) return `trading is halted (${this.halt.reason})`;
        const symbol = order.symbol.toUpperCase();
        if (r.allowList?.length && !r.allowList.includes(symbol))
            return `${order.symbol} is not on the list of symbols automated orders may trade`;
        if (r.tradingHours) {
            const d = new Date(this.now());
            const t = d.getUTCHours() * 60 + d.getUTCMinutes();
            const start = minutes(r.tradingHours.start);
            const end = minutes(r.tradingHours.end);
            const inside = start <= end ? t >= start && t < end : t >= start || t < end;
            if (!inside)
                return `automated orders are only sent between ${r.tradingHours.start} and ${r.tradingHours.end} UTC`;
        }
        if (r.maxOrdersPerMinute !== undefined) {
            const cutoff = this.now() - 60_000;
            const list = (this.recent.get(account.id) ?? []).filter((t) => t > cutoff);
            this.recent.set(account.id, list);
            if (list.length >= r.maxOrdersPerMinute)
                return `more than ${r.maxOrdersPerMinute} automated orders in a minute`;
        }
        const qty = Math.abs(Number(order.qty));
        if (r.maxOrderQty !== undefined && qty > r.maxOrderQty + 1e-12)
            return `the order is for ${qty} units; the limit is ${r.maxOrderQty}`;
        const value = price !== undefined && Number.isFinite(price) ? qty * price : undefined;
        if (r.maxOrderValue !== undefined && value !== undefined && value > r.maxOrderValue + 1e-9) {
            return `the order is worth ${value.toFixed(2)}; the limit per automated order is ${r.maxOrderValue}`;
        }
        const after = position + (order.side === 'buy' ? qty : -qty);
        const adds = Math.abs(after) > Math.abs(position) + 1e-12;
        if (adds) {
            const cap = typeof r.maxPosition === 'number' ? r.maxPosition : r.maxPosition?.[symbol];
            if (cap !== undefined && Math.abs(after) > cap + 1e-12)
                return `the position would be ${Math.abs(after)} units; the limit for ${order.symbol} is ${cap}`;
            if (
                r.maxPositionValue !== undefined &&
                price !== undefined &&
                Math.abs(after) * price > r.maxPositionValue + 1e-9
            ) {
                return `the position would be worth ${(Math.abs(after) * price).toFixed(2)}; the limit is ${r.maxPositionValue}`;
            }
            if (r.maxDailyLoss !== undefined && account.dayPnl <= -Math.abs(r.maxDailyLoss)) {
                return `today's loss (${account.dayPnl.toFixed(2)}) has reached the limit of ${Math.abs(r.maxDailyLoss)}: automated orders may only reduce positions`;
            }
        }
        return null;
    }
}
