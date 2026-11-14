import type { Unsubscribe } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import {
    type AccountState,
    type BrokerPort,
    checkLimits,
    cleanRules,
    DEFAULT_LIMITS,
    DEFAULT_RISK,
    type Execution,
    type Halt,
    type ModifyOrderRequest,
    type OrderLimits,
    type OrderState,
    PaperBroker,
    type PaperSettings,
    type PaperSnapshot,
    type PlaceOrderRequest,
    type PositionState,
    RiskManager,
    type RiskRules,
} from '@ts/oms';
import type { Db } from '../db.ts';
import type { AuditLog } from './audit.ts';

/** What clients hear on the `trading` topic. */
export type TradingEvent =
    | { type: 'order'; accountId: string; order: OrderState }
    | { type: 'execution'; accountId: string; execution: Execution }
    | { type: 'position'; accountId: string; position: PositionState }
    | { type: 'account'; accountId: string; account: AccountState }
    | { type: 'reset'; accountId: string }
    | { type: 'halt'; accountId: string; halt: Halt | null };

export interface TradingState {
    account: AccountState;
    orders: OrderState[];
    positions: PositionState[];
    executions: Execution[];
}

export interface TradingDeps {
    data: MarketDataService;
    db: Db;
    audit?: AuditLog;
    publish?(event: TradingEvent): void;
    log?(message: string): void;
}

const PAPER_KEY = 'trading.paper';
const RISK_KEY = 'trading.risk';
const HALT_KEY = 'trading.halt';
const LIMITS_KEY = 'trading.limits';
/** Position and account updates are sent at most this often per position; orders and fills at once. */
const THROTTLE_MS = 250;
/** How long a price feed outlives the last order or position that needed it. */
const FEED_LINGER_MS = 60_000;

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/**
 * The order manager on the server: one place every order goes through, whichever account it is
 * for. It checks the limits, routes the order, feeds live prices to the paper account, keeps the
 * paper account across restarts and streams every change to the app.
 */
export class TradingService {
    readonly paper: PaperBroker;
    readonly risk: RiskManager;
    limits: OrderLimits;
    /** Told when the kill switch is thrown, so whatever trades automatically stops. */
    readonly onHalt = new Set<(halt: Halt) => void>();
    private deps: TradingDeps;
    private accounts = new Map<string, BrokerPort>();
    private feeds = new Map<string, { stop: Unsubscribe; linger?: ReturnType<typeof setTimeout> }>();
    private pending = new Map<string, TradingEvent>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private offs: Unsubscribe[] = [];

    constructor(deps: TradingDeps) {
        this.deps = deps;
        this.paper = new PaperBroker({
            instrument: (symbol) => {
                const info = deps.data.symbolInfo(symbol);
                return {
                    symbol: info.symbol,
                    tickSize: info.tickSize,
                    lotSize: info.lotSize,
                    minQty: info.minQty,
                    minNotional: info.minNotional,
                };
            },
            now: () => deps.data.clock(),
        });
        this.limits = { ...DEFAULT_LIMITS, ...deps.db.kvJson<OrderLimits>(LIMITS_KEY, {}) };
        this.risk = new RiskManager({ ...DEFAULT_RISK, ...deps.db.kvJson<RiskRules>(RISK_KEY, {}) }, () =>
            deps.data.clock(),
        );
        // A halt survives a restart: nothing trades automatically again until someone resumes.
        this.risk.halt = deps.db.kvJson<Halt | null>(HALT_KEY, null);
        const saved = deps.db.kvJson<PaperSnapshot | null>(PAPER_KEY, null);
        if (saved) {
            try {
                this.paper.restore(saved);
            } catch (err: any) {
                deps.log?.(`the saved paper account could not be read and was set aside: ${err?.message ?? err}`);
                deps.db.kvSet(`${PAPER_KEY}.unreadable.${Date.now()}`, JSON.stringify(saved));
            }
        }
        this.register(this.paper);
    }

    /** Add an account. Every event it emits is streamed to the app. */
    register(broker: BrokerPort): void {
        if (this.accounts.has(broker.id)) throw new Error(`an account "${broker.id}" is already registered`);
        this.accounts.set(broker.id, broker);
        const id = broker.id;
        this.offs.push(
            broker.events.on('order', (order) => {
                this.send({ type: 'order', accountId: id, order });
                this.changed(broker);
            }),
            broker.events.on('execution', (execution) => {
                this.send({ type: 'execution', accountId: id, execution });
                this.changed(broker);
            }),
            broker.events.on('position', (position) =>
                this.queue(`${id}|p|${position.symbol}`, { type: 'position', accountId: id, position }),
            ),
            broker.events.on('account', (account) =>
                this.queue(`${id}|a`, { type: 'account', accountId: id, account }),
            ),
        );
        if (broker !== this.paper) this.refreshFeeds();
    }

