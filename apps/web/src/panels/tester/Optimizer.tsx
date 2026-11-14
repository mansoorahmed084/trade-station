import type { InputMeta, JobEvent, JobStatus, OptimizeRow } from '@ts/backtest/api';
import { useEffect, useMemo, useState } from 'react';
import type { ServerClient } from '../../lib/client.ts';
import {
    buildRequest,
    choiceKey,
    type Market,
    type OptimizerSetup,
    useTester,
    type Vary,
} from '../../lib/tester-store.ts';
import { Button } from '../../ui.tsx';
import { EquityChart } from './EquityChart.tsx';
import { dateTime, pct, ratio, signed, tone } from './format.ts';

type Objective = JobStatus['objective'];
const OBJECTIVES: { id: Objective; label: string }[] = [
    { id: 'netProfit', label: 'Net profit' },
    { id: 'returnOverDrawdown', label: 'Return ÷ drawdown' },
    { id: 'profitFactor', label: 'Profit factor' },
    { id: 'sharpe', label: 'Sharpe ratio' },
    { id: 'maxDrawdown', label: 'Smallest drawdown' },
    { id: 'winRate', label: 'Win rate' },
];

const isNumber = (m: InputMeta) => m.type === 'int' || m.type === 'float';

function defaultVary(m: InputMeta): Vary {
    const d = Number(m.defval) || 1;
    const step =
        m.step ?? (m.type === 'int' ? Math.max(1, Math.round(d / 10)) : Number((d / 10).toPrecision(1)) || 0.1);
    const clamp = (v: number) =>
        Math.min(m.max ?? Number.POSITIVE_INFINITY, Math.max(m.min ?? Number.NEGATIVE_INFINITY, v));
    const snap = (v: number) => (m.type === 'int' ? Math.round(v) : Number(v.toPrecision(6)));
    return { on: false, from: snap(clamp(d / 2)), to: snap(clamp(d * 2)), step };
}

const countOf = (v: Vary) => (v.step > 0 && v.to >= v.from ? Math.floor((v.to - v.from) / v.step + 1e-9) + 1 : 0);

