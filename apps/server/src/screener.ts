import { normalizeTimeframe } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import { ATR, EMA, RSI, SMA } from '@ts/indicators';
import type { ScriptHost } from '@ts/script-engine';

/**
 * The screener: scan a list of symbols, work out a set of measures for each from its recent bars,
 * keep the ones that pass every filter and sort them. A Pine script can add its own columns (the
 * last value of each of its plots): that is the Pine Screener.
 */

export const FIELDS = {
    price: 'Last price',
    changePct: 'Change % (last bar)',
    change5Pct: 'Change % (5 bars)',
    change20Pct: 'Change % (20 bars)',
    volume: 'Volume (last bar)',
    relVolume: 'Relative volume (vs 20-bar average)',
    rsi14: 'RSI (14)',
    sma50DistPct: 'Distance from SMA 50 %',
    sma200DistPct: 'Distance from SMA 200 %',
    emaTrend: 'EMA 9 above EMA 21 (1 = yes)',
    atrPct: 'ATR (14) as % of price',
    highDistPct: 'Distance from the 52-bar high %',
    lowDistPct: 'Distance from the 52-bar low %',
} as const;
export type Field = keyof typeof FIELDS;

export interface Filter {
    /** A built-in field, or `pine:<plot title>`. */
    field: string;
    op: '>' | '<' | '>=' | '<=' | '=' | 'between';
    value: number;
    to?: number;
}

export interface ScreenRequest {
    symbols?: string[];
    /** Every symbol of one provider (and quote currency), when no list is given. */
    provider?: string;
    quote?: string;
    limit?: number;
    timeframe?: string;
    filters?: Filter[];
    sort?: { field: string; desc?: boolean };
    /** Pine source or a saved script id: each plot's last value becomes a `pine:<title>` column. */
    pine?: { source?: string; scriptId?: string };
}

export interface ScreenRow {
    symbol: string;
    values: Record<string, number | null>;
}

export interface ScreenResult {
    columns: { id: string; label: string }[];
    rows: ScreenRow[];
    scanned: number;
    matched: number;
    errors: { symbol: string; error: string }[];
    ms: number;
}

const MAX_SYMBOLS = 300;
const BARS = 260;
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const pct = (a: number, b: number) => (b ? ((a - b) / b) * 100 : null);

/** The built-in measures of one series of bars (oldest first). */
export function measure(bars: {
    close: Float64Array;
    high: Float64Array;
    low: Float64Array;
    open: Float64Array;
    volume: Float64Array;
    length: number;
}): Record<Field, number | null> {
    const n = bars.length;
    const out = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null])) as Record<Field, number | null>;
    if (n === 0) return out;
    const close = bars.close;
    const last = close[n - 1];
    const rsi = new RSI(14);
    const sma50 = new SMA(50);
    const sma200 = new SMA(200);
    const ema9 = new EMA(9);
    const ema21 = new EMA(21);
    const atr = new ATR(14);
    let r = Number.NaN;
    let s50 = Number.NaN;
    let s200 = Number.NaN;
    let e9 = Number.NaN;
    let e21 = Number.NaN;
    let a = Number.NaN;
    for (let i = 0; i < n; i++) {
        r = rsi.push(close[i]);
        s50 = sma50.push(close[i]);
        s200 = sma200.push(close[i]);
        e9 = ema9.push(close[i]);
        e21 = ema21.push(close[i]);
        a = atr.push({
            time: 0,
            open: bars.open[i],
            high: bars.high[i],
            low: bars.low[i],
            close: close[i],
            volume: bars.volume[i],
        });
    }
    const finite = (v: number) => (Number.isFinite(v) ? v : null);
    let avgVol = 0;
    const span = Math.min(20, n - 1);
    for (let i = n - 1 - span; i < n - 1; i++) avgVol += bars.volume[i];
    avgVol = span > 0 ? avgVol / span : 0;
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let i = Math.max(0, n - 52); i < n; i++) {
        hi = Math.max(hi, bars.high[i]);
        lo = Math.min(lo, bars.low[i]);
    }
    out.price = last;
    out.changePct = n > 1 ? pct(last, close[n - 2]) : null;
    out.change5Pct = n > 5 ? pct(last, close[n - 6]) : null;
    out.change20Pct = n > 20 ? pct(last, close[n - 21]) : null;
    out.volume = bars.volume[n - 1];
    out.relVolume = avgVol > 0 ? bars.volume[n - 1] / avgVol : null;
    out.rsi14 = finite(r);
    out.sma50DistPct = Number.isFinite(s50) ? pct(last, s50) : null;
    out.sma200DistPct = Number.isFinite(s200) ? pct(last, s200) : null;
    out.emaTrend = Number.isFinite(e9) && Number.isFinite(e21) ? (e9 > e21 ? 1 : 0) : null;
    out.atrPct = Number.isFinite(a) && last ? (a / last) * 100 : null;
    out.highDistPct = Number.isFinite(hi) ? pct(last, hi) : null;
    out.lowDistPct = Number.isFinite(lo) ? pct(last, lo) : null;
    return out;
}

