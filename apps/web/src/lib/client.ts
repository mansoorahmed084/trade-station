import { type Bar, BarSeries, Emitter, type SymbolInfo, type Unsubscribe } from '@ts/core';
import { type ClientMessage, decodeBarFrame, type ServerMessage } from '@ts/protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface BarRangeQuery {
    from?: number;
    to?: number;
    limit?: number;
}

interface Sub {
    symbol: string;
    tf: string;
    onBar: (bar: Bar) => void;
    lastTime: number;
    /** Frames held back while the bars missed during a disconnect are being replayed. */
    healing: Bar[] | null;
}

export interface PerfSnapshot {
    samples: number;
    /** Server send → message handled in the page. */
    transitP50: number;
    transitP95: number;
    /** Server send → the next animation frame after the update was applied (what the user sees). */
    pixelP50: number;
    pixelP95: number;
    rttMs: number | null;
}

const quantile = (sorted: number[], p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

/**
 * The page's one connection to the server: HTTP for history and state, a WebSocket for live bars
 * and application events. Reconnects on its own and replays whatever a subscription missed.
 */
export class ServerClient {
    readonly events = new Emitter<{ status: ConnectionStatus; rtt: number }>();
    status: ConnectionStatus = 'connecting';
    rttMs: number | null = null;
    private ws: WebSocket | null = null;
    private subs = new Map<number, Sub>();
    private topics = new Map<string, Set<(data: any) => void>>();
    private nextId = 1;
    private attempts = 0;
    private closed = false;
    private everOpen = false;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private transit: number[] = [];
    private pixel: number[] = [];
    private pendingPixel: number[] = [];
    private rafQueued = false;
    private readonly base: string;

    constructor(base = '') {
        this.base = base;
        this.connect();
    }

    // ── HTTP ────────────────────────────────────────────────────────────────

    async json<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(this.base + path, init);
        if (!res.ok) {
            let message = `${res.status} ${res.statusText}`;
            try {
                message = (await res.json()).error ?? message;
            } catch {}
            throw new Error(message);
        }
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    }

    post<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
        return this.json<T>(path, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async bars(symbol: string, tf: string, query: BarRangeQuery = {}, signal?: AbortSignal): Promise<BarSeries> {
        const params = new URLSearchParams({ symbol, tf });
        for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(Math.round(v)));
        const res = await fetch(`${this.base}/api/bars?${params}`, { signal });
        if (!res.ok) {
            let message = `bars ${res.status}`;
            try {
                message = (await res.json()).error ?? message;
            } catch {}
            throw new Error(message);
        }
        return BarSeries.decode(await res.arrayBuffer());
    }

    providers(): Promise<string[]> {
        return this.json('/api/providers');
    }

    symbols(provider?: string, q?: string, limit?: number): Promise<SymbolInfo[]> {
        const params = new URLSearchParams();
        if (provider) params.set('provider', provider);
        if (q) params.set('q', q);
        if (limit) params.set('limit', String(limit));
        return this.json(`/api/symbols?${params}`);
    }

    symbolInfo(symbol: string): Promise<SymbolInfo> {
        return this.json(`/api/symbol?symbol=${encodeURIComponent(symbol)}`);
    }

    async kvGet(key: string): Promise<string | null> {
        const res = await fetch(`${this.base}/api/kv/${encodeURIComponent(key)}?optional`);
        return res.status === 200 ? res.text() : null;
    }

    kvSet(key: string, value: string): void {
        // keepalive lets the last save finish while the tab is closing
        void fetch(`${this.base}/api/kv/${encodeURIComponent(key)}`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: value,
            keepalive: value.length < 60_000,
        }).catch(() => {});
    }

    // ── WebSocket ───────────────────────────────────────────────────────────

    private setStatus(status: ConnectionStatus): void {
        if (this.status === status) return;
        this.status = status;
        this.events.emit('status', status);
    }

    private connect(): void {
        if (this.closed) return;
        this.setStatus('connecting');
        const origin = this.base ? new URL(this.base) : location;
        const url = `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}/ws`;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;
        ws.onopen = () => {
            this.attempts = 0;
            this.setStatus('open');
            if (this.topics.size) this.send({ op: 'listen', topics: [...this.topics.keys()] });
            for (const [id, sub] of this.subs) {
                this.send({ op: 'sub', id, symbol: sub.symbol, tf: sub.tf });
                if (this.everOpen && sub.lastTime > 0) void this.heal(sub);
            }
            this.everOpen = true;
            this.ping();
            this.pingTimer = setInterval(() => this.ping(), 5_000);
        };
        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') this.onControl(JSON.parse(ev.data) as ServerMessage);
            else this.onFrame(ev.data as ArrayBuffer);
        };
        const lost = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            if (this.pingTimer) clearInterval(this.pingTimer);
            this.setStatus('closed');
            if (this.closed) return;
            const delay = Math.min(5_000, 200 * 2 ** Math.min(5, this.attempts++));
            this.retryTimer = setTimeout(() => this.connect(), delay);
        };
        ws.onclose = lost;
        ws.onerror = () => ws.close();
    }

    private send(msg: ClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    private ping(): void {
        this.send({ op: 'ping', t: performance.now() });
    }

    private onControl(msg: ServerMessage): void {
        if (msg.op === 'pong') {
            this.rttMs = performance.now() - msg.t;
            this.events.emit('rtt', this.rttMs);
        } else if (msg.op === 'event') {
            const handlers = this.topics.get(msg.topic);
            if (handlers) for (const h of [...handlers]) h(msg.data);
        } else if (msg.op === 'error') {
            console.warn('[server]', msg.message, msg.id ?? '');
        }
    }

    private onFrame(buf: ArrayBuffer): void {
        const frame = decodeBarFrame(buf);
        const sub = this.subs.get(frame.subId);
        if (!sub) return;
        if (sub.healing) {
            sub.healing.push(frame.bar);
            return;
        }
        this.deliver(sub, frame.bar);
        this.sample(frame.sentAt);
    }

    private deliver(sub: Sub, bar: Bar): void {
        if (bar.time < sub.lastTime) return;
        sub.lastTime = bar.time;
        sub.onBar(bar);
    }

    /** After a reconnect: fetch what was missed over HTTP and replay it before resuming live frames. */
    private async heal(sub: Sub): Promise<void> {
        sub.healing = [];
        try {
            const missed = await this.bars(sub.symbol, sub.tf, { from: sub.lastTime });
            for (const bar of missed.toBars()) this.deliver(sub, bar);
        } catch (err) {
            console.warn('[client] gap repair failed', err);
        } finally {
            const queued = sub.healing ?? [];
            sub.healing = null;
            for (const bar of queued) this.deliver(sub, bar);
        }
    }

    private sample(sentAt: number): void {
        const now = Date.now();
        this.transit.push(now - sentAt);
        if (this.transit.length > 2000) this.transit.splice(0, 1000);
        this.pendingPixel.push(sentAt);
        if (this.rafQueued) return;
        this.rafQueued = true;
        requestAnimationFrame(() => {
            this.rafQueued = false;
            const painted = Date.now();
            for (const sent of this.pendingPixel) this.pixel.push(painted - sent);
            this.pendingPixel.length = 0;
            if (this.pixel.length > 2000) this.pixel.splice(0, 1000);
        });
    }

    /** Live-update latency over the most recent frames. */
    perf(): PerfSnapshot {
        const t = [...this.transit].sort((a, b) => a - b);
        const p = [...this.pixel].sort((a, b) => a - b);
        return {
            samples: t.length,
            transitP50: quantile(t, 0.5),
            transitP95: quantile(t, 0.95),
            pixelP50: quantile(p, 0.5),
            pixelP95: quantile(p, 0.95),
            rttMs: this.rttMs,
        };
    }

    /** Live bars for a series: repeated updates of the forming bar, then the next bar. */
    subscribe(symbol: string, tf: string, onBar: (bar: Bar) => void): Unsubscribe {
        const id = this.nextId++;
        this.subs.set(id, { symbol, tf, onBar, lastTime: 0, healing: null });
        this.send({ op: 'sub', id, symbol, tf });
        return () => {
            if (!this.subs.delete(id)) return;
            this.send({ op: 'unsub', id });
        };
    }

    /** Application events pushed by the server (alerts, orders, strategy state). */
    listen<T = any>(topic: string, handler: (data: T) => void): Unsubscribe {
        let set = this.topics.get(topic);
        if (!set) {
            set = new Set();
            this.topics.set(topic, set);
            this.send({ op: 'listen', topics: [topic] });
        }
        set.add(handler);
        return () => set.delete(handler);
    }

    close(): void {
        this.closed = true;
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.ws?.close();
    }
}
