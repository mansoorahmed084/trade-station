import type { AlertEvent, NotifyTargets } from '@ts/alerts';
import { deliver } from '@ts/alerts';
import type { BacktestProperties, StrategyRef } from '@ts/backtest';
import { newId, normalizeTimeframe, timeframeMs, type Unsubscribe } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import type { Execution, OrderState } from '@ts/oms';
import type { BacktestService } from '../backtest/service.ts';
import type { Db } from '../db.ts';
import type { AuditLog } from '../trading/audit.ts';
import type { TradingService } from '../trading/service.ts';

/**
 * Strategies running on live data. On every closed bar a runner works out the position its
 * strategy wants (by running it, off the main thread, over recent history) and trades the
 * difference with a market order through the risk manager. It never holds an account: the only
 * way its orders reach one is `TradingService.placeAutomated`.
 *
 * - `paper` trades the paper account; `account` an exchange account it was set up for.
 * - `shadow` sends nothing: it records what it would have done, priced at the bar's close.
 * - Every decision is kept, and any time the position held differs from the position wanted it is
 *   recorded as a divergence: explained (a risk refusal, a halt) or not.
 */

export type RunnerMode = 'paper' | 'shadow' | 'account';

export interface RunnerConfig {
    id: string;
    name: string;
    strategy: StrategyRef;
    inputs?: Record<string, number | boolean | string>;
    properties?: BacktestProperties;
    symbol: string;
    timeframe: string;
    mode: RunnerMode;
    /** The exchange account, for `account` mode. */
    accountId?: string;
    /** History each decision is computed from. */
    bars: number;
    /** `next-signal`: wait for the strategy's position to change before following it; `now`: take it on at once. */
    startWith: 'next-signal' | 'now';
    /** Where to announce the runner's fills. */
    notify?: NotifyTargets;
    createdAt: number;
}

export interface Decision {
    /** Open time of the bar decided on. */
    time: number;
    target: number;
    heldBefore: number;
    price: number;
    order?: { id: string; side: 'buy' | 'sell'; qty: number; status: string; fill: number | null; reason?: string };
    note?: string;
}

export interface Divergence {
    time: number;
    wanted: number;
    held: number;
    explained: boolean;
    reason: string;
}

export interface RunnerState {
    status: 'running' | 'stopped' | 'halted' | 'error';
    error?: string;
    following: boolean;
    startTarget: number | null;
    target: number;
    /** The position this runner's own orders built. */
    held: number;
    avgPrice: number;
    realized: number;
    fills: number;
    lastBar: number | null;
    startedAt: number | null;
    decisions: Decision[];
    divergences: Divergence[];
}

export interface RunnerView extends RunnerConfig {
    state: RunnerState;
    accountForOrders: string | null;
}

const KEY = 'automation.runners';
const MAX_DECISIONS = 2000;
const EPS = 1e-9;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const emptyState = (): RunnerState => ({
    status: 'stopped',
    following: false,
    startTarget: null,
    target: 0,
    held: 0,
    avgPrice: 0,
    realized: 0,
    fills: 0,
    lastBar: null,
    startedAt: null,
    decisions: [],
    divergences: [],
});

export interface AutomationDeps {
    data: MarketDataService;
    db: Db;
    backtest: BacktestService;
    trading: TradingService;
    audit?: AuditLog;
    scriptSource(id: string): string | undefined;
    publish?(event: unknown): void;
    notifier?: { telegramToken?: string; smtpUrl?: string; smtpFrom?: string };
    log?(message: string): void;
}

class Runner {
    config: RunnerConfig;
    state: RunnerState;
    private deps: AutomationDeps;
    private stop: Unsubscribe | null = null;
    private busy: Promise<void> | null = null;
    private again = false;
    private waiting = new Set<string>();
    private changed: () => void;

    constructor(config: RunnerConfig, state: RunnerState, deps: AutomationDeps, changed: () => void) {
        this.config = config;
        this.state = state;
        this.deps = deps;
        this.changed = changed;
    }

    get account(): string | null {
        return this.config.mode === 'paper'
            ? 'paper'
            : this.config.mode === 'account'
              ? (this.config.accountId ?? null)
              : null;
    }

