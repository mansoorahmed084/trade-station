/**
 * Parameter search helpers. They only build and rank parameter sets: the caller decides how each
 * set is run (in-process, or across worker threads).
 */

export type ParamRange =
    | { name: string; from: number; to: number; step: number }
    | { name: string; values: (number | boolean | string)[] };

export type ParamSet = Record<string, number | boolean | string>;

export function rangeValues(range: ParamRange): (number | boolean | string)[] {
    if ('values' in range) return range.values;
    const out: number[] = [];
    const step = Math.abs(range.step) || 1;
    const lo = Math.min(range.from, range.to);
    const hi = Math.max(range.from, range.to);
    // Count steps instead of accumulating, so 0.1 steps do not drift.
    const count = Math.floor((hi - lo) / step + 1e-9);
    for (let i = 0; i <= count; i++) out.push(Number((lo + i * step).toPrecision(12)));
    return out;
}

/** How many sets a full grid would hold. */
export function gridSize(ranges: ParamRange[]): number {
    return ranges.reduce((n, r) => n * Math.max(1, rangeValues(r).length), 1);
}

/** Every combination of the ranges. Throws when that is more than `cap`. */
export function expandGrid(ranges: ParamRange[], cap = 5000): ParamSet[] {
    const size = gridSize(ranges);
    if (size > cap)
        throw Object.assign(
            new Error(
                `the grid has ${size} combinations; the limit is ${cap}. Narrow the ranges or use a random search.`,
            ),
            { statusCode: 400 },
        );
    let sets: ParamSet[] = [{}];
    for (const range of ranges) {
        const values = rangeValues(range);
        const next: ParamSet[] = [];
        for (const set of sets) for (const v of values) next.push({ ...set, [range.name]: v });
        sets = next;
    }
    return sets;
}

/** `count` distinct combinations drawn at random from the grid (all of it when the grid is smaller). */
export function sampleGrid(ranges: ParamRange[], count: number, seed = 1): ParamSet[] {
    const size = gridSize(ranges);
    if (size <= count) return expandGrid(ranges, Math.max(count, size));
    let a = seed >>> 0;
    const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const values = ranges.map(rangeValues);
    const seen = new Set<string>();
    const out: ParamSet[] = [];
    for (let guard = 0; out.length < count && guard < count * 50; guard++) {
        const set: ParamSet = {};
        ranges.forEach((r, i) => {
            set[r.name] = values[i][Math.floor(rnd() * values[i].length)];
        });
        const key = JSON.stringify(set);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(set);
    }
    return out;
}

export type Objective = 'netProfit' | 'profitFactor' | 'sharpe' | 'maxDrawdown' | 'winRate' | 'returnOverDrawdown';

export interface RunSummary {
    netProfit: number;
    netProfitPct: number;
    maxDrawdownPct: number;
    profitFactor: number | null;
    sharpe: number | null;
    winRatePct: number;
    trades: number;
}

/** The number an objective ranks by; larger is better for every objective. */
export function score(summary: RunSummary, objective: Objective): number {
    switch (objective) {
        case 'netProfit':
            return summary.netProfit;
        case 'profitFactor':
            return summary.trades === 0 ? Number.NEGATIVE_INFINITY : (summary.profitFactor ?? Number.POSITIVE_INFINITY);
        case 'sharpe':
            return summary.sharpe ?? Number.NEGATIVE_INFINITY;
        case 'maxDrawdown':
            // drawdown is ≤ 0: nearer zero is better, but a run that never traded is not a winner
            return summary.trades === 0 ? Number.NEGATIVE_INFINITY : summary.maxDrawdownPct;
        case 'winRate':
            return summary.trades === 0 ? Number.NEGATIVE_INFINITY : summary.winRatePct;
        case 'returnOverDrawdown':
            return summary.maxDrawdownPct < 0
                ? summary.netProfitPct / -summary.maxDrawdownPct
                : summary.netProfitPct > 0
                  ? Number.POSITIVE_INFINITY
                  : Number.NEGATIVE_INFINITY;
    }
}

export interface Window {
    inSample: [from: number, to: number];
    outOfSample: [from: number, to: number];
}

/**
 * Walk-forward windows over `[from, to]`: the range is cut into `folds` equal steps; each fold
 * optimises on the `inSampleShare` of history just before it and is then tested on the fold itself,
 * so no result is ever measured on data its parameters were chosen from.
 */
export function walkForwardWindows(from: number, to: number, folds: number, inSampleShare = 0.7): Window[] {
    const n = Math.max(1, Math.round(folds));
    const share = Math.min(0.95, Math.max(0.05, inSampleShare));
    // total = inSample + n × step, with inSample = share/(1−share) × step
    const step = (to - from) / (n + share / (1 - share));
    const inSample = (step * share) / (1 - share);
    const out: Window[] = [];
    for (let i = 0; i < n; i++) {
        const start = from + i * step;
        out.push({
            inSample: [Math.round(start), Math.round(start + inSample)],
            outOfSample: [Math.round(start + inSample), Math.round(start + inSample + step)],
        });
    }
    return out;
}
