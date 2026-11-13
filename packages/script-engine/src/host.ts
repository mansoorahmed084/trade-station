import { barCloseTime, barOpenTime, decimalsOf, normalizeTimeframe } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import { Indicator, PineTS } from 'pinets';
import { findUnsupported, readHeader, type UnsupportedReference } from './compat.ts';

export interface RunOptions {
    /** Number of most recent bars to compute over. Default 1,000. */
    bars?: number;
    /** Explicit window by bar open time; overrides `bars` when `from` is given. */
    from?: number;
    to?: number;
    /** Input overrides, keyed by input title. */
    inputs?: Record<string, unknown>;
    /** `all`: `alert()` fires on every bar (for testing and backtests); `realtime`: only on the last bar. */
    alertMode?: 'all' | 'realtime';
    /** Drop the still-forming bar so every value is final. Default false. */
    closedOnly?: boolean;
}

export interface ScriptInput {
    title: string;
    type: string;
    defval: unknown;
    options?: unknown[];
    min?: number;
    max?: number;
    step?: number;
    group?: string;
    tooltip?: string;
}

export interface ScriptAlert {
    time: number;
    message: string;
    title?: string;
    id: string;
}

export interface ScriptTrade {
    entryId: string;
    entryTime: number;
    entryPrice: number;
    exitId?: string;
    exitTime?: number;
    exitPrice?: number;
    /** Signed: positive long, negative short. */
    size: number;
    profit?: number;
    commission?: number;
    maxDrawdown?: number;
    maxRunup?: number;
    open: boolean;
}

export interface StrategyResult {
    initialCapital: number;
    equity: number;
    netProfit: number;
    grossProfit: number;
    grossLoss: number;
    openProfit: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    wins: number;
    losses: number;
    even: number;
    positionSize: number;
    trades: ScriptTrade[];
}

export interface ScriptRun {
    title: string;
    kind: 'indicator' | 'strategy' | null;
    /** Bar open times; every plot array is aligned with it. */
    times: number[];
    /** Plot values by plot title. `null` where the script produced no value. */
    plots: Record<string, (number | null)[]>;
    inputs: ScriptInput[];
    alerts: ScriptAlert[];
    warnings: { message: string; method?: string; bar: number }[];
    strategy?: StrategyResult;
    ms: number;
}

export interface ScriptError {
    stage: 'compile' | 'runtime';
    message: string;
    line?: number;
    column?: number;
}

export interface CompatReport {
    /** The script compiled and ran over the sample without an error. */
    ok: boolean;
    version: number | null;
    kind: 'indicator' | 'strategy' | 'library' | null;
    title: string | null;
    errors: ScriptError[];
    /** Built-ins the script references that the runtime does not have. */
    unsupported: UnsupportedReference[];
    /** Distinct runtime warnings, such as a request the runtime answers with `na`. */
    warnings: { message: string; method?: string }[];
    inputs: number;
    plots: number;
    bars: number;
    ms: number;
}

/** Pull a `line:column` out of a transpiler or runtime error message, when it carries one. */
export function locateError(err: unknown): ScriptError {
    const raw = String((err as any)?.message ?? err);
    const first = raw.split('\n')[0];
    const compile = /transpile|parse|syntax|unexpected token/i.test(raw);
    const at = /\bat (\d+):(\d+)/.exec(raw) ?? /\bline (\d+)(?:[,:]\s*(?:col(?:umn)?\s*)?(\d+))?/i.exec(raw);
    return {
        stage: compile ? 'compile' : 'runtime',
        message: first.replace(/^Failed to transpile Pine Script version \d+:\s*/, ''),
        line: at ? Number(at[1]) : undefined,
        column: at?.[2] ? Number(at[2]) : undefined,
    };
}

/**
 * Runs Pine scripts on the server against the same market data the charts use. This is what lets
 * alerts and strategies keep working with the browser closed, and what the import flow uses to say
 * whether a pasted script will run.
 */