export function passes(values: Record<string, number | null>, filters: Filter[]): boolean {
    for (const f of filters) {
        const v = values[f.field];
        if (v === null || v === undefined || !Number.isFinite(v)) return false;
        switch (f.op) {
            case '>':
                if (!(v > f.value)) return false;
                break;
            case '<':
                if (!(v < f.value)) return false;
                break;
            case '>=':
                if (!(v >= f.value)) return false;
                break;
            case '<=':
                if (!(v <= f.value)) return false;
                break;
            case '=':
                if (Math.abs(v - f.value) > 1e-9) return false;
                break;
            case 'between':
                if (!(v >= Math.min(f.value, f.to ?? f.value) && v <= Math.max(f.value, f.to ?? f.value))) return false;
                break;
            default:
                return false;
        }
    }
    return true;
}

export class Screener {
    private data: MarketDataService;
    private host: ScriptHost;
    private scriptSource: (id: string) => string | undefined;

    constructor(deps: { data: MarketDataService; host: ScriptHost; scriptSource(id: string): string | undefined }) {
        this.data = deps.data;
        this.host = deps.host;
        this.scriptSource = deps.scriptSource;
    }

    async run(req: ScreenRequest): Promise<ScreenResult> {
        const started = performance.now();
        let timeframe: string;
        try {
            timeframe = normalizeTimeframe(String(req.timeframe ?? '1D'));
        } catch {
            throw fail(`Invalid timeframe "${req.timeframe}"`);
        }
        const symbols = this.universe(req);
        const filters = (req.filters ?? []).map((f) => ({
            ...f,
            value: Number(f.value),
            to: f.to === undefined ? undefined : Number(f.to),
        }));
        for (const f of filters) {
            if (!['>', '<', '>=', '<=', '=', 'between'].includes(f.op)) throw fail(`unknown comparison "${f.op}"`);
            if (!Number.isFinite(f.value)) throw fail(`the filter on ${f.field} needs a number`);
            if (!(f.field in FIELDS) && !f.field.startsWith('pine:')) throw fail(`unknown field "${f.field}"`);
        }
        const pine = req.pine?.source ?? (req.pine?.scriptId ? this.scriptSource(req.pine.scriptId) : undefined);
        if (req.pine && !pine?.trim()) throw fail('the Pine column script was not found', 404);

        const rows: ScreenRow[] = [];
        const errors: { symbol: string; error: string }[] = [];
        const pineColumns = new Set<string>();
        // A few at a time: a scan must not crowd out the charts' own requests.
        let next = 0;
        const worker = async () => {
            while (next < symbols.length) {
                const symbol = symbols[next++];
                try {
                    const bars = await this.data.getBars(symbol, timeframe, { limit: BARS });
                    const values: Record<string, number | null> = measure(bars);
                    if (pine) {
                        const run = await this.host.run(pine, symbol, timeframe, { bars: BARS });
                        for (const [title, series] of Object.entries(run.plots)) {
                            pineColumns.add(title);
                            values[`pine:${title}`] = series.length ? series[series.length - 1] : null;
                        }
                    }
                    rows.push({ symbol, values });
                } catch (err: any) {
                    errors.push({ symbol, error: String(err?.message ?? err).slice(0, 200) });
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(6, symbols.length) }, worker));

        const matched = rows.filter((r) => passes(r.values, filters));
        const sortField = req.sort?.field ?? 'changePct';
        const dir = req.sort?.desc === false ? 1 : -1;
        matched.sort((a, b) => {
            const x = a.values[sortField];
            const y = b.values[sortField];
            if (x === null || x === undefined) return 1;
            if (y === null || y === undefined) return -1;
            return (x - y) * dir;
        });
        return {
            columns: [
                ...Object.entries(FIELDS).map(([id, label]) => ({ id, label })),
                ...[...pineColumns].map((t) => ({ id: `pine:${t}`, label: t })),
            ],
            rows: matched,
            scanned: symbols.length,
            matched: matched.length,
            errors,
            ms: performance.now() - started,
        };
    }

    private universe(req: ScreenRequest): string[] {
        let list: string[];
        if (Array.isArray(req.symbols) && req.symbols.length) list = req.symbols.map(String);
        else if (req.provider) {
            const provider = String(req.provider).toUpperCase();
            const quote = req.quote ? String(req.quote).toUpperCase() : undefined;
            list = this.data
                .listSymbols()
                .filter((s) => s.provider === provider && (!quote || s.currency === quote))
                .map((s) => s.symbol);
        } else throw fail('give a list of symbols or a provider to scan');
        const limit = Math.min(MAX_SYMBOLS, Math.max(1, Math.round(req.limit ?? 100)));
        return [...new Set(list)].slice(0, limit);
    }
}
