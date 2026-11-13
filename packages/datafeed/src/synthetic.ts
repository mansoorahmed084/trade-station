import { type Bar, barOpenTime, type SymbolInfo, seededRandom, type Tick, type Unsubscribe } from '@ts/core';
import type { BarQuery, MarketDataAdapter } from './types.ts';

const MIN = 60_000;

interface Spec {
    ticker: string;
    description: string;
    seed: number;
    start: number;
    /** Per-bar volatility as a fraction of price. */
    vol: number;
    /** Per-bar drift as a fraction of price. */
    drift: number;
    tickSize: number;
}

const SPECS: Spec[] = [
    {
        ticker: 'ALPHA',
        description: 'Synthetic random walk',
        seed: 1,
        start: 100,
        vol: 0.0012,
        drift: 0,
        tickSize: 0.01,
    },
    {
        ticker: 'BETA',
        description: 'Synthetic uptrend',
        seed: 2,
        start: 50,
        vol: 0.0009,
        drift: 0.000001,
        tickSize: 0.01,
    },
    {
        ticker: 'GAMMA',
        description: 'Synthetic high volatility',
        seed: 3,
        start: 2000,
        vol: 0.004,
        drift: 0,
        tickSize: 0.1,
    },
];

/**
 * Deterministic market for tests, benchmarks and offline development.
 * Every 1-minute bar is a pure function of its index, and the live stream walks each forming bar
 * along a fixed path that ends exactly on that bar — so live data and history always agree.
 */
export class SyntheticAdapter implements MarketDataAdapter {
    readonly name = 'SYNTH';
    readonly nativeTimeframes = ['1'] as const;
    /** First bar open. Fixed so history is identical across runs. */
    readonly genesis: number;
    private now: () => number;
    private tickMs: number;
    private series = new Map<string, { spec: Spec; rnd: () => number; bars: Bar[]; price: number }>();
    private timers = new Set<ReturnType<typeof setInterval>>();

    constructor(opts: { genesis?: number; now?: () => number; tickMs?: number } = {}) {
        this.genesis = opts.genesis ?? Date.UTC(2025, 0, 1);
        this.now = opts.now ?? Date.now;
        this.tickMs = opts.tickMs ?? 250;
    }

    async listSymbols(): Promise<SymbolInfo[]> {
        return SPECS.map((s) => ({
            symbol: `SYNTH:${s.ticker}`,
            provider: 'SYNTH',
            ticker: s.ticker,
            description: s.description,
            type: 'synthetic',
            tickSize: s.tickSize,
            lotSize: 0.001,
            minQty: 0.001,
            currency: 'USD',
            baseCurrency: s.ticker,
            timezone: 'Etc/UTC',
            session: '24x7',
        }));
    }

    async firstBarTime(): Promise<number> {
        return this.genesis;
    }

    private state(ticker: string) {
        let st = this.series.get(ticker);
        if (!st) {
            const spec = SPECS.find((s) => s.ticker === ticker);
            if (!spec) throw new Error(`SYNTH: unknown ticker ${ticker}`);
            st = { spec, rnd: seededRandom(spec.seed), bars: [], price: spec.start };
            this.series.set(ticker, st);
        }
        return st;
    }

    /** The final (closed) form of the 1-minute bar at `index`, generating up to it on demand. */
    private barAt(ticker: string, index: number): Bar {
        const st = this.state(ticker);
        const { spec, rnd } = st;
        const round = (p: number) => Number((Math.round(p / spec.tickSize) * spec.tickSize).toFixed(8));
        while (st.bars.length <= index) {
            const i = st.bars.length;
            const open = st.price;
            const close = round(Math.max(spec.tickSize, open * (1 + spec.drift + (rnd() - 0.5) * 2 * spec.vol)));
            const high = round(Math.max(open, close) * (1 + rnd() * spec.vol * 0.5));
            const low = round(Math.max(spec.tickSize, Math.min(open, close) * (1 - rnd() * spec.vol * 0.5)));
            st.bars.push({ time: this.genesis + i * MIN, open, high, low, close, volume: Math.round(10 + rnd() * 90) });
            st.price = close;
        }
        return st.bars[index];
    }

