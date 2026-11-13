import {
    averageTrueRange,
    type Bar,
    BarSeries,
    barOpenTime,
    type ChartTransform,
    createTransform,
    normalizeTimeframe,
    type ParsedTransform,
    parseTransform,
    roundToTick,
    type SymbolInfo,
    splitSymbol,
    toTransformSpec,
    type Unsubscribe,
} from '@ts/core';
import type { BarListener, MarketDataService } from './service.ts';
import type { BarQuery } from './types.ts';

/**
 * Series that no venue serves directly but are computed from ones that are:
 *  - price-driven chart types, named by a suffix on the symbol (`BINANCE:BTCUSDT.RENKOXATR14`);
 *  - spreads and formulas under the `SPREAD:` prefix (`SPREAD:BINANCE:ETHUSDT/BINANCE:BTCUSDT`).
 * Both answer the same two calls as any other series, so charts, scripts and alerts treat them alike.
 */
export interface VirtualSeries {
    describe(): Promise<SymbolInfo>;
    getBars(timeframe: string, query: BarQuery): Promise<BarSeries>;
    subscribe(timeframe: string, listener: BarListener): Unsubscribe;
}

/** Source bars a chart-type series is built from. Its first output bar depends on where this window starts. */
const SOURCE_BARS = 20_000;
const MAX_CACHED = 24;

function window(series: BarSeries, query: BarQuery): BarSeries {
    let out = series;
    if (query.from !== undefined || query.to !== undefined) {
        const a = query.from !== undefined ? out.lowerBound(query.from) : 0;
        const b = query.to !== undefined ? out.lowerBound(query.to + 1) : out.length;
        out = out.slice(a, b);
    }
    if (query.limit !== undefined && out.length > query.limit) out = out.slice(out.length - query.limit);
    return out === series ? series.slice() : out;
}

// ── Chart-type series ───────────────────────────────────────────────────────

class DerivedSeries {
    private svc: MarketDataService;
    private base: SymbolInfo;
    private tf: string;
    private parsed: ParsedTransform;
    private suffix: string;
    private transform: ChartTransform | null = null;
    private out = new BarSeries();
    /** Open time of the newest source bar already pushed through the transform. */
    private lastSource = Number.NEGATIVE_INFINITY;
    private building: Promise<void> | null = null;
    private listeners = new Set<BarListener>();
    private stopBase: Unsubscribe | null = null;
    private prevBase: Bar | null = null;
    private lastEmitted = Number.NEGATIVE_INFINITY;
    size = Number.NaN;

    constructor(svc: MarketDataService, base: SymbolInfo, tf: string, parsed: ParsedTransform, suffix: string) {
        this.svc = svc;
        this.base = base;
        this.tf = tf;
        this.parsed = parsed;
        this.suffix = suffix;
    }

    get busy(): boolean {
        return this.listeners.size > 0;
    }

    private split(source: BarSeries): { closed: BarSeries; forming: Bar | null } {
        const boundary = barOpenTime(this.svc.clock(), this.tf);
        const last = source.last();
        if (last && last.time >= boundary) return { closed: source.slice(0, source.length - 1), forming: last };
        return { closed: source, forming: null };
    }

    private ensure(): Promise<void> {
        this.building ??= (async () => {
            const source = await this.svc.getBars(this.base.symbol, this.tf, { limit: SOURCE_BARS });
            const { closed } = this.split(source);
            // Box, reversal or range size: given outright, or the ATR of the loaded history.
            let size = this.parsed.size ?? Number.NaN;
            if (this.parsed.atr !== undefined) size = averageTrueRange(closed, this.parsed.atr);
            if (!(size > 0)) size = this.base.tickSize * 10;
            this.size = Math.max(this.base.tickSize, roundToTick(size, this.base.tickSize));
            this.transform = createTransform(toTransformSpec(this.parsed, this.size));
            for (let i = 0; i < closed.length; i++) this.feed(closed.at(i), false);
        })().catch((err) => {
            this.building = null;
            throw err;
        });
        return this.building;
    }

