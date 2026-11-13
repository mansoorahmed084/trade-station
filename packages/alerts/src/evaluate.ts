import type { Bar } from '@ts/core';
import {
    ATR,
    BollingerBands,
    CCI,
    DMI,
    Donchian,
    EMA,
    Highest,
    Lowest,
    MACD,
    OBV,
    RMA,
    ROC,
    RSI,
    SMA,
    StdDev,
    Stochastic,
    Supertrend,
    VWAP,
    VWMA,
    WMA,
} from '@ts/indicators';
import {
    type Comparison,
    type Condition,
    isComparison,
    isScriptAlert,
    type Operand,
    type PriceField,
} from './types.ts';

/**
 * Values computed outside the evaluator and handed in at each evaluation: Pine plots and script
 * alerts, which the server's script host produces.
 */
export interface External {
    plots: ReadonlyMap<string, number>;
    scriptAlerts: ReadonlySet<string>;
}

const NOTHING: External = { plots: new Map(), scriptAlerts: new Set() };
const NA = Number.NaN;

export function priceOf(bar: Bar, field: PriceField = 'close'): number {
    switch (field) {
        case 'open':
            return bar.open;
        case 'high':
            return bar.high;
        case 'low':
            return bar.low;
        case 'volume':
            return bar.volume;
        case 'hl2':
            return (bar.high + bar.low) / 2;
        case 'hlc3':
            return (bar.high + bar.low + bar.close) / 3;
        case 'ohlc4':
            return (bar.open + bar.high + bar.low + bar.close) / 4;
        default:
            return bar.close;
    }
}

const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, val) =>
        val && typeof val === 'object' && !Array.isArray(val)
            ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
            : val,
    );

/** Identity of a script run: the same script with the same inputs is computed once, however many alerts use it. */
export function scriptKey(ref: { scriptId?: string; source?: string; inputs?: Record<string, unknown> }): string {
    return stable({
        id: ref.scriptId ?? null,
        src: ref.scriptId ? null : (ref.source ?? ''),
        inputs: ref.inputs ?? {},
    });
}

export const plotKey = (ref: { scriptId?: string; source?: string; inputs?: Record<string, unknown> }, plot: string) =>
    `${scriptKey(ref)}|plot|${plot}`;
export const scriptAlertKey = (
    ref: { scriptId?: string; source?: string; inputs?: Record<string, unknown> },
    title?: string,
) => `${scriptKey(ref)}|alert|${title ?? '*'}`;

interface Source {
    /** Value for a closed bar; advances any internal state. */
    push(bar: Bar, ext: External): number;
    /** Value for a forming bar; changes nothing. */
    peek(bar: Bar, ext: External): number;
}

