/**
 * Compare a backtest here against TradingView's own trade list.
 *
 * In TradingView: put the strategy on a chart, open the Strategy Tester, and use "Export data" →
 * "List of trades". Then run the same strategy over the same symbol, timeframe and dates here and
 * let this tool line the two lists up. It needs the server running (`npm start`), because the run
 * uses the server's stored history.
 *
 *   node tests/golden/compare-tv-trades.ts <trades.csv> --symbol BINANCE:BTCUSDT --tf 60 \
 *        --pine strategy.pine | --native ema-cross \
 *        [--from 2024-01-01] [--to 2024-06-30] [--tz-offset 0] [--inputs '{"Fast EMA":9}'] \
 *        [--properties '{"initialCapital":10000}'] [--server http://127.0.0.1:8787]
 *
 * Without --from/--to the window is taken from the export itself: from 500 bars before its first
 * trade (for indicators to warm up, as they had on TradingView's chart) to its last exit. When the
 * strategy sizes orders by percent of equity, give --from the first bar of TradingView's backtest:
 * equity, and so every quantity, depends on where the run began.
 * `--tz-offset` is the chart's time zone in minutes east of UTC when the list was exported.
 * Exits non-zero when fewer than 99% of trades agree.
 */
import { readFileSync } from 'node:fs';
import { type BacktestResult, compareTrades, parseTvTrades } from '@ts/backtest';
import { normalizeTimeframe, timeframeMs } from '@ts/core';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const file = args[0];
const symbol = flag('symbol');
const tf = flag('tf');
if (!file || file.startsWith('--') || !symbol || !tf || (!flag('pine') && !flag('native'))) {
    console.error(
        'usage: node tests/golden/compare-tv-trades.ts <trades.csv> --symbol S --tf TF (--pine file.pine | --native id) [--from D] [--to D] [--tz-offset MIN] [--inputs JSON] [--properties JSON] [--server URL]',
    );
    process.exit(2);
}

const timeframe = normalizeTimeframe(tf);
const barMs = timeframeMs(timeframe);
const theirs = parseTvTrades(readFileSync(file, 'utf8'), { utcOffsetMinutes: Number(flag('tz-offset') ?? 0) });
if (theirs.length === 0) {
    console.error('no trades found in the export');
    process.exit(2);
}
const from = flag('from') ? Date.parse(flag('from')!) : theirs[0].entryTime - 500 * barMs;
const lastExit = Math.max(...theirs.map((t) => t.exitTime ?? t.entryTime));
const to = flag('to') ? Date.parse(flag('to')!) : lastExit + barMs;

const server = flag('server') ?? 'http://127.0.0.1:8787';
const body = {
    strategy: flag('pine')
        ? { kind: 'pine', source: readFileSync(flag('pine')!, 'utf8') }
        : { kind: 'native', id: flag('native') },
    symbol,
    timeframe,
    from,
    to,
    inputs: flag('inputs') ? JSON.parse(flag('inputs')!) : undefined,
    properties: flag('properties') ? JSON.parse(flag('properties')!) : undefined,
};
const res = await fetch(`${server}/api/backtest/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
});
const result = (await res.json()) as BacktestResult & { error?: string };
if (!res.ok) {
    console.error(`the run failed: ${result.error}`);
    process.exit(2);
}

// Only trades TradingView could also have taken: those entered inside its own list's span.
const ours = result.report.trades.filter((t) => t.entryTime >= theirs[0].entryTime - barMs && t.entryTime <= lastExit);
const c = compareTrades(ours, theirs, { barMs });
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
console.log(
    `${result.title} on ${symbol} ${timeframe}, ${stamp(from)} → ${stamp(to)} (${result.report.bars} bars, ${result.engine} engine)`,
);
console.log(`trades: ${c.ours} here, ${c.theirs} in TradingView; ${c.matched} matched, ${c.identical} identical`);
console.log(`agreement: ${c.agreementPct.toFixed(2)}%   largest price difference: ${c.maxPriceDiffPct.toFixed(5)}%`);
if (c.netProfit.diffPct !== null) {
    console.log(
        `net profit: ${c.netProfit.ours.toFixed(2)} here, ${c.netProfit.theirs.toFixed(2)} there (${c.netProfit.diffPct >= 0 ? '+' : ''}${c.netProfit.diffPct.toFixed(3)}%)`,
    );
}
for (const t of c.missing.slice(0, 10))
    console.log(`  only in TradingView: #${t.number} ${t.side} ${stamp(t.entryTime)} @ ${t.entryPrice}`);
for (const t of c.extra.slice(0, 10)) console.log(`  only here: ${t.side} ${stamp(t.entryTime)} @ ${t.entryPrice}`);
for (const m of c.mismatches.slice(0, 20)) {
    const show = (v: number) => (m.field === 'exit time' ? stamp(v) : String(v));
    console.log(`  #${m.number} ${m.field}: ${show(m.ours)} here, ${show(m.theirs)} there`);
}
const sizes = c.mismatches.filter((m) => m.field === 'quantity').length;
if (sizes >= 3 && sizes === c.mismatches.filter((m) => m.field !== 'profit').length && !flag('from')) {
    console.log(
        "\nOnly quantities differ. With sizing by percent of equity the run must start on the same bar as\nTradingView's did: pass --from with the date of the first bar of its backtest.",
    );
}
if (c.agreementPct < 99) process.exitCode = 1;
