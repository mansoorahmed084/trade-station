import { BarSeries } from './series.ts';
import { barOpenTime } from './timeframe.ts';
import type { Bar } from './types.ts';

/** Build a coarser series from a finer one. The caller guarantees `canAggregate(fine, coarse)`. */
export function aggregate(src: BarSeries, toTf: string): BarSeries {
    const out = new BarSeries(Math.max(16, Math.ceil(src.length / 2)));
    if (src.length === 0) return out;
    let bucket = barOpenTime(src.time[0], toTf);
    let o = src.open[0];
    let h = src.high[0];
    let l = src.low[0];
    let c = src.close[0];
    let v = src.volume[0];
    for (let i = 1; i < src.length; i++) {
        const b = barOpenTime(src.time[i], toTf);
        if (b !== bucket) {
            out.append(bucket, o, h, l, c, v);
            bucket = b;
            o = src.open[i];
            h = src.high[i];
            l = src.low[i];
            c = src.close[i];
            v = src.volume[i];
        } else {
            if (src.high[i] > h) h = src.high[i];
            if (src.low[i] < l) l = src.low[i];
            c = src.close[i];
            v += src.volume[i];
        }
    }
    out.append(bucket, o, h, l, c, v);
    return out;
}

export interface AggregateUpdate {
    bar: Bar;
    /** True when this update opened a new coarse bar (the previous one is now final). */
    opened: boolean;
}

/**
 * Incremental aggregation of a live base stream. The base stream may update its forming bar
 * any number of times (same open time) before moving on; the coarse bar stays exact throughout.
 */
export class LiveAggregator {
    readonly timeframe: string;
    private bucket = Number.NaN;
    /** Completed base bars inside the current bucket, folded together. */
    private done: Bar | null = null;
    /** The base bar still forming. */
    private cur: Bar | null = null;

    constructor(timeframe: string) {
        this.timeframe = timeframe;
    }

    /** Seed with base bars that are already inside the current coarse bucket (after a history load). */
    seed(bars: readonly Bar[]): void {
        for (const b of bars) this.push(b);
    }

    push(base: Bar): AggregateUpdate | null {
        const bucket = barOpenTime(base.time, this.timeframe);
        let opened = false;
        if (bucket !== this.bucket) {
            if (bucket < this.bucket) return null; // stale bar from an older bucket
            this.bucket = bucket;
            this.done = null;
            this.cur = base;
            opened = true;
        } else if (this.cur && base.time === this.cur.time) {
            this.cur = base;
        } else if (this.cur && base.time > this.cur.time) {
            this.done = this.done ? fold(this.done, this.cur) : { ...this.cur };
            this.cur = base;
        } else {
            return null; // stale base bar inside the bucket
        }
        return { bar: this.current()!, opened };
    }

    current(): Bar | null {
        if (!this.cur) return null;
        const merged = this.done ? fold(this.done, this.cur) : { ...this.cur };
        merged.time = this.bucket;
        return merged;
    }
}

function fold(a: Bar, b: Bar): Bar {
    return {
        time: a.time,
        open: a.open,
        high: Math.max(a.high, b.high),
        low: Math.min(a.low, b.low),
        close: b.close,
        volume: a.volume + b.volume,
    };
}
