/**
 * Timeframes use TradingView's canonical notation:
 *   seconds `1S` `15S` · minutes as a bare integer `1` `60` `240` · `1D` · `1W` · `1M`.
 * Bar opens are aligned to UTC: weeks start Monday, months are calendar months.
 */

export type TimeframeUnit = 'S' | 'm' | 'D' | 'W' | 'M';

export interface ParsedTimeframe {
    n: number;
    unit: TimeframeUnit;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
/** 1970-01-05, the first Monday after the epoch. */
const FIRST_MONDAY = 4 * DAY;

const cache = new Map<string, ParsedTimeframe>();

/** Parse any accepted spelling (`60`, `1h`, `4H`, `1d`, `D`, `1W`, `15S`, `3M`). Throws on garbage. */
export function parseTimeframe(tf: string): ParsedTimeframe {
    const hit = cache.get(tf);
    if (hit) return hit;
    const m = /^(\d*)([a-zA-Z]?)$/.exec(tf.trim());
    if (!m || (m[1] === '' && m[2] === '')) throw new Error(`Invalid timeframe: "${tf}"`);
    const n = m[1] === '' ? 1 : Number(m[1]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid timeframe: "${tf}"`);
    let parsed: ParsedTimeframe;
    switch (m[2]) {
        case '':
        case 'm':
            parsed = { n, unit: 'm' };
            break;
        case 'h':
        case 'H':
            parsed = { n: n * 60, unit: 'm' };
            break;
        case 's':
        case 'S':
            parsed = { n, unit: 'S' };
            break;
        case 'd':
        case 'D':
            parsed = { n, unit: 'D' };
            break;
        case 'w':
        case 'W':
            parsed = { n, unit: 'W' };
            break;
        case 'M':
            parsed = { n, unit: 'M' };
            break;
        default:
            throw new Error(`Invalid timeframe: "${tf}"`);
    }
    cache.set(tf, parsed);
    return parsed;
}

/** Canonical spelling: `60`, `15S`, `1D`, `1W`, `1M`. */
export function normalizeTimeframe(tf: string): string {
    const { n, unit } = parseTimeframe(tf);
    return unit === 'm' ? String(n) : `${n}${unit}`;
}

/** Bar duration in ms. Months are nominal (30 days) — use `barCloseTime` for exact boundaries. */
export function timeframeMs(tf: string): number {
    const { n, unit } = parseTimeframe(tf);
    switch (unit) {
        case 'S':
            return n * SECOND;
        case 'm':
            return n * MINUTE;
        case 'D':
            return n * DAY;
        case 'W':
            return n * WEEK;
        case 'M':
            return n * 30 * DAY;
    }
}

/** Open time of the bar that contains `time`. */
export function barOpenTime(time: number, tf: string): number {
    const { n, unit } = parseTimeframe(tf);
    if (unit === 'M') {
        const d = new Date(time);
        const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
        const start = Math.floor(idx / n) * n;
        return Date.UTC(Math.floor(start / 12), start % 12, 1);
    }
    if (unit === 'W') {
        const span = n * WEEK;
        return Math.floor((time - FIRST_MONDAY) / span) * span + FIRST_MONDAY;
    }
    const span = unit === 'S' ? n * SECOND : unit === 'm' ? n * MINUTE : n * DAY;
    return Math.floor(time / span) * span;
}

/** Close time (exclusive) of the bar that opens at `open`. */
export function barCloseTime(open: number, tf: string): number {
    const { n, unit } = parseTimeframe(tf);
    if (unit === 'M') {
        const d = new Date(open);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
    }
    return open + timeframeMs(tf);
}

/** True when every `fine` bar falls inside exactly one `coarse` bar, so `coarse` can be built from `fine`. */
export function canAggregate(fine: string, coarse: string): boolean {
    const f = parseTimeframe(fine);
    const c = parseTimeframe(coarse);
    const rank = { S: 0, m: 1, D: 2, W: 3, M: 4 } as const;
    if (rank[f.unit] > rank[c.unit]) return false;
    if (f.unit === 'M') return c.n % f.n === 0;
    if (c.unit === 'M') return f.unit !== 'W' && DAY % timeframeMs(fine) === 0;
    if (c.unit === 'W') return f.unit === 'W' ? c.n % f.n === 0 : DAY % timeframeMs(fine) === 0;
    return timeframeMs(coarse) % timeframeMs(fine) === 0;
}

/** Human label: `1m`, `4h`, `1D`. */
export function timeframeLabel(tf: string): string {
    const { n, unit } = parseTimeframe(tf);
    if (unit === 'm') return n % 60 === 0 ? `${n / 60}h` : `${n}m`;
    if (unit === 'S') return `${n}s`;
    return `${n}${unit}`;
}
