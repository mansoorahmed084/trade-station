import type { Bar } from '@ts/core';

/**
 * Native technical indicators with Pine Script semantics, built for speed.
 *
 * Every indicator is incremental and has two entry points:
 *   `push(x)` — commit a CLOSED bar's value and return the indicator's value for it;
 *   `peek(x)` — the value the indicator would have if `x` were the next bar, without changing
 *               state. This is what a forming bar uses: call it as often as ticks arrive.
 * Both are O(1) (amortised for rolling extremes), so 25 indicators cost microseconds per tick.
 * Values are NaN until enough bars have been seen, exactly where Pine returns `na`.
 */

const NA = Number.NaN;

export interface Study<In, Out> {
    push(x: In): Out;
    peek(x: In): Out;
}

// ── Rolling window primitives ───────────────────────────────────────────────

/** Fixed-length ring of the last `length` committed values. */
class Ring {
    readonly length: number;
    private buf: Float64Array;
    count = 0;

    constructor(length: number) {
        if (!Number.isInteger(length) || length < 1)
            throw new Error(`indicator length must be a positive integer (got ${length})`);
        this.length = length;
        this.buf = new Float64Array(length);
    }

    get full(): boolean {
        return this.count >= this.length;
    }

    /** The value about to leave the window (only meaningful when full). */
    get oldest(): number {
        return this.buf[this.count % this.length];
    }

    /** Value `back` bars ago (0 = newest committed). */
    at(back: number): number {
        return this.buf[(this.count - 1 - back + this.length * 2) % this.length];
    }

    /** Store a value; returns the one it displaced (0 while filling). */
    push(x: number): number {
        const i = this.count % this.length;
        const out = this.count >= this.length ? this.buf[i] : 0;
        this.buf[i] = x;
        this.count++;
        return out;
    }
}

/** Rolling maximum (or minimum) over the last `length` values via a monotonic deque. */
class Extreme implements Study<number, number> {
    private length: number;
    private sign: 1 | -1;
    private idx: Int32Array;
    private val: Float64Array;
    private head = 0;
    private tail = 0;
    private count = 0;

    constructor(length: number, kind: 'max' | 'min') {
        if (!Number.isInteger(length) || length < 1)
            throw new Error(`indicator length must be a positive integer (got ${length})`);
        this.length = length;
        this.sign = kind === 'max' ? 1 : -1;
        this.idx = new Int32Array(length + 1);
        this.val = new Float64Array(length + 1);
    }

    private get cap(): number {
        return this.length + 1;
    }

    push(x: number): number {
        const i = this.count++;
        const v = x * this.sign;
        while (this.head !== this.tail && this.val[(this.tail - 1 + this.cap) % this.cap] <= v)
            this.tail = (this.tail - 1 + this.cap) % this.cap;
        this.idx[this.tail] = i;
        this.val[this.tail] = v;
        this.tail = (this.tail + 1) % this.cap;
        if (this.idx[this.head] <= i - this.length) this.head = (this.head + 1) % this.cap;
        return this.count >= this.length ? this.val[this.head] * this.sign : NA;
    }

    peek(x: number): number {
        if (this.count + 1 < this.length) return NA;
        const v = x * this.sign;
        const start = this.count - this.length + 1; // first index inside the window that ends at the peeked bar
        let h = this.head;
        while (h !== this.tail && this.idx[h] < start) h = (h + 1) % this.cap;
        const best = h === this.tail ? v : Math.max(v, this.val[h]);
        return best * this.sign;
    }
}

export const Highest = class extends Extreme {
    constructor(length: number) {
        super(length, 'max');
    }
};
export const Lowest = class extends Extreme {
    constructor(length: number) {
        super(length, 'min');
    }
};

// ── Moving averages ─────────────────────────────────────────────────────────

/** Simple moving average (`ta.sma`). */
export class SMA implements Study<number, number> {
    private ring: Ring;
    private sum = 0;

    constructor(length: number) {
        this.ring = new Ring(length);
    }

    push(x: number): number {
        this.sum += x - this.ring.push(x);
        return this.ring.full ? this.sum / this.ring.length : NA;
    }

    peek(x: number): number {
        if (this.ring.count + 1 < this.ring.length) return NA;
        return (this.sum + x - (this.ring.full ? this.ring.oldest : 0)) / this.ring.length;
    }
}

/** Exponentially weighted average seeded with an SMA, as Pine does. `alpha` = 2/(n+1) for EMA, 1/n for RMA. */
class Smoothed implements Study<number, number> {
    private length: number;
    private alpha: number;
    private count = 0;
    private seed = 0;
    private value = NA;

