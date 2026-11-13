import { BarSeries, normalizeTimeframe } from '@ts/core';

/** Build CSV text from bars. Times are ISO 8601 in UTC. */
export function barsToCsv(
    bars: { time: number; open: number; high: number; low: number; close: number; volume?: number }[],
): string {
    const lines = ['time,open,high,low,close,volume'];
    for (const b of bars)
        lines.push(`${new Date(b.time).toISOString()},${b.open},${b.high},${b.low},${b.close},${b.volume ?? ''}`);
    return `${lines.join('\n')}\n`;
}

export function download(filename: string, text: string, type = 'text/csv'): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the bars of a chart, as loaded right now, as CSV. Returns the number of bars written. */
export async function exportActiveChart(chart: any): Promise<number> {
    const market = chart.market as { symbol?: string; timeframe?: string; bars?: number };
    if (!market?.symbol) throw new Error('the chart has no symbol');
    const tf = normalizeTimeframe(market.timeframe ?? '60');
    const params = new URLSearchParams({
        symbol: market.symbol,
        tf,
        limit: String(Math.max(300, market.bars ?? 5000)),
    });
    const res = await fetch(`/api/bars?${params}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
    const bars = BarSeries.decode(await res.arrayBuffer()).toBars();
    const safe = market.symbol.replace(/[^A-Za-z0-9._-]+/g, '_');
    download(`${safe}_${tf}.csv`, barsToCsv(bars));
    return bars.length;
}
