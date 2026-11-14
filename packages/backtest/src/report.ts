import type { BarSeries } from '@ts/core';

/**
 * Performance report built from a trade list and the bars it was traded on. It does not care which
 * engine produced the trades, so Pine strategies and native ones are measured the same way.
 * This module has no Node dependencies: the app imports it too.
 */

export interface TradeRecord {
    side: 'long' | 'short';
    qty: number;
    entryTime: number;
    entryPrice: number;
    entryId?: string;
    exitTime?: number;
    exitPrice?: number;
    exitId?: string;
    /** Net result: realised for a closed trade, marked to the last bar for an open one. */
    pnl: number;
    commission: number;
    maxRunup?: number;
    maxDrawdown?: number;
    open: boolean;
}

export interface SideStats {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    netProfit: number;
    grossProfit: number;
    grossLoss: number;
    /** Gross profit ÷ gross loss. `null` when there were no losing trades. */
    profitFactor: number | null;
    avgTrade: number;
    avgWin: number;
    avgLoss: number;
    /** Average win ÷ average loss. */
    payoff: number | null;
    largestWin: number;
    largestLoss: number;
    avgBarsInTrade: number;
}

export interface Report {
    initialCapital: number;
    finalEquity: number;
    netProfit: number;
    netProfitPct: number;
    /** Largest peak-to-valley fall of bar-close equity, in currency and as a share of the peak. */
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpe: number | null;
    sortino: number | null;
    cagrPct: number | null;
    buyHoldPct: number;
    /** Share of bars with a position open. */
    exposurePct: number;
    commission: number;
    all: SideStats;
    long: SideStats;
    short: SideStats;
    /**
     * Bar-close equity, thinned to at most ~1,500 points. `drawdown` is ≤ 0. `buyHold` is what the
     * same capital would be worth had it bought at the first close and held.
     */
    equity: { time: number[]; value: number[]; drawdown: number[]; buyHold: number[] };
    monthly: { month: string; pnl: number; returnPct: number }[];
    trades: TradeRecord[];
    bars: number;
    from: number;
    to: number;
}

const MAX_POINTS = 1500;
const DAY = 86_400_000;

function sideStats(trades: TradeRecord[], barMs: number): SideStats {
    const closed = trades.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);
    const sum = (list: TradeRecord[]) => list.reduce((a, t) => a + t.pnl, 0);
    const grossProfit = sum(wins);
    const grossLoss = -sum(losses);
    const avgWin = wins.length ? grossProfit / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const bars = closed.reduce((a, t) => a + Math.max(0, ((t.exitTime ?? t.entryTime) - t.entryTime) / barMs), 0);
    return {
        trades: closed.length,
        wins: wins.length,
        losses: losses.length,
        winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
        netProfit: grossProfit - grossLoss,
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
        avgTrade: closed.length ? (grossProfit - grossLoss) / closed.length : 0,
        avgWin,
        avgLoss,
        payoff: avgLoss > 0 ? avgWin / avgLoss : null,
        largestWin: wins.reduce((a, t) => Math.max(a, t.pnl), 0),
        largestLoss: losses.reduce((a, t) => Math.min(a, t.pnl), 0),
        avgBarsInTrade: closed.length ? bars / closed.length : 0,
    };
}

/**
 * Equity at each bar close: capital, plus every trade closed by then, plus open trades marked to
 * that bar's close. Returns the curve and how many bars had a position open.
 */
export function equityCurve(
    trades: TradeRecord[],
    bars: BarSeries,
    initialCapital: number,
): { equity: Float64Array; inMarket: number } {
    const n = bars.length;
    const equity = new Float64Array(n);
    const byEntry = [...trades].sort((a, b) => a.entryTime - b.entryTime);
    let next = 0;
    let realized = 0;
    let active: TradeRecord[] = [];
    let inMarket = 0;
    for (let i = 0; i < n; i++) {
        const t = bars.time[i];
        while (next < byEntry.length && byEntry[next].entryTime <= t) active.push(byEntry[next++]);
        let unrealized = 0;
        let stillOpen = false;
        const keep: TradeRecord[] = [];
        for (const trade of active) {
            if (!trade.open && trade.exitTime !== undefined && trade.exitTime <= t) realized += trade.pnl;
            else {
                keep.push(trade);
                stillOpen = true;
                unrealized += (bars.close[i] - trade.entryPrice) * trade.qty * (trade.side === 'long' ? 1 : -1);
            }
        }
        active = keep;
        if (stillOpen) inMarket++;
        equity[i] = initialCapital + realized + unrealized;
    }
    return { equity, inMarket };
}

