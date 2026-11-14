import {
    type BacktestProperties,
    type BacktestRequest,
    type BacktestResult,
    expandGrid,
    type JobEvent,
    type JobStatus,
    MAX_BARS,
    type Objective,
    type OptimizeRequest,
    type OptimizeRow,
    type ParamRange,
    type ParamSet,
    type RunSummary,
    rangeValues,
    STRATEGIES,
    type StrategyDescription,
    type StrategyRef,
    sampleGrid,
    score,
    strategyById,
    type WalkForwardFold,
    type WalkForwardRequest,
    type WalkForwardResult,
    walkForwardWindows,
} from '@ts/backtest';
import { barOpenTime, newId, normalizeTimeframe, timeframeMs } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import { describeScript } from '@ts/script-engine';
import type { RunJob, StrategyPosition } from './execute.ts';
import { WorkerPool } from './pool.ts';

const MAX_SOURCE = 400_000;
/** Combinations one search may run. A Pine run costs far more than a native one. */
const MAX_SETS = { native: 5000, pine: 1000 } as const;
const OBJECTIVES: Objective[] = ['netProfit', 'profitFactor', 'sharpe', 'maxDrawdown', 'winRate', 'returnOverDrawdown'];
const DAY = 86_400_000;

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const finite = (v: unknown): number | undefined =>
    v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);

interface Job {
    status: JobStatus;
    rows: OptimizeRow[];
    abort: AbortController;
    lastEvent: number;
}

export interface BacktestDeps {
    data: MarketDataService;
    /** Source of a saved script, by id. */
    scriptSource(id: string): string | undefined;
    publish?(event: JobEvent): void;
    log?(message: string): void;
    /** Worker threads. Default: one fewer than the machine's cores, at most 8. */
    workers?: number;
}

/**
 * The strategy tester's server side: checks a request, fixes its window to closed bars, and hands
 * the run to a worker thread. Parameter searches and walk-forward tests are jobs that report
 * progress while they run.
 */
export class BacktestService {
    readonly pool: WorkerPool;
    private deps: BacktestDeps;
    private jobs = new Map<string, Job>();
    private runs = 0;

    constructor(deps: BacktestDeps) {
        this.deps = deps;
        this.pool = new WorkerPool(deps.data, deps.workers);
    }

    strategies(): (StrategyDescription & { id: string })[] {
        return STRATEGIES.map((s) => ({
            id: s.id,
            engine: 'native',
            title: s.name,
            description: s.description,
            inputs: s.inputs.map((i) => ({ ...i })),
        }));
    }

    /** A strategy's name and inputs without running it. */
    async describe(ref: StrategyRef): Promise<StrategyDescription> {
        const strategy = this.strategy(ref);
        if (strategy.kind === 'native') {
            const s = strategyById(strategy.id)!;
            return {
                engine: 'native',
                title: s.name,
                description: s.description,
                inputs: s.inputs.map((i) => ({ ...i })),
            };
        }
        const d = await describeScript(strategy.source!);
        if (d.kind !== 'strategy') {
            throw fail('This script is an indicator. The tester runs scripts that start with strategy(...).');
        }
        return {
            engine: 'pine',
            title: d.title,
            inputs: d.inputs.map((i) => ({
                name: i.title,
                title: i.title,
                type: i.type,
                defval: i.defval,
                min: i.min,
                max: i.max,
                step: i.step,
                options: i.options,
            })),
        };
    }

    async run(input: BacktestRequest): Promise<BacktestResult> {
        const started = performance.now();
        const request = await this.resolve(input);
        const result = (await this.pool.run(this.job(request, windowKey(request), 'full'))) as BacktestResult;
        result.ms = performance.now() - started;
        this.runs++;
        return result;
    }

    /**
     * Where a strategy stands after the last closed bar: the position it wants to hold. Market
     * orders are taken to fill at the close of the bar that placed them, so a signal on this bar
     * already shows in the answer.
     */
    async position(input: BacktestRequest): Promise<StrategyPosition> {
        const request = await this.resolve({
            ...input,
            properties: { ...input.properties, processOrdersOnClose: true },
        });
        return (await this.pool.run(this.job(request, windowKey(request), 'position'))) as StrategyPosition;
    }

