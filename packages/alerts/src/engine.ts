import {
    type Bar,
    type BarSeries,
    barOpenTime,
    Emitter,
    newId,
    normalizeTimeframe,
    type SymbolInfo,
    timeframeMs,
    type Unsubscribe,
} from '@ts/core';
import {
    ConditionEvaluator,
    type External,
    plotKey,
    type ScriptRef,
    scriptAlertKey,
    scriptRefs,
    warmupBars,
} from './evaluate.ts';
import { DEFAULT_MESSAGE, describeCondition, renderMessage } from './template.ts';
import {
    type Alert,
    type AlertEvent,
    type AlertInput,
    type Condition,
    type Delivery,
    emptyState,
    type Frequency,
    isComparison,
    isScriptAlert,
    type NotifyTargets,
    type Operand,
    type Operator,
} from './types.ts';

/** The slice of the market-data service the engine needs. */
export interface AlertData {
    getBars(
        symbol: string,
        timeframe: string,
        query?: { from?: number; to?: number; limit?: number },
    ): Promise<BarSeries>;
    subscribe(symbol: string, timeframe: string, listener: (bar: Bar, opened: boolean) => void): Unsubscribe;
    describe(symbol: string): Promise<SymbolInfo>;
    clock(): number;
}

/** What a script run must report for alerts: plot series aligned with bar times, and alert calls. */
export interface ScriptRunLike {
    times: number[];
    plots: Record<string, (number | null)[]>;
    alerts: { time: number; message: string; title?: string }[];
}

export interface AlertScripts {
    run(
        source: string,
        symbol: string,
        timeframe: string,
        opts: { bars?: number; inputs?: Record<string, unknown>; closedOnly?: boolean; alertMode?: 'all' | 'realtime' },
    ): Promise<ScriptRunLike>;
    /** Source of a library script by id, or null when it no longer exists. */
    resolve(scriptId: string): string | null;
}

export interface AlertStore {
    list(): Alert[];
    save(alert: Alert): void;
    remove(id: string): void;
    appendLog(event: AlertEvent): void;
    updateLog(event: AlertEvent): void;
}

export interface EngineDeps {
    data: AlertData;
    store: AlertStore;
    scripts?: AlertScripts;
    /** Send the notifications for a fired alert. The in-app channel is the caller's too. */
    deliver?: (event: AlertEvent, alert: Alert) => Promise<Delivery[]>;
    log?: (message: string) => void;
}

const OPERATORS: Operator[] = [
    'crossing',
    'crossing_up',
    'crossing_down',
    'greater',
    'less',
    'entering_channel',
    'exiting_channel',
    'inside_channel',
    'outside_channel',
    'moving_up',
    'moving_down',
    'moving_up_pct',
    'moving_down_pct',
];
const FREQUENCIES: Frequency[] = ['once', 'once_per_bar', 'once_per_bar_close', 'every_time'];
const MAX_ALERTS = 5000;
const MAX_SYMBOLS = 1000;
/** Bars a script is computed over for an alert: enough for its indicators to settle. */
const SCRIPT_BARS = 500;
/** Closed bars replayed at most after downtime. Older ones are skipped, not evaluated. */
const MAX_CATCHUP_BARS = 5000;
/** Late fires reported per alert and symbol after downtime; further missed occurrences are evaluated but not announced. */
const MAX_LATE_FIRES = 5;
/** Minimum spacing of intrabar script recomputes. */
const SCRIPT_TICK_MS = 2000;

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

function checkOperand(op: unknown, where: string): Operand {
    const o = op as Operand;
    if (!o || typeof o !== 'object') throw bad(`${where} is missing`);
    switch (o.type) {
        case 'price':
            return o;
        case 'value':
            if (typeof o.value !== 'number' || !Number.isFinite(o.value))
                throw bad(`${where}: the value must be a number`);
            return o;
        case 'indicator':
            if (typeof o.study !== 'string') throw bad(`${where}: an indicator needs a study`);
            return o;
        case 'line':
            for (const p of [o.a, o.b])
                if (!p || !Number.isFinite(p.time) || !Number.isFinite(p.price))
                    throw bad(`${where}: a line needs two anchors`);
            return o;
        case 'plot':
            if (!o.plot || (!o.scriptId && !o.source)) throw bad(`${where}: a plot needs a script and a plot title`);
            return o;
        default:
            throw bad(`${where}: unknown operand type`);
    }
}