function indicatorSource(op: Extract<Operand, { type: 'indicator' }>): Source {
    const p = op.params ?? {};
    const len = (name: string, fallback: number) => Math.max(1, Math.round(p[name] ?? fallback));
    const of = (fallback: PriceField) => (bar: Bar) => priceOf(bar, op.source ?? fallback);
    const wrap = <In, Out>(
        study: { push(x: In): Out; peek(x: In): Out },
        input: (bar: Bar) => In,
        pick: (out: Out) => number = (o) => o as unknown as number,
    ): Source => ({
        push: (bar) => pick(study.push(input(bar))),
        peek: (bar) => pick(study.peek(input(bar))),
    });
    const whole = (bar: Bar) => bar;
    switch (op.study) {
        case 'sma':
            return wrap(new SMA(len('length', 20)), of('close'));
        case 'ema':
            return wrap(new EMA(len('length', 20)), of('close'));
        case 'rma':
            return wrap(new RMA(len('length', 14)), of('close'));
        case 'wma':
            return wrap(new WMA(len('length', 20)), of('close'));
        case 'vwma':
            return wrap(new VWMA(len('length', 20)), (bar) => ({
                price: priceOf(bar, op.source ?? 'close'),
                volume: bar.volume,
            }));
        case 'rsi':
            return wrap(new RSI(len('length', 14)), of('close'));
        case 'stdev':
            return wrap(new StdDev(len('length', 20)), of('close'));
        case 'roc':
            return wrap(new ROC(len('length', 10)), of('close'));
        case 'cci':
            return wrap(new CCI(len('length', 20)), of('hlc3'));
        case 'highest':
            return wrap(new Highest(len('length', 20)), of('high'));
        case 'lowest':
            return wrap(new Lowest(len('length', 20)), of('low'));
        case 'macd': {
            const out = (op.output ?? 'macd') as 'macd' | 'signal' | 'hist';
            return wrap(new MACD(len('fast', 12), len('slow', 26), len('signal', 9)), of('close'), (v) => v[out]);
        }
        case 'bb': {
            const out = (op.output ?? 'basis') as 'basis' | 'upper' | 'lower';
            return wrap(new BollingerBands(len('length', 20), p.mult ?? 2), of('close'), (v) => v[out]);
        }
        case 'atr':
            return wrap(new ATR(len('length', 14)), whole);
        case 'stoch':
            return wrap(new Stochastic(len('length', 14)), whole);
        case 'supertrend':
            return wrap(new Supertrend(p.factor ?? 3, len('period', 10)), whole, (v) =>
                op.output === 'direction' ? v.direction : v.value,
            );
        case 'dmi': {
            const out = (op.output ?? 'adx') as 'adx' | 'plus' | 'minus';
            return wrap(new DMI(len('length', 14), len('smoothing', 14)), whole, (v) => v[out]);
        }
        case 'donchian': {
            const out = (op.output ?? 'basis') as 'upper' | 'lower' | 'basis';
            return wrap(new Donchian(len('length', 20)), whole, (v) => v[out]);
        }
        case 'obv':
            return wrap(new OBV(), whole);
        case 'vwap':
            return wrap(new VWAP(), whole);
    }
}

/** Price of a drawn line at a moment in time, or NaN where the line does not reach. */
export function lineValue(op: Extract<Operand, { type: 'line' }>, time: number): number {
    const [first, second] = op.a.time <= op.b.time ? [op.a, op.b] : [op.b, op.a];
    if (first.time === second.time) return first.price;
    if (time < first.time && op.extend !== 'left' && op.extend !== 'both') return NA;
    if (time > second.time && op.extend !== 'right' && op.extend !== 'both') return NA;
    return first.price + ((second.price - first.price) * (time - first.time)) / (second.time - first.time);
}

function makeSource(op: Operand): Source {
    switch (op.type) {
        case 'price': {
            const read = (bar: Bar) => priceOf(bar, op.field);
            return { push: read, peek: read };
        }
        case 'value': {
            const read = () => op.value;
            return { push: read, peek: read };
        }
        case 'indicator':
            return indicatorSource(op);
        case 'line': {
            const read = (bar: Bar) => lineValue(op, bar.time);
            return { push: read, peek: read };
        }
        case 'plot': {
            const key = plotKey(op, op.plot);
            const read = (_bar: Bar, ext: External) => ext.plots.get(key) ?? NA;
            return { push: read, peek: read };
        }
    }
}

interface Reading {
    left: number;
    right: number;
    upper: number;
    lower: number;
}

interface Node {
    seed(bar: Bar, ext: External): void;
    tick(bar: Bar, ext: External): boolean;
    close(bar: Bar, ext: External): boolean;
}

class Leaf implements Node {
    private c: Comparison;
    private left: Source;
    private right: Source | null;
    private upper: Source | null;
    private lower: Source | null;
    /** Readings at the previous evaluation of any kind, and at the previous bar close. */
    private prevTick: Reading | null = null;
    private prevBar: Reading | null = null;
    /** Left-hand values of recent closed bars, newest last, for the "moving" operators. */
    private history: number[] = [];
    last: Reading | null = null;