    constructor(length: number, alpha: number) {
        if (!Number.isInteger(length) || length < 1)
            throw new Error(`indicator length must be a positive integer (got ${length})`);
        this.length = length;
        this.alpha = alpha;
    }

    push(x: number): number {
        if (Number.isNaN(x)) return this.value; // an undefined input neither advances nor resets the average
        this.count++;
        if (this.count < this.length) {
            this.seed += x;
            return NA;
        }
        if (this.count === this.length) this.value = (this.seed + x) / this.length;
        else this.value = this.alpha * x + (1 - this.alpha) * this.value;
        return this.value;
    }

    peek(x: number): number {
        if (Number.isNaN(x)) return this.value;
        const n = this.count + 1;
        if (n < this.length) return NA;
        if (n === this.length) return (this.seed + x) / this.length;
        return this.alpha * x + (1 - this.alpha) * this.value;
    }
}

/** Exponential moving average (`ta.ema`). */
export class EMA extends Smoothed {
    constructor(length: number) {
        super(length, 2 / (length + 1));
    }
}

/** Wilder's moving average (`ta.rma`), the smoothing behind RSI, ATR and ADX. */
export class RMA extends Smoothed {
    constructor(length: number) {
        super(length, 1 / length);
    }
}

/** Linearly weighted moving average (`ta.wma`): the newest bar has weight n, the oldest 1. */
export class WMA implements Study<number, number> {
    private ring: Ring;
    private sum = 0;
    private weighted = 0;
    private denom: number;

    constructor(length: number) {
        this.ring = new Ring(length);
        this.denom = (length * (length + 1)) / 2;
    }

    push(x: number): number {
        const n = this.ring.length;
        if (this.ring.full) {
            this.weighted += n * x - this.sum;
            this.sum += x - this.ring.push(x);
        } else {
            this.ring.push(x);
            this.sum += x;
            this.weighted += this.ring.count * x;
        }
        return this.ring.full ? this.weighted / this.denom : NA;
    }

    peek(x: number): number {
        const n = this.ring.length;
        if (this.ring.full) return (this.weighted + n * x - this.sum) / this.denom;
        return this.ring.count + 1 === n ? (this.weighted + n * x) / this.denom : NA;
    }
}

/** Volume-weighted moving average (`ta.vwma`). */
export class VWMA implements Study<{ price: number; volume: number }, number> {
    private pv: SMA;
    private v: SMA;

    constructor(length: number) {
        this.pv = new SMA(length);
        this.v = new SMA(length);
    }

    push(x: { price: number; volume: number }): number {
        return this.pv.push(x.price * x.volume) / this.v.push(x.volume);
    }

    peek(x: { price: number; volume: number }): number {
        return this.pv.peek(x.price * x.volume) / this.v.peek(x.volume);
    }
}

// ── Dispersion ──────────────────────────────────────────────────────────────

/**
 * Population standard deviation over a window (`ta.stdev`).
 * Running sums of squares lose precision when prices are large and their spread small, so values are
 * kept relative to an offset near the current price and the sums are rebuilt exactly once per window.
 */
export class StdDev implements Study<number, number> {
    private ring: Ring;
    private offset = NA;
    private sum = 0;
    private sumSq = 0;
    private sinceRebuild = 0;

    constructor(length: number) {
        this.ring = new Ring(length);
    }

    private static of(sum: number, sumSq: number, n: number): number {
        const mean = sum / n;
        return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    }

    private rebuild(): void {
        const n = Math.min(this.ring.count, this.ring.length);
        this.offset = this.ring.at(0);
        this.sum = 0;
        this.sumSq = 0;
        for (let back = 0; back < n; back++) {
            const d = this.ring.at(back) - this.offset;
            this.sum += d;
            this.sumSq += d * d;
        }
        this.sinceRebuild = 0;
    }

    push(x: number): number {
        if (Number.isNaN(this.offset)) this.offset = x;
        const full = this.ring.full;
        const out = this.ring.push(x);
        const d = x - this.offset;
        const o = full ? out - this.offset : 0;
        this.sum += d - o;
        this.sumSq += d * d - o * o;
        if (++this.sinceRebuild >= this.ring.length) this.rebuild();
        return this.ring.full ? StdDev.of(this.sum, this.sumSq, this.ring.length) : NA;
    }

    peek(x: number): number {
        if (this.ring.count + 1 < this.ring.length) return NA;
        const offset = Number.isNaN(this.offset) ? x : this.offset;
        const d = x - offset;
        const o = this.ring.full ? this.ring.oldest - offset : 0;
        return StdDev.of(this.sum + d - o, this.sumSq + d * d - o * o, this.ring.length);
    }
}

