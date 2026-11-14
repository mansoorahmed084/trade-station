import {
    type BacktestProperties,
    type BacktestRequest,
    type BacktestResult,
    buildReport,
    type InputMeta,
    intrabarLookup,
    magnifierTimeframe,
    type RunSummary,
    resolveInputs,
    runBacktest,
    strategyById,
    summarize,
    type TradeRecord,
} from '@ts/backtest';
import { barCloseTime, timeframeMs } from '@ts/core';
import { type ScriptData, ScriptHost } from '@ts/script-engine';

/** One run, as handed to a worker thread: the window is already fixed and a Pine script is already source. */
export interface RunJob {
    /** Runs of one group share the bars they load. */
    group: string;
    request: BacktestRequest;
    /** The server's clock when the job was made. */
    now: number;
    /** `summary` returns only the numbers a parameter search ranks by. */
    detail: 'full' | 'summary';
}

export type RunOutput = BacktestResult | { summary: RunSummary };

const NATIVE_DEFAULTS: BacktestResult['properties'] = {
    initialCapital: 10_000,
    commission: { type: 'percent', value: 0 },
    slippageTicks: 0,
    qty: { type: 'percent_of_equity', value: 10 },
    pyramiding: 1,
    processOrdersOnClose: false,
};

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** The window of a request as a bar query. */
const windowOf = (r: BacktestRequest) =>
    r.from === undefined ? { limit: r.bars ?? 5000, to: r.to } : { from: r.from, to: r.to };

function pineProps(p: BacktestProperties = {}): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (p.initialCapital !== undefined) out.initial_capital = p.initialCapital;
    if (p.commission) {
        out.commission_type = p.commission.type;
        out.commission_value = p.commission.value;
    }
    if (p.slippageTicks !== undefined) out.slippage = p.slippageTicks;
    if (p.qty) {
        out.default_qty_type = p.qty.type;
        out.default_qty_value = p.qty.value;
    }
    if (p.pyramiding !== undefined) out.pyramiding = p.pyramiding;
    if (p.processOrdersOnClose !== undefined) out.process_orders_on_close = p.processOrdersOnClose;
    return out;
}

/**
 * Run one backtest against a data port. This is the whole engine side of the strategy tester; it
 * runs in a worker thread so that a long run never holds up live data on the main thread.
 */
