import { type Bar, Emitter, normalizeTimeframe, type SymbolInfo, sleep, type Tick, type Unsubscribe } from '@ts/core';
import { Agent, fetch as pooledFetch } from 'undici';
import type { BarQuery, Depth, MarketDataAdapter } from './types.ts';

const INTERVALS: Record<string, string> = {
    '1S': '1s',
    '1': '1m',
    '3': '3m',
    '5': '5m',
    '15': '15m',
    '30': '30m',
    '60': '1h',
    '120': '2h',
    '240': '4h',
    '360': '6h',
    '480': '8h',
    '720': '12h',
    '1D': '1d',
    '3D': '3d',
    '1W': '1w',
    '1M': '1M',
};

const REST_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api.binance.us'];
const WS_HOSTS = ['wss://data-stream.binance.vision/stream', 'wss://stream.binance.com:9443/stream'];
const PAGE = 1000;
/** Connections kept open to the venue. A request on an open connection takes ~140 ms; a new TLS handshake adds ~450 ms. */
const WARM_CONNECTIONS = 8;

export interface BinanceOptions {
    restHosts?: string[];
    wsHosts?: string[];
    fetch?: typeof fetch;
    /** Injected for tests. */
    WebSocket?: typeof WebSocket;
}

/** Binance spot market data: public REST klines + one multiplexed WebSocket. No API key needed. */
export class BinanceAdapter implements MarketDataAdapter {
    readonly name = 'BINANCE';
    readonly nativeTimeframes = Object.keys(INTERVALS);
    private restHosts: string[];
    private wsHosts: string[];
    private fetchFn: typeof fetch;
    private WS: typeof WebSocket;
    private restHost = 0;
    private agent: Agent | null = null;

