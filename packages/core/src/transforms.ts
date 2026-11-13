import { BarSeries } from './series.ts';
import type { Bar } from './types.ts';

/**
 * Price-driven chart types: Renko, Line Break, Kagi, Point & Figure and Range bars.
 * Each is an incremental state machine over source bars, so history and live data share one code
 * path: `push` a closed source bar to get the output bars it completed, `preview` to see the one
 * still forming. An output bar keeps the time it was given while forming, so a chart can update it
 * in place and then watch it close.
 */

export type TransformSpec =
    | { kind: 'renko'; box: number }
    | { kind: 'linebreak'; lines: number }
    | { kind: 'kagi'; reversal: number }
    | { kind: 'pnf'; box: number; reversal: number }
    | { kind: 'range'; range: number };

export interface ChartTransform {
    /** Feed one CLOSED source bar. Returns the output bars it completed, oldest first (often none). */
    push(bar: Bar): Bar[];
    /** The output bar still forming, optionally extended by a forming source bar. Changes no state. */
    preview(forming?: Bar): Bar | null;
}

const EPS = 1e-9;

abstract class Base implements ChartTransform {
    /** Time of the last completed output bar. Output times are strictly increasing. */
    private cursor = Number.NEGATIVE_INFINITY;
    /** Time of the output bar now forming, fixed when it starts. */
    private formingTime: number | undefined;
    protected volume = 0;

    /** The forming output bar starts no earlier than this source bar. */
    protected begin(sourceTime: number): void {
        if (this.formingTime === undefined) this.formingTime = Math.max(sourceTime, this.cursor + 1);
    }

    /** Close the forming output bar: returns its time and starts the next one within the same source bar. */
    protected complete(sourceTime: number): number {
        const t = this.formingTime ?? Math.max(sourceTime, this.cursor + 1);
        this.cursor = t;
        this.formingTime = undefined;
        this.begin(sourceTime);
        return t;
    }

    protected previewTime(forming?: Bar): number | null {
        if (this.formingTime !== undefined) return this.formingTime;
        return forming ? Math.max(forming.time, this.cursor + 1) : null;
    }

    /** Volume gathered since the last completed bar; resets the counter. */
    protected takeVolume(): number {
        const v = this.volume;
        this.volume = 0;
        return v;
    }

    abstract push(bar: Bar): Bar[];
    abstract preview(forming?: Bar): Bar | null;
}

const body = (time: number, open: number, close: number, volume: number): Bar => ({
    time,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume,
});

/** Renko: a new brick each time the close moves one box; a reversal needs two boxes. */
class Renko extends Base {
    private box: number;
    /** Close of the last brick. */
    private base: number | undefined;
    private dir: -1 | 0 | 1 = 0;
    private last = Number.NaN;

    constructor(box: number) {
        super();
        if (!(box > 0)) throw new Error('renko box must be positive');
        this.box = box;
    }

    push(bar: Bar): Bar[] {
        this.begin(bar.time);
        this.volume += bar.volume;
        this.last = bar.close;
        if (this.base === undefined) {
            this.base = Math.round(bar.close / this.box) * this.box;
            return [];
        }
        const out: Bar[] = [];
        const emit = (open: number, close: number) => {
            out.push(body(this.complete(bar.time), open, close, this.takeVolume()));
            this.base = close;
        };
        for (;;) {
            const up = this.dir < 0 ? this.base + 2 * this.box : this.base + this.box;
            const down = this.dir > 0 ? this.base - 2 * this.box : this.base - this.box;
            if (bar.close >= up - EPS) {
                emit(up - this.box, up);
                this.dir = 1;
            } else if (bar.close <= down + EPS) {
                emit(down + this.box, down);
                this.dir = -1;
            } else break;
        }
        return out;
    }

    preview(forming?: Bar): Bar | null {
        const time = this.previewTime(forming);
        if (time === null || this.base === undefined) return null;
        const price = forming?.close ?? this.last;
        const d = this.dir || (price >= this.base ? 1 : -1);
        let open = this.base;
        let close = this.base;
        if ((price - this.base) * d >= 0) close = price;
        else {
            const edge = this.base - d * this.box;
            if ((price - edge) * d < 0) {
                open = edge;
                close = price;
            }
        }
        return body(time, open, close, this.volume + (forming?.volume ?? 0));
    }
}

/** N-line break: a line continues on a new closing extreme and reverses only past the last N lines. */
class LineBreak extends Base {
    private n: number;
    private lines: { open: number; close: number }[] = [];