/** Reject a malformed condition with a message that says what is wrong. */
export function checkCondition(c: unknown, depth = 0): Condition {
    if (!c || typeof c !== 'object') throw bad('the condition is missing');
    if (depth > 4) throw bad('conditions are nested too deeply');
    const cond = c as Condition;
    if (isComparison(cond)) {
        if (!OPERATORS.includes(cond.op)) throw bad(`unknown operator "${cond.op}"`);
        checkOperand(cond.left, 'left side');
        if (cond.op.includes('channel')) {
            checkOperand(cond.upper, 'upper bound');
            checkOperand(cond.lower, 'lower bound');
        } else if (cond.op.startsWith('moving')) {
            if (typeof cond.amount !== 'number' || !(cond.amount > 0))
                throw bad('a "moving" condition needs a positive amount');
        } else checkOperand(cond.right, 'right side');
        return cond;
    }
    if (isScriptAlert(cond)) {
        if (!cond.scriptAlert.scriptId && !cond.scriptAlert.source) throw bad('a script alert needs a script');
        return cond;
    }
    const children = 'all' in cond ? cond.all : (cond as { any: Condition[] }).any;
    if (!Array.isArray(children) || children.length === 0) throw bad('a group needs at least one condition');
    if (children.length > 20) throw bad('a group can hold at most 20 conditions');
    for (const child of children) checkCondition(child, depth + 1);
    return cond;
}

interface Runtime {
    alert: Alert;
    symbol: string;
    tickSize: number;
    evaluator: ConditionEvaluator;
    refs: ScriptRef[];
    ext: { plots: Map<string, number>; scriptAlerts: Set<string> };
    /** Plot values by title and the script's own message, for the alert text. */
    plotsByTitle: Record<string, number>;
    scriptMessage: string | null;
    ready: boolean;
    stopped: boolean;
    pending: { bar: Bar; opened: boolean }[];
    lastBar: Bar | null;
    wasTrue: boolean;
    /** Fires produced while replaying missed bars; capped so a long outage cannot flood every channel. */
    lateFires: number;
    lastScriptTick: number;
    /** Serialises work for alerts that wait on a script run. */
    chain: Promise<void>;
    stop: Unsubscribe;
}

/**
 * Runs every active alert against live market data on the server, so alerts keep working with no
 * browser open. Each alert is seeded from history, evaluated on every tick and bar close, and after
 * a restart replays the bars that closed while it was down.
 */
export class AlertEngine {
    readonly events = new Emitter<{ fired: AlertEvent; changed: { id: string; removed?: boolean } }>();
    private deps: EngineDeps;
    private alerts = new Map<string, Alert>();
    private runtimes = new Map<string, Runtime[]>();
    private dirty = new Set<string>();
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private log: (message: string) => void;
    evaluations = 0;

    constructor(deps: EngineDeps) {
        this.deps = deps;
        this.log = deps.log ?? (() => {});
    }

    /** Load saved alerts and start watching the active ones. Resolves once each has caught up with history. */
    async start(): Promise<void> {
        for (const alert of this.deps.store.list()) this.alerts.set(alert.id, alert);
        this.flushTimer = setInterval(() => this.flush(), 2000);
        this.flushTimer.unref?.();
        await Promise.all([...this.alerts.values()].filter((a) => a.active).map((a) => this.activate(a)));
    }

    stop(): void {
        if (this.flushTimer) clearInterval(this.flushTimer);
        for (const list of this.runtimes.values()) for (const rt of list) this.stopRuntime(rt);
        this.runtimes.clear();
        this.flush();
    }