    private ws: WebSocket | null = null;
    private wsHost = 0;
    private wsReady = false;
    private wsAttempts = 0;
    private wsTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private lastMessageAt = 0;
    private everConnected = false;
    private closed = false;
    private nextId = 1;
    /** stream name → handlers */
    private streams = new Map<string, Set<(data: any) => void>>();
    private events = new Emitter<{ reconnect: void }>();
    private active = 0;
    private queue: (() => void)[] = [];
    private lastRestAt = 0;
    private warmTimer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: BinanceOptions = {}) {
        this.restHosts = opts.restHosts ?? REST_HOSTS;
        this.wsHosts = opts.wsHosts ?? WS_HOSTS;
        if (opts.fetch) this.fetchFn = opts.fetch;
        else {
            // Node drops idle connections after 4 s by default; hold them so requests skip the handshake.
            const agent = new Agent({ keepAliveTimeout: 90_000, keepAliveMaxTimeout: 600_000, connections: 16 });
            this.agent = agent;
            this.fetchFn = ((input: any, init?: any) =>
                pooledFetch(input, { ...init, dispatcher: agent })) as unknown as typeof fetch;
        }
        this.WS = opts.WebSocket ?? WebSocket;
    }

    /**
     * Public aggregate trades in `[from, to)`, oldest first. Binance answers at most 1,000 per
     * request and a time window of at most an hour, so the range is cut into windows fetched a few at
     * a time, each continued by trade id until it is complete.
     */
    async getTrades(
        ticker: string,
        from: number,
        to: number,
        limit: number,
    ): Promise<{ trades: Tick[]; truncated: boolean }> {
        const HOUR = 3_600_000;
        const windows: [number, number][] = [];
        for (let a = from; a < to; a += HOUR) windows.push([a, Math.min(to, a + HOUR)]);
        const pages: Tick[][] = new Array(windows.length);
        let total = 0;
        let truncated = false;
        const fetchWindow = async (w: number) => {
            const [a, b] = windows[w];
            const out: Tick[] = [];
            let rows: any[] = await this.rest('/api/v3/aggTrades', {
                symbol: ticker,
                startTime: a,
                endTime: b - 1,
                limit: 1000,
            });
            for (;;) {
                for (const r of rows) {
                    if (r.T >= b) break;
                    out.push({ time: r.T, price: Number(r.p), size: Number(r.q), side: r.m ? 'sell' : 'buy' });
                }
                total += rows.length;
                if (rows.length < 1000 || rows[rows.length - 1].T >= b - 1) break;
                if (total >= limit) {
                    truncated = true;
                    break;
                }
                rows = await this.rest('/api/v3/aggTrades', {
                    symbol: ticker,
                    fromId: rows[rows.length - 1].a + 1,
                    limit: 1000,
                });
            }
            pages[w] = out;
        };
        for (let i = 0; i < windows.length; i += 4) {
            if (total >= limit) {
                truncated = true;
                break;
            }
            await Promise.all(windows.slice(i, i + 4).map((_, k) => fetchWindow(i + k)));
        }
        const trades = pages.filter(Boolean).flat();
        if (trades.length > limit) {
            truncated = true;
            trades.length = limit;
        }
        return { trades, truncated };
    }

    /** The public order book (no account needed). */
    async getDepth(ticker: string, levels: number): Promise<Depth> {
        const limit = [5, 10, 20, 50, 100, 500, 1000].find((n) => n >= levels) ?? 1000;
        const book = await this.rest('/api/v3/depth', { symbol: ticker, limit });
        const side = (rows: [string, string][]) =>
            rows.slice(0, levels).map(([p, q]) => [Number(p), Number(q)] as [number, number]);
        return { bids: side(book.bids ?? []), asks: side(book.asks ?? []), time: Date.now() };
    }

    // ── REST ────────────────────────────────────────────────────────────────

    /** At most 8 requests in flight; retries on rate limits and server errors; fails over between hosts. */
    private async rest(path: string, params: Record<string, string | number | undefined> = {}): Promise<any> {
        this.lastRestAt = Date.now();
        this.keepWarm();
        if (this.active >= 8) await new Promise<void>((resolve) => this.queue.push(resolve));
        this.active++;
        try {
            let lastError: unknown;
            for (let attempt = 0; attempt < 6; attempt++) {
                const url = new URL(path, this.restHosts[this.restHost]);
                for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
                try {
                    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
                    if (res.ok) return await res.json();
                    if (res.status === 429 || res.status === 418) {
                        const retry = Number(res.headers.get('retry-after') ?? 1);
                        await sleep(Math.min(30_000, Math.max(1, retry) * 1000));
                        continue;
                    }
                    if (res.status === 451 || res.status === 403 || res.status >= 500) {
                        this.restHost = (this.restHost + 1) % this.restHosts.length;
                        lastError = new Error(`Binance ${res.status} on ${url.host}`);
                        await sleep(200 * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
                } catch (err: any) {
                    if (String(err?.message).startsWith('Binance 4')) throw err;
                    lastError = err;
                    this.restHost = (this.restHost + 1) % this.restHosts.length;
                    await sleep(200 * (attempt + 1));
                }
            }
            throw lastError instanceof Error ? lastError : new Error('Binance request failed');
        } finally {
            this.active--;
            this.queue.shift()?.();
        }
    }

    /**
     * An idle HTTPS connection gets closed, and the next request then pays a fresh handshake
     * (hundreds of ms). While the feed is in use, a cheap ping keeps the connection open.
     */
    private keepWarm(): void {
        if (this.warmTimer || this.closed) return;
        this.warmTimer = setInterval(() => {
            if (Date.now() - this.lastRestAt > 10 * 60_000 && this.streams.size === 0) {
                clearInterval(this.warmTimer!);
                this.warmTimer = null;
                return;
            }
            void this.pingPool();
        }, 30_000);
        this.warmTimer.unref?.();
    }

    /** Touch several connections at once so the pool keeps that many open. */
    private async pingPool(): Promise<void> {
        const url = new URL('/api/v3/ping', this.restHosts[this.restHost]);
        await Promise.all(
            Array.from({ length: WARM_CONNECTIONS }, () =>
                this.fetchFn(url, { signal: AbortSignal.timeout(5_000) })
                    .then((res) => res.arrayBuffer())
                    .catch(() => {}),
            ),
        );
    }

    /** Open the HTTPS connections ahead of the first real request. */
    async warm(): Promise<void> {
        this.lastRestAt = Date.now();
        this.keepWarm();
        await this.pingPool();
    }

    async listSymbols(): Promise<SymbolInfo[]> {
        const info = await this.rest('/api/v3/exchangeInfo');
        const out: SymbolInfo[] = [];
        for (const s of info.symbols ?? []) {
            if (s.status !== 'TRADING') continue;
            const filter = (type: string) => (s.filters ?? []).find((f: any) => f.filterType === type);
            const price = filter('PRICE_FILTER');
            const lot = filter('LOT_SIZE');
            const notional = filter('NOTIONAL') ?? filter('MIN_NOTIONAL');
            out.push({
                symbol: `BINANCE:${s.symbol}`,
                provider: 'BINANCE',
                ticker: s.symbol,
                description: `${s.baseAsset} / ${s.quoteAsset}`,
                type: 'crypto',
                tickSize: Number(price?.tickSize ?? 0.01),
                lotSize: Number(lot?.stepSize ?? 0.00001),
                minQty: Number(lot?.minQty ?? 0.00001),
                minNotional: notional ? Number(notional.minNotional) : undefined,
                currency: s.quoteAsset,
                baseCurrency: s.baseAsset,
                timezone: 'Etc/UTC',
                session: '24x7',
            });
        }
        return out;
    }

    async firstBarTime(ticker: string, timeframe: string): Promise<number> {
        const interval = INTERVALS[normalizeTimeframe(timeframe)];
        if (!interval) throw new Error(`Binance has no native ${timeframe} bars`);
        const rows: any[][] = await this.rest('/api/v3/klines', { symbol: ticker, interval, limit: 1, startTime: 0 });
        return rows.length ? rows[0][0] : Date.now();
    }

    async getBars(ticker: string, timeframe: string, query: BarQuery): Promise<Bar[]> {
        const interval = INTERVALS[normalizeTimeframe(timeframe)];
        if (!interval) throw new Error(`Binance has no native ${timeframe} bars`);
        const parse = (rows: any[][]): Bar[] =>
            rows.map((r) => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));
        let bars: Bar[] = [];
        if (query.from !== undefined) {
            // A bounded window: page forward so each response holds only bars inside it.
            let cursor = query.from;
            for (;;) {
                const rows: any[][] = await this.rest('/api/v3/klines', {
                    symbol: ticker,
                    interval,
                    limit: PAGE,
                    startTime: cursor,
                    endTime: query.to,
                });
                if (!rows.length) break;
                bars.push(...parse(rows));
                if (rows.length < PAGE) break;
                cursor = rows[rows.length - 1][0] + 1;
            }
        } else {
            // Newest-first: with only endTime set, Binance returns the latest bars before it.
            const want = query.limit ?? PAGE;
            const pages: Bar[][] = [];
            let count = 0;
            let end = query.to;
            while (count < want) {
                const limit = Math.min(PAGE, want - count);
                const rows: any[][] = await this.rest('/api/v3/klines', {
                    symbol: ticker,
                    interval,
                    limit,
                    endTime: end,
                });
                if (!rows.length) break;
                pages.unshift(parse(rows));
                count += rows.length;
                if (rows.length < limit) break; // reached the listing date
                end = rows[0][0] - 1;
            }
            bars = pages.flat();
        }
        if (query.limit !== undefined && bars.length > query.limit) bars = bars.slice(-query.limit);
        return bars;
    }

    // ── WebSocket ───────────────────────────────────────────────────────────

    private connect(): void {
        if (this.closed || this.ws) return;
        const ws = new this.WS(this.wsHosts[this.wsHost]);
        this.ws = ws;
        ws.addEventListener('open', () => {
            this.wsReady = true;
            this.wsAttempts = 0;
            this.lastMessageAt = Date.now();
            const names = [...this.streams.keys()];
            for (let i = 0; i < names.length; i += 100) this.send('SUBSCRIBE', names.slice(i, i + 100));
            if (this.everConnected) this.events.emit('reconnect', undefined);
            this.everConnected = true;
        });
        ws.addEventListener('message', (ev: MessageEvent) => {
            this.lastMessageAt = Date.now();
            let msg: any;
            try {
                msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
            } catch {
                return;
            }
            const handlers = msg.stream ? this.streams.get(msg.stream) : undefined;
            if (handlers) for (const h of handlers) h(msg.data);
        });
        const lost = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this.wsReady = false;
            if (this.closed || this.streams.size === 0) return;
            this.wsAttempts++;
            if (this.wsAttempts % 3 === 0) this.wsHost = (this.wsHost + 1) % this.wsHosts.length;
            const delay = Math.min(15_000, 250 * 2 ** Math.min(6, this.wsAttempts));
            this.wsTimer = setTimeout(() => this.connect(), delay);
        };
        ws.addEventListener('close', lost);
        ws.addEventListener('error', () => {
            try {
                ws.close();
            } catch {}
            lost();
        });
        // A socket that stays open but silent is as bad as a closed one.
        if (!this.watchdog) {
            this.watchdog = setInterval(() => {
                if (this.wsReady && this.streams.size > 0 && Date.now() - this.lastMessageAt > 20_000) {
                    try {
                        this.ws?.close();
                    } catch {}
                }
            }, 5_000);
            this.watchdog.unref?.();
        }
    }

    private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
        if (!this.wsReady || !this.ws || params.length === 0) return;
        this.ws.send(JSON.stringify({ method, params, id: this.nextId++ }));
    }

    private stream(name: string, handler: (data: any) => void): Unsubscribe {
        let set = this.streams.get(name);
        if (!set) {
            set = new Set();
            this.streams.set(name, set);
            this.send('SUBSCRIBE', [name]);
        }
        set.add(handler);
        this.connect();
        return () => {
            set.delete(handler);
            if (set.size === 0 && this.streams.get(name) === set) {
                this.streams.delete(name);
                this.send('UNSUBSCRIBE', [name]);
            }
        };
    }

    subscribeBars(ticker: string, timeframe: string, onBar: (bar: Bar, eventTime: number) => void): Unsubscribe {
        const interval = INTERVALS[normalizeTimeframe(timeframe)];
        if (!interval) throw new Error(`Binance has no native ${timeframe} stream`);
        return this.stream(`${ticker.toLowerCase()}@kline_${interval}`, (d) => {
            const k = d?.k;
            if (!k) return;
            onBar({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, d.E ?? Date.now());
        });
    }

    subscribeTrades(ticker: string, onTick: (tick: Tick) => void): Unsubscribe {
        return this.stream(`${ticker.toLowerCase()}@aggTrade`, (d) => {
            if (d?.p === undefined) return;
            onTick({ time: d.T, price: +d.p, size: +d.q, side: d.m ? 'sell' : 'buy' });
        });
    }

    onReconnect(handler: () => void): Unsubscribe {
        return this.events.on('reconnect', handler);
    }

    close(): void {
        this.closed = true;
        if (this.wsTimer) clearTimeout(this.wsTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        if (this.warmTimer) clearInterval(this.warmTimer);
        void this.agent?.close().catch(() => {});
        try {
            this.ws?.close();
        } catch {}
        this.ws = null;
    }
}