export function buildReport(
    trades: TradeRecord[],
    bars: BarSeries,
    initialCapital: number,
    barMs: number,
    periodsPerYear = 365,
): Report {
    const n = bars.length;
    const { equity, inMarket } = equityCurve(trades, bars, initialCapital);

    // Drawdown from the running peak.
    const drawdown = new Float64Array(n);
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPct = 0;
    for (let i = 0; i < n; i++) {
        if (equity[i] > peak) peak = equity[i];
        drawdown[i] = equity[i] - peak;
        if (drawdown[i] < maxDrawdown) maxDrawdown = drawdown[i];
        if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, (drawdown[i] / peak) * 100);
    }

    // Daily returns for the risk ratios; month-end equity for the monthly table. A calendar month is
    // only worked out when the day changes, which keeps this cheap on a million intraday bars.
    const daily: number[] = [];
    const monthly: Report['monthly'] = [];
    let dayStart = initialCapital;
    let monthStart = initialCapital;
    const monthOf = (time: number) => {
        const d = new Date(time);
        return d.getUTCFullYear() * 12 + d.getUTCMonth();
    };
    for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        if (!last && Math.floor(bars.time[i + 1] / DAY) === Math.floor(bars.time[i] / DAY)) continue;
        if (dayStart > 0) daily.push(equity[i] / dayStart - 1);
        dayStart = equity[i];
        const month = monthOf(bars.time[i]);
        if (last || monthOf(bars.time[i + 1]) !== month) {
            monthly.push({
                month: `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, '0')}`,
                pnl: equity[i] - monthStart,
                returnPct: monthStart > 0 ? (equity[i] / monthStart - 1) * 100 : 0,
            });
            monthStart = equity[i];
        }
    }
    const mean = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
    const variance = daily.length > 1 ? daily.reduce((a, r) => a + (r - mean) ** 2, 0) / (daily.length - 1) : 0;
    const downside = daily.length > 1 ? daily.reduce((a, r) => a + Math.min(0, r) ** 2, 0) / (daily.length - 1) : 0;
    const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(periodsPerYear) : null;
    const sortino = downside > 0 ? (mean / Math.sqrt(downside)) * Math.sqrt(periodsPerYear) : null;

    const finalEquity = n ? equity[n - 1] : initialCapital;
    const from = n ? bars.time[0] : 0;
    const to = n ? bars.time[n - 1] : 0;
    const years = (to - from) / (365.25 * DAY);
    const cagrPct =
        years > 0.02 && finalEquity > 0 && initialCapital > 0
            ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100
            : null;

    // Thin the curve for display, always keeping the last point and the deepest drawdown.
    const stride = Math.max(1, Math.ceil(n / MAX_POINTS));
    let deepest = 0;
    for (let i = 1; i < n; i++) if (drawdown[i] < drawdown[deepest]) deepest = i;
    const points = {
        time: [] as number[],
        value: [] as number[],
        drawdown: [] as number[],
        buyHold: [] as number[],
    };
    const firstClose = n ? bars.close[0] : 0;
    for (let i = 0; i < n; i++) {
        if (i % stride !== 0 && i !== n - 1 && i !== deepest) continue;
        points.time.push(bars.time[i]);
        points.value.push(equity[i]);
        points.drawdown.push(drawdown[i]);
        points.buyHold.push(firstClose > 0 ? (initialCapital * bars.close[i]) / firstClose : initialCapital);
    }

    return {
        initialCapital,
        finalEquity,
        netProfit: finalEquity - initialCapital,
        netProfitPct: initialCapital > 0 ? (finalEquity / initialCapital - 1) * 100 : 0,
        maxDrawdown,
        maxDrawdownPct,
        sharpe,
        sortino,
        cagrPct,
        buyHoldPct: n && bars.close[0] > 0 ? (bars.close[n - 1] / bars.close[0] - 1) * 100 : 0,
        exposurePct: n ? (inMarket / n) * 100 : 0,
        commission: trades.reduce((a, t) => a + t.commission, 0),
        all: sideStats(trades, barMs),
        long: sideStats(
            trades.filter((t) => t.side === 'long'),
            barMs,
        ),
        short: sideStats(
            trades.filter((t) => t.side === 'short'),
            barMs,
        ),
        equity: points,
        monthly,
        trades,
        bars: n,
        from,
        to,
    };
}

/** The handful of numbers a parameter search ranks by. */
export function summarize(report: Report): {
    netProfit: number;
    netProfitPct: number;
    maxDrawdownPct: number;
    profitFactor: number | null;
    sharpe: number | null;
    winRatePct: number;
    trades: number;
} {
    return {
        netProfit: report.netProfit,
        netProfitPct: report.netProfitPct,
        maxDrawdownPct: report.maxDrawdownPct,
        profitFactor: report.all.profitFactor,
        sharpe: report.sharpe,
        winRatePct: report.all.winRatePct,
        trades: report.all.trades,
    };
}

export interface MonteCarloResult {
    runs: number;
    /** Percentiles of the final equity and of the worst drawdown across the reshuffled runs. */
    finalEquity: { p5: number; p25: number; p50: number; p75: number; p95: number };
    maxDrawdownPct: { p5: number; p25: number; p50: number; p75: number; p95: number };
    /** Share of runs in which equity reached zero. */
    ruinPct: number;
}

/**
 * Reshuffle the order of the closed trades many times. The total is the same every time; what
 * changes is the path, and so the drawdown — an estimate of how much of the measured drawdown was luck.
 */
export function monteCarlo(trades: TradeRecord[], initialCapital: number, runs = 1000, seed = 1): MonteCarloResult {
    const pnls = trades.filter((t) => !t.open).map((t) => t.pnl);
    let a = seed >>> 0;
    const rnd = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const finals: number[] = [];
    const drawdowns: number[] = [];
    let ruined = 0;
    const order = pnls.map((_, i) => i);
    for (let r = 0; r < runs; r++) {
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        let equity = initialCapital;
        let peak = initialCapital;
        let worst = 0;
        let broke = false;
        for (const i of order) {
            equity += pnls[i];
            if (equity > peak) peak = equity;
            if (peak > 0) worst = Math.min(worst, ((equity - peak) / peak) * 100);
            if (equity <= 0) broke = true;
        }
        finals.push(equity);
        drawdowns.push(worst);
        if (broke) ruined++;
    }
    const pct = (list: number[]) => {
        const s = [...list].sort((x, y) => x - y);
        const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
        return { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
    };
    return {
        runs,
        finalEquity: pct(finals),
        maxDrawdownPct: pct(drawdowns),
        ruinPct: runs ? (ruined / runs) * 100 : 0,
    };
}
