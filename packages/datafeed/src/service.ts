import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    aggregate,
    type Bar,
    type BarSeries,
    barCloseTime,
    barOpenTime,
    canAggregate,
    Emitter,
    LiveAggregator,
    normalizeTimeframe,
    type SymbolInfo,
    splitSymbol,
    type Tick,
    timeframeMs,
    type Unsubscribe,
} from '@ts/core';
import type { BarStore, Range } from './store.ts';
import { type BarQuery, type MarketDataAdapter, type SeriesKey, seriesId } from './types.ts';
import { VirtualSeriesManager } from './virtual.ts';

export type BarListener = (bar: Bar, opened: boolean) => void;

interface Hub {
    key: SeriesKey;
    symbol: string;
    listeners: Set<BarListener>;
    last: Bar | null;
    lastEventTime: number;
    stop: Unsubscribe[];
    /** Pending teardown while the hub lingers with no listeners. */
    linger: ReturnType<typeof setTimeout> | null;
}

export interface DataServiceOptions {
    adapters: MarketDataAdapter[];
    store: BarStore;
    now?: () => number;
    /** How long a cached symbol list stays fresh before a background refresh. */
    symbolTtlMs?: number;
    log?: (message: string) => void;
    /**
     * Keep a live stream running this long after its last listener leaves. Switching back to a
     * recently viewed symbol then finds its forming bar in memory instead of asking the venue.
     */
    lingerMs?: number;
}

const WINDOW_BARS = 1000;
/** How long a forming bar fetched for one request may answer the next. The live stream takes over after that. */
const TAIL_TTL_MS = 3_000;

/**
 * The single source of market data for everything else: charts, scripts, alerts, backtests, orders.
 * History is served from the disk cache and fetched once per gap; live bars are fanned out from one
 * upstream stream per series; timeframes a venue lacks are aggregated from the coarsest one it has.
 */
export class MarketDataService {
    readonly store: BarStore;
    readonly events = new Emitter<{ reconnect: { provider: string }; symbols: { provider: string; count: number } }>();
    private adapters = new Map<string, MarketDataAdapter>();
    private symbols = new Map<string, SymbolInfo>();
    private byTicker = new Map<string, SymbolInfo>();
    private hubs = new Map<string, Hub>();
    private tradeHubs = new Map<string, { listeners: Set<(t: Tick) => void>; stop: Unsubscribe; last: Tick | null }>();
    private locks = new Map<string, Promise<unknown>>();
    private genesis = new Map<string, number>();
    private tails = new Map<string, { bar: Bar; at: number }>();
    private now: () => number;
    private ttl: number;
    private log: (message: string) => void;
    private lingerMs: number;
    private stops: Unsubscribe[] = [];
    private virtual = new VirtualSeriesManager(this);

    constructor(opts: DataServiceOptions) {
        this.store = opts.store;
        this.now = opts.now ?? Date.now;
        this.ttl = opts.symbolTtlMs ?? 12 * 3600_000;
        this.log = opts.log ?? (() => {});
        this.lingerMs = opts.lingerMs ?? 0;
        for (const a of opts.adapters) {
            this.adapters.set(a.name, a);
            if (a.onReconnect) this.stops.push(a.onReconnect(() => void this.heal(a)));
        }
    }

    // ── Symbols ─────────────────────────────────────────────────────────────

    /** Load every adapter's symbol list: from the disk cache when fresh, else from the venue. */
    async init(): Promise<void> {
        for (const adapter of this.adapters.values()) void adapter.warm?.();
        await Promise.all(
            [...this.adapters.values()].map(async (adapter) => {
                const path = join(this.store.dir, `symbols-${adapter.name}.json`);
                let cached: SymbolInfo[] | null = null;
                let fresh = false;
                if (existsSync(path)) {
                    try {
                        cached = JSON.parse(readFileSync(path, 'utf8'));
                        fresh = this.now() - statSync(path).mtimeMs < this.ttl;
                    } catch {}
                }
                const refresh = async () => {
                    const list = await adapter.listSymbols();
                    mkdirSync(this.store.dir, { recursive: true });
                    writeFileSync(path, JSON.stringify(list));
                    this.index(adapter.name, list);
                };
                if (cached?.length) {
                    this.index(adapter.name, cached);
                    if (!fresh)
                        void refresh().catch((e) =>
                            this.log(`symbol refresh failed for ${adapter.name}: ${e.message}`),
                        );
                } else {
                    try {
                        await refresh();
                    } catch (e: any) {
                        this.log(`could not load symbols for ${adapter.name}: ${e.message}`);
                    }
                }
            }),
        );
    }