    constructor(c: Comparison) {
        this.c = c;
        this.left = makeSource(c.left);
        this.right = c.right ? makeSource(c.right) : null;
        this.upper = c.upper ? makeSource(c.upper) : null;
        this.lower = c.lower ? makeSource(c.lower) : null;
    }

    private read(bar: Bar, ext: External, commit: boolean): Reading {
        const get = (s: Source | null) => (s ? (commit ? s.push(bar, ext) : s.peek(bar, ext)) : NA);
        return { left: get(this.left), right: get(this.right), upper: get(this.upper), lower: get(this.lower) };
    }

    private test(now: Reading, prev: Reading | null): boolean {
        const { left: l, right: r } = now;
        const inside = (x: Reading) => x.left <= x.upper && x.left >= x.lower;
        const defined = (x: Reading) => !Number.isNaN(x.left) && !Number.isNaN(x.upper) && !Number.isNaN(x.lower);
        switch (this.c.op) {
            case 'greater':
                return l > r;
            case 'less':
                return l < r;
            case 'crossing_up':
                return !!prev && prev.left <= prev.right && l > r;
            case 'crossing_down':
                return !!prev && prev.left >= prev.right && l < r;
            case 'crossing':
                return !!prev && ((prev.left <= prev.right && l > r) || (prev.left >= prev.right && l < r));
            case 'inside_channel':
                return defined(now) && inside(now);
            case 'outside_channel':
                return defined(now) && !inside(now);
            case 'entering_channel':
                return !!prev && defined(now) && defined(prev) && !inside(prev) && inside(now);
            case 'exiting_channel':
                return !!prev && defined(now) && defined(prev) && inside(prev) && !inside(now);
            default: {
                const n = Math.max(1, Math.round(this.c.bars ?? 1));
                const ref = this.history[this.history.length - n];
                const amount = this.c.amount ?? 0;
                if (ref === undefined || Number.isNaN(ref) || Number.isNaN(l)) return false;
                if (this.c.op === 'moving_up') return l - ref >= amount;
                if (this.c.op === 'moving_down') return ref - l >= amount;
                if (this.c.op === 'moving_up_pct') return ((l - ref) / Math.abs(ref)) * 100 >= amount;
                return ((ref - l) / Math.abs(ref)) * 100 >= amount;
            }
        }
    }

    private commit(now: Reading): void {
        this.prevBar = now;
        this.prevTick = now;
        this.last = now;
        this.history.push(now.left);
        const keep = Math.max(1, Math.round(this.c.bars ?? 1)) + 1;
        if (this.history.length > keep) this.history.shift();
    }

    seed(bar: Bar, ext: External): void {
        this.commit(this.read(bar, ext, true));
    }

    tick(bar: Bar, ext: External): boolean {
        const now = this.read(bar, ext, false);
        const result = this.test(now, this.prevTick ?? this.prevBar);
        this.prevTick = now;
        this.last = now;
        return result;
    }

    close(bar: Bar, ext: External): boolean {
        const now = this.read(bar, ext, true);
        const result = this.test(now, this.prevBar);
        this.commit(now);
        return result;
    }
}

class ScriptAlertLeaf implements Node {
    private key: string;

    constructor(key: string) {
        this.key = key;
    }

    seed(): void {}

    tick(_bar: Bar, ext: External): boolean {
        return ext.scriptAlerts.has(this.key);
    }

    close(_bar: Bar, ext: External): boolean {
        return ext.scriptAlerts.has(this.key);
    }
}

class Group implements Node {
    private children: Node[];
    private every: boolean;

    constructor(children: Node[], every: boolean) {
        this.children = children;
        this.every = every;
    }

    seed(bar: Bar, ext: External): void {
        for (const c of this.children) c.seed(bar, ext);
    }