    async start(): Promise<void> {
        if (this.state.status === 'running') return;
        if (this.deps.trading.risk.halt)
            throw fail(`trading is halted (${this.deps.trading.risk.halt.reason}): resume it first`, 409);
        this.state.status = 'running';
        this.state.error = undefined;
        this.state.startedAt = this.deps.data.clock();
        // A fresh start waits for the strategy's next signal again (unless told to take its position on at once).
        this.state.following = this.config.startWith === 'now';
        this.state.startTarget = null;
        this.stop = this.deps.data.subscribe(this.config.symbol, this.config.timeframe, (_bar, opened) => {
            if (opened) this.decideSoon();
        });
        this.audit('start', 'ok');
        this.changed();
        await this.decideSoon();
    }

    halt(reason: string): void {
        if (this.state.status !== 'running') return;
        this.detach();
        this.state.status = 'halted';
        this.state.error = reason;
        this.changed();
    }

    pause(): void {
        if (this.state.status === 'stopped') return;
        this.detach();
        this.state.status = 'stopped';
        this.audit('stop', 'ok');
        this.changed();
    }

    private detach(): void {
        this.stop?.();
        this.stop = null;
    }

    /** Decide on the latest closed bar; a request while one is running is folded into a single re-run. */
    decideSoon(): Promise<void> {
        if (this.busy) {
            this.again = true;
            return this.busy;
        }
        this.busy = (async () => {
            do {
                this.again = false;
                try {
                    await this.decide();
                } catch (err: any) {
                    this.state.status = 'error';
                    this.state.error = String(err?.message ?? err);
                    this.detach();
                    this.audit('decide', 'error', { reason: this.state.error });
                    this.deps.log?.(`strategy ${this.config.name} stopped: ${this.state.error}`);
                    this.changed();
                    return;
                }
            } while (this.again && this.state.status === 'running');
        })().finally(() => {
            this.busy = null;
        });
        return this.busy;
    }

    private async decide(): Promise<void> {
        if (this.state.status !== 'running') return;
        const c = this.config;
        const strategy =
            c.strategy.kind === 'pine' && c.strategy.scriptId && !c.strategy.source
                ? { kind: 'pine' as const, source: this.deps.scriptSource(c.strategy.scriptId) }
                : c.strategy;
        const at = await this.deps.backtest.position({
            strategy,
            symbol: c.symbol,
            timeframe: c.timeframe,
            bars: c.bars,
            inputs: c.inputs,
            properties: c.properties,
        });
        const s = this.state;
        if (s.lastBar !== null && at.time <= s.lastBar) return;
        s.lastBar = at.time;
        s.target = at.position;
        if (s.startTarget === null) s.startTarget = at.position;
        if (!s.following && at.position !== s.startTarget) s.following = true;
        const desired = s.following ? at.position : s.held;
        const decision: Decision = { time: at.time, target: at.position, heldBefore: s.held, price: at.price };
        if (!s.following) decision.note = 'waiting for the strategy’s next signal';
        const delta = desired - s.held;
        if (Math.abs(delta) > EPS && this.waiting.size === 0) {
            const side = delta > 0 ? 'buy' : 'sell';
            const qty = Math.abs(delta);
            if (c.mode === 'shadow') {
                // Nothing is sent: the change is taken at the bar's close.
                decision.order = { id: `shadow-${at.time}`, side, qty, status: 'shadow', fill: at.price };
                this.applyFill(side, qty, at.price);
            } else {
                const order = await this.deps.trading.placeAutomated(
                    this.account!,
                    {
                        symbol: c.symbol,
                        side,
                        type: 'market',
                        qty,
                        source: 'strategy',
                        clientId: c.id,
                        comment: c.name,
                    },
                    `strategy:${c.id}`,
                );
                decision.order = {
                    id: order.id,
                    side,
                    qty,
                    status: order.status,
                    fill: order.avgFillPrice,
                    reason: order.reason,
                };
                if (order.status === 'filled') {
                    this.applyFill(side, order.filledQty, order.avgFillPrice ?? at.price);
                    void this.announce(side, order.filledQty, order.avgFillPrice ?? at.price, at.time);
                } else if (order.status === 'working') this.waiting.add(order.id);
                else if (order.status === 'rejected') decision.note = `not sent: ${order.reason}`;
            }
        }
        if (s.following && this.waiting.size === 0 && Math.abs(s.held - desired) > EPS) {
            const refused = decision.order?.status === 'rejected';
            s.divergences.push({
                time: at.time,
                wanted: desired,
                held: s.held,
                explained: refused,
                reason: refused
                    ? `the order was refused: ${decision.order!.reason}`
                    : 'the position held does not match the strategy',
            });
            if (s.divergences.length > 500) s.divergences.splice(0, s.divergences.length - 500);
        }
        s.decisions.push(decision);
        if (s.decisions.length > MAX_DECISIONS) s.decisions.splice(0, s.decisions.length - MAX_DECISIONS);
        this.changed();
    }