    private index(provider: string, list: SymbolInfo[]): void {
        for (const [id, s] of this.symbols) if (s.provider === provider) this.symbols.delete(id);
        for (const s of list) this.symbols.set(s.symbol, s);
        this.byTicker.clear();
        // Adapter declaration order decides which venue a bare ticker resolves to.
        for (const name of this.adapters.keys()) {
            for (const s of this.symbols.values()) {
                if (s.provider === name && !this.byTicker.has(s.ticker)) this.byTicker.set(s.ticker, s);
            }
        }
        this.events.emit('symbols', { provider, count: list.length });
    }

    listSymbols(): SymbolInfo[] {
        return [...this.symbols.values()];
    }

    /** Resolve `PROVIDER:TICKER` or a bare ticker. Throws when nothing serves it. */
    resolve(symbol: string): { adapter: MarketDataAdapter; info: SymbolInfo } {
        const { provider, ticker } = splitSymbol(symbol);
        const info = provider
            ? (this.symbols.get(`${provider}:${ticker}`) ?? this.symbols.get(`${provider}:${ticker.toUpperCase()}`))
            : (this.byTicker.get(ticker) ?? this.byTicker.get(ticker.toUpperCase()));
        if (!info) throw new Error(`Unknown symbol: ${symbol}`);
        return { adapter: this.adapters.get(info.provider)!, info };
    }

    symbolInfo(symbol: string): SymbolInfo {
        return this.resolve(symbol).info;
    }

    /** Facts about any symbol, including chart-type series (`SYMBOL.RENKOXATR14`) and `SPREAD:` formulas. */
    async describe(symbol: string): Promise<SymbolInfo> {
        const virtual = this.virtual.match(symbol);
        return virtual ? virtual.describe() : this.resolve(symbol).info;
    }

    /** The tradable symbol behind any chart symbol: a chart-type suffix is dropped. Throws for formulas. */
    underlying(symbol: string): SymbolInfo {
        const split = VirtualSeriesManager.looksVirtual(symbol) ? this.virtual.splitTransform(symbol) : null;
        return split ? split.base : this.resolve(symbol).info;
    }

    /** The service's clock (injectable for tests). */
    clock(): number {
        return this.now();
    }

    // ── History ─────────────────────────────────────────────────────────────

    /** The native timeframe to build `timeframe` from: itself when native, else the coarsest that divides it. */
    baseTimeframe(adapter: MarketDataAdapter, timeframe: string): string {
        const tf = normalizeTimeframe(timeframe);
        const natives = adapter.nativeTimeframes.map(normalizeTimeframe);
        if (natives.includes(tf)) return tf;
        const candidates = natives
            .filter((n) => timeframeMs(n) < timeframeMs(tf) && canAggregate(n, tf))
            .sort((a, b) => timeframeMs(b) - timeframeMs(a));
        if (!candidates.length) throw new Error(`${adapter.name} cannot serve timeframe ${timeframe}`);
        return candidates[0];
    }

    private async locked<T>(id: string, task: () => Promise<T>): Promise<T> {
        const prev = this.locks.get(id) ?? Promise.resolve();
        const run = prev.then(task, task);
        const settled = run.catch(() => {});
        this.locks.set(id, settled);
        try {
            return await run;
        } finally {
            if (this.locks.get(id) === settled) this.locks.delete(id);
        }
    }