    private flush(): void {
        // Retire alerts whose expiry has passed, whether or not their condition ever came true.
        const now = this.deps.data.clock();
        for (const alert of this.alerts.values()) {
            if (!alert.active || alert.expiresAt === null || now < alert.expiresAt) continue;
            alert.active = false;
            this.deactivate(alert.id);
            this.dirty.add(alert.id);
            this.events.emit('changed', { id: alert.id });
        }
        for (const id of this.dirty) {
            const alert = this.alerts.get(id);
            if (alert) this.deps.store.save(alert);
        }
        this.dirty.clear();
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    list(): Alert[] {
        return [...this.alerts.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    get(id: string): Alert | undefined {
        return this.alerts.get(id);
    }

    private async normalize(
        input: AlertInput,
        base?: Alert,
    ): Promise<Omit<Alert, 'id' | 'createdAt' | 'updatedAt' | 'state'>> {
        const rawSymbols = input.symbols ?? base?.symbols;
        if (!Array.isArray(rawSymbols) || rawSymbols.length === 0) throw bad('an alert needs at least one symbol');
        if (rawSymbols.length > MAX_SYMBOLS) throw bad(`an alert can watch at most ${MAX_SYMBOLS} symbols`);
        const symbols: string[] = [];
        for (const s of rawSymbols) {
            let info: SymbolInfo;
            try {
                info = await this.deps.data.describe(String(s));
            } catch (err: any) {
                throw bad(err?.message ?? `unknown symbol ${s}`);
            }
            if (!symbols.includes(info.symbol)) symbols.push(info.symbol);
        }
        let timeframe: string;
        try {
            timeframe = normalizeTimeframe(String(input.timeframe ?? base?.timeframe ?? '1'));
        } catch {
            throw bad('invalid timeframe');
        }
        const condition = checkCondition(input.condition ?? base?.condition);
        const frequency = (input.frequency ?? base?.frequency ?? 'once_per_bar') as Frequency;
        if (!FREQUENCIES.includes(frequency)) throw bad('invalid frequency');
        const cooldownMs = Math.max(0, Math.round(Number(input.cooldownMs ?? base?.cooldownMs ?? 0)) || 0);
        const expiresAt =
            input.expiresAt === undefined
                ? (base?.expiresAt ?? null)
                : input.expiresAt === null
                  ? null
                  : Number(input.expiresAt);
        if (expiresAt !== null && !Number.isFinite(expiresAt)) throw bad('invalid expiry');
        const n = (input.notify ?? base?.notify ?? { app: true, sound: true }) as NotifyTargets;
        const url = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);
        const notify: NotifyTargets = { app: n.app !== false, sound: !!n.sound };
        if (n.webhook) {
            const u = url(n.webhook.url);
            if (!u) throw bad('the webhook URL must start with http:// or https://');
            notify.webhook = { url: u, secret: n.webhook.secret ? String(n.webhook.secret) : undefined };
        }
        if (n.discord) {
            const u = url(n.discord.url);
            if (!u) throw bad('the Discord webhook URL must start with https://');
            notify.discord = { url: u };
        }
        if (n.telegram?.chatId) notify.telegram = { chatId: String(n.telegram.chatId).trim() };
        if (n.email?.to) {
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(n.email.to.trim())) throw bad('invalid email address');
            notify.email = { to: n.email.to.trim() };
        }
        const name = String(input.name ?? base?.name ?? '').trim() || describeCondition(condition);
        return {
            name: name.slice(0, 200),
            symbols,
            timeframe,
            condition,
            frequency,
            cooldownMs,
            expiresAt,
            message: String(input.message ?? base?.message ?? '').slice(0, 4000),
            notify,
            active: input.active ?? base?.active ?? true,
        };
    }

    async create(input: AlertInput): Promise<Alert> {
        if (this.alerts.size >= MAX_ALERTS) throw bad(`the limit of ${MAX_ALERTS} alerts is reached`);
        const now = this.deps.data.clock();
        const alert: Alert = {
            id: newId('al'),
            ...(await this.normalize(input)),
            createdAt: now,
            updatedAt: now,
            state: emptyState(),
        };
        this.alerts.set(alert.id, alert);
        this.deps.store.save(alert);
        if (alert.active) await this.activate(alert);
        this.events.emit('changed', { id: alert.id });
        return alert;
    }

    /** Change an alert. Its history counters are kept; what it has "seen" starts afresh. */
    async update(id: string, input: AlertInput): Promise<Alert | null> {
        const current = this.alerts.get(id);
        if (!current) return null;
        const next: Alert = {
            ...current,
            ...(await this.normalize(input, current)),
            updatedAt: this.deps.data.clock(),
            state: { ...current.state, lastBarTime: {}, lastFiredBar: {}, done: [] },
        };
        this.deactivate(id);
        this.alerts.set(id, next);
        this.deps.store.save(next);
        if (next.active) await this.activate(next);
        this.events.emit('changed', { id });
        return next;
    }

    async setActive(id: string, active: boolean): Promise<Alert | null> {
        const alert = this.alerts.get(id);
        if (!alert) return null;
        if (alert.active === active && (!active || this.runtimes.has(id))) return alert;
        alert.active = active;
        alert.updatedAt = this.deps.data.clock();
        if (active) {
            // Resuming: do not replay what happened while it was paused, and let a finished `once` alert run again.
            alert.state.lastBarTime = {};
            alert.state.done = [];
            this.deactivate(id);
            await this.activate(alert);
        } else this.deactivate(id);
        this.deps.store.save(alert);
        this.events.emit('changed', { id });
        return alert;
    }

    remove(id: string): boolean {
        if (!this.alerts.has(id)) return false;
        this.deactivate(id);
        this.alerts.delete(id);
        this.dirty.delete(id);
        this.deps.store.remove(id);
        this.events.emit('changed', { id, removed: true });
        return true;
    }

    stats(): { alerts: number; active: number; runtimes: number; evaluations: number } {
        let runtimes = 0;
        for (const list of this.runtimes.values()) runtimes += list.length;
        return {
            alerts: this.alerts.size,
            active: [...this.alerts.values()].filter((a) => a.active).length,
            runtimes,
            evaluations: this.evaluations,
        };
    }

    // ── Runtime ─────────────────────────────────────────────────────────────

    private stopRuntime(rt: Runtime): void {
        rt.stopped = true;
        rt.stop();
    }

    private deactivate(id: string): void {
        for (const rt of this.runtimes.get(id) ?? []) this.stopRuntime(rt);
        this.runtimes.delete(id);
    }

    private async activate(alert: Alert): Promise<void> {
        const list: Runtime[] = [];
        this.runtimes.set(alert.id, list);
        await Promise.all(
            alert.symbols
                .filter((symbol) => !(alert.frequency === 'once' && alert.state.done.includes(symbol)))
                .map(async (symbol) => {
                    const rt: Runtime = {
                        alert,
                        symbol,
                        tickSize: 0.01,
                        evaluator: new ConditionEvaluator(alert.condition),
                        refs: scriptRefs(alert.condition),
                        ext: { plots: new Map(), scriptAlerts: new Set() },
                        plotsByTitle: {},
                        scriptMessage: null,
                        ready: false,
                        stopped: false,
                        pending: [],
                        lastBar: null,
                        wasTrue: false,
                        lateFires: 0,
                        lastScriptTick: 0,
                        chain: Promise.resolve(),
                        stop: () => {},
                    };
                    list.push(rt);
                    try {
                        // Listen first, so nothing that happens while history loads is lost.
                        rt.stop = this.deps.data.subscribe(symbol, alert.timeframe, (bar, opened) =>
                            this.onBar(rt, bar, opened),
                        );
                        rt.tickSize = (await this.deps.data.describe(symbol)).tickSize;
                        await this.seed(rt);
                    } catch (err: any) {
                        // Do not leave a half-started listener buffering ticks forever.
                        this.stopRuntime(rt);
                        list.splice(list.indexOf(rt), 1);
                        this.log(`alert "${alert.name}" could not start on ${symbol}: ${err?.message ?? err}`);
                    }
                }),
        );
    }

    /** Bring a runtime up to date with history: warm up silently, then replay bars missed while down. */
    private async seed(rt: Runtime): Promise<void> {
        const { alert, symbol } = rt;
        const tf = alert.timeframe;
        const ms = timeframeMs(tf);
        const now = this.deps.data.clock();
        const warmup = Math.max(50, warmupBars(alert.condition));
        const lastSeen = alert.state.lastBarTime[symbol];
        const missed =
            lastSeen === undefined ? 0 : Math.min(MAX_CATCHUP_BARS, Math.max(0, Math.ceil((now - lastSeen) / ms)));
        const history = await this.deps.data.getBars(symbol, tf, { limit: warmup + missed + 2 });
        const boundary = barOpenTime(now, tf);
        const closed = history.toBars().filter((b) => b.time < boundary);
        if (rt.stopped) return;

        // One script run covers the whole seeding window.
        const snapshots = rt.refs.length ? await this.scriptHistory(rt, closed) : null;
        for (let i = 0; i < closed.length; i++) {
            const bar = closed[i];
            if (snapshots) this.applySnapshot(rt, snapshots, bar.time);
            if (lastSeen === undefined || bar.time <= lastSeen) rt.evaluator.seed(bar, rt.ext);
            else this.closeBar(rt, bar, true);
            if (rt.stopped) return;
        }
        if (closed.length) {
            alert.state.lastBarTime[symbol] = closed[closed.length - 1].time;
            this.dirty.add(alert.id);
            rt.lastBar = null;
        }
        rt.ready = true;
        const pending = rt.pending;
        rt.pending = [];
        for (const p of pending) this.onBar(rt, p.bar, p.opened);
    }

    private onBar(rt: Runtime, bar: Bar, opened: boolean): void {
        if (rt.stopped) return;
        if (!rt.ready) {
            rt.pending.push({ bar: { ...bar }, opened });
            return;
        }
        const copy = { ...bar };
        if (rt.refs.length === 0) {
            this.step(rt, copy);
            return;
        }
        // Script-backed alerts wait for the script: keep their work in order.
        rt.chain = rt.chain
            .then(() => this.stepWithScripts(rt, copy))
            .catch((err) => this.log(`alert "${rt.alert.name}": ${err?.message ?? err}`));
    }

    private step(rt: Runtime, bar: Bar): void {
        const last = rt.lastBar;
        // Bars already handled during seeding arrive again from the stream: skip them.
        const seen = rt.alert.state.lastBarTime[rt.symbol];
        if (seen !== undefined && bar.time <= seen) return;
        if (last && bar.time > last.time) this.closeBar(rt, last, false);
        rt.lastBar = bar;
        this.tick(rt, bar);
    }

    private async stepWithScripts(rt: Runtime, bar: Bar): Promise<void> {
        if (rt.stopped) return;
        const seen = rt.alert.state.lastBarTime[rt.symbol];
        if (seen !== undefined && bar.time <= seen) return;
        const last = rt.lastBar;
        if (last && bar.time > last.time) {
            await this.refreshScripts(rt, last.time, true);
            if (rt.stopped) return;
            this.closeBar(rt, last, false);
        }
        rt.lastBar = bar;
        if (rt.alert.frequency === 'once_per_bar_close') return;
        const now = this.deps.data.clock();
        if (now - rt.lastScriptTick >= SCRIPT_TICK_MS) {
            rt.lastScriptTick = now;
            await this.refreshScripts(rt, bar.time, false);
            if (rt.stopped) return;
        }
        this.tick(rt, bar);
    }

    private closeBar(rt: Runtime, bar: Bar, late: boolean): void {
        this.evaluations++;
        const hit = rt.evaluator.close(bar, rt.ext);
        rt.alert.state.lastBarTime[rt.symbol] = bar.time;
        this.dirty.add(rt.alert.id);
        // A replayed bar has no ticks: for every frequency, its close is the only evidence there is.
        if (hit && (late || rt.alert.frequency === 'once_per_bar_close')) this.maybeFire(rt, bar, late);
        if (rt.alert.frequency === 'every_time') rt.wasTrue = false;
    }

    private tick(rt: Runtime, bar: Bar): void {
        const { alert } = rt;
        if (alert.frequency === 'once_per_bar_close') return;
        this.evaluations++;
        const hit = rt.evaluator.tick(bar, rt.ext);
        if (alert.frequency === 'every_time') {
            const rising = hit && !rt.wasTrue;
            const again = hit && rt.wasTrue && alert.cooldownMs > 0;
            rt.wasTrue = hit;
            if (rising || again) this.maybeFire(rt, bar, false);
            return;
        }
        if (hit) this.maybeFire(rt, bar, false);
    }

    private maybeFire(rt: Runtime, bar: Bar, late: boolean): void {
        const { alert, symbol } = rt;
        const now = this.deps.data.clock();
        if (!alert.active || rt.stopped) return;
        if (alert.expiresAt !== null && now >= alert.expiresAt) {
            alert.active = false;
            this.deactivate(alert.id);
            this.deps.store.save(alert);
            this.events.emit('changed', { id: alert.id });
            return;
        }
        if (alert.frequency !== 'every_time' && alert.state.lastFiredBar[symbol] === bar.time) return;
        if (late && ++rt.lateFires > MAX_LATE_FIRES) return;
        if (
            alert.cooldownMs > 0 &&
            alert.state.lastFiredAt !== null &&
            now - alert.state.lastFiredAt < alert.cooldownMs &&
            !late
        )
            return;

        const values = rt.evaluator.values();
        const template = alert.message.trim() || rt.scriptMessage || DEFAULT_MESSAGE;
        const event: AlertEvent = {
            id: newId('ev'),
            alertId: alert.id,
            alertName: alert.name,
            symbol,
            timeframe: alert.timeframe,
            time: now,
            barTime: bar.time,
            price: bar.close,
            message: renderMessage(template, {
                alertName: alert.name,
                symbol,
                timeframe: alert.timeframe,
                bar,
                now,
                tickSize: rt.tickSize,
                left: values.left,
                right: values.right,
                plots: rt.plotsByTitle,
            }),
            late,
            sound: !!alert.notify.sound,
            deliveries: [],
        };
        alert.state.lastFiredBar[symbol] = bar.time;
        alert.state.lastFiredAt = now;
        alert.state.fireCount++;
        if (alert.frequency === 'once') {
            if (!alert.state.done.includes(symbol)) alert.state.done.push(symbol);
            this.stopRuntime(rt);
            const list = this.runtimes.get(alert.id);
            if (list) list.splice(list.indexOf(rt), 1);
            if (alert.symbols.every((s) => alert.state.done.includes(s))) {
                alert.active = false;
                this.runtimes.delete(alert.id);
            }
        }
        this.deps.store.save(alert);
        this.dirty.delete(alert.id);
        this.deps.store.appendLog(event);
        this.events.emit('fired', event);
        this.events.emit('changed', { id: alert.id });
        if (this.deps.deliver) {
            this.deps
                .deliver(event, alert)
                .then((deliveries) => {
                    event.deliveries = deliveries;
                    this.deps.store.updateLog(event);
                })
                .catch((err) => this.log(`delivery failed for "${alert.name}": ${err?.message ?? err}`));
        }
    }

    // ── Scripts ─────────────────────────────────────────────────────────────

    private sourceOf(ref: ScriptRef): string | null {
        if (ref.source) return ref.source;
        return ref.scriptId ? (this.deps.scripts?.resolve(ref.scriptId) ?? null) : null;
    }

    /** Copy the values of one bar out of script runs into the runtime's external inputs. */
    private applyRun(rt: Runtime, ref: ScriptRef, run: ScriptRunLike, barTime: number): void {
        const i = run.times.lastIndexOf(barTime);
        for (const [title, values] of Object.entries(run.plots)) {
            const v = i >= 0 ? values[i] : null;
            const value = v === null || v === undefined ? Number.NaN : v;
            rt.ext.plots.set(plotKey(ref, title), value);
            rt.plotsByTitle[title] = value;
        }
        for (const a of run.alerts) {
            if (a.time !== barTime) continue;
            // `alertcondition` carries a title; a bare `alert()` call is matched by the wildcard key.
            if (a.title) rt.ext.scriptAlerts.add(scriptAlertKey(ref, a.title));
            else {
                rt.ext.scriptAlerts.add(scriptAlertKey(ref));
                rt.scriptMessage = a.message || rt.scriptMessage;
            }
        }
    }

    private async scriptHistory(rt: Runtime, closed: Bar[]): Promise<Map<ScriptRef, ScriptRunLike>> {
        const out = new Map<ScriptRef, ScriptRunLike>();
        if (!this.deps.scripts || closed.length === 0) return out;
        for (const ref of rt.refs) {
            const source = this.sourceOf(ref);
            if (!source) continue;
            try {
                out.set(
                    ref,
                    await this.deps.scripts.run(source, rt.symbol, rt.alert.timeframe, {
                        bars: closed.length + SCRIPT_BARS,
                        inputs: ref.inputs,
                        closedOnly: true,
                        alertMode: 'all',
                    }),
                );
            } catch (err: any) {
                this.log(`alert "${rt.alert.name}": script failed: ${err?.message ?? err}`);
            }
        }
        return out;
    }

    private applySnapshot(rt: Runtime, runs: Map<ScriptRef, ScriptRunLike>, barTime: number): void {
        rt.ext.scriptAlerts.clear();
        for (const [ref, run] of runs) this.applyRun(rt, ref, run, barTime);
    }

    private async refreshScripts(rt: Runtime, barTime: number, closedOnly: boolean): Promise<void> {
        rt.ext.scriptAlerts.clear();
        if (!this.deps.scripts) return;
        for (const ref of rt.refs) {
            const source = this.sourceOf(ref);
            if (!source) continue;
            try {
                const run = await this.deps.scripts.run(source, rt.symbol, rt.alert.timeframe, {
                    bars: SCRIPT_BARS,
                    inputs: ref.inputs,
                    closedOnly,
                    alertMode: 'all',
                });
                this.applyRun(rt, ref, run, barTime);
            } catch (err: any) {
                this.log(`alert "${rt.alert.name}": script failed: ${err?.message ?? err}`);
            }
        }
    }
}
