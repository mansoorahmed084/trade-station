import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { BacktestResult, StrategyDescription } from '@ts/backtest/api';
import { monteCarlo, type Report, type SideStats, type TradeRecord } from '@ts/backtest/report';
import { compareTrades, parseTvTrades, type TradeComparison, tradesToCsv } from '@ts/backtest/tv-trades';
import { normalizeTimeframe, timeframeLabel, timeframeMs } from '@ts/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type ChartMarker, setChartMarkers } from '../lib/chart-lines.ts';
import { stripChartType } from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';
import {
    choiceKey,
    type Market,
    type RangeChoice,
    runTester,
    type StrategyChoice,
    strategyRef,
    type TesterTab,
    useTester,
} from '../lib/tester-store.ts';
import { Button, Tabs } from '../ui.tsx';
import { EquityChart } from './tester/EquityChart.tsx';
import { dateTime, money, pct, price, qty, ratio, signed, tone } from './tester/format.ts';
import { Optimizer } from './tester/Optimizer.tsx';
import { TesterSettings } from './tester/Settings.tsx';

const TABS: { id: TesterTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'performance', label: 'Performance' },
    { id: 'trades', label: 'List of trades' },
    { id: 'optimize', label: 'Optimise' },
    { id: 'montecarlo', label: 'Monte Carlo' },
];

const RANGES: { label: string; value: string; range: RangeChoice }[] = [
    { label: 'Last 1,000 bars', value: 'b1000', range: { mode: 'bars', bars: 1000 } },
    { label: 'Last 5,000 bars', value: 'b5000', range: { mode: 'bars', bars: 5000 } },
    { label: 'Last 20,000 bars', value: 'b20000', range: { mode: 'bars', bars: 20_000 } },
    { label: 'Last 100,000 bars', value: 'b100000', range: { mode: 'bars', bars: 100_000 } },
    { label: 'Last 500,000 bars', value: 'b500000', range: { mode: 'bars', bars: 500_000 } },
    { label: 'Date range…', value: 'dates', range: { mode: 'dates', from: '', to: '' } },
    { label: 'Entire history', value: 'all', range: { mode: 'all' } },
];
const rangeValue = (r: RangeChoice) => (r.mode === 'bars' ? `b${r.bars}` : r.mode);
/** Small windows re-run on every change; a deep one waits for the Run button. */
const autoRuns = (r: RangeChoice) => r.mode === 'bars' && r.bars <= 20_000;

/** The symbol and timeframe of the active chart, without any chart-type suffix. */
function useChartMarket(workspace: VelaWorkspace): Market | null {
    const [market, setMarket] = useState<Market | null>(null);
    useEffect(() => {
        const read = () => {
            const m = (workspace.chart as any)?.market;
            const symbol = stripChartType(String(m?.symbol ?? ''));
            if (!symbol) return;
            let timeframe = String(m?.timeframe ?? '60');
            try {
                timeframe = normalizeTimeframe(timeframe);
            } catch {}
            setMarket((prev) =>
                prev && prev.symbol === symbol && prev.timeframe === timeframe ? prev : { symbol, timeframe },
            );
        };
        read();
        const timer = setInterval(read, 500);
        return () => clearInterval(timer);
    }, [workspace]);
    return market;
}

/** Entry and exit fills of a run as chart markers. */
function markersOf(trades: TradeRecord[]): ChartMarker[] {
    const out: ChartMarker[] = [];
    for (const t of trades) {
        const long = t.side === 'long';
        out.push({ time: t.entryTime, price: t.entryPrice, side: long ? 'buy' : 'sell', text: t.entryId });
        if (!t.open && t.exitTime !== undefined && t.exitPrice !== undefined) {
            out.push({ time: t.exitTime, price: t.exitPrice, side: long ? 'sell' : 'buy', text: signed(t.pnl) });
        }
    }
    return out;
}