    /** Push one closed source bar; optionally announce the output bars it completed. */
    private feed(bar: Bar, announce: boolean): void {
        if (bar.time <= this.lastSource) return;
        this.lastSource = bar.time;
        for (const done of this.transform!.push(bar)) {
            this.out.append(done.time, done.open, done.high, done.low, done.close, done.volume);
            if (announce) this.emit(done);
        }
    }

    /** Catch up with source bars that closed since the last look. Returns the forming source bar. */
    private async refresh(announce: boolean): Promise<Bar | null> {
        const from = Number.isFinite(this.lastSource) ? this.lastSource : undefined;
        const source = await this.svc.getBars(this.base.symbol, this.tf, from !== undefined ? { from } : { limit: 2 });
        const { closed, forming } = this.split(source);
        for (let i = 0; i < closed.length; i++) this.feed(closed.at(i), announce);
        return forming;
    }

    private emit(bar: Bar): void {
        const opened = bar.time > this.lastEmitted;
        if (opened) this.lastEmitted = bar.time;
        for (const l of [...this.listeners]) l(bar, opened);
    }

    async describe(): Promise<SymbolInfo> {
        return {
            ...this.base,
            symbol: `${this.base.symbol}.${this.suffix}`,
            ticker: `${this.base.ticker}.${this.suffix}`,
        };
    }

    async getBars(query: BarQuery): Promise<BarSeries> {
        await this.ensure();
        const forming = await this.refresh(this.listeners.size > 0);
        const all = this.out.slice();
        const preview = this.transform!.preview(forming ?? undefined);
        if (preview && (all.length === 0 || preview.time > all.time[all.length - 1])) {
            all.append(preview.time, preview.open, preview.high, preview.low, preview.close, preview.volume);
        }
        return window(all, query);
    }

    subscribe(listener: BarListener): Unsubscribe {
        this.listeners.add(listener);
        if (!this.stopBase) {
            let ready = false;
            const pending: Bar[] = [];
            const onBase = (bar: Bar) => {
                // A newer source bar means the previous one is final: run it through the transform.
                if (this.prevBase && bar.time > this.prevBase.time) this.feed(this.prevBase, true);
                this.prevBase = { ...bar };
                const preview = this.transform!.preview(bar);
                if (preview) this.emit(preview);
            };
            this.stopBase = this.svc.subscribe(this.base.symbol, this.tf, (bar) => {
                if (ready) onBase(bar);
                else pending.push({ ...bar });
            });
            this.ensure()
                .then(() => this.refresh(false))
                .catch(() => {})
                .finally(() => {
                    ready = !!this.transform;
                    if (ready) for (const bar of pending) onBase(bar);
                    pending.length = 0;
                });
        }
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0 && this.stopBase) {
                this.stopBase();
                this.stopBase = null;
                this.prevBase = null;
            }
        };
    }
}

// ── Spreads and formulas ────────────────────────────────────────────────────

type Node =
    | { t: 'num'; v: number }
    | { t: 'sym'; s: string }
    | { t: 'neg'; a: Node }
    | { t: 'op'; op: '+' | '-' | '*' | '/'; a: Node; b: Node };