    /** A fill of one of this runner's orders that arrived after the order was sent (an exchange order). */
    onExecution(e: Execution): void {
        if (!this.waiting.has(e.orderId)) return;
        this.applyFill(e.side, e.qty, e.price);
        void this.announce(e.side, e.qty, e.price, e.time);
        this.changed();
    }

    onOrder(o: OrderState): void {
        if (!this.waiting.has(o.id)) return;
        if (o.status !== 'working' && o.status !== 'inactive') this.waiting.delete(o.id);
        if (o.status === 'cancelled' || o.status === 'rejected') {
            this.state.divergences.push({
                time: this.state.lastBar ?? o.updatedAt,
                wanted: this.state.target,
                held: this.state.held,
                explained: true,
                reason: `the order ended ${o.status}${o.reason ? `: ${o.reason}` : ''}`,
            });
            this.changed();
        }
    }

    private applyFill(side: 'buy' | 'sell', qty: number, price: number): void {
        const s = this.state;
        const signed = side === 'buy' ? qty : -qty;
        const before = s.held;
        const after = before + signed;
        // Realise whatever the fill closes, at the average price of what it closes.
        if (before !== 0 && Math.sign(signed) !== Math.sign(before)) {
            const closed = Math.min(Math.abs(signed), Math.abs(before));
            s.realized += (price - s.avgPrice) * closed * Math.sign(before);
        }
        if (Math.abs(after) < EPS) s.avgPrice = 0;
        else if (before === 0 || Math.sign(after) !== Math.sign(before)) s.avgPrice = price;
        else if (Math.abs(after) > Math.abs(before))
            s.avgPrice = (s.avgPrice * Math.abs(before) + price * Math.abs(signed)) / Math.abs(after);
        s.held = Math.abs(after) < EPS ? 0 : Number(after.toPrecision(12));
        s.fills++;
    }

    private async announce(side: 'buy' | 'sell', qty: number, price: number, barTime: number): Promise<void> {
        const c = this.config;
        const message = `${c.name}: ${side === 'buy' ? 'bought' : 'sold'} ${qty} ${c.symbol} at ${price}; position ${this.state.held}`;
        this.deps.publish?.({
            type: 'strategy-fill',
            runnerId: c.id,
            name: c.name,
            symbol: c.symbol,
            side,
            qty,
            price,
            held: this.state.held,
            message,
        });
        if (!c.notify || !Object.values(c.notify).some(Boolean)) return;
        const event: AlertEvent = {
            id: newId('sf'),
            alertId: c.id,
            alertName: c.name,
            symbol: c.symbol,
            timeframe: c.timeframe,
            time: this.deps.data.clock(),
            barTime,
            price,
            message,
            late: false,
            sound: !!c.notify.sound,
            deliveries: [],
        };
        try {
            // Only the outside channels: the app hears it on the trading topic above.
            await deliver(event, { notify: { ...c.notify, app: false } } as any, this.deps.notifier ?? {});
        } catch {}
    }

    private audit(action: string, outcome: 'ok' | 'error', detail?: Record<string, unknown>): void {
        this.deps.audit?.record({
            actor: `strategy:${this.config.id}`,
            action: `strategy ${action}`,
            account: this.account ?? 'shadow',
            symbol: this.config.symbol,
            outcome,
            detail: { name: this.config.name, mode: this.config.mode, ...detail },
        });
    }
}

/** Creates, keeps and runs the strategy runners. */
export class AutomationService {
    private deps: AutomationDeps;
    private runners = new Map<string, Runner>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private offs: (() => void)[] = [];