    /** Start a parameter search. Returns at once; follow it with `status` or the `backtest` topic. */
    async optimize(input: OptimizeRequest): Promise<JobStatus> {
        const request = await this.resolve(input);
        const { sets, objective } = await this.search(input, request);
        const job = this.start('optimize', objective, sets.length);
        void this.runSearch(job, request, sets).then(
            () => this.settle(job),
            (err) => this.settle(job, err),
        );
        return this.snapshot(job);
    }

    /** Start a walk-forward test: choose parameters on each in-sample window, measure them on the next. */
    async walkForward(input: WalkForwardRequest): Promise<JobStatus> {
        const request = await this.resolve(input);
        const { sets, objective } = await this.search(input, request);
        const ms = timeframeMs(request.timeframe);
        const to = request.to!;
        const from = request.from ?? to - ((request.bars ?? 5000) - 1) * ms;
        const folds = Math.min(20, Math.max(2, Math.round(finite(input.folds) ?? 4)));
        const windows = walkForwardWindows(from, to, folds, finite(input.inSampleShare) ?? 0.7);
        if ((windows[0].outOfSample[1] - windows[0].outOfSample[0]) / ms < 20) {
            throw fail('each out-of-sample window would hold fewer than 20 bars: use fewer folds or a longer history');
        }
        const job = this.start('walkforward', objective, windows.length * (sets.length + 1));
        void this.runWalkForward(job, request, sets, windows).then(
            () => this.settle(job),
            (err) => this.settle(job, err),
        );
        return this.snapshot(job);
    }

    status(id: string): JobStatus | null {
        const job = this.jobs.get(id);
        return job ? this.snapshot(job) : null;
    }

    cancel(id: string): boolean {
        const job = this.jobs.get(id);
        if (!job) return false;
        if (job.status.state === 'running') {
            job.status.state = 'cancelled';
            job.abort.abort();
        }
        return true;
    }

    stats() {
        return { ...this.pool.stats(), runs: this.runs, jobs: this.jobs.size };
    }

    close(): void {
        for (const job of this.jobs.values()) job.abort.abort();
        this.pool.close();
    }

    // ── Requests ────────────────────────────────────────────────────────────

    private strategy(ref: StrategyRef | undefined): StrategyRef {
        if (ref?.kind === 'native') {
            if (!strategyById(String(ref.id))) throw fail(`Unknown strategy "${ref.id}"`, 404);
            return { kind: 'native', id: String(ref.id) };
        }
        if (ref?.kind === 'pine') {
            const source =
                typeof ref.source === 'string' && ref.source.trim()
                    ? ref.source
                    : ref.scriptId
                      ? this.deps.scriptSource(String(ref.scriptId))
                      : undefined;
            if (!source?.trim()) {
                throw ref.scriptId ? fail('script not found', 404) : fail('a Pine strategy needs source or scriptId');
            }
            if (source.length > MAX_SOURCE) throw fail('the script is too large', 413);
            return { kind: 'pine', source };
        }
        throw fail('strategy is required: { kind: "native", id } or { kind: "pine", source | scriptId }');
    }

    /** Check a request and pin its window to closed bars, so the same request always gives the same answer. */
    private async resolve(input: BacktestRequest): Promise<BacktestRequest> {
        if (!input || typeof input !== 'object') throw fail('a request body is required');
        const symbol = String(input.symbol ?? '').trim();
        if (!symbol) throw fail('symbol is required');
        let timeframe: string;
        try {
            timeframe = normalizeTimeframe(String(input.timeframe ?? ''));
        } catch {
            throw fail(`Invalid timeframe "${input.timeframe ?? ''}"`);
        }
        const strategy = this.strategy(input.strategy);
        const { data } = this.deps;
        await data.describe(symbol);
        const ms = timeframeMs(timeframe);
        const cap = MAX_BARS[strategy.kind];
        const boundary = barOpenTime(data.clock(), timeframe) - 1;
        const to = Math.min(finite(input.to) ?? boundary, boundary);
        let from = finite(input.from);
        let bars: number | undefined;
        if (from !== undefined) {
            from = Math.max(from, await data.firstBarTime(symbol, timeframe));
            if (from > to) throw fail('the window is empty: it starts after it ends');
            const count = Math.ceil((to - from) / ms) + 1;
            if (count > cap) {
                throw fail(
                    `that window is about ${count.toLocaleString('en-US')} bars; a ${strategy.kind} run covers at most ${cap.toLocaleString('en-US')}. Use a larger timeframe or a shorter range.`,
                );
            }
        } else {
            bars = Math.min(cap, Math.max(2, Math.round(finite(input.bars) ?? 5000)));
        }
        return {
            strategy,
            symbol,
            timeframe,
            from,
            to,
            bars,
            inputs: cleanInputs(input.inputs),
            properties: cleanProperties(input.properties),
        };
    }