export async function execute(job: RunJob, data: ScriptData): Promise<RunOutput> {
    const started = performance.now();
    const { request } = job;
    const { symbol, timeframe: tf } = request;
    const info = await data.describe(symbol);
    const periodsPerYear = info.session === '24x7' ? 365 : 252;
    const warnings: string[] = [];
    let trades: TradeRecord[];
    let title: string;
    let inputs: InputMeta[];
    let properties: BacktestResult['properties'];
    let engineMs: number;
    const magnifier: BacktestResult['magnifier'] = { requested: !!request.properties?.barMagnifier, applied: false };

    if (request.strategy.kind === 'native') {
        const strategy = strategyById(request.strategy.id);
        if (!strategy) throw fail(`Unknown strategy "${request.strategy.id}"`, 404);
        const bars = await data.getBars(symbol, tf, windowOf(request));
        const given = request.properties ?? {};
        properties = {
            initialCapital: given.initialCapital ?? NATIVE_DEFAULTS.initialCapital,
            commission: given.commission ?? NATIVE_DEFAULTS.commission,
            slippageTicks: given.slippageTicks ?? NATIVE_DEFAULTS.slippageTicks,
            qty: given.qty ?? NATIVE_DEFAULTS.qty,
            pyramiding: Math.max(1, given.pyramiding ?? NATIVE_DEFAULTS.pyramiding),
            processOrdersOnClose: given.processOrdersOnClose ?? NATIVE_DEFAULTS.processOrdersOnClose,
        };
        let intrabar: ReturnType<typeof intrabarLookup> | undefined;
        if (magnifier.requested && bars.length > 0) {
            const lower = magnifierTimeframe(tf);
            if (!lower) magnifier.note = 'There is no smaller timeframe to read below this one.';
            else {
                const fine = await data.getBars(symbol, lower, {
                    from: bars.time[0],
                    to: barCloseTime(bars.time[bars.length - 1], tf) - 1,
                });
                intrabar = intrabarLookup(fine, tf);
                Object.assign(magnifier, { applied: true, timeframe: lower, bars: fine.length });
            }
        }
        const values = resolveInputs(strategy, request.inputs);
        const t0 = performance.now();
        const run = runBacktest(strategy, bars, {
            broker: {
                initialCapital: properties.initialCapital,
                commission: properties.commission,
                slippageTicks: properties.slippageTicks,
                tickSize: info.tickSize,
            },
            qty: properties.qty,
            lotSize: info.lotSize,
            pyramiding: properties.pyramiding,
            processOrdersOnClose: properties.processOrdersOnClose,
            inputs: values,
            intrabar,
        });
        engineMs = performance.now() - t0;
        trades = run.trades;
        title = strategy.name;
        inputs = strategy.inputs.map((i) => ({ ...i, value: values[i.name] }));
        const report = buildReport(trades, bars, properties.initialCapital, timeframeMs(tf), periodsPerYear);
        if (job.detail === 'summary') return { summary: summarize(report) };
        return {
            engine: 'native',
            title,
            symbol,
            timeframe: tf,
            report,
            inputs,
            properties,
            magnifier,
            warnings,
            engineMs,
            ms: performance.now() - started,
        };
    }

    const source = request.strategy.source;
    if (!source?.trim()) throw fail('the strategy has no source code');
    const host = new ScriptHost(data);
    const window = windowOf(request);
    const run = await host.run(source, symbol, tf, {
        bars: window.limit,
        from: window.from,
        to: window.to,
        inputs: request.inputs,
        props: pineProps(request.properties),
        alertMode: 'all',
    });
    if (!run.strategy) {
        throw fail('This script is an indicator. The tester runs scripts that start with strategy(...).');
    }
    engineMs = run.ms;
    const cfg = run.strategy.properties as Record<string, any>;
    properties = {
        initialCapital: run.strategy.initialCapital,
        commission: { type: cfg.commission_type ?? 'percent', value: cfg.commission_value ?? 0 },
        slippageTicks: cfg.slippage ?? 0,
        qty: { type: cfg.default_qty_type ?? 'fixed', value: cfg.default_qty_value ?? 1 },
        pyramiding: Math.max(1, cfg.pyramiding ?? 1),
        processOrdersOnClose: !!cfg.process_orders_on_close,
    };
    trades = run.strategy.trades.map((t) => ({
        side: t.size >= 0 ? 'long' : 'short',
        qty: Math.abs(t.size),
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        entryId: t.entryId,
        exitTime: t.open ? undefined : t.exitTime,
        exitPrice: t.open ? undefined : t.exitPrice,
        exitId: t.open ? undefined : t.exitId,
        pnl: t.profit ?? 0,
        commission: t.commission ?? 0,
        maxRunup: t.maxRunup,
        maxDrawdown: t.maxDrawdown,
        open: t.open,
    }));
    title = run.title;
    inputs = run.inputs.map((i) => ({
        name: i.title,
        title: i.title,
        type: i.type,
        defval: i.defval,
        value: request.inputs?.[i.title] ?? i.defval,
        min: i.min,
        max: i.max,
        step: i.step,
        options: i.options,
    }));
    if (magnifier.requested) {
        magnifier.note =
            'The Pine runtime fills orders from the chart bar alone. Use a native strategy for magnified fills.';
    }
    const seen = new Set<string>();
    for (const w of run.warnings) {
        if (seen.has(w.message)) continue;
        seen.add(w.message);
        warnings.push(w.message);
    }
    const bars = await data.getBars(symbol, tf, window);
    const report = buildReport(trades, bars, properties.initialCapital, timeframeMs(tf), periodsPerYear);
    if (job.detail === 'summary') return { summary: summarize(report) };
    return {
        engine: 'pine',
        title,
        symbol,
        timeframe: tf,
        report,
        inputs,
        properties,
        magnifier,
        warnings,
        engineMs,
        ms: performance.now() - started,
    };
}