    constructor(deps: AutomationDeps) {
        this.deps = deps;
        const saved = deps.db.kvJson<{ config: RunnerConfig; state: RunnerState }[]>(KEY, []);
        for (const { config, state } of saved) {
            this.runners.set(
                config.id,
                new Runner(config, { ...emptyState(), ...state }, deps, () => this.changed(config.id)),
            );
        }
        const halt = () => {
            for (const r of this.runners.values()) r.halt(`kill switch: ${deps.trading.risk.halt?.reason ?? ''}`);
        };
        deps.trading.onHalt.add(halt);
        this.offs.push(() => deps.trading.onHalt.delete(halt));
    }

    /** Start the runners that were running when the server stopped (unless trading is halted). */
    async start(): Promise<void> {
        // Fills and order updates from every account reach the runner that sent the order.
        for (const id of ['paper', ...this.accountIds()]) {
            const broker = this.deps.trading.broker(id);
            if (!broker) continue;
            this.offs.push(
                broker.events.on('execution', (e) => {
                    for (const r of this.runners.values()) r.onExecution(e);
                }),
                broker.events.on('order', (o) => {
                    for (const r of this.runners.values()) r.onOrder(o);
                }),
            );
        }
        for (const r of this.runners.values()) {
            if (r.state.status !== 'running') continue;
            r.state.status = 'stopped';
            if (this.deps.trading.risk.halt) {
                r.state.status = 'halted';
                continue;
            }
            await r
                .start()
                .catch((err) => this.deps.log?.(`strategy ${r.config.name} could not restart: ${err?.message ?? err}`));
        }
    }

    private accountIds(): string[] {
        const ids = new Set<string>();
        for (const r of this.runners.values()) if (r.config.accountId) ids.add(r.config.accountId);
        for (const a of this.deps.trading.accountsList()) ids.add(a.id);
        ids.delete('paper');
        return [...ids];
    }

    list(): RunnerView[] {
        return [...this.runners.values()].map((r) => this.view(r));
    }

    get(id: string): RunnerView {
        return this.view(this.runner(id));
    }

    /** `confirmedAccount` is the account the screen is switched to: needed to set up a runner on a real account. */
    async create(input: Partial<RunnerConfig>, confirmedAccount?: string): Promise<RunnerView> {
        const config = await this.clean(input, confirmedAccount);
        const runner = new Runner(config, emptyState(), this.deps, () => this.changed(config.id));
        this.runners.set(config.id, runner);
        this.deps.audit?.record({
            actor: 'user',
            action: 'strategy created',
            account: runner.account ?? 'shadow',
            symbol: config.symbol,
            outcome: 'ok',
            detail: { id: config.id, name: config.name, mode: config.mode },
        });
        this.changed(config.id);
        return this.view(runner);
    }

    async startRunner(id: string, confirmedAccount?: string): Promise<RunnerView> {
        const r = this.runner(id);
        this.guard(r.config, confirmedAccount);
        await r.start();
        return this.view(r);
    }

    stopRunner(id: string): RunnerView {
        const r = this.runner(id);
        r.pause();
        return this.view(r);
    }

    remove(id: string): void {
        const r = this.runner(id);
        r.pause();
        this.runners.delete(id);
        this.deps.audit?.record({
            actor: 'user',
            action: 'strategy deleted',
            symbol: r.config.symbol,
            outcome: 'ok',
            detail: { id, name: r.config.name },
        });
        this.save();
    }

    /**
     * Replay the strategy over the period the runner has been deciding on, as one continuous
     * backtest, and compare: every bar where the live decision and the replay disagree is listed.
     */
    async verify(
        id: string,
    ): Promise<{ checked: number; mismatches: { time: number; live: number; replay: number }[] }> {
        const r = this.runner(id);
        const decisions = r.state.decisions;
        if (decisions.length === 0) return { checked: 0, mismatches: [] };
        const c = r.config;
        const ms = timeframeMs(c.timeframe);
        const first = decisions[0].time;
        const last = decisions[decisions.length - 1].time;
        const strategy =
            c.strategy.kind === 'pine' && c.strategy.scriptId && !c.strategy.source
                ? { kind: 'pine' as const, source: this.deps.scriptSource(c.strategy.scriptId) }
                : c.strategy;
        const result = await this.deps.backtest.run({
            strategy,
            symbol: c.symbol,
            timeframe: c.timeframe,
            from: first - c.bars * ms,
            to: last,
            inputs: c.inputs,
            properties: { ...c.properties, processOrdersOnClose: true },
        });
        const trades = result.report.trades;
        const positionAt = (t: number) => {
            let p = 0;
            for (const tr of trades) {
                if (tr.entryTime > t) continue;
                if (!tr.open && tr.exitTime !== undefined && tr.exitTime <= t) continue;
                p += tr.side === 'long' ? tr.qty : -tr.qty;
            }
            return Number(p.toPrecision(12));
        };
        const mismatches: { time: number; live: number; replay: number }[] = [];
        for (const d of decisions) {
            const replay = positionAt(d.time);
            if (Math.abs(replay - d.target) > Math.max(1e-9, Math.abs(d.target) * 1e-6))
                mismatches.push({ time: d.time, live: d.target, replay });
        }
        return { checked: decisions.length, mismatches };
    }