    /** Fetch one uncovered range in parallel windows and record it as covered. */
    private async fill(adapter: MarketDataAdapter, key: SeriesKey, gap: Range): Promise<void> {
        const ms = timeframeMs(key.timeframe);
        const boundary = barOpenTime(this.now(), key.timeframe);
        const span = WINDOW_BARS * ms;
        let start = gap[0];
        if ((gap[1] - start) / span > 8) {
            // A deep request: don't walk back through years in which the instrument did not exist.
            const id = seriesId(key);
            let genesis = this.genesis.get(id);
            if (genesis === undefined) {
                genesis = barOpenTime(await adapter.firstBarTime(key.ticker, key.timeframe), key.timeframe);
                this.genesis.set(id, genesis);
            }
            if (start < genesis) {
                this.store.addCoverage(key, start, Math.min(genesis, gap[1]));
                start = genesis;
            }
        }
        const windows: Range[] = [];
        for (let a = start; a < gap[1]; a += span) windows.push([a, Math.min(gap[1], a + span)]);
        if (windows.length > 40) this.log(`downloading ${seriesId(key)}: ${windows.length} requests`);
        // Four at a time: a deep download must leave request slots free for whatever the user does next.
        for (let i = 0; i < windows.length; i += 4) {
            const batch = windows.slice(i, i + 4);
            const results = await Promise.all(
                batch.map(([a, b]) => adapter.getBars(key.ticker, key.timeframe, { from: a, to: b - 1 })),
            );
            for (let k = 0; k < batch.length; k++) {
                const closed = results[k].filter(
                    (bar) => bar.time >= batch[k][0] && bar.time < batch[k][1] && bar.time < boundary,
                );
                this.store.write(key, closed);
                this.store.addCoverage(key, batch[k][0], Math.min(batch[k][1], boundary));
            }
        }
    }

    /** The forming bar of a native series: from the live stream if one runs, else a short-lived cache, else the venue. */
    private async formingBar(
        adapter: MarketDataAdapter,
        key: SeriesKey,
        boundary: number,
        to: number,
    ): Promise<Bar | null> {
        const id = seriesId(key);
        const hub = this.hubs.get(id);
        if (hub?.last && hub.last.time >= boundary) return hub.last;
        const cached = this.tails.get(id);
        if (cached && cached.bar.time >= boundary && this.now() - cached.at < TAIL_TTL_MS) return cached.bar;
        const tail = await adapter.getBars(key.ticker, key.timeframe, { from: boundary, to });
        const bar = tail.length ? tail[tail.length - 1] : null;
        if (bar) this.tails.set(id, { bar, at: this.now() });
        // A chart that just loaded history is about to subscribe: warm the stream for it.
        if (this.lingerMs > 0 && !this.hubs.has(id))
            this.subscribe(`${key.provider}:${key.ticker}`, key.timeframe, () => {})();
        return bar;
    }

    /** Bars of a native timeframe with open time in `[from, to]`: cache first, then the venue for gaps. */
    private async loadNative(adapter: MarketDataAdapter, key: SeriesKey, from: number, to: number): Promise<BarSeries> {
        const boundary = barOpenTime(this.now(), key.timeframe);
        const closedTo = Math.min(to + 1, boundary);
        // History gaps and the forming bar come from the venue independently: ask for both at once.
        const forming = to >= boundary ? this.formingBar(adapter, key, boundary, to) : Promise.resolve(null);
        forming.catch(() => {});
        // Take the series lock only when something is actually missing, so a request for bars already
        // on disk never queues behind an unrelated download of older history.
        if (from < closedTo && this.store.missing(key, from, closedTo).length > 0) {
            await this.locked(seriesId(key), async () => {
                for (const gap of this.store.missing(key, from, closedTo)) await this.fill(adapter, key, gap);
            });
        }
        const series = this.store.read(key, from, closedTo);
        const bar = await forming;
        if (bar && (series.length === 0 || bar.time > series.time[series.length - 1])) {
            series.append(bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume);
        }
        return series;
    }

    /**
     * Bars for any timeframe. With `from` the window is `[from, to]`; with only `limit` it is the
     * newest `limit` bars up to `to`. The last bar is the forming one when the window reaches now.
     */
    async getBars(symbol: string, timeframe: string, query: BarQuery = {}): Promise<BarSeries> {
        const virtual = this.virtual.match(symbol);
        if (virtual) return virtual.getBars(timeframe, query);
        const { adapter, info } = this.resolve(symbol);
        const tf = normalizeTimeframe(timeframe);
        const base = this.baseTimeframe(adapter, tf);
        const key: SeriesKey = { provider: adapter.name, ticker: info.ticker, timeframe: base };
        const now = this.now();
        const to = Math.min(query.to ?? now, now);
        const ms = timeframeMs(tf);
        const limit = query.limit ?? (query.from === undefined ? 300 : undefined);
        let from = query.from !== undefined ? barOpenTime(query.from, tf) : barOpenTime(to, tf) - (limit! - 1) * ms;

        // `to` bounds the open time of the requested timeframe's bars. A coarse bar that opens at or
        // before `to` needs every base bar up to its own close, or it would be built from a fragment.
        const nativeTo = base === tf ? to : Math.min(now, barCloseTime(barOpenTime(to, tf), tf) - 1);
        const load = async () => {
            const native = await this.loadNative(adapter, key, Math.max(0, from), nativeTo);
            return base === tf ? native : aggregate(native, tf);
        };
        let series = await load();
        if (query.from === undefined && limit !== undefined) {
            // Markets with sessions or thin trading return fewer bars than the nominal window: widen it.
            for (let round = 0; round < 4 && series.length < limit && from > 0; round++) {
                const before = series.length;
                from -= Math.max(1, limit - series.length) * ms * 2;
                series = await load();
                if (series.length === before) break; // nothing older exists
            }
        }
        if (limit !== undefined && series.length > limit) series = series.slice(series.length - limit);
        return series;
    }