    /** The parameter sets and objective of a search request. */
    private async search(
        input: OptimizeRequest,
        request: BacktestRequest,
    ): Promise<{ sets: ParamSet[]; objective: Objective }> {
        const objective = OBJECTIVES.includes(input.objective) ? input.objective : 'netProfit';
        const known = new Set((await this.describe(request.strategy)).inputs.map((i) => i.name));
        const ranges: ParamRange[] = [];
        for (const raw of Array.isArray(input.ranges) ? input.ranges : []) {
            const name = String((raw as any)?.name ?? '');
            if (!known.has(name)) throw fail(`the strategy has no input named "${name}"`);
            if ('values' in raw && Array.isArray(raw.values)) {
                if (raw.values.length === 0) throw fail(`"${name}" has no values to try`);
                ranges.push({ name, values: raw.values.slice(0, 1000) });
            } else {
                const r = raw as { from: unknown; to: unknown; step: unknown };
                const lo = finite(r.from);
                const hi = finite(r.to);
                const step = finite(r.step);
                if (lo === undefined || hi === undefined || !step) {
                    throw fail(`"${name}" needs from, to and a step other than zero`);
                }
                if (Math.abs(hi - lo) / Math.abs(step) > 100_000) throw fail(`"${name}" has too many steps`);
                ranges.push({ name, from: lo, to: hi, step });
            }
        }
        if (ranges.length === 0) throw fail('choose at least one input to vary');
        if (ranges.every((r) => rangeValues(r).length < 2) && input.method !== 'random') {
            throw fail('every range holds a single value: there is nothing to compare');
        }
        const cap = MAX_SETS[request.strategy.kind];
        const sets =
            input.method === 'random'
                ? sampleGrid(
                      ranges,
                      Math.min(cap, Math.max(1, Math.round(finite(input.samples) ?? 200))),
                      finite(input.seed) ?? 1,
                  )
                : expandGrid(ranges, cap);
        return { sets, objective };
    }

    private job(request: BacktestRequest, group: string, detail: RunJob['detail']): RunJob {
        return { group, request, now: this.deps.data.clock(), detail };
    }

    // ── Jobs ────────────────────────────────────────────────────────────────

    private start(kind: JobStatus['kind'], objective: Objective, total: number): Job {
        const job: Job = {
            status: {
                id: newId('job'),
                kind,
                state: 'running',
                done: 0,
                total,
                startedAt: Date.now(),
                objective,
                rows: [],
                rowCount: 0,
                rate: 0,
            },
            rows: [],
            abort: new AbortController(),
            lastEvent: 0,
        };
        this.jobs.set(job.status.id, job);
        // Keep the last few finished jobs for the page to read; drop older ones.
        const finished = [...this.jobs.values()].filter((j) => j.status.state !== 'running');
        for (const old of finished.slice(0, Math.max(0, finished.length - 20))) this.jobs.delete(old.status.id);
        return job;
    }

    private snapshot(job: Job): JobStatus {
        const elapsed = ((job.status.finishedAt ?? Date.now()) - job.status.startedAt) / 1000;
        return {
            ...job.status,
            rows: job.rows.slice(0, 200),
            rowCount: job.rows.length,
            rate: elapsed > 0 ? job.status.done / elapsed : 0,
        };
    }

    private progress(job: Job, force = false): void {
        const now = Date.now();
        if (!force && now - job.lastEvent < 100) return;
        job.lastEvent = now;
        this.deps.publish?.({
            type: 'progress',
            id: job.status.id,
            done: job.status.done,
            total: job.status.total,
            best: job.rows[0] ?? null,
        });
    }