    // Every child is evaluated every time, even once the answer is known: each keeps its own history.
    private combine(results: boolean[]): boolean {
        if (results.length === 0) return false;
        return this.every ? results.every(Boolean) : results.some(Boolean);
    }

    tick(bar: Bar, ext: External): boolean {
        return this.combine(this.children.map((c) => c.tick(bar, ext)));
    }

    close(bar: Bar, ext: External): boolean {
        return this.combine(this.children.map((c) => c.close(bar, ext)));
    }
}

function build(condition: Condition, leaves: Leaf[]): Node {
    if (isComparison(condition)) {
        const leaf = new Leaf(condition);
        leaves.push(leaf);
        return leaf;
    }
    if (isScriptAlert(condition))
        return new ScriptAlertLeaf(scriptAlertKey(condition.scriptAlert, condition.scriptAlert.title));
    if ('all' in condition)
        return new Group(
            condition.all.map((c) => build(c, leaves)),
            true,
        );
    return new Group(
        condition.any.map((c) => build(c, leaves)),
        false,
    );
}

/**
 * Evaluates one alert condition on one series. Feed it history with `seed`, then every forming-bar
 * update with `tick` and every closed bar with `close`. `tick` compares against the previous tick
 * (a level crossed mid-bar is caught the moment it happens); `close` compares bar close to bar close.
 */
export class ConditionEvaluator {
    private root: Node;
    private leaves: Leaf[] = [];

    constructor(condition: Condition) {
        this.root = build(condition, this.leaves);
    }

    seed(bar: Bar, ext: External = NOTHING): void {
        this.root.seed(bar, ext);
    }

    tick(bar: Bar, ext: External = NOTHING): boolean {
        return this.root.tick(bar, ext);
    }

    close(bar: Bar, ext: External = NOTHING): boolean {
        return this.root.close(bar, ext);
    }

    /** Operand values of the first comparison at the last evaluation, for message placeholders. */
    values(): { left: number; right: number } {
        const first = this.leaves[0]?.last;
        return { left: first?.left ?? NA, right: first?.right ?? first?.upper ?? NA };
    }
}

export interface ScriptRef {
    key: string;
    scriptId?: string;
    source?: string;
    inputs?: Record<string, unknown>;
}

/** Every distinct script a condition depends on. */
export function scriptRefs(condition: Condition): ScriptRef[] {
    const out = new Map<string, ScriptRef>();
    const add = (ref: { scriptId?: string; source?: string; inputs?: Record<string, unknown> }) => {
        const key = scriptKey(ref);
        if (!out.has(key)) out.set(key, { key, scriptId: ref.scriptId, source: ref.source, inputs: ref.inputs });
    };
    const walk = (c: Condition) => {
        if (isComparison(c)) {
            for (const op of [c.left, c.right, c.upper, c.lower]) if (op?.type === 'plot') add(op);
        } else if (isScriptAlert(c)) add(c.scriptAlert);
        else for (const child of 'all' in c ? c.all : c.any) walk(child);
    };
    walk(condition);
    return [...out.values()];
}

/** Bars of history an evaluator needs before its indicators are trustworthy. */
export function warmupBars(condition: Condition): number {
    let need = 2;
    const operand = (op?: Operand) => {
        if (op?.type !== 'indicator') return;
        const p = op.params ?? {};
        const longest = Math.max(p.length ?? 0, p.slow ?? 0, p.period ?? 0, p.smoothing ?? 0, 26);
        // exponentially smoothed studies converge over a few multiples of their length
        need = Math.max(need, Math.ceil(longest * 5) + 20);
    };
    const walk = (c: Condition) => {
        if (isComparison(c)) {
            for (const op of [c.left, c.right, c.upper, c.lower]) operand(op);
            need = Math.max(need, (c.bars ?? 1) + 2);
        } else if (!isScriptAlert(c)) for (const child of 'all' in c ? c.all : c.any) walk(child);
    };
    walk(condition);
    return need;
}