    /** Start price feeds for whatever the saved paper account still holds. */
    async start(): Promise<void> {
        await Promise.all([...this.watchedAll()].map((symbol) => this.ensurePrice(symbol).catch(() => {})));
        this.refreshFeeds();
    }

    accountsList(): AccountState[] {
        return [...this.accounts.values()].map((a) => a.account());
    }

    /** Reading an account spends nothing, so it needs no confirmation from the screen. */
    state(accountId: string): TradingState {
        const broker = this.accounts.get(accountId);
        if (!broker) throw fail(`no account "${accountId}"`, 404);
        return {
            account: broker.account(),
            orders: broker.orders(),
            positions: broker.positions(),
            executions: broker.executions(500),
        };
    }

    /**
     * Route an order. `confirmedAccount` is the account the screen the order came from is switched
     * to: an order for a real-money account is refused unless that screen names it, so nothing
     * placed on a paper screen can ever reach a live broker.
     */
    async place(accountId: string, request: PlaceOrderRequest, confirmedAccount?: string): Promise<OrderState> {
        const broker = this.account(accountId, confirmedAccount);
        const symbol = this.tradable(request.symbol);
        const order = { ...request, symbol };
        const price = await this.ensurePrice(symbol);
        const ref = order.limit ?? order.stop ?? price;
        const breach = checkLimits(this.limits, broker.account(), order, ref);
        if (breach) throw Object.assign(fail(breach, 422), { limit: true });
        const placed = await broker.placeOrder(order);
        this.refreshFeeds();
        return placed;
    }

    /**
     * Place an order on behalf of something automatic: a strategy or a webhook. It must pass the
     * risk rules (and the per-order limits) first; nothing automatic can reach an account another way.
     * Refusals are recorded in the audit log and come back as a rejected order.
     */
    async placeAutomated(accountId: string, request: PlaceOrderRequest, actor: string): Promise<OrderState> {
        const broker = this.accounts.get(accountId);
        if (!broker) throw fail(`no account "${accountId}"`, 404);
        const symbol = this.tradable(request.symbol);
        const order: PlaceOrderRequest = { ...request, symbol };
        const price = await this.ensurePrice(symbol);
        const ref = order.limit ?? order.stop ?? price;
        const position = broker.positions().find((p) => p.symbol === symbol)?.qty ?? 0;
        const breach =
            this.risk.check({ order, price: ref, position, account: broker.account() }) ??
            checkLimits(this.limits, broker.account(), order, ref);
        const detail = {
            side: order.side,
            type: order.type,
            qty: order.qty,
            limit: order.limit,
            stop: order.stop,
            price: ref,
        };
        if (breach) {
            this.deps.audit?.record({
                actor,
                action: 'place',
                account: accountId,
                symbol,
                outcome: 'rejected',
                detail: { ...detail, reason: breach },
            });
            const now = this.deps.data.clock();
            return {
                id: `refused-${now}`,
                accountId,
                symbol,
                side: order.side,
                type: order.type,
                qty: Number(order.qty),
                filledQty: 0,
                avgFillPrice: null,
                tif: order.tif ?? 'GTC',
                status: 'rejected',
                reason: breach,
                role: 'entry',
                reduceOnly: !!order.reduceOnly,
                source: order.source ?? 'strategy',
                createdAt: now,
                updatedAt: now,
            };
        }
        try {
            const placed = await broker.placeOrder(order);
            this.deps.audit?.record({
                actor,
                action: 'place',
                account: accountId,
                symbol,
                outcome: placed.status === 'rejected' ? 'rejected' : 'ok',
                detail: {
                    ...detail,
                    order: placed.id,
                    status: placed.status,
                    fill: placed.avgFillPrice,
                    reason: placed.reason,
                },
            });
            this.refreshFeeds();
            return placed;
        } catch (err: any) {
            this.deps.audit?.record({
                actor,
                action: 'place',
                account: accountId,
                symbol,
                outcome: 'error',
                detail: { ...detail, reason: err?.message },
            });
            throw err;
        }
    }