    // ── Live ────────────────────────────────────────────────────────────────

    private emit(hub: Hub, bar: Bar, opened: boolean): void {
        for (const listener of [...hub.listeners]) {
            try {
                listener(bar, opened);
            } catch (err) {
                console.error('[datafeed] bar listener threw', err);
            }
        }
    }

    private onNativeBar(hub: Hub, bar: Bar, eventTime: number): void {
        const prev = hub.last;
        if (prev && bar.time < prev.time) return;
        const opened = !prev || bar.time > prev.time;
        if (opened && prev) {
            this.store.write(hub.key, [prev]);
            this.store.extendCoverage(hub.key, prev.time, barCloseTime(prev.time, hub.key.timeframe));
        }
        const next = { ...bar };
        // A trade newer than this snapshot has already moved the price: keep it.
        const trade = this.tradeHubs.get(`${hub.key.provider}:${hub.key.ticker}`)?.last;
        if (
            trade &&
            trade.time > eventTime &&
            trade.time >= next.time &&
            trade.time < barCloseTime(next.time, hub.key.timeframe)
        ) {
            next.close = trade.price;
            if (trade.price > next.high) next.high = trade.price;
            if (trade.price < next.low) next.low = trade.price;
        }
        hub.last = next;
        hub.lastEventTime = eventTime;
        this.emit(hub, next, opened);
    }

    private onTrade(hub: Hub, tick: Tick): void {
        const bar = hub.last;
        if (!bar || tick.time <= hub.lastEventTime) return;
        if (tick.time < bar.time || tick.time >= barCloseTime(bar.time, hub.key.timeframe)) return;
        if (tick.price === bar.close) return;
        bar.close = tick.price;
        if (tick.price > bar.high) bar.high = tick.price;
        if (tick.price < bar.low) bar.low = tick.price;
        this.emit(hub, bar, false);
    }

    private startHub(hub: Hub, adapter: MarketDataAdapter, tf: string, base: string): void {
        if (base === tf) {
            hub.stop.push(
                adapter.subscribeBars(hub.key.ticker, tf, (bar, eventTime) => this.onNativeBar(hub, bar, eventTime)),
            );
            if (adapter.subscribeTrades)
                hub.stop.push(this.subscribeTrades(hub.symbol, (tick) => this.onTrade(hub, tick)));
            return;
        }
        // Aggregated timeframe: fold the base stream, seeded with the base bars already inside this bucket.
        const agg = new LiveAggregator(tf);
        let seeded = false;
        const pending: Bar[] = [];
        const push = (bar: Bar) => {
            const update = agg.push(bar);
            if (!update) return;
            const opened = !hub.last || update.bar.time > hub.last.time;
            hub.last = update.bar;
            this.emit(hub, update.bar, opened);
        };
        hub.stop.push(
            this.subscribe(`${hub.key.provider}:${hub.key.ticker}`, base, (bar) => {
                if (seeded) push(bar);
                else pending.push({ ...bar });
            }),
        );
        const bucket = barOpenTime(this.now(), tf);
        this.getBars(hub.symbol, base, { from: bucket })
            .then((series) => {
                for (const bar of series.toBars()) agg.push(bar);
            })
            .catch((e) => this.log(`seed failed for ${seriesId(hub.key)}: ${e.message}`))
            .finally(() => {
                seeded = true;
                for (const bar of pending) push(bar);
                pending.length = 0;
            });
    }