    constructor(lines: number) {
        super();
        if (!(lines >= 1)) throw new Error('line break count must be at least 1');
        this.n = Math.floor(lines);
    }

    private next(close: number, first?: Bar): { open: number; close: number } | null {
        const last = this.lines[this.lines.length - 1];
        if (!last) return first && first.close !== first.open ? { open: first.open, close: first.close } : null;
        const recent = this.lines.slice(-this.n);
        const highest = Math.max(...recent.map((l) => Math.max(l.open, l.close)));
        const lowest = Math.min(...recent.map((l) => Math.min(l.open, l.close)));
        if (last.close > last.open) {
            if (close > last.close) return { open: last.close, close };
            if (close < lowest) return { open: last.open, close };
        } else {
            if (close < last.close) return { open: last.close, close };
            if (close > highest) return { open: last.open, close };
        }
        return null;
    }

    push(bar: Bar): Bar[] {
        this.begin(bar.time);
        this.volume += bar.volume;
        const line = this.next(bar.close, bar);
        if (!line) return [];
        this.lines.push(line);
        if (this.lines.length > this.n + 1) this.lines.shift();
        return [body(this.complete(bar.time), line.open, line.close, this.takeVolume())];
    }

    preview(forming?: Bar): Bar | null {
        const time = this.previewTime(forming);
        if (time === null || !forming) return null;
        const line = this.next(forming.close, forming);
        return line ? body(time, line.open, line.close, this.volume + forming.volume) : null;
    }
}

/** Kagi: one line per swing; the line turns when the close retraces by the reversal amount. */
class Kagi extends Base {
    private reversal: number;
    private dir: -1 | 0 | 1 = 0;
    private start = Number.NaN;
    private extreme = Number.NaN;

    constructor(reversal: number) {
        super();
        if (!(reversal > 0)) throw new Error('kagi reversal must be positive');
        this.reversal = reversal;
    }

    push(bar: Bar): Bar[] {
        this.begin(bar.time);
        this.volume += bar.volume;
        const c = bar.close;
        if (Number.isNaN(this.start)) {
            this.start = c;
            this.extreme = c;
            return [];
        }
        if (this.dir === 0) {
            if (Math.abs(c - this.start) >= this.reversal - EPS) {
                this.dir = c > this.start ? 1 : -1;
                this.extreme = c;
            }
            return [];
        }
        if ((c - this.extreme) * this.dir > 0) {
            this.extreme = c;
            return [];
        }
        if ((this.extreme - c) * this.dir >= this.reversal - EPS) {
            const done = body(this.complete(bar.time), this.start, this.extreme, this.takeVolume());
            this.start = this.extreme;
            this.extreme = c;
            this.dir = this.dir === 1 ? -1 : 1;
            return [done];
        }
        return [];
    }

    preview(forming?: Bar): Bar | null {
        const time = this.previewTime(forming);
        if (time === null || Number.isNaN(this.start)) return null;
        let end = this.extreme;
        if (forming && this.dir !== 0 && (forming.close - end) * this.dir > 0) end = forming.close;
        if (forming && this.dir === 0) end = forming.close;
        return body(time, this.start, end, this.volume + (forming?.volume ?? 0));
    }
}

/** Point & Figure: columns of boxes; a column reverses after a move of `reversal` boxes against it. */
class PointAndFigure extends Base {
    private box: number;
    private rev: number;
    private dir: -1 | 0 | 1 = 0;
    private top = Number.NaN;
    private bottom = Number.NaN;

    constructor(box: number, reversal: number) {
        super();
        if (!(box > 0) || !(reversal >= 1))
            throw new Error('point & figure needs a positive box and a reversal of at least 1');
        this.box = box;
        this.rev = Math.floor(reversal);
    }

    private floor(p: number): number {
        return Math.floor(p / this.box + EPS) * this.box;
    }

    private ceil(p: number): number {
        return Math.ceil(p / this.box - EPS) * this.box;
    }

    private column(time: number, volume: number): Bar {
        return this.dir >= 0 ? body(time, this.bottom, this.top, volume) : body(time, this.top, this.bottom, volume);
    }