export interface Bands {
    basis: number;
    upper: number;
    lower: number;
}

/** Bollinger Bands (`ta.bb`). */
export class BollingerBands implements Study<number, Bands> {
    private sma: SMA;
    private dev: StdDev;
    private mult: number;

    constructor(length: number, mult = 2) {
        this.sma = new SMA(length);
        this.dev = new StdDev(length);
        this.mult = mult;
    }

    private bands(basis: number, dev: number): Bands {
        return { basis, upper: basis + this.mult * dev, lower: basis - this.mult * dev };
    }

    push(x: number): Bands {
        return this.bands(this.sma.push(x), this.dev.push(x));
    }

    peek(x: number): Bands {
        return this.bands(this.sma.peek(x), this.dev.peek(x));
    }
}

// ── Momentum ────────────────────────────────────────────────────────────────

/** Relative Strength Index (`ta.rsi`). */
export class RSI implements Study<number, number> {
    private up: RMA;
    private down: RMA;
    private prev = NA;

    constructor(length: number) {
        this.up = new RMA(length);
        this.down = new RMA(length);
    }

    private static of(up: number, down: number): number {
        if (Number.isNaN(up) || Number.isNaN(down)) return NA;
        return down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down);
    }

    push(x: number): number {
        const change = x - this.prev;
        this.prev = x;
        if (Number.isNaN(change)) return NA;
        return RSI.of(this.up.push(Math.max(change, 0)), this.down.push(Math.max(-change, 0)));
    }

    peek(x: number): number {
        const change = x - this.prev;
        if (Number.isNaN(change)) return NA;
        return RSI.of(this.up.peek(Math.max(change, 0)), this.down.peek(Math.max(-change, 0)));
    }
}

export interface MacdValue {
    macd: number;
    signal: number;
    hist: number;
}

/** Moving Average Convergence Divergence (`ta.macd`). */
export class MACD implements Study<number, MacdValue> {
    private fast: EMA;
    private slow: EMA;
    private sig: EMA;

    constructor(fast = 12, slow = 26, signal = 9) {
        this.fast = new EMA(fast);
        this.slow = new EMA(slow);
        this.sig = new EMA(signal);
    }

    push(x: number): MacdValue {
        const macd = this.fast.push(x) - this.slow.push(x);
        const signal = this.sig.push(macd);
        return { macd, signal, hist: macd - signal };
    }

    peek(x: number): MacdValue {
        const macd = this.fast.peek(x) - this.slow.peek(x);
        const signal = this.sig.peek(macd);
        return { macd, signal, hist: macd - signal };
    }
}

/** Rate of change in percent (`ta.roc`). */
export class ROC implements Study<number, number> {
    private ring: Ring;

    constructor(length: number) {
        this.ring = new Ring(length);
    }

    push(x: number): number {
        const full = this.ring.full;
        const old = this.ring.push(x);
        return full ? (100 * (x - old)) / old : NA;
    }

    peek(x: number): number {
        return this.ring.full ? (100 * (x - this.ring.oldest)) / this.ring.oldest : NA;
    }
}

/** Stochastic %K (`ta.stoch(close, high, low, length)`). Smooth it with an SMA for the classic %K and %D. */
export class Stochastic implements Study<Bar, number> {
    private hi: InstanceType<typeof Highest>;
    private lo: InstanceType<typeof Lowest>;

    constructor(length: number) {
        this.hi = new Highest(length);
        this.lo = new Lowest(length);
    }

    private static of(close: number, hh: number, ll: number): number {
        return (100 * (close - ll)) / (hh - ll);
    }

    push(bar: Bar): number {
        return Stochastic.of(bar.close, this.hi.push(bar.high), this.lo.push(bar.low));
    }

    peek(bar: Bar): number {
        return Stochastic.of(bar.close, this.hi.peek(bar.high), this.lo.peek(bar.low));
    }
}

/** Commodity Channel Index (`ta.cci`). The mean deviation is recomputed over the window: O(length). */
export class CCI implements Study<number, number> {
    private ring: Ring;
    private sum = 0;

    constructor(length: number) {
        this.ring = new Ring(length);
    }

    private value(x: number, mean: number, includeOldest: boolean): number {
        const n = this.ring.length;
        let dev = Math.abs(x - mean);
        // committed values inside the window, newest first; when peeking, the oldest one has left it
        const committed = includeOldest ? n - 1 : Math.min(n - 1, this.ring.count);
        for (let back = includeOldest ? 1 : 0, k = 0; k < committed; back++, k++)
            dev += Math.abs(this.ring.at(back) - mean);
        return (x - mean) / (0.015 * (dev / n));
    }

