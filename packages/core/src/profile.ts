/**
 * Market profiles: TPO (time-price opportunity) letters per session, with the point of control,
 * the value area and the initial balance. Pure functions over bars, shared by the chart and tests.
 */

export interface ProfileBar {
    time: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

export interface TpoRow {
    /** Bottom of the row's price band; the band is `[price, price + rowSize)`. */
    price: number;
    /** Period letters that traded in this band, in time order (`A` is the first period). */
    letters: string;
}

export interface TpoSession {
    start: number;
    end: number;
    rowSize: number;
    rows: TpoRow[];
    /** Band with the most letters (ties go to the one nearest the session's middle). */
    poc: number;
    /** Value area: the bands around the point of control holding `valueArea` of all letters. */
    vah: number;
    val: number;
    /** Initial balance: the range of the first `ibPeriods` periods. */
    ibHigh: number;
    ibLow: number;
    high: number;
    low: number;
    /** Letters in the whole session. */
    count: number;
    /** Periods the session has so far. */
    periods: number;
}

export interface TpoOptions {
    /** Length of one letter's period. Default 30 minutes. */
    periodMs?: number;
    /** Session length, from UTC midnight. Default one day. */
    sessionMs?: number;
    rowSize: number;
    /** Share of letters in the value area. Default 0.7. */
    valueArea?: number;
    /** Periods in the initial balance. Default 2 (the first hour). */
    ibPeriods?: number;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The letter of a period: A–Z, then a–z, then repeating. */
export const tpoLetter = (period: number): string => LETTERS[period % LETTERS.length];

/** A round row size near `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
    if (!(raw > 0) || !Number.isFinite(raw)) return 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) ?? 10 * mag;
}

/**
 * Profiles of every session the bars touch. Bars may be any timeframe up to the period length;
 * each bar marks the bands between its low and high with its period's letter (once per band).
 */
export function tpoProfiles(bars: readonly ProfileBar[], options: TpoOptions): TpoSession[] {
    const periodMs = options.periodMs ?? 30 * 60_000;
    const sessionMs = options.sessionMs ?? 86_400_000;
    const row = options.rowSize;
    const share = options.valueArea ?? 0.7;
    const ibPeriods = options.ibPeriods ?? 2;
    if (!(row > 0)) throw new Error('the row size must be above zero');
    const sessions = new Map<
        number,
        { cells: Map<number, Set<number>>; high: number; low: number; ibHigh: number; ibLow: number; last: number }
    >();
    for (const b of bars) {
        if (!Number.isFinite(b.high) || !Number.isFinite(b.low)) continue;
        const start = Math.floor(b.time / sessionMs) * sessionMs;
        const period = Math.floor((b.time - start) / periodMs);
        let s = sessions.get(start);
        if (!s) {
            s = { cells: new Map(), high: -Infinity, low: Infinity, ibHigh: -Infinity, ibLow: Infinity, last: 0 };
            sessions.set(start, s);
        }
        s.high = Math.max(s.high, b.high);
        s.low = Math.min(s.low, b.low);
        s.last = Math.max(s.last, period);
        if (period < ibPeriods) {
            s.ibHigh = Math.max(s.ibHigh, b.high);
            s.ibLow = Math.min(s.ibLow, b.low);
        }
        // Bands are indexed by integer steps so floating point never splits one band in two.
        const lo = Math.floor(b.low / row + 1e-9);
        const hi = Math.floor(b.high / row + 1e-9);
        for (let k = lo; k <= hi; k++) {
            let set = s.cells.get(k);
            if (!set) {
                set = new Set();
                s.cells.set(k, set);
            }
            set.add(period);
        }
    }
    const out: TpoSession[] = [];
    for (const [start, s] of [...sessions].sort((a, b) => a[0] - b[0])) {
        const keys = [...s.cells.keys()].sort((a, b) => a - b);
        const counts = keys.map((k) => s.cells.get(k)!.size);
        const total = counts.reduce((a, c) => a + c, 0);
        // Point of control: most letters; a tie goes to the band nearest the middle of the range.
        const mid = (keys[0] + keys[keys.length - 1]) / 2;
        let poc = 0;
        for (let i = 1; i < keys.length; i++) {
            if (
                counts[i] > counts[poc] ||
                (counts[i] === counts[poc] && Math.abs(keys[i] - mid) < Math.abs(keys[poc] - mid))
            )
                poc = i;
        }
        // Value area: grow from the point of control, each step taking the side with more letters.
        let lo = poc;
        let hi = poc;
        let inside = counts[poc];
        while (inside < total * share && (lo > 0 || hi < keys.length - 1)) {
            const up = hi < keys.length - 1 ? counts[hi + 1] : -1;
            const down = lo > 0 ? counts[lo - 1] : -1;
            if (up >= down) inside += counts[++hi];
            else inside += counts[--lo];
        }
        const price = (k: number) => Number((k * row).toPrecision(12));
        out.push({
            start,
            end: start + sessionMs,
            rowSize: row,
            rows: keys.map((k) => ({
                price: price(k),
                letters: [...s.cells.get(k)!]
                    .sort((a, b) => a - b)
                    .map(tpoLetter)
                    .join(''),
            })),
            poc: price(keys[poc]),
            vah: price(keys[hi]),
            val: price(keys[lo]),
            ibHigh: s.ibHigh,
            ibLow: s.ibLow,
            high: s.high,
            low: s.low,
            count: total,
            periods: s.last + 1,
        });
    }
    return out;
}

export interface FootprintLevel {
    /** Bottom of the level's price band, `[price, price + rowSize)`. */
    price: number;
    /** Volume bought by aggressive buyers (at the ask) and sold by aggressive sellers (at the bid). */
    buy: number;
    sell: number;
}

export interface FootprintBar {
    time: number;
    /** Lowest price first. */
    levels: FootprintLevel[];
    buy: number;
    sell: number;
    /** Buy volume less sell volume. */
    delta: number;
    /** The level with the most volume. */
    poc: number;
    trades: number;
}

/**
 * Volume footprints: each bar's trades split by price level and by the aggressor's side.
 * `barTimes` are the bars' open times (ascending); a trade belongs to the last bar that opened at
 * or before it, up to `barMs` after that bar's open.
 */
export function footprints(
    barTimes: readonly number[],
    barMs: number,
    trades: readonly { time: number; price: number; size: number; side?: 'buy' | 'sell' }[],
    rowSize: number,
): FootprintBar[] {
    if (!(rowSize > 0)) throw new Error('the row size must be above zero');
    const out: FootprintBar[] = barTimes.map((time) => ({
        time,
        levels: [],
        buy: 0,
        sell: 0,
        delta: 0,
        poc: Number.NaN,
        trades: 0,
    }));
    const cells = barTimes.map(() => new Map<number, FootprintLevel>());
    let i = 0;
    for (const t of trades) {
        while (i < barTimes.length - 1 && t.time >= barTimes[i + 1]) i++;
        if (t.time < barTimes[i] || t.time >= barTimes[i] + barMs) continue;
        const k = Math.floor(t.price / rowSize + 1e-9);
        let level = cells[i].get(k);
        if (!level) {
            level = { price: Number((k * rowSize).toPrecision(12)), buy: 0, sell: 0 };
            cells[i].set(k, level);
        }
        if (t.side === 'sell') level.sell += t.size;
        else level.buy += t.size;
        out[i].trades++;
    }
    for (let b = 0; b < out.length; b++) {
        const levels = [...cells[b].values()].sort((x, y) => x.price - y.price);
        let best = Number.NaN;
        let most = -1;
        for (const l of levels) {
            l.buy = Number(l.buy.toPrecision(12));
            l.sell = Number(l.sell.toPrecision(12));
            out[b].buy += l.buy;
            out[b].sell += l.sell;
            if (l.buy + l.sell > most) {
                most = l.buy + l.sell;
                best = l.price;
            }
        }
        out[b].levels = levels;
        out[b].buy = Number(out[b].buy.toPrecision(12));
        out[b].sell = Number(out[b].sell.toPrecision(12));
        out[b].delta = Number((out[b].buy - out[b].sell).toPrecision(12));
        out[b].poc = best;
    }
    return out;
}
