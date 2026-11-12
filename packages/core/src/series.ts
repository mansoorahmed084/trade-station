import type { Bar } from './types.ts';

const MAGIC = 0x31425354; // "TSB1" little-endian
const HEADER_BYTES = 8;
const COLUMNS = 6;

/**
 * Columnar bar storage: one Float64Array per field, no per-bar objects.
 * Bars are kept sorted by open time with no duplicates.
 */
export class BarSeries {
    time: Float64Array;
    open: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    length = 0;

    constructor(capacity = 1024) {
        const cap = Math.max(16, capacity);
        this.time = new Float64Array(cap);
        this.open = new Float64Array(cap);
        this.high = new Float64Array(cap);
        this.low = new Float64Array(cap);
        this.close = new Float64Array(cap);
        this.volume = new Float64Array(cap);
    }

    static fromBars(bars: readonly Bar[]): BarSeries {
        const s = new BarSeries(bars.length);
        for (const b of bars) s.upsert(b);
        return s;
    }

    get capacity(): number {
        return this.time.length;
    }

    private grow(min: number): void {
        if (min <= this.capacity) return;
        const cap = Math.max(min, this.capacity * 2);
        for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            const next = new Float64Array(cap);
            next.set(this[key].subarray(0, this.length));
            this[key] = next;
        }
    }

    /** Append a bar strictly newer than the last one. Throws otherwise — use `upsert` for unordered input. */
    append(time: number, open: number, high: number, low: number, close: number, volume: number): void {
        if (this.length > 0 && time <= this.time[this.length - 1]) {
            throw new Error(`append out of order: ${time} <= ${this.time[this.length - 1]}`);
        }
        this.grow(this.length + 1);
        const i = this.length++;
        this.time[i] = time;
        this.open[i] = open;
        this.high[i] = high;
        this.low[i] = low;
        this.close[i] = close;
        this.volume[i] = volume;
    }

    private write(i: number, b: Bar): void {
        this.time[i] = b.time;
        this.open[i] = b.open;
        this.high[i] = b.high;
        this.low[i] = b.low;
        this.close[i] = b.close;
        this.volume[i] = b.volume;
    }

    /** Insert or replace by open time, keeping order. Returns what happened. */
    upsert(b: Bar): 'appended' | 'updated' | 'inserted' {
        const n = this.length;
        if (n === 0 || b.time > this.time[n - 1]) {
            this.append(b.time, b.open, b.high, b.low, b.close, b.volume);
            return 'appended';
        }
        if (b.time === this.time[n - 1]) {
            this.write(n - 1, b);
            return 'updated';
        }
        const i = this.lowerBound(b.time);
        if (this.time[i] === b.time) {
            this.write(i, b);
            return 'updated';
        }
        this.grow(n + 1);
        for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            this[key].copyWithin(i + 1, i, n);
        }
        this.length++;
        this.write(i, b);
        return 'inserted';
    }

    at(i: number): Bar {
        if (i < 0 || i >= this.length) throw new RangeError(`bar index ${i} out of range`);
        return {
            time: this.time[i],
            open: this.open[i],
            high: this.high[i],
            low: this.low[i],
            close: this.close[i],
            volume: this.volume[i],
        };
    }

    last(): Bar | undefined {
        return this.length ? this.at(this.length - 1) : undefined;
    }

    get firstTime(): number | undefined {
        return this.length ? this.time[0] : undefined;
    }

    get lastTime(): number | undefined {
        return this.length ? this.time[this.length - 1] : undefined;
    }

    /** First index whose time is >= `time` (== length when none). */
    lowerBound(time: number): number {
        let lo = 0;
        let hi = this.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.time[mid] < time) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /** Index of the bar opening exactly at `time`, or -1. */
    indexOf(time: number): number {
        const i = this.lowerBound(time);
        return i < this.length && this.time[i] === time ? i : -1;
    }

    /** Index of the last bar opening at or before `time`, or -1. */
    indexAtOrBefore(time: number): number {
        const i = this.lowerBound(time);
        if (i < this.length && this.time[i] === time) return i;
        return i - 1;
    }

    /** Copy of bars in `[from, to)` by index. */
    slice(from = 0, to = this.length): BarSeries {
        const a = Math.max(0, from);
        const b = Math.min(this.length, to);
        const n = Math.max(0, b - a);
        const s = new BarSeries(n);
        for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            s[key].set(this[key].subarray(a, b));
        }
        s.length = n;
        return s;
    }

    /** Copy of bars whose open time is in `[fromTime, toTime)`. */
    range(fromTime: number, toTime: number): BarSeries {
        return this.slice(this.lowerBound(fromTime), this.lowerBound(toTime));
    }

    toBars(from = 0, to = this.length): Bar[] {
        const out: Bar[] = [];
        for (let i = Math.max(0, from); i < Math.min(this.length, to); i++) out.push(this.at(i));
        return out;
    }

    /** Merge another sorted series in; on equal times the other series wins. */
    merge(other: BarSeries): void {
        if (other.length === 0) return;
        if (this.length === 0 || other.time[0] > this.time[this.length - 1]) {
            this.grow(this.length + other.length);
            for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
                this[key].set(other[key].subarray(0, other.length), this.length);
            }
            this.length += other.length;
            return;
        }
        const merged = new BarSeries(this.length + other.length);
        let i = 0;
        let j = 0;
        while (i < this.length || j < other.length) {
            const ti = i < this.length ? this.time[i] : Number.POSITIVE_INFINITY;
            const tj = j < other.length ? other.time[j] : Number.POSITIVE_INFINITY;
            if (tj <= ti) {
                merged.append(tj, other.open[j], other.high[j], other.low[j], other.close[j], other.volume[j]);
                if (tj === ti) i++;
                j++;
            } else {
                merged.append(ti, this.open[i], this.high[i], this.low[i], this.close[i], this.volume[i]);
                i++;
            }
        }
        Object.assign(this, {
            time: merged.time,
            open: merged.open,
            high: merged.high,
            low: merged.low,
            close: merged.close,
            volume: merged.volume,
            length: merged.length,
        });
    }

    /** Drop every bar. Keeps the allocated capacity. */
    clear(): void {
        this.length = 0;
    }

    /**
     * Binary wire/storage form: 8-byte header (magic, count) then six contiguous Float64 columns.
     * Decoding is a zero-parse typed-array view.
     */
    encode(from = 0, to = this.length): ArrayBuffer {
        const a = Math.max(0, from);
        const b = Math.min(this.length, to);
        const n = Math.max(0, b - a);
        const buf = new ArrayBuffer(HEADER_BYTES + COLUMNS * n * 8);
        const head = new Uint32Array(buf, 0, 2);
        head[0] = MAGIC;
        head[1] = n;
        const body = new Float64Array(buf, HEADER_BYTES);
        let off = 0;
        for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            body.set(this[key].subarray(a, b), off);
            off += n;
        }
        return buf;
    }

    static decode(input: ArrayBuffer | Uint8Array): BarSeries {
        let buf: ArrayBuffer;
        if (input instanceof Uint8Array) {
            // Node Buffers may be views into a shared pool at an unaligned offset — copy out.
            buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
        } else buf = input;
        if (buf.byteLength < HEADER_BYTES) throw new Error('bar payload too short');
        const head = new Uint32Array(buf, 0, 2);
        if (head[0] !== MAGIC) throw new Error('bad bar payload magic');
        const n = head[1];
        if (buf.byteLength !== HEADER_BYTES + COLUMNS * n * 8) throw new Error('bar payload length mismatch');
        const body = new Float64Array(buf, HEADER_BYTES);
        const s = new BarSeries(n);
        let off = 0;
        for (const key of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            s[key].set(body.subarray(off, off + n));
            off += n;
        }
        s.length = n;
        return s;
    }
}