    /**
     * The kill switch: halt everything automatic, cancel every working order on every account and,
     * if asked, close every position. Stays in force (across restarts) until `resume`.
     */
    async kill(
        options: { flatten?: boolean; reason?: string; by?: string } = {},
    ): Promise<{ halt: Halt; cancelled: number; closed: number; errors: string[] }> {
        const halt: Halt = {
            at: this.deps.data.clock(),
            reason: options.reason?.slice(0, 200) || 'kill switch',
            by: options.by ?? 'user',
        };
        this.risk.halt = halt;
        this.deps.db.kvSet(HALT_KEY, JSON.stringify(halt));
        for (const listener of this.onHalt) {
            try {
                listener(halt);
            } catch {}
        }
        let cancelled = 0;
        let closed = 0;
        const errors: string[] = [];
        for (const broker of this.accounts.values()) {
            // Entries first: cancelling one also cancels the exits waiting for it.
            const open = broker
                .orders()
                .filter((o) => o.status === 'working' || o.status === 'inactive')
                .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
            for (const o of open) {
                const current = broker.orders().find((x) => x.id === o.id);
                if (current?.status !== 'working' && current?.status !== 'inactive') continue;
                try {
                    await broker.cancelOrder(o.id);
                    cancelled++;
                } catch (err: any) {
                    errors.push(`${broker.name}: could not cancel ${o.id}: ${err?.message ?? err}`);
                }
            }
            if (options.flatten) {
                for (const p of broker.positions()) {
                    try {
                        await this.ensurePrice(p.symbol);
                        const order = await broker.closePosition(p.symbol);
                        if (order && order.status !== 'rejected') closed++;
                        else if (order) errors.push(`${broker.name}: could not close ${p.symbol}: ${order.reason}`);
                    } catch (err: any) {
                        errors.push(`${broker.name}: could not close ${p.symbol}: ${err?.message ?? err}`);
                    }
                }
            }
        }
        this.deps.audit?.record({
            actor: halt.by,
            action: 'kill switch',
            outcome: errors.length ? 'error' : 'ok',
            detail: { reason: halt.reason, flatten: !!options.flatten, cancelled, closed, errors },
        });
        this.send({ type: 'halt', accountId: '*', halt });
        this.refreshFeeds();
        return { halt, cancelled, closed, errors };
    }

    /** Allow automatic trading again after a halt. */
    resume(by = 'user'): void {
        const was = this.risk.halt;
        this.risk.halt = null;
        this.deps.db.kvDelete(HALT_KEY);
        this.deps.audit?.record({ actor: by, action: 'resume', outcome: 'ok', detail: { halted: was } });
        this.send({ type: 'halt', accountId: '*', halt: null });
    }

    setRisk(rules: unknown, by = 'user'): RiskRules {
        const clean = cleanRules(rules);
        this.risk.rules = clean;
        this.deps.db.kvSet(RISK_KEY, JSON.stringify(clean));
        this.deps.audit?.record({
            actor: by,
            action: 'risk rules',
            outcome: 'ok',
            detail: clean as Record<string, unknown>,
        });
        return clean;
    }

    /** The account by id, without the screen check: for automation that was set up from that account's screen. */
    broker(id: string): BrokerPort | undefined {
        return this.accounts.get(id);
    }

    async modify(
        accountId: string,
        orderId: string,
        changes: ModifyOrderRequest,
        confirmedAccount?: string,
    ): Promise<OrderState> {
        const broker = this.account(accountId, confirmedAccount);
        const order = broker.orders().find((o) => o.id === orderId);
        if (order && changes.qty !== undefined) {
            const breach = checkLimits(
                { maxOrderValue: this.limits.maxOrderValue },
                broker.account(),
                { ...order, qty: Number(changes.qty) },
                changes.limit ?? changes.stop ?? order.limit ?? order.stop ?? this.paper.lastPrice(order.symbol),
            );
            if (breach) throw fail(breach, 422);
        }
        const result = await broker.modifyOrder(orderId, changes);
        this.refreshFeeds();
        return result;
    }

    async cancel(accountId: string, orderId: string, confirmedAccount?: string): Promise<OrderState> {
        const result = await this.account(accountId, confirmedAccount).cancelOrder(orderId);
        this.refreshFeeds();
        return result;
    }