/** Parameter search and walk-forward testing for the strategy under test. */
export function Optimizer({ client, market }: { client: ServerClient; market: Market | null }) {
    const description = useTester((s) => s.description);
    const key = useTester((s) => choiceKey(s.choice));
    const setInputs = useTester((s) => s.setInputs);
    const patch = useTester((s) => s.patch);
    const setup = useTester((s) => s.optimizer);
    const job = useTester((s) => s.job);
    const [error, setError] = useState<string | null>(null);
    const { objective, method, samples, mode, folds, share } = setup;
    const change = (c: Partial<OptimizerSetup>) => patch({ optimizer: { ...useTester.getState().optimizer, ...c } });
    const setJob = (next: JobStatus | null) => patch({ job: next });

    const numeric = useMemo(() => (description?.inputs ?? []).filter(isNumber), [description]);
    // Ranges are kept per strategy; an input seen for the first time starts from its default.
    const vary = useMemo(() => {
        const saved = setup.vary[key] ?? {};
        return Object.fromEntries(numeric.map((m) => [m.name, saved[m.name] ?? defaultVary(m)])) as Record<
            string,
            Vary
        >;
    }, [setup.vary, key, numeric]);

    const chosen = numeric.filter((m) => vary[m.name]?.on);
    const combinations = chosen.reduce((n, m) => n * countOf(vary[m.name]), chosen.length ? 1 : 0);
    const runs = method === 'random' ? Math.min(samples, combinations) : combinations;

    // Progress arrives as events; the rows are read on a slower beat and once more at the end.
    useEffect(() => {
        const current = () => useTester.getState().job;
        const refresh = async () => {
            const j = current();
            if (!j) return;
            try {
                const next = await client.json<JobStatus>(`/api/backtest/jobs/${j.id}`);
                if (current()?.id === next.id) useTester.setState({ job: next });
            } catch {}
        };
        const off = client.listen<JobEvent>('backtest', (event) => {
            const j = current();
            if (!j || event.id !== j.id) return;
            if (event.type === 'progress') useTester.setState({ job: { ...j, done: event.done, total: event.total } });
            else void refresh();
        });
        const timer = setInterval(() => {
            if (current()?.state === 'running') void refresh();
        }, 700);
        if (current()?.state === 'running') void refresh();
        return () => {
            off();
            clearInterval(timer);
        };
    }, [client]);

    const start = async () => {
        if (!market) return;
        const request = buildRequest(market);
        if (!request) return;
        setError(null);
        const body = {
            ...request,
            objective,
            method,
            samples,
            ranges: chosen.map((m) => ({
                name: m.name,
                from: vary[m.name].from,
                to: vary[m.name].to,
                step: vary[m.name].step,
            })),
            ...(mode === 'walkforward' ? { folds, inSampleShare: share / 100 } : {}),
        };
        try {
            const started = await client.post<JobStatus>(
                mode === 'walkforward' ? '/api/backtest/walk-forward' : '/api/backtest/optimize',
                body,
            );
            setJob(started);
        } catch (err: any) {
            setError(String(err?.message ?? err));
        }
    };
    const cancel = async () => {
        if (job) await client.json(`/api/backtest/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
    };
    const apply = (row: OptimizeRow) => {
        setInputs({ ...(useTester.getState().inputs[key] ?? {}), ...row.inputs });
        patch({ tab: 'overview' });
    };
    const update = (name: string, c: Partial<Vary>) =>
        change({ vary: { ...setup.vary, [key]: { ...vary, [name]: { ...vary[name], ...c } } } });

    const running = job?.state === 'running';
    const wf = job?.kind === 'walkforward' ? job.walkForward : undefined;

    return (
        <div className="optimizer" data-testid="optimizer">
            <div className="optimizer-setup">
                <div className="seg">
                    <button
                        type="button"
                        className={mode === 'search' ? 'on' : ''}
                        onClick={() => change({ mode: 'search' })}
                    >
                        Parameter search
                    </button>
                    <button
                        type="button"
                        className={mode === 'walkforward' ? 'on' : ''}
                        onClick={() => change({ mode: 'walkforward' })}
                    >
                        Walk-forward
                    </button>
                </div>
                {numeric.length === 0 && <p className="muted">This strategy has no numeric inputs to vary.</p>}
                <table className="grid-table vary">
                    <thead>
                        <tr>
                            <th>Vary</th>
                            <th>From</th>
                            <th>To</th>
                            <th>Step</th>
                            <th className="num">Values</th>
                        </tr>
                    </thead>
                    <tbody>
                        {numeric.map((m) => {
                            const v = vary[m.name] ?? defaultVary(m);
                            return (
                                <tr key={m.name} className={v.on ? '' : 'off'}>
                                    <td>
                                        <label className="check">
                                            <input
                                                type="checkbox"
                                                checked={v.on}
                                                onChange={(e) => update(m.name, { on: e.target.checked })}
                                            />
                                            {m.title}
                                        </label>
                                    </td>
                                    {(['from', 'to', 'step'] as const).map((f) => (
                                        <td key={f}>
                                            <input
                                                type="number"
                                                step="any"
                                                aria-label={`${m.title} ${f}`}
                                                value={v[f]}
                                                disabled={!v.on}
                                                onChange={(e) => update(m.name, { [f]: Number(e.target.value) })}
                                            />
                                        </td>
                                    ))}
                                    <td className="num">{v.on ? countOf(v) : '—'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <div className="row wrap">
                    <label className="inline">
                        Rank by
                        <select value={objective} onChange={(e) => change({ objective: e.target.value as Objective })}>
                            {OBJECTIVES.map((o) => (
                                <option key={o.id} value={o.id}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="inline">
                        Method
                        <select
                            value={method}
                            onChange={(e) => change({ method: e.target.value as 'grid' | 'random' })}
                        >
                            <option value="grid">Every combination</option>
                            <option value="random">Random sample</option>
                        </select>
                    </label>
                    {method === 'random' && (
                        <label className="inline">
                            Samples
                            <input
                                type="number"
                                min={1}
                                max={5000}
                                value={samples}
                                onChange={(e) => change({ samples: Number(e.target.value) || 1 })}
                            />
                        </label>
                    )}
                    {mode === 'walkforward' && (
                        <>
                            <label className="inline">
                                Folds
                                <input
                                    type="number"
                                    min={2}
                                    max={20}
                                    value={folds}
                                    onChange={(e) => change({ folds: Number(e.target.value) || 2 })}
                                />
                            </label>
                            <label className="inline">
                                In-sample %
                                <input
                                    type="number"
                                    min={10}
                                    max={90}
                                    value={share}
                                    onChange={(e) => change({ share: Number(e.target.value) || 70 })}
                                />
                            </label>
                        </>
                    )}
                </div>
                <div className="row">
                    {running ? (
                        <Button variant="danger" onClick={cancel}>
                            Cancel
                        </Button>
                    ) : (
                        <Button
                            variant="primary"
                            disabled={!market || runs < 1}
                            onClick={start}
                            data-testid="optimize-start"
                        >
                            {mode === 'walkforward' ? 'Run walk-forward' : 'Run search'}
                        </Button>
                    )}
                    <span className="muted">
                        {runs > 0
                            ? `${runs.toLocaleString('en-US')} run${runs === 1 ? '' : 's'}${mode === 'walkforward' ? ` per fold × ${folds} folds` : ''}`
                            : 'Tick at least one input to vary.'}
                    </span>
                </div>
                {error && <div className="error-text">{error}</div>}
            </div>

            <div className="optimizer-results">
                {!job && (
                    <p className="muted">
                        {mode === 'walkforward'
                            ? 'Walk-forward chooses parameters on one stretch of history and measures them on the stretch that follows, so the result is never measured on data the parameters were fitted to.'
                            : 'Each combination is run over the same bars as the test above and ranked by the measure you choose.'}
                    </p>
                )}
                {job && (
                    <div className="progress-line" data-testid="optimize-progress">
                        <div className="progress">
                            <i style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }} />
                        </div>
                        <span>
                            {job.done.toLocaleString('en-US')} / {job.total.toLocaleString('en-US')}
                            {job.state === 'running'
                                ? ` · ${Math.round(job.rate).toLocaleString('en-US')} runs/s`
                                : ` · ${job.state}`}
                        </span>
                        {job.error && <span className="error-text">{job.error}</span>}
                    </div>
                )}
                {job?.kind === 'optimize' && job.rows.length > 0 && (
                    <div className="table-scroll">
                        <table className="grid-table" data-testid="optimize-rows">
                            <thead>
                                <tr>
                                    <th className="num">#</th>
                                    {Object.keys(job.rows[0].inputs).map((name) => (
                                        <th key={name} className="num">
                                            {description?.inputs.find((i) => i.name === name)?.title ?? name}
                                        </th>
                                    ))}
                                    <th className="num">Net profit</th>
                                    <th className="num">Return</th>
                                    <th className="num">Max drawdown</th>
                                    <th className="num">Profit factor</th>
                                    <th className="num">Sharpe</th>
                                    <th className="num">Win rate</th>
                                    <th className="num">Trades</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {job.rows.map((row, i) => (
                                    <tr key={JSON.stringify(row.inputs)}>
                                        <td className="num muted">{i + 1}</td>
                                        {Object.values(row.inputs).map((v, k) => (
                                            // biome-ignore lint/suspicious/noArrayIndexKey: the columns of a row never reorder
                                            <td key={k} className="num">
                                                {String(v)}
                                            </td>
                                        ))}
                                        <td className={`num ${tone(row.summary.netProfit)}`}>
                                            {signed(row.summary.netProfit)}
                                        </td>
                                        <td className={`num ${tone(row.summary.netProfitPct)}`}>
                                            {pct(row.summary.netProfitPct)}
                                        </td>
                                        <td className="num">{pct(row.summary.maxDrawdownPct)}</td>
                                        <td className="num">{ratio(row.summary.profitFactor)}</td>
                                        <td className="num">{ratio(row.summary.sharpe)}</td>
                                        <td className="num">{row.summary.winRatePct.toFixed(1)}%</td>
                                        <td className="num">{row.summary.trades}</td>
                                        <td>
                                            <button type="button" className="link" onClick={() => apply(row)}>
                                                Use
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {job.rowCount > job.rows.length && (
                            <p className="muted">
                                Showing the best {job.rows.length} of {job.rowCount.toLocaleString('en-US')}.
                            </p>
                        )}
                    </div>
                )}
                {wf && (
                    <div className="walkforward" data-testid="walkforward">
                        <div className="kpis">
                            <div className="kpi">
                                <span>Out-of-sample net profit</span>
                                <b className={tone(wf.outOfSample.netProfit)}>{signed(wf.outOfSample.netProfit)}</b>
                                <small>{pct(wf.outOfSample.netProfitPct)}</small>
                            </div>
                            <div className="kpi">
                                <span>Max drawdown</span>
                                <b>{pct(wf.outOfSample.maxDrawdownPct)}</b>
                            </div>
                            <div className="kpi">
                                <span>Trades</span>
                                <b>{wf.outOfSample.trades}</b>
                            </div>
                            <div
                                className="kpi"
                                title="Annualised out-of-sample return ÷ annualised in-sample return. Near 1 means the fit carried over; near 0 means it did not."
                            >
                                <span>Walk-forward efficiency</span>
                                <b>{ratio(wf.efficiency)}</b>
                            </div>
                        </div>
                        <EquityChart
                            time={wf.equity.time}
                            series={[
                                { name: 'Out-of-sample equity', color: 'var(--series-1)', values: wf.equity.value },
                            ]}
                            height={180}
                        />
                        <table className="grid-table">
                            <thead>
                                <tr>
                                    <th>Fold</th>
                                    <th>Fitted on</th>
                                    <th>Tested on</th>
                                    <th>Chosen inputs</th>
                                    <th className="num">In-sample</th>
                                    <th className="num">Out-of-sample</th>
                                    <th className="num">Trades</th>
                                </tr>
                            </thead>
                            <tbody>
                                {wf.folds.map((f, i) => (
                                    <tr key={f.outOfSample[0]}>
                                        <td>{i + 1}</td>
                                        <td>
                                            {dateTime(f.inSample[0], false)} → {dateTime(f.inSample[1], false)}
                                        </td>
                                        <td>
                                            {dateTime(f.outOfSample[0], false)} → {dateTime(f.outOfSample[1], false)}
                                        </td>
                                        <td>
                                            {Object.entries(f.best)
                                                .map(
                                                    ([k, v]) =>
                                                        `${description?.inputs.find((x) => x.name === k)?.title ?? k} ${v}`,
                                                )
                                                .join(', ')}
                                        </td>
                                        <td className={`num ${tone(f.inSampleSummary.netProfitPct)}`}>
                                            {pct(f.inSampleSummary.netProfitPct)}
                                        </td>
                                        <td className={`num ${tone(f.outOfSampleSummary.netProfitPct)}`}>
                                            {pct(f.outOfSampleSummary.netProfitPct)}
                                        </td>
                                        <td className="num">{f.outOfSampleSummary.trades}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