    /** Live bars for any timeframe. One upstream stream per series, however many listeners. */
    subscribe(symbol: string, timeframe: string, listener: BarListener): Unsubscribe {
        const virtual = this.virtual.match(symbol);
        if (virtual) return virtual.subscribe(timeframe, listener);
        const { adapter, info } = this.resolve(symbol);
        const tf = normalizeTimeframe(timeframe);
        const base = this.baseTimeframe(adapter, tf);
        const key: SeriesKey = { provider: adapter.name, ticker: info.ticker, timeframe: tf };
        const id = seriesId(key);
        let hub = this.hubs.get(id);
        if (!hub) {
            hub = {
                key,
                symbol: info.symbol,
                listeners: new Set(),
                last: null,
                lastEventTime: 0,
                stop: [],
                linger: null,
            };
            this.hubs.set(id, hub);
            this.startHub(hub, adapter, tf, base);
        }
        if (hub.linger) {
            clearTimeout(hub.linger);
            hub.linger = null;
        }
        hub.listeners.add(listener);
        const target = hub;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            target.listeners.delete(listener);
            if (target.listeners.size > 0 || this.hubs.get(id) !== target) return;
            const teardown = () => {
                target.linger = null;
                if (target.listeners.size > 0 || this.hubs.get(id) !== target) return;
                this.hubs.delete(id);
                for (const stop of target.stop) stop();
            };
            if (this.lingerMs > 0) {
                target.linger = setTimeout(teardown, this.lingerMs);
                target.linger.unref?.();
            } else teardown();
        };
    }

    /** Live trade prints. Throws when the venue has none. */
    subscribeTrades(symbol: string, listener: (tick: Tick) => void): Unsubscribe {
        const { adapter, info } = this.resolve(symbol);
        if (!adapter.subscribeTrades) throw new Error(`${adapter.name} has no trade stream`);
        const id = info.symbol;
        let hub = this.tradeHubs.get(id);
        if (!hub) {
            const created = { listeners: new Set<(t: Tick) => void>(), stop: () => {}, last: null as Tick | null };
            created.stop = adapter.subscribeTrades(info.ticker, (tick) => {
                created.last = tick;
                for (const l of [...created.listeners]) l(tick);
            });
            this.tradeHubs.set(id, created);
            hub = created;
        }
        hub.listeners.add(listener);
        const target = hub;
        return () => {
            target.listeners.delete(listener);
            if (target.listeners.size === 0 && this.tradeHubs.get(id) === target) {
                this.tradeHubs.delete(id);
                target.stop();
            }
        };
    }

    /** Most recent price seen on any live stream of the symbol, if one is running. */
    lastPrice(symbol: string): number | undefined {
        const { info } = this.resolve(symbol);
        const trade = this.tradeHubs.get(info.symbol)?.last;
        if (trade) return trade.price;
        let newest: Bar | null = null;
        for (const hub of this.hubs.values()) {
            if (hub.symbol === info.symbol && hub.last && (!newest || hub.last.time >= newest.time)) newest = hub.last;
        }
        return newest?.close;
    }

    /** After an upstream reconnect: replay whatever each native stream missed, in order. */
    private async heal(adapter: MarketDataAdapter): Promise<void> {
        this.events.emit('reconnect', { provider: adapter.name });
        const natives = adapter.nativeTimeframes.map(normalizeTimeframe);
        for (const hub of [...this.hubs.values()]) {
            if (hub.key.provider !== adapter.name || !hub.last || !natives.includes(hub.key.timeframe)) continue;
            try {
                const missed = await adapter.getBars(hub.key.ticker, hub.key.timeframe, { from: hub.last.time });
                for (const bar of missed) this.onNativeBar(hub, bar, this.now());
            } catch (e: any) {
                this.log(`gap repair failed for ${seriesId(hub.key)}: ${e.message}`);
            }
        }
    }

    stats(): { hubs: number; tradeHubs: number; symbols: number } {
        return { hubs: this.hubs.size, tradeHubs: this.tradeHubs.size, symbols: this.symbols.size };
    }

    close(): void {
        for (const stop of this.stops) stop();
        for (const hub of this.hubs.values()) {
            if (hub.linger) clearTimeout(hub.linger);
            for (const stop of hub.stop) stop();
        }
        for (const hub of this.tradeHubs.values()) hub.stop();
        this.hubs.clear();
        this.tradeHubs.clear();
        for (const a of this.adapters.values()) a.close?.();
    }
}