/** The strategy tester: run a strategy over history and read the result. */
export function StrategyTester({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const market = useChartMarket(workspace);
    const choice = useTester((s) => s.choice);
    const draft = useTester((s) => s.draft);
    const range = useTester((s) => s.range);
    const tab = useTester((s) => s.tab);
    const result = useTester((s) => s.result);
    const running = useTester((s) => s.running);
    const error = useTester((s) => s.error);
    const stale = useTester((s) => s.stale);
    const showMarkers = useTester((s) => s.showMarkers);
    const inputs = useTester((s) => s.inputs[choiceKey(s.choice)]);
    const properties = useTester((s) => s.properties);
    const patch = useTester((s) => s.patch);
    const [natives, setNatives] = useState<(StrategyDescription & { id: string })[]>([]);
    const [scripts, setScripts] = useState<{ id: string; name: string; kind: string | null }[]>([]);
    const [settings, setSettings] = useState(false);

    useEffect(() => {
        client
            .json<(StrategyDescription & { id: string })[]>('/api/backtest/strategies')
            .then(setNatives)
            .catch(() => {});
        client
            .json<{ id: string; name: string; kind: string | null }[]>('/api/scripts')
            .then((list) => setScripts(list.filter((s) => s.kind === 'strategy')))
            .catch(() => {});
    }, [client]);

    // What the chosen strategy's inputs are, for the settings and the optimiser.
    const key = choiceKey(choice);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` and the draft's revision say when the strategy changed
    useEffect(() => {
        const strategy = strategyRef();
        patch({ description: null });
        if (!strategy) return;
        let live = true;
        client
            .post<StrategyDescription>('/api/backtest/describe', { strategy })
            .then((description) => live && patch({ description }))
            .catch((err) => live && patch({ error: String(err?.message ?? err) }));
        return () => {
            live = false;
        };
    }, [client, key, draft?.rev]);

    // Re-run when anything that changes the answer changes.
    const signature = JSON.stringify([key, draft?.rev, inputs, properties, range, market]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: the signature covers every setting a run reads
    useEffect(() => {
        if (!market) return;
        if (!autoRuns(range)) {
            patch({ stale: true });
            return;
        }
        const timer = setTimeout(() => void runTester(client, market), 200);
        return () => clearTimeout(timer);
    }, [client, signature]);

    // Mark the fills on every chart showing the tested market.
    useEffect(() => {
        const paint = () => {
            for (const cell of workspace.cells() as any[]) {
                const m = cell.chart?.market;
                let tf = String(m?.timeframe ?? '');
                try {
                    tf = normalizeTimeframe(tf);
                } catch {}
                const same =
                    !!result &&
                    showMarkers &&
                    stripChartType(String(m?.symbol ?? '')) === result.symbol &&
                    tf === result.timeframe;
                const want = same ? result : null;
                if (cell.__tsMarked === want) continue;
                cell.__tsMarked = want;
                setChartMarkers(cell, want ? markersOf(want.report.trades) : []);
            }
        };
        paint();
        const timer = setInterval(paint, 600);
        return () => clearInterval(timer);
    }, [workspace, result, showMarkers]);
    useEffect(
        () => () => {
            for (const cell of workspace.cells() as any[]) {
                cell.__tsMarked = null;
                setChartMarkers(cell, []);
            }
        },
        [workspace],
    );

    const choose = (value: string) => {
        const [kind, id] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
        const next: StrategyChoice =
            kind === 'native'
                ? { kind: 'native', id }
                : kind === 'pine'
                  ? { kind: 'pine', scriptId: id }
                  : { kind: 'draft' };
        patch({ choice: next, result: null, error: null, job: null });
    };
    const chooseRange = (value: string) => {
        const preset = RANGES.find((r) => r.value === value)?.range;
        if (!preset) return;
        if (preset.mode === 'dates') {
            const today = new Date().toISOString().slice(0, 10);
            const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
            patch({ range: { mode: 'dates', from: yearAgo, to: today } });
        } else patch({ range: preset });
    };

    const jump = (trade: TradeRecord) => {
        const chart: any = workspace.chart;
        if (!chart?.setVisibleRange || !result) return;
        const pad = 60 * timeframeMs(result.timeframe);
        chart.setVisibleRange({ from: trade.entryTime - pad, to: (trade.exitTime ?? trade.entryTime) + pad });
    };

    const report = result?.report;
    return (
        <div className="tester" data-testid="tester">
            <div className="tester-bar">
                <select
                    value={key === 'draft' ? 'draft:' : key}
                    onChange={(e) => choose(e.target.value)}
                    aria-label="Strategy"
                    data-testid="tester-strategy"
                >
                    <optgroup label="Built in">
                        {natives.map((s) => (
                            <option key={s.id} value={`native:${s.id}`}>
                                {s.title}
                            </option>
                        ))}
                    </optgroup>
                    <optgroup label="Pine strategies">
                        {scripts.map((s) => (
                            <option key={s.id} value={`pine:${s.id}`}>
                                {s.name}
                            </option>
                        ))}
                        {draft && <option value="draft:">{draft.title} (from the editor)</option>}
                    </optgroup>
                </select>
                <span className="tester-market" title="The tester follows the active chart" data-testid="tester-market">
                    {market ? `${market.symbol} · ${timeframeLabel(market.timeframe)}` : '—'}
                </span>
                <select
                    value={rangeValue(range)}
                    onChange={(e) => chooseRange(e.target.value)}
                    aria-label="History to test"
                >
                    {RANGES.map((r) => (
                        <option key={r.value} value={r.value}>
                            {r.label}
                        </option>
                    ))}
                </select>
                {range.mode === 'dates' && (
                    <>
                        <input
                            type="date"
                            aria-label="From"
                            value={range.from}
                            onChange={(e) => patch({ range: { ...range, from: e.target.value } })}
                        />
                        <input
                            type="date"
                            aria-label="To"
                            value={range.to}
                            onChange={(e) => patch({ range: { ...range, to: e.target.value } })}
                        />
                    </>
                )}
                <Button
                    variant={stale && !autoRuns(range) ? 'primary' : undefined}
                    disabled={!market || running}
                    onClick={() => market && runTester(client, market)}
                    data-testid="tester-run"
                >
                    {running ? 'Running…' : 'Run'}
                </Button>
                <Button variant="ghost" onClick={() => setSettings(true)} data-testid="tester-settings-open">
                    Settings
                </Button>
                <label className="check" title="Mark entries and exits on the chart">
                    <input
                        type="checkbox"
                        checked={showMarkers}
                        onChange={(e) => patch({ showMarkers: e.target.checked })}
                    />
                    Trades on chart
                </label>
                <span className="spacer" />
                {result && !error && (
                    <span className="muted tester-status" data-testid="tester-status">
                        {result.report.bars.toLocaleString('en-US')} bars · {result.report.all.trades} trades ·{' '}
                        {result.engine === 'pine' ? 'Pine' : 'native'} ·{' '}
                        {result.ms < 1000 ? `${Math.round(result.ms)} ms` : `${(result.ms / 1000).toFixed(1)} s`}
                    </span>
                )}
            </div>
            {error && (
                <div className="tester-error" data-testid="tester-error">
                    {error}
                </div>
            )}
            {result?.magnifier.note && <div className="tester-note">{result.magnifier.note}</div>}
            {result?.warnings.slice(0, 2).map((w) => (
                <div key={w} className="tester-note">
                    {w}
                </div>
            ))}
            <Tabs tabs={TABS} value={tab} onChange={(t) => patch({ tab: t })} />
            <div className={`tester-body ${running ? 'is-running' : ''}`}>
                {tab === 'optimize' ? (
                    <Optimizer client={client} market={market} />
                ) : !report ? (
                    <p className="muted pad">
                        {running ? 'Running…' : error ? '' : 'Choose a strategy to test it on the active chart.'}
                    </p>
                ) : tab === 'overview' ? (
                    <Overview result={result} />
                ) : tab === 'performance' ? (
                    <Performance report={report} />
                ) : tab === 'trades' ? (
                    <Trades result={result} onJump={jump} />
                ) : (
                    <MonteCarlo report={report} />
                )}
            </div>
            {settings && <TesterSettings onClose={() => setSettings(false)} />}
        </div>
    );
}

function Kpi(props: { label: string; value: string; sub?: string; tone?: string; title?: string }) {
    return (
        <div className="kpi" title={props.title}>
            <span>{props.label}</span>
            <b className={props.tone}>{props.value}</b>
            {props.sub && <small>{props.sub}</small>}
        </div>
    );
}

function Overview({ result }: { result: BacktestResult }) {
    const r = result.report;
    const drawdownPct = useMemo(
        () => r.equity.drawdown.map((d, i) => (r.equity.value[i] - d > 0 ? (d / (r.equity.value[i] - d)) * 100 : 0)),
        [r],
    );
    return (
        <div className="overview" data-testid="tester-overview">
            <div className="kpis">
                <Kpi
                    label="Net profit"
                    value={signed(r.netProfit)}
                    sub={pct(r.netProfitPct)}
                    tone={tone(r.netProfit)}
                />
                <Kpi
                    label="Max drawdown"
                    value={money(r.maxDrawdown)}
                    sub={pct(r.maxDrawdownPct)}
                    title="Largest fall of equity from a peak"
                />
                <Kpi label="Profit factor" value={ratio(r.all.profitFactor)} title="Gross profit ÷ gross loss" />
                <Kpi
                    label="Win rate"
                    value={`${r.all.winRatePct.toFixed(1)}%`}
                    sub={`${r.all.wins} of ${r.all.trades}`}
                />
                <Kpi
                    label="Closed trades"
                    value={String(r.all.trades)}
                    sub={`${r.exposurePct.toFixed(0)}% of bars in a position`}
                />
                <Kpi label="Sharpe" value={ratio(r.sharpe)} title="Annualised, from daily returns" />
                <Kpi
                    label="Buy & hold"
                    value={pct(r.buyHoldPct)}
                    title="Return of buying at the first bar and holding"
                />
            </div>
            <EquityChart
                time={r.equity.time}
                series={[
                    { name: 'Strategy', color: 'var(--series-1)', values: r.equity.value },
                    { name: 'Buy & hold', color: 'var(--series-2)', values: r.equity.buyHold },
                ]}
                drawdownPct={drawdownPct}
                height={270}
            />
        </div>
    );
}

const ROWS: { label: string; get: (s: SideStats) => string; tone?: (s: SideStats) => string }[] = [
    { label: 'Net profit', get: (s) => signed(s.netProfit), tone: (s) => tone(s.netProfit) },
    { label: 'Gross profit', get: (s) => money(s.grossProfit) },
    { label: 'Gross loss', get: (s) => money(s.grossLoss) },
    { label: 'Profit factor', get: (s) => ratio(s.profitFactor) },
    { label: 'Closed trades', get: (s) => String(s.trades) },
    { label: 'Winning trades', get: (s) => String(s.wins) },
    { label: 'Losing trades', get: (s) => String(s.losses) },
    { label: 'Win rate', get: (s) => `${s.winRatePct.toFixed(2)}%` },
    { label: 'Average trade', get: (s) => signed(s.avgTrade), tone: (s) => tone(s.avgTrade) },
    { label: 'Average win', get: (s) => money(s.avgWin) },
    { label: 'Average loss', get: (s) => money(s.avgLoss) },
    { label: 'Win ÷ loss ratio', get: (s) => ratio(s.payoff) },
    { label: 'Largest win', get: (s) => money(s.largestWin) },
    { label: 'Largest loss', get: (s) => money(s.largestLoss) },
    { label: 'Average bars in a trade', get: (s) => s.avgBarsInTrade.toFixed(1) },
];

function Performance({ report: r }: { report: Report }) {
    return (
        <div className="performance" data-testid="tester-performance">
            <table className="grid-table">
                <thead>
                    <tr>
                        <th />
                        <th className="num">All</th>
                        <th className="num">Long</th>
                        <th className="num">Short</th>
                    </tr>
                </thead>
                <tbody>
                    {ROWS.map((row) => (
                        <tr key={row.label}>
                            <td>{row.label}</td>
                            {[r.all, r.long, r.short].map((s, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: three fixed columns
                                <td key={i} className={`num ${row.tone?.(s) ?? ''}`}>
                                    {row.get(s)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="performance-side">
                <table className="grid-table">
                    <tbody>
                        {(
                            [
                                ['Initial capital', money(r.initialCapital)],
                                ['Final equity', money(r.finalEquity)],
                                ['Return', pct(r.netProfitPct)],
                                ['Annual growth (CAGR)', r.cagrPct === null ? '—' : pct(r.cagrPct)],
                                ['Max drawdown', `${money(r.maxDrawdown)} (${pct(r.maxDrawdownPct)})`],
                                ['Sharpe ratio', ratio(r.sharpe)],
                                ['Sortino ratio', ratio(r.sortino)],
                                ['Commission paid', money(r.commission)],
                                ['Time in the market', `${r.exposurePct.toFixed(1)}%`],
                                ['Buy & hold return', pct(r.buyHoldPct)],
                                ['Tested', `${dateTime(r.from, false)} → ${dateTime(r.to, false)}`],
                            ] as const
                        ).map(([label, value]) => (
                            <tr key={label}>
                                <td>{label}</td>
                                <td className="num">{value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {r.monthly.length > 1 && (
                    <div className="months">
                        <h4>Monthly returns</h4>
                        <div className="month-grid">
                            {r.monthly.slice(-36).map((m) => (
                                <div key={m.month} className="month" title={`${m.month}: ${signed(m.pnl)}`}>
                                    <span>{m.month}</span>
                                    <b className={tone(m.returnPct)}>{pct(m.returnPct, 1)}</b>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function Trades({ result, onJump }: { result: BacktestResult; onJump: (t: TradeRecord) => void }) {
    const trades = result.report.trades;
    const [shown, setShown] = useState(300);
    const [comparison, setComparison] = useState<TradeComparison | { error: string } | null>(null);
    const file = useRef<HTMLInputElement>(null);
    // Newest first, each with the running total up to it.
    const rows = useMemo(() => {
        let total = 0;
        return trades.map((t, i) => ({ t, n: i + 1, total: (total += t.open ? 0 : t.pnl) })).reverse();
    }, [trades]);

    const download = () => {
        const url = URL.createObjectURL(new Blob([tradesToCsv(trades)], { type: 'text/csv' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${result.title.replace(/[^\w-]+/g, '_')}_${result.symbol.replace(/[^\w-]+/g, '_')}_${result.timeframe}_trades.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
    const compare = async (f: File | undefined) => {
        if (!f) return;
        try {
            const theirs = parseTvTrades(await f.text());
            setComparison(compareTrades(trades, theirs, { barMs: timeframeMs(result.timeframe) }));
        } catch (err: any) {
            setComparison({ error: String(err?.message ?? err) });
        }
        if (file.current) file.current.value = '';
    };

    return (
        <div className="trades" data-testid="tester-trades">
            <div className="row trades-tools">
                <span className="muted">
                    {trades.length.toLocaleString('en-US')} trades · click a row to see it on the chart
                </span>
                <span className="grow" />
                <Button variant="ghost" onClick={download}>
                    Export CSV
                </Button>
                <Button
                    variant="ghost"
                    onClick={() => file.current?.click()}
                    title="Compare this run with a List of trades export from TradingView"
                >
                    Compare with a TradingView export…
                </Button>
                <input
                    ref={file}
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    data-testid="tv-file"
                    onChange={(e) => compare(e.target.files?.[0])}
                />
            </div>
            {comparison && 'error' in comparison && <div className="tester-error">{comparison.error}</div>}
            {comparison && !('error' in comparison) && (
                <div className="comparison" data-testid="tv-comparison">
                    <b>{comparison.agreementPct.toFixed(1)}% of trades agree.</b> {comparison.matched} of{' '}
                    {comparison.theirs} TradingView trades found here; {comparison.identical} identical in price, size
                    and exit time. {comparison.missing.length} only in TradingView, {comparison.extra.length} only here.
                    Largest price difference {comparison.maxPriceDiffPct.toFixed(4)}%.
                    {comparison.netProfit.diffPct !== null &&
                        ` Net profit differs by ${pct(comparison.netProfit.diffPct)}.`}
                    {comparison.mismatches.length > 0 && (
                        <ul>
                            {comparison.mismatches.slice(0, 8).map((m) => (
                                <li key={`${m.number}${m.field}`}>
                                    Trade {m.number}: {m.field} {m.field === 'exit time' ? dateTime(m.ours) : m.ours}{' '}
                                    here, {m.field === 'exit time' ? dateTime(m.theirs) : m.theirs} there
                                </li>
                            ))}
                        </ul>
                    )}
                    <button type="button" className="link" onClick={() => setComparison(null)}>
                        Dismiss
                    </button>
                </div>
            )}
            <div className="table-scroll">
                <table className="grid-table rows-click">
                    <thead>
                        <tr>
                            <th className="num">#</th>
                            <th>Side</th>
                            <th>Entry</th>
                            <th className="num">Price</th>
                            <th>Exit</th>
                            <th className="num">Price</th>
                            <th className="num">Quantity</th>
                            <th className="num">Profit</th>
                            <th className="num">Run-up</th>
                            <th className="num">Drawdown</th>
                            <th className="num">Cumulative</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.slice(0, shown).map(({ t, n, total }) => {
                            const cost = t.entryPrice * t.qty;
                            return (
                                <tr key={n} onClick={() => onJump(t)}>
                                    <td className="num muted">{n}</td>
                                    <td>{t.side === 'long' ? 'Long' : 'Short'}</td>
                                    <td>
                                        {dateTime(t.entryTime)} <span className="muted">{t.entryId}</span>
                                    </td>
                                    <td className="num">{price(t.entryPrice)}</td>
                                    <td>
                                        {t.open || t.exitTime === undefined ? (
                                            <span className="muted">Open</span>
                                        ) : (
                                            <>
                                                {dateTime(t.exitTime)}{' '}
                                                <span className="muted">
                                                    {t.exitId?.replace(/:(stop|limit)$/, ' $1')}
                                                </span>
                                            </>
                                        )}
                                    </td>
                                    <td className="num">{t.exitPrice === undefined ? '—' : price(t.exitPrice)}</td>
                                    <td className="num">{qty(t.qty)}</td>
                                    <td className={`num ${tone(t.pnl)}`}>
                                        {signed(t.pnl)}{' '}
                                        <span className="muted">{cost > 0 ? pct((t.pnl / cost) * 100) : ''}</span>
                                    </td>
                                    <td className="num">
                                        {t.maxRunup === undefined ? '—' : money(Math.abs(t.maxRunup))}
                                    </td>
                                    <td className="num">
                                        {t.maxDrawdown === undefined ? '—' : money(Math.abs(t.maxDrawdown))}
                                    </td>
                                    <td className={`num ${tone(total)}`}>{signed(total)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {rows.length > shown && (
                    <Button variant="ghost" onClick={() => setShown(shown + 1000)}>
                        Show more ({(rows.length - shown).toLocaleString('en-US')} older)
                    </Button>
                )}
            </div>
        </div>
    );
}

function MonteCarlo({ report }: { report: Report }) {
    const [runs, setRuns] = useState(2000);
    const mc = useMemo(() => monteCarlo(report.trades, report.initialCapital, runs, 7), [report, runs]);
    const closed = report.all.trades;
    const cols = ['p5', 'p25', 'p50', 'p75', 'p95'] as const;
    return (
        <div className="montecarlo" data-testid="tester-montecarlo">
            <p className="muted">
                The {closed} closed trades are replayed in {runs.toLocaleString('en-US')} random orders. The total is
                the same every time; the path is not — so this shows how much of the measured drawdown was down to the
                order the trades happened to come in.
            </p>
            <label className="inline">
                Reshuffles
                <select value={runs} onChange={(e) => setRuns(Number(e.target.value))}>
                    {[500, 2000, 10_000].map((n) => (
                        <option key={n} value={n}>
                            {n.toLocaleString('en-US')}
                        </option>
                    ))}
                </select>
            </label>
            {closed < 2 ? (
                <p className="muted">There are too few closed trades to reshuffle.</p>
            ) : (
                <table className="grid-table">
                    <thead>
                        <tr>
                            <th />
                            <th className="num">Worst 5%</th>
                            <th className="num">25%</th>
                            <th className="num">Median</th>
                            <th className="num">75%</th>
                            <th className="num">Best 5%</th>
                            <th className="num">This run</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Max drawdown</td>
                            {cols.map((c) => (
                                <td key={c} className="num">
                                    {pct(mc.maxDrawdownPct[c])}
                                </td>
                            ))}
                            <td className="num">{pct(report.maxDrawdownPct)}</td>
                        </tr>
                        <tr>
                            <td>Final equity</td>
                            {cols.map((c) => (
                                <td key={c} className="num">
                                    {money(mc.finalEquity[c])}
                                </td>
                            ))}
                            <td className="num">{money(report.finalEquity)}</td>
                        </tr>
                        <tr>
                            <td>Chance of losing everything</td>
                            <td className="num" colSpan={6}>
                                {mc.ruinPct.toFixed(2)}%
                            </td>
                        </tr>
                    </tbody>
                </table>
            )}
        </div>
    );
}