/** Parse `A/B`, `A-B*2`, `(A+B)/2` … where an operand is a number or a symbol. */
export function parseFormula(text: string): { ast: Node; symbols: string[] } {
    const tokens = text.match(/\s*([()+\-*/]|[A-Za-z0-9_.:!]+)/g)?.map((t) => t.trim()) ?? [];
    if (tokens.join('') !== text.replace(/\s+/g, '')) throw new Error(`Cannot parse formula: ${text}`);
    let i = 0;
    const symbols: string[] = [];
    const factor = (): Node => {
        const tok = tokens[i++];
        if (tok === undefined) throw new Error(`Formula ends unexpectedly: ${text}`);
        if (tok === '(') {
            const inner = expr();
            if (tokens[i++] !== ')') throw new Error(`Missing ")" in formula: ${text}`);
            return inner;
        }
        if (tok === '-') return { t: 'neg', a: factor() };
        if (/^\d+(\.\d+)?$/.test(tok)) return { t: 'num', v: Number(tok) };
        if (/^[A-Za-z0-9_.:!]+$/.test(tok) && /[A-Za-z]/.test(tok)) {
            if (!symbols.includes(tok)) symbols.push(tok);
            return { t: 'sym', s: tok };
        }
        throw new Error(`Unexpected "${tok}" in formula: ${text}`);
    };
    const term = (): Node => {
        let node = factor();
        while (tokens[i] === '*' || tokens[i] === '/')
            node = { t: 'op', op: tokens[i++] as '*' | '/', a: node, b: factor() };
        return node;
    };
    const expr = (): Node => {
        let node = term();
        while (tokens[i] === '+' || tokens[i] === '-')
            node = { t: 'op', op: tokens[i++] as '+' | '-', a: node, b: term() };
        return node;
    };
    const ast = expr();
    if (i !== tokens.length) throw new Error(`Unexpected "${tokens[i]}" in formula: ${text}`);
    if (symbols.length === 0) throw new Error('A formula needs at least one symbol');
    if (symbols.length > 6) throw new Error('A formula can use at most 6 symbols');
    return { ast, symbols };
}

function evaluate(node: Node, value: (symbol: string) => number): number {
    switch (node.t) {
        case 'num':
            return node.v;
        case 'sym':
            return value(node.s);
        case 'neg':
            return -evaluate(node.a, value);
        case 'op': {
            const a = evaluate(node.a, value);
            const b = evaluate(node.b, value);
            return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b;
        }
    }
}

class SpreadSeries {
    private svc: MarketDataService;
    private text: string;
    private ast: Node;
    private symbols: string[];

    constructor(svc: MarketDataService, text: string) {
        this.svc = svc;
        this.text = text;
        const parsed = parseFormula(text);
        this.ast = parsed.ast;
        this.symbols = parsed.symbols;
        for (const s of this.symbols) svc.resolve(s); // fail early on an unknown operand
    }

    /**
     * One output bar from the operands' bars at the same time. Open and close are exact; high and
     * low are the envelope of the formula applied to each corner, an approximation, since the
     * operands' intrabar extremes need not coincide.
     */
    private combine(time: number, bars: Map<string, Bar>): Bar | null {
        const at = (field: 'open' | 'high' | 'low' | 'close') => evaluate(this.ast, (s) => bars.get(s)![field]);
        const open = at('open');
        const close = at('close');
        const a = at('high');
        const b = at('low');
        if (![open, close, a, b].every(Number.isFinite)) return null;
        return { time, open, close, high: Math.max(open, close, a, b), low: Math.min(open, close, a, b), volume: 0 };
    }

    async describe(): Promise<SymbolInfo> {
        // Size the price grid to the formula's magnitude: 6 significant digits.
        let tickSize = 0.01;
        try {
            const last = (await this.getBars('1D', { limit: 1 })).last();
            const magnitude = last ? Math.floor(Math.log10(Math.abs(last.close) || 1)) : 0;
            tickSize = 10 ** Math.min(0, Math.max(-10, magnitude - 5));
        } catch {}
        return {
            symbol: `SPREAD:${this.text}`,
            provider: 'SPREAD',
            ticker: this.text,
            description: `Formula: ${this.text}`,
            type: 'index',
            tickSize,
            lotSize: 1,
            minQty: 1,
            currency: '',
            timezone: 'Etc/UTC',
            session: '24x7',
        };
    }

    async getBars(timeframe: string, query: BarQuery): Promise<BarSeries> {
        // Operands may have bars the others lack, so ask for a little more than the window needs.
        const padded: BarQuery = query.limit !== undefined ? { ...query, limit: query.limit + 50 } : query;
        const series = await Promise.all(this.symbols.map((s) => this.svc.getBars(s, timeframe, padded)));
        const out = new BarSeries(series[0].length);
        const bars = new Map<string, Bar>();
        for (let i = 0; i < series[0].length; i++) {
            const time = series[0].time[i];
            let complete = true;
            bars.set(this.symbols[0], series[0].at(i));
            for (let k = 1; k < series.length; k++) {
                const j = series[k].indexOf(time);
                if (j < 0) {
                    complete = false;
                    break;
                }
                bars.set(this.symbols[k], series[k].at(j));
            }
            if (!complete) continue;
            const bar = this.combine(time, bars);
            if (bar) out.append(bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume);
        }
        return window(out, query);
    }