    private settle(job: Job, err?: any): void {
        if (job.status.state === 'running') {
            job.status.state = err ? 'failed' : 'done';
            if (err) job.status.error = String(err?.message ?? err);
        }
        job.status.finishedAt = Date.now();
        if (err && job.status.state === 'failed')
            this.deps.log?.(`backtest job ${job.status.id} failed: ${job.status.error}`);
        this.progress(job, true);
        this.deps.publish?.({ type: 'finished', id: job.status.id, state: job.status.state });
    }

    /** Run every set over one window; returns the rows, best first. */
    private async rank(
        job: Job,
        request: BacktestRequest,
        sets: ParamSet[],
        group: string,
        onRow?: (rows: OptimizeRow[]) => void,
    ): Promise<OptimizeRow[]> {
        const rows: OptimizeRow[] = [];
        let firstError: Error | null = null;
        await Promise.all(
            sets.map(async (set) => {
                try {
                    const out = (await this.pool.run(
                        this.job({ ...request, inputs: { ...request.inputs, ...set } }, group, 'summary'),
                        job.abort.signal,
                    )) as { summary: RunSummary };
                    const value = score(out.summary, job.status.objective);
                    insert(
                        rows,
                        { inputs: set, summary: out.summary, score: Number.isFinite(value) ? value : null },
                        value,
                    );
                    onRow?.(rows);
                } catch (err: any) {
                    if (err?.cancelled) return; // not run: it does not count as done
                    firstError ??= err;
                }
                job.status.done++;
                this.progress(job);
            }),
        );
        if (job.abort.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
        if (rows.length === 0 && firstError) throw firstError;
        if (firstError) job.status.error = `some runs failed: ${(firstError as Error).message}`;
        return rows;
    }

    private async runSearch(job: Job, request: BacktestRequest, sets: ParamSet[]): Promise<void> {
        await this.rank(job, request, sets, `job:${job.status.id}`, (rows) => {
            job.rows = rows;
        });
    }

    private async runWalkForward(
        job: Job,
        request: BacktestRequest,
        sets: ParamSet[],
        windows: ReturnType<typeof walkForwardWindows>,
    ): Promise<void> {
        const folds = await Promise.all(
            windows.map(async (w, i): Promise<{ fold: WalkForwardFold; result: BacktestResult }> => {
                // The two windows share a boundary: the in-sample one stops a millisecond short of it.
                const inSample = { ...request, bars: undefined, from: w.inSample[0], to: w.inSample[1] - 1 };
                const rows = await this.rank(job, inSample, sets, `job:${job.status.id}:in${i}`);
                const best = rows[0];
                const outOfSample = {
                    ...request,
                    bars: undefined,
                    from: w.outOfSample[0],
                    to: Math.min(w.outOfSample[1], request.to!),
                    inputs: { ...request.inputs, ...best.inputs },
                };
                const result = (await this.pool.run(
                    this.job(outOfSample, `job:${job.status.id}:out${i}`, 'full'),
                    job.abort.signal,
                )) as BacktestResult;
                job.status.done++;
                this.progress(job);
                const r = result.report;
                return {
                    result,
                    fold: {
                        inSample: [inSample.from, inSample.to],
                        outOfSample: [outOfSample.from, outOfSample.to],
                        best: best.inputs,
                        inSampleSummary: best.summary,
                        outOfSampleSummary: {
                            netProfit: r.netProfit,
                            netProfitPct: r.netProfitPct,
                            maxDrawdownPct: r.maxDrawdownPct,
                            profitFactor: r.all.profitFactor,
                            sharpe: r.sharpe,
                            winRatePct: r.all.winRatePct,
                            trades: r.all.trades,
                        },
                    },
                };
            }),
        );
        job.status.walkForward = stitch(folds);
    }
}

/** Insert a row keeping the list ordered best first. Rows that cannot be ranked go last. */
function insert(rows: OptimizeRow[], row: OptimizeRow, value: number): void {
    const rank = (v: number | null, raw?: number) =>
        raw !== undefined ? (Number.isNaN(raw) ? Number.NEGATIVE_INFINITY : raw) : (v ?? Number.NEGATIVE_INFINITY);
    const mine = rank(null, value);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        // A row whose score was infinite is stored as null: keep whatever order it was inserted in.
        if (rank(rows[mid].score) >= mine) lo = mid + 1;
        else hi = mid;
    }
    rows.splice(lo, 0, row);
}

