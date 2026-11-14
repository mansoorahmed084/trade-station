/** Number and date formatting shared by the tester's views. */

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');

export const money = (v: number, digits = 2): string =>
    `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** `+1,234.50` / `−87.10` */
export const signed = (v: number, digits = 2): string => `${sign(v)}${money(Math.abs(v), digits)}`;

/** `+12.34%` */
export const pct = (v: number, digits = 2): string => `${sign(v)}${Math.abs(v).toFixed(digits)}%`;

/** A ratio that may not exist (no losing trade, say). */
export const ratio = (v: number | null | undefined, digits = 2): string =>
    v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/** Axis-sized numbers: in full below 10,000, then 12.5K / 3.2M. */
export function compact(v: number): string {
    const a = Math.abs(v);
    const s = v < 0 ? '−' : '';
    if (a >= 1e9) return `${s}${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
    if (a >= 1e6) return `${s}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e4) return `${s}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
    return `${s}${a.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : 0 })}`;
}

/**
 * Labels for one axis: every tick in the same unit, with just enough decimals to tell neighbouring
 * ticks apart (10.05K and 10.10K, never 10.1K twice).
 */
export function axisLabels(ticks: number[]): string[] {
    const top = Math.max(...ticks.map(Math.abs), 0);
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : top || 1;
    const [unit, suffix] = top >= 1e6 ? [1e6, 'M'] : top >= 1e4 ? [1e3, 'K'] : [1, ''];
    const digits = Math.min(4, Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9)));
    return ticks.map(
        (v) =>
            `${v < 0 ? '−' : ''}${(Math.abs(v) / unit).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`,
    );
}

/** A price with as many decimals as it needs, up to 8. */
export const price = (v: number): string =>
    v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 1 ? 8 : 4 });

export const qty = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 6 });

const two = (n: number) => String(n).padStart(2, '0');

/** `2025-03-14 09:30` in UTC, the clock every bar is stamped in. */
export function dateTime(ms: number, withTime = true): string {
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    return withTime ? `${date} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : date;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An axis label suited to how much time the whole axis covers. */
export function axisDate(ms: number, spanMs: number): string {
    const d = new Date(ms);
    if (spanMs < 3 * 86_400_000) return `${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
    if (spanMs < 300 * 86_400_000) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `pos` / `neg` class for a signed result. The sign is always printed too, so colour never stands alone. */
export const tone = (v: number): string => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

/** Round tick values covering `[min, max]`. */
export function niceTicks(min: number, max: number, count = 4): number[] {
    if (!(max > min)) return [min];
    const raw = (max - min) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
    return out;
}