    subscribe(timeframe: string, listener: BarListener): Unsubscribe {
        const latest = new Map<string, Bar>();
        let lastTime = Number.NEGATIVE_INFINITY;
        const stops = this.symbols.map((s) =>
            this.svc.subscribe(s, timeframe, (bar) => {
                latest.set(s, bar);
                if (latest.size < this.symbols.length) return;
                // Emit only when every operand is on the same bar.
                for (const other of latest.values()) if (other.time !== bar.time) return;
                const out = this.combine(bar.time, latest);
                if (!out) return;
                const opened = out.time > lastTime;
                lastTime = Math.max(lastTime, out.time);
                listener(out, opened);
            }),
        );
        return () => {
            for (const stop of stops) stop();
        };
    }
}

// ── Lookup ──────────────────────────────────────────────────────────────────

export class VirtualSeriesManager {
    private svc: MarketDataService;
    private derived = new Map<string, DerivedSeries>();
    private spreads = new Map<string, SpreadSeries>();

    constructor(svc: MarketDataService) {
        this.svc = svc;
    }

    /** True when the symbol is spelled like a virtual series (cheap; does not validate it). */
    static looksVirtual(symbol: string): boolean {
        return symbol.includes('.') || /^spread:/i.test(symbol);
    }

    /** The chart-type suffix of a symbol and the plain symbol under it, when it has a valid one. */
    splitTransform(symbol: string): { base: SymbolInfo; parsed: ParsedTransform; suffix: string } | null {
        const dot = symbol.lastIndexOf('.');
        if (dot <= 0) return null;
        const parsed = parseTransform(symbol.slice(dot + 1));
        if (!parsed) return null;
        try {
            return {
                base: this.svc.resolve(symbol.slice(0, dot)).info,
                parsed,
                suffix: symbol.slice(dot + 1).toUpperCase(),
            };
        } catch {
            return null;
        }
    }

    /** The virtual series a symbol names, or null for an ordinary symbol. Throws on a malformed formula. */
    match(symbol: string): VirtualSeries | null {
        if (!VirtualSeriesManager.looksVirtual(symbol)) return null;
        const { provider, ticker } = splitSymbol(symbol);
        if (provider === 'SPREAD') {
            let spread = this.spreads.get(ticker);
            if (!spread) {
                spread = new SpreadSeries(this.svc, ticker);
                this.spreads.set(ticker, spread);
                if (this.spreads.size > MAX_CACHED) this.spreads.delete(this.spreads.keys().next().value!);
            }
            const s = spread;
            return {
                describe: () => s.describe(),
                getBars: (tf, query) => s.getBars(normalizeTimeframe(tf), query),
                subscribe: (tf, listener) => s.subscribe(normalizeTimeframe(tf), listener),
            };
        }
        const split = this.splitTransform(symbol);
        if (!split) return null;
        const series = (timeframe: string): DerivedSeries => {
            const tf = normalizeTimeframe(timeframe);
            const id = `${split.base.symbol}.${split.suffix}@${tf}`;
            let d = this.derived.get(id);
            if (!d) {
                d = new DerivedSeries(this.svc, split.base, tf, split.parsed, split.suffix);
                this.derived.set(id, d);
                if (this.derived.size > MAX_CACHED) {
                    for (const [key, old] of this.derived) {
                        if (!old.busy && old !== d) {
                            this.derived.delete(key);
                            break;
                        }
                    }
                }
            }
            return d;
        };
        return {
            describe: () => series('1D').describe(),
            getBars: (tf, query) => series(tf).getBars(query),
            subscribe: (tf, listener) => series(tf).subscribe(listener),
        };
    }
}