export class ScriptHost {
    private data: MarketDataService;

    constructor(data: MarketDataService) {
        this.data = data;
    }

    /** The data-provider port the Pine runtime calls for the chart series and every `request.security`. */
    provider() {
        const data = this.data;
        return {
            async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number) {
                const tf = normalizeTimeframe(timeframe);
                const series = await data.getBars(tickerId, tf, { limit, from: sDate, to: eDate });
                const out = new Array(series.length);
                for (let i = 0; i < series.length; i++) {
                    out[i] = {
                        openTime: series.time[i],
                        open: series.open[i],
                        high: series.high[i],
                        low: series.low[i],
                        close: series.close[i],
                        volume: series.volume[i],
                        closeTime: barCloseTime(series.time[i], tf) - 1,
                    };
                }
                return out;
            },
            async getSymbolInfo(tickerId: string) {
                const s = await data.describe(tickerId);
                const pricescale = 10 ** decimalsOf(s.tickSize);
                return {
                    ticker: s.ticker,
                    tickerid: s.symbol,
                    prefix: s.provider,
                    root: s.baseCurrency ?? s.ticker,
                    main_tickerid: s.symbol,
                    description: s.description,
                    type: s.type,
                    currency: s.currency,
                    basecurrency: s.baseCurrency ?? '',
                    timezone: s.timezone,
                    session: s.session,
                    mintick: s.tickSize,
                    pricescale,
                    minmove: Math.round(s.tickSize * pricescale),
                    pointvalue: 1,
                    mincontract: s.minQty,
                    volumetype: 'base',
                } as any;
            },
            configure() {},
        };
    }

    /** Compute a script over a symbol and timeframe. Throws a `ScriptError`-shaped error on failure. */
    async run(source: string, symbol: string, timeframe: string, opts: RunOptions = {}): Promise<ScriptRun> {
        const tf = normalizeTimeframe(timeframe);
        const started = performance.now();
        let to = opts.to;
        if (opts.closedOnly) {
            // The forming bar opens at the current boundary: stop one millisecond before it.
            const boundary = barOpenTime(this.data.clock(), tf) - 1;
            to = to === undefined ? boundary : Math.min(to, boundary);
        }
        const limit = opts.from === undefined ? (opts.bars ?? 1000) : undefined;
        const pine = new PineTS(this.provider() as any, symbol, tf, limit, opts.from, to);
        pine.setAlertMode(opts.alertMode ?? 'all');
        const indicator = new Indicator(source, opts.inputs ?? {});
        let ctx: any;
        try {
            ctx = await pine.run(indicator);
        } catch (err) {
            throw Object.assign(new Error(locateError(err).message), locateError(err));
        }

        const klines: { openTime: number }[] = ctx.marketData ?? [];
        const times = klines.map((k) => k.openTime);
        const plots: Record<string, (number | null)[]> = {};
        for (const [name, plot] of Object.entries<any>(ctx.plots ?? {})) {
            const data: any[] = plot?.data ?? [];
            // Only numeric series are returned; shapes, fills and the like are chart-side visuals.
            if (!data.some((d) => typeof d?.value === 'number')) continue;
            const values: (number | null)[] = new Array(times.length).fill(null);
            for (let i = 0; i < data.length && i < values.length; i++) {
                const v = data[i]?.value;
                values[i] = typeof v === 'number' && Number.isFinite(v) ? v : null;
            }
            plots[name] = values;
        }

        let inputs: ScriptInput[] = [];
        try {
            inputs = indicator.getInputsMeta().map((i: any) => ({
                title: i.title ?? i.name ?? i.id,
                type: i.type,
                defval: i.defval,
                options: i.options,
                min: i.minval,
                max: i.maxval,
                step: i.step,
                group: i.group,
                tooltip: i.tooltip,
            }));
        } catch {}

        const header = readHeader(source);
        const result: ScriptRun = {
            title: ctx.strategy?.config?.title ?? header.title ?? 'Script',
            kind: ctx.strategy
                ? 'strategy'
                : (indicator.getDeclarationType() ?? (header.kind === 'library' ? null : header.kind)),
            times,
            plots,
            inputs,
            alerts: (ctx.alerts ?? []).map((a: any) => ({
                time: a.time,
                message: String(a.message ?? ''),
                title: a.title,
                id: String(a.id ?? ''),
            })),
            warnings: (ctx.warnings ?? []).map((w: any) => ({
                message: String(w.message),
                method: w.method,
                bar: w.bar,
            })),
            ms: 0,
        };
        if (ctx.strategy) result.strategy = summarize(ctx.strategy);
        result.ms = performance.now() - started;
        return result;
    }

    /**
     * Would this script run here? Compiles and executes it over a short sample, and lists every
     * built-in it references that the runtime lacks. Never throws.
     */
    async check(source: string, symbol: string, timeframe = '60', bars = 500): Promise<CompatReport> {
        const started = performance.now();
        const header = readHeader(source);
        const report: CompatReport = {
            ok: false,
            version: header.version,
            kind: header.kind,
            title: header.title,
            errors: [],
            unsupported: [],
            warnings: [],
            inputs: 0,
            plots: 0,
            bars: 0,
            ms: 0,
        };
        try {
            report.unsupported = await findUnsupported(source);
        } catch {}
        if (header.kind === 'library') {
            report.errors.push({
                stage: 'compile',
                message: 'This is a library. Import it from a script instead of adding it to a chart.',
            });
        } else {
            try {
                const run = await this.run(source, symbol, timeframe, { bars });
                report.ok = true;
                report.kind = run.kind ?? report.kind;
                report.title = run.title;
                report.inputs = run.inputs.length;
                report.plots = Object.keys(run.plots).length;
                report.bars = run.times.length;
                const seen = new Set<string>();
                for (const w of run.warnings) {
                    if (seen.has(w.message)) continue;
                    seen.add(w.message);
                    report.warnings.push({ message: w.message, method: w.method });
                }
            } catch (err: any) {
                const located = locateError(err);
                report.errors.push({
                    stage: err?.stage ?? located.stage,
                    message: located.message,
                    line: err?.line ?? located.line,
                    column: err?.column ?? located.column,
                });
                // A runtime "x is not a function" on a built-in is the same finding as the static list: name it.
                const missing = /^([a-z_]+\.[A-Za-z0-9_.]+) is not a function/.exec(located.message);
                if (missing && !report.unsupported.some((u) => u.name === missing[1])) {
                    report.unsupported.push({ name: missing[1], line: located.line ?? 0, column: located.column ?? 0 });
                }
            }
        }
        report.ms = performance.now() - started;
        return report;
    }
}

function summarize(s: any): StrategyResult {
    const trade = (t: any, open: boolean): ScriptTrade => ({
        entryId: String(t.entry_id ?? t.id ?? ''),
        entryTime: t.entry_time,
        entryPrice: t.entry_price,
        exitId: t.exit_id,
        exitTime: t.exit_time,
        exitPrice: t.exit_price,
        size: t.size,
        profit: t.profit,
        commission: t.commission,
        maxDrawdown: t.max_drawdown,
        maxRunup: t.max_runup,
        open,
    });
    return {
        initialCapital: s.initial_capital,
        equity: s.equity,
        netProfit: s.netprofit,
        grossProfit: s.grossprofit,
        grossLoss: s.grossloss,
        openProfit: s.openprofit,
        maxDrawdown: s.max_drawdown,
        maxDrawdownPercent: s.max_drawdown_percent_value,
        wins: s.wintrades,
        losses: s.losstrades,
        even: s.eventrades,
        positionSize: s.position_size,
        trades: [
            ...(s.closedtrades ?? []).map((t: any) => trade(t, false)),
            ...(s.opentrades ?? []).map((t: any) => trade(t, true)),
        ],
    };
}