    /** The bar as it looks part-way through its minute. `fraction` in [0, 1). */
    private forming(final: Bar, fraction: number, tickSize: number): Bar {
        // Path: open → nearer extreme → farther extreme → close (the usual intrabar assumption).
        const upFirst = final.high - final.open <= final.open - final.low;
        const pts = upFirst
            ? [final.open, final.high, final.low, final.close]
            : [final.open, final.low, final.high, final.close];
        const legs = [Math.abs(pts[1] - pts[0]), Math.abs(pts[2] - pts[1]), Math.abs(pts[3] - pts[2])];
        const total = legs[0] + legs[1] + legs[2] || 1;
        let dist = fraction * total;
        let price = pts[0];
        let high = pts[0];
        let low = pts[0];
        for (let k = 0; k < 3; k++) {
            const step = Math.min(dist, legs[k]);
            price = pts[k] + Math.sign(pts[k + 1] - pts[k]) * step;
            high = Math.max(high, price);
            low = Math.min(low, price);
            dist -= step;
            if (dist <= 0) break;
        }
        const snap = (p: number) => Number((Math.round(p / tickSize) * tickSize).toFixed(8));
        return {
            time: final.time,
            open: final.open,
            high: snap(high),
            low: snap(low),
            close: snap(price),
            volume: Math.round(final.volume * fraction),
        };
    }

    private snapshot(ticker: string, at: number): Bar | null {
        if (at < this.genesis) return null;
        const index = Math.floor((at - this.genesis) / MIN);
        const final = this.barAt(ticker, index);
        return this.forming(final, (at - final.time) / MIN, this.state(ticker).spec.tickSize);
    }

    async getBars(ticker: string, timeframe: string, query: BarQuery): Promise<Bar[]> {
        if (timeframe !== '1') throw new Error(`SYNTH serves only 1-minute bars natively (asked for ${timeframe})`);
        const now = this.now();
        const to = Math.min(query.to ?? now, now);
        if (to < this.genesis) return [];
        const lastIndex = Math.floor((to - this.genesis) / MIN);
        const fromIndex = Math.max(0, query.from === undefined ? 0 : Math.ceil((query.from - this.genesis) / MIN));
        const first = query.limit ? Math.max(fromIndex, lastIndex - query.limit + 1) : fromIndex;
        const out: Bar[] = [];
        for (let i = first; i <= lastIndex; i++) {
            const final = this.barAt(ticker, i);
            const formingNow = barOpenTime(now, '1') === final.time;
            out.push(
                formingNow
                    ? this.forming(final, (now - final.time) / MIN, this.state(ticker).spec.tickSize)
                    : { ...final },
            );
        }
        return out;
    }

    subscribeBars(ticker: string, timeframe: string, onBar: (bar: Bar, eventTime: number) => void): Unsubscribe {
        if (timeframe !== '1') throw new Error('SYNTH streams only 1-minute bars');
        let lastOpen = -1;
        const timer = setInterval(() => {
            const now = this.now();
            const open = barOpenTime(now, '1');
            // Close out the previous bar exactly before the first tick of the next one.
            if (lastOpen >= 0 && open > lastOpen) {
                onBar({ ...this.barAt(ticker, Math.floor((lastOpen - this.genesis) / MIN)) }, now);
            }
            const snap = this.snapshot(ticker, now);
            if (snap) onBar(snap, now);
            lastOpen = open;
        }, this.tickMs);
        this.timers.add(timer);
        return () => {
            clearInterval(timer);
            this.timers.delete(timer);
        };
    }

    subscribeTrades(ticker: string, onTick: (tick: Tick) => void): Unsubscribe {
        let last = Number.NaN;
        const timer = setInterval(() => {
            const now = this.now();
            const snap = this.snapshot(ticker, now);
            if (!snap || snap.close === last) return;
            onTick({ time: now, price: snap.close, size: 1, side: snap.close > last ? 'buy' : 'sell' });
            last = snap.close;
        }, this.tickMs);
        this.timers.add(timer);
        return () => {
            clearInterval(timer);
            this.timers.delete(timer);
        };
    }

    close(): void {
        for (const t of this.timers) clearInterval(t);
        this.timers.clear();
    }
}