    push(x: number): number {
        this.sum += x - this.ring.push(x);
        return this.ring.full ? this.value(x, this.sum / this.ring.length, true) : NA;
    }

    peek(x: number): number {
        const n = this.ring.length;
        if (this.ring.count + 1 < n) return NA;
        const mean = (this.sum + x - (this.ring.full ? this.ring.oldest : 0)) / n;
        return this.value(x, mean, false);
    }
}

// ── Volatility and trend ────────────────────────────────────────────────────

/** True range of a bar against the previous close (`ta.tr(true)`: the first bar's range is high − low). */
export function trueRange(bar: Bar, prevClose: number): number {
    if (Number.isNaN(prevClose)) return bar.high - bar.low;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** Average True Range (`ta.atr`). */
export class ATR implements Study<Bar, number> {
    private rma: RMA;
    private prevClose = NA;

    constructor(length: number) {
        this.rma = new RMA(length);
    }

    push(bar: Bar): number {
        const tr = trueRange(bar, this.prevClose);
        this.prevClose = bar.close;
        return this.rma.push(tr);
    }

    peek(bar: Bar): number {
        return this.rma.peek(trueRange(bar, this.prevClose));
    }
}

export interface SupertrendValue {
    value: number;
    /** -1 while price is above the line (uptrend), 1 while below — Pine's convention. */
    direction: number;
}

/** Supertrend (`ta.supertrend(factor, atrPeriod)`). */
export class Supertrend implements Study<Bar, SupertrendValue> {
    private atr: ATR;
    private factor: number;
    private upper = NA;
    private lower = NA;
    private line = NA;
    private prevClose = NA;
    private prevAtr = NA;

    constructor(factor = 3, atrPeriod = 10) {
        this.factor = factor;
        this.atr = new ATR(atrPeriod);
    }

    private step(bar: Bar, atr: number) {
        // No ATR yet: the line and its direction are undefined, and nothing carries forward.
        if (Number.isNaN(atr)) return { upper: NA, lower: NA, value: NA, direction: NA };
        const mid = (bar.high + bar.low) / 2;
        let upper = mid + this.factor * atr;
        let lower = mid - this.factor * atr;
        const prevLower = Number.isNaN(this.lower) ? 0 : this.lower;
        const prevUpper = Number.isNaN(this.upper) ? 0 : this.upper;
        lower = lower > prevLower || this.prevClose < prevLower ? lower : prevLower;
        upper = upper < prevUpper || this.prevClose > prevUpper ? upper : prevUpper;
        let direction: number;
        if (Number.isNaN(this.prevAtr)) direction = 1;
        else if (this.line === prevUpper) direction = bar.close > upper ? -1 : 1;
        else direction = bar.close < lower ? 1 : -1;
        const value = direction === -1 ? lower : upper;
        return { upper, lower, value, direction };
    }

    push(bar: Bar): SupertrendValue {
        const atr = this.atr.push(bar);
        const s = this.step(bar, atr);
        this.upper = s.upper;
        this.lower = s.lower;
        this.line = s.value;
        this.prevClose = bar.close;
        this.prevAtr = atr;
        return { value: s.value, direction: s.direction };
    }

    peek(bar: Bar): SupertrendValue {
        const s = this.step(bar, this.atr.peek(bar));
        return { value: s.value, direction: s.direction };
    }
}

export interface DmiValue {
    plus: number;
    minus: number;
    adx: number;
}

/** Directional Movement Index and ADX (`ta.dmi(diLength, adxSmoothing)`). */
export class DMI implements Study<Bar, DmiValue> {
    private tr: RMA;
    private plusDm: RMA;
    private minusDm: RMA;
    private adx: RMA;
    private prev: Bar | null = null;
    private lastPlus = NA;
    private lastMinus = NA;

    constructor(diLength = 14, adxSmoothing = 14) {
        this.tr = new RMA(diLength);
        this.plusDm = new RMA(diLength);
        this.minusDm = new RMA(diLength);
        this.adx = new RMA(adxSmoothing);
    }

    private inputs(bar: Bar) {
        const prev = this.prev;
        const up = prev ? bar.high - prev.high : NA;
        const down = prev ? prev.low - bar.low : NA;
        return {
            // `ta.tr`, not `ta.tr(true)`: undefined on the first bar, so the smoothing starts one bar later than ATR's
            tr: prev ? trueRange(bar, prev.close) : NA,
            plus: Number.isNaN(up) ? NA : up > down && up > 0 ? up : 0,
            minus: Number.isNaN(down) ? NA : down > up && down > 0 ? down : 0,
        };
    }

    private finish(tr: number, plusDm: number, minusDm: number, commit: boolean): DmiValue {
        // `fixnan`: hold the last defined value
        let plus = (100 * plusDm) / tr;
        let minus = (100 * minusDm) / tr;
        if (Number.isNaN(plus)) plus = this.lastPlus;
        if (Number.isNaN(minus)) minus = this.lastMinus;
        if (commit) {
            this.lastPlus = plus;
            this.lastMinus = minus;
        }
        const sum = plus + minus;
        const dx = Math.abs(plus - minus) / (sum === 0 ? 1 : sum);
        const adx = 100 * (commit ? this.adx.push(dx) : this.adx.peek(dx));
        return { plus, minus, adx };
    }

    push(bar: Bar): DmiValue {
        const x = this.inputs(bar);
        this.prev = bar;
        return this.finish(this.tr.push(x.tr), this.plusDm.push(x.plus), this.minusDm.push(x.minus), true);
    }

    peek(bar: Bar): DmiValue {
        const x = this.inputs(bar);
        return this.finish(this.tr.peek(x.tr), this.plusDm.peek(x.plus), this.minusDm.peek(x.minus), false);
    }
}

export interface Channel {
    upper: number;
    lower: number;
    basis: number;
}

/** Donchian channel: highest high and lowest low over a window. */
export class Donchian implements Study<Bar, Channel> {
    private hi: InstanceType<typeof Highest>;
    private lo: InstanceType<typeof Lowest>;

    constructor(length: number) {
        this.hi = new Highest(length);
        this.lo = new Lowest(length);
    }

    push(bar: Bar): Channel {
        const upper = this.hi.push(bar.high);
        const lower = this.lo.push(bar.low);
        return { upper, lower, basis: (upper + lower) / 2 };
    }

    peek(bar: Bar): Channel {
        const upper = this.hi.peek(bar.high);
        const lower = this.lo.peek(bar.low);
        return { upper, lower, basis: (upper + lower) / 2 };
    }
}

// ── Volume ──────────────────────────────────────────────────────────────────

/** On-Balance Volume (`ta.obv`). */
export class OBV implements Study<Bar, number> {
    private total = 0;
    private prevClose = NA;

    private delta(bar: Bar): number {
        if (Number.isNaN(this.prevClose)) return 0;
        return Math.sign(bar.close - this.prevClose) * bar.volume;
    }

    push(bar: Bar): number {
        this.total += this.delta(bar);
        this.prevClose = bar.close;
        return this.total;
    }

    peek(bar: Bar): number {
        return this.total + this.delta(bar);
    }
}

/** Volume-weighted average price, restarting each UTC day (`ta.vwap` on a 24x7 market). */
export class VWAP implements Study<Bar, number> {
    private day = -1;
    private pv = 0;
    private v = 0;

    push(bar: Bar): number {
        const day = Math.floor(bar.time / 86_400_000);
        if (day !== this.day) {
            this.day = day;
            this.pv = 0;
            this.v = 0;
        }
        this.pv += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
        this.v += bar.volume;
        return this.pv / this.v;
    }

    peek(bar: Bar): number {
        const fresh = Math.floor(bar.time / 86_400_000) !== this.day;
        const typical = (bar.high + bar.low + bar.close) / 3;
        return ((fresh ? 0 : this.pv) + typical * bar.volume) / ((fresh ? 0 : this.v) + bar.volume);
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Detects a series crossing another (`ta.crossover` / `ta.crossunder` / `ta.cross`). */
export class Cross {
    private prevA = NA;
    private prevB = NA;

    private test(a: number, b: number): { over: boolean; under: boolean } {
        return {
            over: a > b && this.prevA <= this.prevB,
            under: a < b && this.prevA >= this.prevB,
        };
    }

    push(a: number, b: number): { over: boolean; under: boolean } {
        const out = this.test(a, b);
        this.prevA = a;
        this.prevB = b;
        return out;
    }

    peek(a: number, b: number): { over: boolean; under: boolean } {
        return this.test(a, b);
    }
}

/** Run a study over a whole series of inputs. */
export function series<In, Out>(study: Study<In, Out>, inputs: readonly In[]): Out[] {
    const out: Out[] = new Array(inputs.length);
    for (let i = 0; i < inputs.length; i++) out[i] = study.push(inputs[i]);
    return out;
}
