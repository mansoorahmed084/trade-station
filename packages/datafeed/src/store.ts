import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Bar, BarSeries } from '@ts/core';
import type { SeriesKey } from './types.ts';

/** Half-open range of bar open times `[from, to)`. */
export type Range = [from: number, to: number];

const ROW = 6;
const ROW_BYTES = ROW * 8;

export function mergeRanges(ranges: Range[]): Range[] {
    const sorted = ranges.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
    const out: Range[] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else out.push([r[0], r[1]]);
    }
    return out;
}

/** The parts of `[from, to)` not covered by `ranges` (which must be merged and sorted). */
export function subtractRanges(from: number, to: number, ranges: Range[]): Range[] {
    const out: Range[] = [];
    let cursor = from;
    for (const [a, b] of ranges) {
        if (b <= cursor) continue;
        if (a >= to) break;
        if (a > cursor) out.push([cursor, Math.min(a, to)]);
        cursor = Math.max(cursor, b);
        if (cursor >= to) break;
    }
    if (cursor < to) out.push([cursor, to]);
    return out;
}

interface Meta {
    /** Ranges of bar open times fetched completely from the source. A bar missing inside one never traded. */
    ranges: Range[];
}

/**
 * Closed-bar history on disk. One directory per series, one file per UTC year, fixed 48-byte rows
 * (time, open, high, low, close, volume as Float64) — appends are a single write and reads are a
 * typed-array view. Coverage is tracked separately so a gap in trading is never mistaken for missing data.
 */
export class BarStore {
    readonly dir: string;
    private segments = new Map<string, BarSeries>();
    private metas = new Map<string, Meta>();
    private maxSegments: number;

    constructor(dir: string, opts: { maxCachedSegments?: number } = {}) {
        this.dir = dir;
        this.maxSegments = opts.maxCachedSegments ?? 48;
        mkdirSync(dir, { recursive: true });
    }

    private seriesDir(key: SeriesKey): string {
        return join(this.dir, key.provider, encodeURIComponent(key.ticker), key.timeframe);
    }

    private loadSegment(key: SeriesKey, year: number): BarSeries {
        const path = join(this.seriesDir(key), `${year}.bin`);
        const cached = this.segments.get(path);
        if (cached) {
            // refresh LRU position
            this.segments.delete(path);
            this.segments.set(path, cached);
            return cached;
        }
        let series = new BarSeries(16);
        if (existsSync(path)) {
            const file = readFileSync(path);
            const n = Math.floor(file.byteLength / ROW_BYTES);
            const rows = new Float64Array(file.buffer.slice(file.byteOffset, file.byteOffset + n * ROW_BYTES));
            series = new BarSeries(n);
            for (let i = 0, o = 0; i < n; i++, o += ROW) {
                series.time[i] = rows[o];
                series.open[i] = rows[o + 1];
                series.high[i] = rows[o + 2];
                series.low[i] = rows[o + 3];
                series.close[i] = rows[o + 4];
                series.volume[i] = rows[o + 5];
            }
            series.length = n;
        }
        this.segments.set(path, series);
        if (this.segments.size > this.maxSegments) this.segments.delete(this.segments.keys().next().value!);
        return series;
    }

    private static rows(series: BarSeries, from: number): Float64Array {
        const n = series.length - from;
        const rows = new Float64Array(n * ROW);
        for (let i = 0, o = 0; i < n; i++, o += ROW) {
            const j = from + i;
            rows[o] = series.time[j];
            rows[o + 1] = series.open[j];
            rows[o + 2] = series.high[j];
            rows[o + 3] = series.low[j];
            rows[o + 4] = series.close[j];
            rows[o + 5] = series.volume[j];
        }
        return rows;
    }

    /** Merge closed bars into the store (newer data wins on equal open times). */
    write(key: SeriesKey, bars: BarSeries | readonly Bar[]): void {
        const input = bars instanceof BarSeries ? bars : BarSeries.fromBars(bars);
        if (input.length === 0) return;
        const dir = this.seriesDir(key);
        mkdirSync(dir, { recursive: true });
        let start = 0;
        while (start < input.length) {
            const year = new Date(input.time[start]).getUTCFullYear();
            const yearEnd = Date.UTC(year + 1, 0, 1);
            let end = start;
            while (end < input.length && input.time[end] < yearEnd) end++;
            const chunk = input.slice(start, end);
            const segment = this.loadSegment(key, year);
            const path = join(dir, `${year}.bin`);
            const before = segment.length;
            const pureAppend = before === 0 || chunk.time[0] > segment.time[before - 1];
            segment.merge(chunk);
            if (pureAppend && before > 0) {
                appendFileSync(path, Buffer.from(BarStore.rows(segment, before).buffer));
            } else {
                const tmp = `${path}.tmp`;
                writeFileSync(tmp, Buffer.from(BarStore.rows(segment, 0).buffer));
                renameSync(tmp, path);
            }
            start = end;
        }
    }

    /** Closed bars with open time in `[from, to)`. */
    read(key: SeriesKey, from: number, to: number): BarSeries {
        const out = new BarSeries(1024);
        if (to <= from) return out;
        const firstYear = new Date(Math.max(from, 0)).getUTCFullYear();
        const lastYear = new Date(Math.min(to - 1, 8.64e15)).getUTCFullYear();
        for (let year = firstYear; year <= lastYear; year++) {
            const segment = this.loadSegment(key, year);
            if (segment.length === 0) continue;
            const a = segment.lowerBound(from);
            const b = segment.lowerBound(to);
            if (b > a) out.merge(segment.slice(a, b));
        }
        return out;
    }

    private meta(key: SeriesKey): Meta {
        const path = join(this.seriesDir(key), 'meta.json');
        let meta = this.metas.get(path);
        if (!meta) {
            try {
                meta = JSON.parse(readFileSync(path, 'utf8')) as Meta;
                if (!Array.isArray(meta.ranges)) meta = { ranges: [] };
            } catch {
                meta = { ranges: [] };
            }
            this.metas.set(path, meta);
        }
        return meta;
    }

    private saveMeta(key: SeriesKey, meta: Meta): void {
        const dir = this.seriesDir(key);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'meta.json');
        writeFileSync(`${path}.tmp`, JSON.stringify(meta));
        renameSync(`${path}.tmp`, path);
    }

    coverage(key: SeriesKey): Range[] {
        return this.meta(key).ranges.map((r) => [r[0], r[1]]);
    }

    /** Record that `[from, to)` was fetched completely from the source. */
    addCoverage(key: SeriesKey, from: number, to: number): void {
        if (to <= from) return;
        const meta = this.meta(key);
        meta.ranges = mergeRanges([...meta.ranges, [from, to]]);
        this.saveMeta(key, meta);
    }

    /** Extend coverage by `[from, to)` only if it touches an existing range — used for live-closed bars. */
    extendCoverage(key: SeriesKey, from: number, to: number): boolean {
        const meta = this.meta(key);
        if (!meta.ranges.some((r) => r[1] >= from && r[0] <= to)) return false;
        this.addCoverage(key, from, to);
        return true;
    }

    /** Parts of `[from, to)` that still have to be fetched. */
    missing(key: SeriesKey, from: number, to: number): Range[] {
        return subtractRanges(from, to, this.meta(key).ranges);
    }
}