/** Join the out-of-sample folds into one result. */
function stitch(folds: { fold: WalkForwardFold; result: BacktestResult }[]): WalkForwardResult {
    const initial = folds[0]?.result.report.initialCapital ?? 0;
    const equity = { time: [] as number[], value: [] as number[] };
    let base = initial;
    let peak = initial;
    let maxDrawdownPct = 0;
    let trades = 0;
    let inRate = 0;
    let outRate = 0;
    for (const { fold, result } of folds) {
        const r = result.report;
        for (let i = 0; i < r.equity.time.length; i++) {
            const value = base + (r.equity.value[i] - r.initialCapital);
            equity.time.push(r.equity.time[i]);
            equity.value.push(value);
            if (value > peak) peak = value;
            if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((value - peak) / peak) * 100);
        }
        base += r.netProfit;
        trades += r.all.trades;
        const days = (span: [number, number]) => Math.max(1, (span[1] - span[0]) / DAY);
        inRate += fold.inSampleSummary.netProfitPct / days(fold.inSample);
        outRate += fold.outOfSampleSummary.netProfitPct / days(fold.outOfSample);
    }
    return {
        folds: folds.map((f) => f.fold),
        outOfSample: {
            netProfit: base - initial,
            netProfitPct: initial > 0 ? (base / initial - 1) * 100 : 0,
            trades,
            maxDrawdownPct,
        },
        efficiency: inRate > 0 ? outRate / inRate : null,
        equity,
    };
}

/** Runs over the same bars share a group, so a thread that has them loaded does not ask again. */
const windowKey = (r: BacktestRequest) =>
    `run:${r.symbol}|${r.timeframe}|${r.from ?? ''}|${r.to ?? ''}|${r.bars ?? ''}`;

function cleanInputs(inputs: unknown): Record<string, number | boolean | string> {
    const out: Record<string, number | boolean | string> = {};
    if (!inputs || typeof inputs !== 'object') return out;
    for (const [key, value] of Object.entries(inputs as Record<string, unknown>).slice(0, 200)) {
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') out[key] = value;
    }
    return out;
}

function cleanProperties(p: BacktestProperties | undefined): BacktestProperties {
    const out: BacktestProperties = {};
    if (!p || typeof p !== 'object') return out;
    const capital = finite(p.initialCapital);
    if (capital !== undefined) {
        if (!(capital > 0)) throw fail('initial capital must be above zero');
        out.initialCapital = capital;
    }
    if (p.commission) {
        const value = finite(p.commission.value);
        if (
            !['percent', 'cash_per_order', 'cash_per_contract'].includes(p.commission.type) ||
            value === undefined ||
            value < 0
        ) {
            throw fail(
                'commission needs a type (percent, cash_per_order, cash_per_contract) and a value of zero or more',
            );
        }
        out.commission = { type: p.commission.type, value };
    }
    const slippage = finite(p.slippageTicks);
    if (slippage !== undefined) {
        if (slippage < 0) throw fail('slippage cannot be negative');
        out.slippageTicks = Math.round(slippage);
    }
    if (p.qty) {
        const value = finite(p.qty.value);
        if (!['fixed', 'cash', 'percent_of_equity'].includes(p.qty.type) || value === undefined || !(value > 0)) {
            throw fail('order size needs a type (fixed, cash, percent_of_equity) and a value above zero');
        }
        out.qty = { type: p.qty.type, value };
    }
    const pyramiding = finite(p.pyramiding);
    if (pyramiding !== undefined) out.pyramiding = Math.min(100, Math.max(1, Math.round(pyramiding)));
    if (typeof p.processOrdersOnClose === 'boolean') out.processOrdersOnClose = p.processOrdersOnClose;
    if (typeof p.barMagnifier === 'boolean') out.barMagnifier = p.barMagnifier;
    return out;
}