    push(bar: Bar): Bar[] {
        this.begin(bar.time);
        this.volume += bar.volume;
        const c = bar.close;
        if (Number.isNaN(this.top)) {
            this.top = this.bottom = this.floor(c);
            return [];
        }
        if (this.dir === 0) {
            if (c >= this.top + this.box - EPS) {
                this.dir = 1;
                this.top = this.floor(c);
            } else if (c <= this.bottom - this.box + EPS) {
                this.dir = -1;
                this.bottom = this.ceil(c);
            }
            return [];
        }
        if (this.dir === 1) {
            if (c >= this.top + this.box - EPS) this.top = this.floor(c);
            else if (c <= this.top - this.rev * this.box + EPS) {
                const done = this.column(this.complete(bar.time), this.takeVolume());
                this.dir = -1;
                this.top -= this.box;
                this.bottom = this.ceil(c);
                return [done];
            }
            return [];
        }
        if (c <= this.bottom - this.box + EPS) this.bottom = this.ceil(c);
        else if (c >= this.bottom + this.rev * this.box - EPS) {
            const done = this.column(this.complete(bar.time), this.takeVolume());
            this.dir = 1;
            this.bottom += this.box;
            this.top = this.floor(c);
            return [done];
        }
        return [];
    }

    preview(forming?: Bar): Bar | null {
        const time = this.previewTime(forming);
        if (time === null || Number.isNaN(this.top)) return null;
        return this.column(time, this.volume + (forming?.volume ?? 0));
    }
}

/** Range bars: every completed bar spans exactly `range` from low to high. */
class RangeBars extends Base {
    private range: number;
    private cur: { open: number; high: number; low: number; close: number } | null = null;

    constructor(range: number) {
        super();
        if (!(range > 0)) throw new Error('range must be positive');
        this.range = range;
    }

    /** Move the forming bar to `price`, completing bars whenever the range is exceeded. */
    private walk(
        state: NonNullable<RangeBars['cur']>,
        price: number,
        done: (b: NonNullable<RangeBars['cur']>) => void,
    ) {
        let s = state;
        for (;;) {
            if (price > s.low + this.range + EPS) {
                s.high = s.low + this.range;
                s.close = s.high;
                done(s);
                s = { open: s.close, high: s.close, low: s.close, close: s.close };
            } else if (price < s.high - this.range - EPS) {
                s.low = s.high - this.range;
                s.close = s.low;
                done(s);
                s = { open: s.close, high: s.close, low: s.close, close: s.close };
            } else {
                s.high = Math.max(s.high, price);
                s.low = Math.min(s.low, price);
                s.close = price;
                return s;
            }
        }
    }

    /** The intrabar path assumed for a source bar: open, nearer extreme, farther extreme, close. */
    private static path(bar: Bar): number[] {
        const upFirst = bar.high - bar.open <= bar.open - bar.low;
        return upFirst ? [bar.open, bar.high, bar.low, bar.close] : [bar.open, bar.low, bar.high, bar.close];
    }

    push(bar: Bar): Bar[] {
        this.begin(bar.time);
        if (!this.cur) this.cur = { open: bar.open, high: bar.open, low: bar.open, close: bar.open };
        const finished: NonNullable<RangeBars['cur']>[] = [];
        for (const price of RangeBars.path(bar)) this.cur = this.walk(this.cur, price, (b) => finished.push({ ...b }));
        // The source bar's volume is shared evenly between the bars it touched.
        const share = bar.volume / (finished.length + 1);
        const out: Bar[] = [];
        for (const b of finished) {
            out.push({ time: this.complete(bar.time), ...b, volume: this.volume + share });
            this.volume = 0;
        }
        this.volume += share;
        return out;
    }

    preview(forming?: Bar): Bar | null {
        const time = this.previewTime(forming);
        if (time === null || (!this.cur && !forming)) return null;
        let s = this.cur
            ? { ...this.cur }
            : { open: forming!.open, high: forming!.open, low: forming!.open, close: forming!.open };
        if (forming) {
            const p = Math.min(s.low + this.range, Math.max(s.high - this.range, forming.close));
            s = { open: s.open, high: Math.max(s.high, p), low: Math.min(s.low, p), close: p };
        }
        return { time, ...s, volume: this.volume + (forming?.volume ?? 0) };
    }
}

export function createTransform(spec: TransformSpec): ChartTransform {
    switch (spec.kind) {
        case 'renko':
            return new Renko(spec.box);
        case 'linebreak':
            return new LineBreak(spec.lines);
        case 'kagi':
            return new Kagi(spec.reversal);
        case 'pnf':
            return new PointAndFigure(spec.box, spec.reversal);
        case 'range':
            return new RangeBars(spec.range);
    }
}