    close(): void {
        for (const off of this.offs.splice(0)) off();
        for (const r of this.runners.values()) {
            const was = r.state.status;
            r.pause();
            // Remember it was running, so a restart picks it up again.
            if (was === 'running') r.state.status = 'running';
        }
        this.flush();
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private runner(id: string): Runner {
        const r = this.runners.get(id);
        if (!r) throw fail('strategy runner not found', 404);
        return r;
    }

    private view(r: Runner): RunnerView {
        return { ...r.config, state: r.state, accountForOrders: r.account };
    }

    /** A runner on a real-money account must be set up and started from a screen switched to that account. */
    private guard(config: RunnerConfig, confirmed?: string): void {
        if (config.mode !== 'account') return;
        const broker = this.deps.trading.broker(config.accountId ?? '');
        if (!broker) throw fail(`no account "${config.accountId}"`, 404);
        if (broker.kind !== 'paper' && confirmed !== broker.id) {
            throw fail(
                `"${broker.name}" trades real money: set this strategy up from a screen switched to that account`,
                403,
            );
        }
    }

    private async clean(input: Partial<RunnerConfig>, confirmed?: string): Promise<RunnerConfig> {
        const mode = input.mode ?? 'paper';
        if (!['paper', 'shadow', 'account'].includes(mode)) throw fail('mode must be paper, shadow or account');
        let timeframe: string;
        try {
            timeframe = normalizeTimeframe(String(input.timeframe ?? ''));
        } catch {
            throw fail(`Invalid timeframe "${input.timeframe ?? ''}"`);
        }
        const symbol = String(input.symbol ?? '').trim();
        if (!symbol) throw fail('symbol is required');
        // The strategy must describe and run: ask the backtest service, which checks everything.
        const description = await this.deps.backtest.describe(input.strategy as StrategyRef);
        const bars = Math.min(20_000, Math.max(100, Math.round(Number(input.bars ?? 2000))));
        const config: RunnerConfig = {
            id: newId('run'),
            name:
                String(input.name ?? '')
                    .trim()
                    .slice(0, 80) || `${description.title} · ${symbol} ${timeframe}`,
            strategy: input.strategy as StrategyRef,
            inputs: input.inputs,
            properties: input.properties,
            symbol,
            timeframe,
            mode,
            accountId: mode === 'account' ? String(input.accountId ?? '') : undefined,
            bars,
            startWith: input.startWith === 'now' ? 'now' : 'next-signal',
            notify: input.notify,
            createdAt: this.deps.data.clock(),
        };
        this.guard(config, confirmed);
        // A strategy that cannot work out a position on this market is refused now, not at its first bar.
        await this.deps.backtest.position({
            strategy:
                config.strategy.kind === 'pine' && config.strategy.scriptId && !config.strategy.source
                    ? { kind: 'pine', source: this.deps.scriptSource(config.strategy.scriptId) }
                    : config.strategy,
            symbol,
            timeframe,
            bars: Math.min(bars, 500),
            inputs: config.inputs,
            properties: config.properties,
        });
        return config;
    }

    private changed(id: string): void {
        const r = this.runners.get(id);
        if (r) this.deps.publish?.({ type: 'runner', runner: this.view(r) });
        this.save();
    }

    private save(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.deps.db.kvSet(
                KEY,
                JSON.stringify([...this.runners.values()].map((r) => ({ config: r.config, state: r.state }))),
            );
        }, 200);
        this.saveTimer.unref?.();
    }

    /** Write now (used on shutdown). */
    flush(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
        this.deps.db.kvSet(
            KEY,
            JSON.stringify([...this.runners.values()].map((r) => ({ config: r.config, state: r.state }))),
        );
    }
}