    /** Cancel every working order, of one symbol or of all. Returns how many were cancelled. */
    async cancelAll(accountId: string, symbol?: string, confirmedAccount?: string): Promise<number> {
        const broker = this.account(accountId, confirmedAccount);
        const target = symbol ? this.tradable(symbol) : undefined;
        let n = 0;
        // Entries first: cancelling one also cancels its waiting exits.
        const open = broker
            .orders()
            .filter((o) => (o.status === 'working' || o.status === 'inactive') && (!target || o.symbol === target))
            .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId));
        for (const o of open) {
            const current = broker.orders().find((x) => x.id === o.id);
            if (current?.status !== 'working' && current?.status !== 'inactive') continue;
            await broker.cancelOrder(o.id);
            n++;
        }
        this.refreshFeeds();
        return n;
    }

    async closePosition(
        accountId: string,
        symbol: string,
        qty?: number,
        confirmedAccount?: string,
    ): Promise<OrderState | null> {
        const broker = this.account(accountId, confirmedAccount);
        const target = this.tradable(symbol);
        await this.ensurePrice(target);
        const result = await broker.closePosition(target, qty);
        this.refreshFeeds();
        return result;
    }

    async reversePosition(accountId: string, symbol: string, confirmedAccount?: string): Promise<OrderState | null> {
        const broker = this.account(accountId, confirmedAccount);
        const target = this.tradable(symbol);
        const position = broker.positions().find((p) => p.symbol === target);
        const price = await this.ensurePrice(target);
        if (position) {
            const breach = checkLimits(
                this.limits,
                broker.account(),
                { symbol: target, side: 'buy', type: 'market', qty: Math.abs(position.qty) * 2 },
                price,
            );
            if (breach) throw fail(breach, 422);
        }
        const result = await broker.reversePosition(target);
        this.refreshFeeds();
        return result;
    }

    async setBrackets(
        accountId: string,
        symbol: string,
        brackets: { takeProfit?: number | null; stopLoss?: number | null },
        confirmedAccount?: string,
    ): Promise<PositionState> {
        const broker = this.account(accountId, confirmedAccount);
        const target = this.tradable(symbol);
        await this.ensurePrice(target);
        return broker.setPositionBrackets(target, brackets);
    }

    /** Start the paper account over, optionally with new settings. */
    resetPaper(settings: Partial<PaperSettings> = {}): AccountState {
        const clean: Partial<PaperSettings> = {};
        if (settings.initialBalance !== undefined) {
            const v = Number(settings.initialBalance);
            if (!(v > 0) || v > 1e12) throw fail('the starting balance must be above zero');
            clean.initialBalance = v;
        }
        if (settings.currency !== undefined) clean.currency = String(settings.currency).slice(0, 8).toUpperCase();
        if (settings.commission !== undefined) {
            const c = settings.commission as any;
            if (!['percent', 'cash_per_order', 'cash_per_contract'].includes(c?.type) || !(Number(c.value) >= 0)) {
                throw fail(
                    'commission needs a type (percent, cash_per_order, cash_per_contract) and a value of zero or more',
                );
            }
            clean.commission = { type: c.type, value: Number(c.value) };
        }
        if (settings.slippageTicks !== undefined)
            clean.slippageTicks = Math.max(0, Math.round(Number(settings.slippageTicks) || 0));
        if (settings.leverage !== undefined) {
            const v = Number(settings.leverage);
            if (!(v >= 1 && v <= 100)) throw fail('leverage must be between 1 and 100');
            clean.leverage = v;
        }
        this.paper.reset(clean);
        this.save(true);
        this.send({ type: 'reset', accountId: this.paper.id });
        this.refreshFeeds();
        return this.paper.account();
    }

    setLimits(limits: OrderLimits): OrderLimits {
        const out: OrderLimits = {};
        for (const key of ['maxOrderValue', 'maxOrdersPerDay', 'maxDailyLoss'] as const) {
            const v = (limits as any)?.[key];
            if (v === undefined || v === null || v === '') continue;
            const n = Number(v);
            if (!(n >= 0) || !Number.isFinite(n)) throw fail(`${key} must be a number of zero or more`);
            out[key] = n;
        }
        this.limits = out;
        this.deps.db.kvSet(LIMITS_KEY, JSON.stringify(out));
        return out;
    }

    close(): void {
        for (const off of this.offs.splice(0)) off();
        for (const feed of this.feeds.values()) {
            if (feed.linger) clearTimeout(feed.linger);
            feed.stop();
        }
        this.feeds.clear();
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flush();
        this.save(true);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private account(id: string, confirmed?: string): BrokerPort {
        const broker = this.accounts.get(id);
        if (!broker) throw fail(`no account "${id}"`, 404);
        if (broker.kind !== 'paper' && confirmed !== broker.id) {
            throw fail(
                `"${broker.name}" trades real money. The request did not come from a screen switched to that account, so it was refused.`,
                403,
            );
        }
        return broker;
    }

    /** The instrument an order trades: a chart-type series trades its underlying; a formula cannot be traded. */
    private tradable(symbol: unknown): string {
        const s = String(symbol ?? '').trim();
        if (!s) throw fail('symbol is required');
        if (/^SPREAD:/i.test(s)) throw fail('a formula cannot be traded: trade its legs');
        try {
            return this.deps.data.underlying(s).symbol;
        } catch (err: any) {
            throw fail(err?.message ?? `Unknown symbol ${s}`, 404);
        }
    }

    /** A current price for the symbol, starting its feed if needed. */
    private async ensurePrice(symbol: string): Promise<number | undefined> {
        this.feed(symbol);
        const known = this.paper.lastPrice(symbol) ?? this.deps.data.lastPrice(symbol);
        if (known !== undefined) {
            if (this.paper.lastPrice(symbol) === undefined) this.tickAll(symbol, known, this.deps.data.clock());
            return known;
        }
        // No stream has printed yet: use the latest one-minute close.
        try {
            const bars = await this.deps.data.getBars(symbol, '1', { limit: 1 });
            const last = bars.last();
            if (last && this.paper.lastPrice(symbol) === undefined)
                this.tickAll(symbol, last.close, this.deps.data.clock());
        } catch {}
        return this.paper.lastPrice(symbol);
    }

    /** A live price, to every account that wants one. */
    private tickAll(symbol: string, price: number, time: number): void {
        for (const broker of this.accounts.values()) broker.tick?.(symbol, price, time);
    }

    /** Symbols any account needs live prices for. */
    private watchedAll(): Set<string> {
        const out = new Set<string>();
        for (const broker of this.accounts.values()) for (const s of broker.watched?.() ?? []) out.add(s);
        return out;
    }

    /** Make sure live prices for the symbol reach every account. */
    private feed(symbol: string): void {
        const existing = this.feeds.get(symbol);
        if (existing) {
            if (existing.linger) {
                clearTimeout(existing.linger);
                existing.linger = undefined;
            }
            return;
        }
        const { data } = this.deps;
        let stop: Unsubscribe;
        try {
            stop = data.subscribeTrades(symbol, (tick) => this.tickAll(symbol, tick.price, tick.time));
        } catch {
            // A venue without a trade stream: follow the forming one-minute bar instead.
            stop = data.subscribe(symbol, '1', (bar) => this.tickAll(symbol, bar.close, data.clock()));
        }
        this.feeds.set(symbol, { stop });
    }

    /** Stop feeds nothing needs any more, after a grace period. */
    private refreshFeeds(): void {
        const needed = this.watchedAll();
        for (const symbol of needed) this.feed(symbol);
        for (const [symbol, feed] of this.feeds) {
            if (needed.has(symbol) || feed.linger) continue;
            feed.linger = setTimeout(() => {
                if (this.watchedAll().has(symbol)) {
                    feed.linger = undefined;
                    return;
                }
                feed.stop();
                this.feeds.delete(symbol);
            }, FEED_LINGER_MS);
            feed.linger.unref?.();
        }
    }

    private changed(broker: BrokerPort): void {
        if (broker === this.paper) this.save(false);
    }

    private save(now: boolean): void {
        const write = () => {
            this.saveTimer = null;
            this.deps.db.kvSet(PAPER_KEY, JSON.stringify(this.paper.snapshot()));
        };
        if (now) {
            if (this.saveTimer) clearTimeout(this.saveTimer);
            write();
            return;
        }
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(write, 300);
        this.saveTimer.unref?.();
    }

    private send(event: TradingEvent): void {
        // An order or fill must not overtake the position and account updates queued before it.
        this.flush();
        this.deps.publish?.(event);
    }

    private queue(key: string, event: TradingEvent): void {
        this.pending.set(key, event);
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => this.flush(), THROTTLE_MS);
        this.flushTimer.unref?.();
    }

    private flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const events = [...this.pending.values()];
        this.pending.clear();
        for (const e of events) this.deps.publish?.(e);
    }
}