/** Run a whole source series through a transform. The forming output bar is appended last. */
export function transformAll(source: BarSeries, spec: TransformSpec): BarSeries {
    const transform = createTransform(spec);
    const out = new BarSeries(Math.max(16, source.length >> 2));
    for (let i = 0; i < source.length; i++) {
        for (const b of transform.push(source.at(i))) out.append(b.time, b.open, b.high, b.low, b.close, b.volume);
    }
    const forming = transform.preview();
    if (forming && (out.length === 0 || forming.time > out.time[out.length - 1])) {
        out.append(forming.time, forming.open, forming.high, forming.low, forming.close, forming.volume);
    }
    return out;
}

/** Wilder's Average True Range at the last bar of the series (NaN when there are too few bars). */
export function averageTrueRange(series: BarSeries, length: number): number {
    if (series.length <= length) return Number.NaN;
    let atr = 0;
    for (let i = 1; i < series.length; i++) {
        const tr = Math.max(
            series.high[i] - series.low[i],
            Math.abs(series.high[i] - series.close[i - 1]),
            Math.abs(series.low[i] - series.close[i - 1]),
        );
        if (i <= length) {
            atr += tr / length;
        } else atr = (atr * (length - 1) + tr) / length;
    }
    return atr;
}

/**
 * Parse the chart-type suffix of a symbol. The suffix is letters and digits only, with `X` between
 * parts and `P` as the decimal point: `RENKOX50`, `RENKOXATR14`, `LBX3`, `KAGIX1P5`, `KAGIXATR14`,
 * `PNFX10X3`, `PNFXATR14X3`, `RANGEX25`. ATR sizes are resolved by the caller.
 */
export interface ParsedTransform {
    kind: TransformSpec['kind'];
    /** Fixed size, when given as a number. */
    size?: number;
    /** ATR length, when the size is `ATR<n>`. */
    atr?: number;
    /** Line count (line break) or reversal boxes (point & figure). */
    count?: number;
}

const KINDS: Record<string, TransformSpec['kind']> = {
    RENKO: 'renko',
    LB: 'linebreak',
    KAGI: 'kagi',
    PNF: 'pnf',
    RANGE: 'range',
};

export function parseTransform(suffix: string): ParsedTransform | null {
    const [head, ...parts] = suffix.toUpperCase().split('X');
    const kind = KINDS[head];
    if (!kind) return null;
    const size = (token: string | undefined): { size?: number; atr?: number } | null => {
        if (!token) return null;
        const atr = /^ATR(\d+)$/.exec(token);
        if (atr) return Number(atr[1]) > 0 ? { atr: Number(atr[1]) } : null;
        if (!/^\d+(P\d+)?$/.test(token)) return null;
        const n = Number(token.replace('P', '.'));
        return n > 0 ? { size: n } : null;
    };
    const count = (token: string | undefined): number | null =>
        token && /^\d+$/.test(token) && Number(token) >= 1 ? Number(token) : null;
    if (kind === 'linebreak') {
        const n = count(parts[0]);
        return n !== null && parts.length === 1 ? { kind, count: n } : null;
    }
    const sz = size(parts[0]);
    if (!sz) return null;
    if (kind === 'pnf') {
        const n = count(parts[1]);
        return n !== null && parts.length === 2 ? { kind, ...sz, count: n } : null;
    }
    return parts.length === 1 ? { kind, ...sz } : null;
}

/** The inverse of `parseTransform`. */
export function formatTransform(t: ParsedTransform): string {
    const head = Object.keys(KINDS).find((k) => KINDS[k] === t.kind)!;
    const size = t.atr !== undefined ? `ATR${t.atr}` : String(t.size).replace('.', 'P');
    if (t.kind === 'linebreak') return `${head}X${t.count ?? 3}`;
    if (t.kind === 'pnf') return `${head}X${size}X${t.count ?? 3}`;
    return `${head}X${size}`;
}

/** Turn a parsed suffix into a concrete spec, given the resolved box / reversal / range size. */
export function toTransformSpec(parsed: ParsedTransform, resolvedSize: number): TransformSpec {
    switch (parsed.kind) {
        case 'renko':
            return { kind: 'renko', box: resolvedSize };
        case 'kagi':
            return { kind: 'kagi', reversal: resolvedSize };
        case 'range':
            return { kind: 'range', range: resolvedSize };
        case 'pnf':
            return { kind: 'pnf', box: resolvedSize, reversal: parsed.count ?? 3 };
        case 'linebreak':
            return { kind: 'linebreak', lines: parsed.count ?? 3 };
    }
}
