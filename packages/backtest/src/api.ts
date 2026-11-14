import type { Commission } from './broker.ts';
import type { Objective, ParamRange, ParamSet, RunSummary } from './optimize.ts';
import type { Report } from './report.ts';
import type { QtySpec } from './strategy.ts';

/**
 * What the strategy tester asks the server and what it gets back. Types only: the app imports this
 * file, so it must stay free of Node dependencies.
 */

export type StrategyRef =
    /** One of the built-in TypeScript strategies. */
    | { kind: 'native'; id: string }
    /** A Pine strategy: one saved in the library, or source straight from the editor. */
    | { kind: 'pine'; scriptId?: string; source?: string };

/**
 * Account and order settings for a run. For a Pine strategy anything left out keeps the value of
 * the script's own `strategy()` declaration; for a native strategy it takes the default.
 */
export interface BacktestProperties {
    initialCapital?: number;
    commission?: Commission;
    slippageTicks?: number;
    /** Size of each entry. */
    qty?: QtySpec;
    /** Maximum entries in one direction. */
    pyramiding?: number;
    /** Fill market orders at the close of the bar that placed them. */
    processOrdersOnClose?: boolean;
    /** Walk through smaller bars inside each chart bar to decide which order filled first. */
    barMagnifier?: boolean;
}

export interface BacktestRequest {
    strategy: StrategyRef;
    symbol: string;
    timeframe: string;
    /** Window by bar open time. Without `from`, the newest `bars` closed bars up to `to`. */
    from?: number;
    to?: number;
    /** Default 5,000. */
    bars?: number;
    /** Input values: by `name` for a native strategy, by title for a Pine one. */
    inputs?: Record<string, number | boolean | string>;
    properties?: BacktestProperties;
}

export interface InputMeta {
    /** The key to send a value under. */
    name: string;
    title: string;
    type: string;
    defval: unknown;
    /** The value the run used. */
    value?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: unknown[];
}

export interface StrategyDescription {
    engine: 'native' | 'pine';
    title: string;
    description?: string;
    inputs: InputMeta[];
}

export interface BacktestResult {
    engine: 'native' | 'pine';
    title: string;
    symbol: string;
    timeframe: string;
    report: Report;
    inputs: InputMeta[];
    /** The settings the run actually used. */
    properties: Required<Omit<BacktestProperties, 'barMagnifier'>>;
    magnifier: { requested: boolean; applied: boolean; timeframe?: string; bars?: number; note?: string };
    warnings: string[];
    /** Time spent in the engine, without loading bars or building the report. */
    engineMs: number;
    /** Whole request on the server. */
    ms: number;
}

export interface OptimizeRequest extends BacktestRequest {
    ranges: ParamRange[];
    objective: Objective;
    /** `grid` tries every combination; `random` draws `samples` of them. */
    method?: 'grid' | 'random';
    samples?: number;
    seed?: number;
}

export interface WalkForwardRequest extends OptimizeRequest {
    folds: number;
    /** Share of each fold's history used to choose parameters. Default 0.7. */
    inSampleShare?: number;
}

export interface OptimizeRow {
    inputs: ParamSet;
    summary: RunSummary;
    /** What the objective ranks by; `null` when it is not a finite number (no losing trade, say). */
    score: number | null;
}

export interface WalkForwardFold {
    inSample: [from: number, to: number];
    outOfSample: [from: number, to: number];
    /** The parameters that scored best in sample. */
    best: ParamSet;
    inSampleSummary: RunSummary;
    outOfSampleSummary: RunSummary;
}

export interface WalkForwardResult {
    folds: WalkForwardFold[];
    /** The out-of-sample folds joined end to end; each starts from the initial capital and its result is added on. */
    outOfSample: { netProfit: number; netProfitPct: number; trades: number; maxDrawdownPct: number };
    /** Annualised out-of-sample return ÷ annualised in-sample return. `null` when in-sample did not profit. */
    efficiency: number | null;
    equity: { time: number[]; value: number[] };
}

export interface JobStatus {
    id: string;
    kind: 'optimize' | 'walkforward';
    state: 'running' | 'done' | 'cancelled' | 'failed';
    done: number;
    total: number;
    error?: string;
    startedAt: number;
    finishedAt?: number;
    objective: Objective;
    /** Best first. At most 200 are returned; `rowCount` is how many ran. */
    rows: OptimizeRow[];
    rowCount: number;
    walkForward?: WalkForwardResult;
    /** Runs per second so far. */
    rate: number;
}

/** Sent on the `backtest` topic while a job runs. */
export type JobEvent =
    | { type: 'progress'; id: string; done: number; total: number; best: OptimizeRow | null }
    | { type: 'finished'; id: string; state: JobStatus['state'] };

/** Bars a single run may cover. Pine runs at a few microseconds a bar, so its ceiling is lower. */
export const MAX_BARS = { native: 3_000_000, pine: 1_000_000 } as const;
