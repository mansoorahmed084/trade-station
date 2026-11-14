import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useEffect, useMemo, useState } from 'react';
import type { ServerClient } from '../lib/client.ts';
import { Button } from '../ui.tsx';

interface Filter {
    field: string;
    op: '>' | '<' | '>=' | '<=' | 'between';
    value: string;
    to: string;
}

interface Result {
    columns: { id: string; label: string }[];
    rows: { symbol: string; values: Record<string, number | null> }[];
    scanned: number;
    matched: number;
    errors: { symbol: string; error: string }[];
    ms: number;
}

type Universe =
    | { kind: 'watchlist'; id: string; name: string; symbols: string[] }
    | { kind: 'provider'; provider: string; quote?: string; label: string };

const TIMEFRAMES = [
    ['1D', '1 day'],
    ['240', '4 hours'],
    ['60', '1 hour'],
    ['15', '15 minutes'],
    ['1W', '1 week'],
] as const;

/** Columns shown by default; the rest can be switched on. */
const DEFAULT_COLUMNS = [
    'price',
    'changePct',
    'change5Pct',
    'relVolume',
    'rsi14',
    'sma50DistPct',
    'sma200DistPct',
    'atrPct',
    'highDistPct',
];

const fmt = (id: string, v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (id.endsWith('Pct')) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
    if (id === 'volume') return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (id === 'emaTrend') return v ? 'up' : 'down';
    return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 10 ? 4 : 2 });
};
const tone = (id: string, v: number | null | undefined) =>
    v !== null && v !== undefined && id.endsWith('Pct') ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '';

/** The screener: scan a list of symbols, filter and sort them, open one on the chart. */
export function Screener({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const [fields, setFields] = useState<Record<string, string>>({});
    const [universes, setUniverses] = useState<Universe[]>([]);
    const [universe, setUniverse] = useState(0);
    const [timeframe, setTimeframe] = useState('1D');
    const [limit, setLimit] = useState(60);
    const [filters, setFilters] = useState<Filter[]>([]);
    const [scripts, setScripts] = useState<{ id: string; name: string }[]>([]);
    const [pine, setPine] = useState('');
    const [result, setResult] = useState<Result | null>(null);
    const [shown, setShown] = useState<string[]>(DEFAULT_COLUMNS);
    const [sort, setSort] = useState<{ id: string; desc: boolean }>({ id: 'changePct', desc: true });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        client
            .json<Record<string, string>>('/api/screener/fields')
            .then(setFields)
            .catch(() => {});
        client
            .json<{ id: string; name: string; kind: string | null }[]>('/api/scripts')
            .then((l) => setScripts(l.filter((s) => s.kind === 'indicator')))
            .catch(() => {});
        // What can be scanned: each watchlist, and whole venues.
        Promise.all([
            client.kvGet('watchlists').catch(() => null),
            client.providers().catch(() => [] as string[]),
        ]).then(([raw, providers]) => {
            const list: Universe[] = [];
            try {
                const doc = raw ? JSON.parse(raw) : null;
                for (const l of doc?.lists ?? []) {
                    const symbols = (l.items ?? []).filter((i: any) => i.kind === 'symbol').map((i: any) => i.symbol);
                    if (symbols.length) list.push({ kind: 'watchlist', id: l.id, name: l.name, symbols });
                }
            } catch {}
            if (providers.includes('BINANCE'))
                list.push({ kind: 'provider', provider: 'BINANCE', quote: 'USDT', label: 'Binance: USDT pairs' });
            if (providers.includes('SYNTH'))
                list.push({ kind: 'provider', provider: 'SYNTH', label: 'Synthetic market' });
            setUniverses(list);
        });
    }, [client]);

    const run = async () => {
        const u = universes[universe];
        if (!u) return;
        setBusy(true);
        setError(null);
        try {
            const body = {
                ...(u.kind === 'watchlist' ? { symbols: u.symbols } : { provider: u.provider, quote: u.quote, limit }),
                timeframe,
                filters: filters
                    .filter((f) => f.value.trim() !== '')
                    .map((f) => ({
                        field: f.field,
                        op: f.op,
                        value: Number(f.value),
                        to: f.op === 'between' ? Number(f.to) : undefined,
                    })),
                pine: pine ? { scriptId: pine } : undefined,
            };
            const r = await client.post<Result>('/api/screener/run', body);
            setResult(r);
            const pineCols = r.columns.filter((c) => c.id.startsWith('pine:')).map((c) => c.id);
            setShown((s) => [...s.filter((id) => !id.startsWith('pine:')), ...pineCols]);
        } catch (err: any) {
            setError(String(err?.message ?? err));
        } finally {
            setBusy(false);
        }
    };

    const rows = useMemo(() => {
        if (!result) return [];
        const dir = sort.desc ? -1 : 1;
        return [...result.rows].sort((a, b) => {
            const x = sort.id === 'symbol' ? a.symbol : a.values[sort.id];
            const y = sort.id === 'symbol' ? b.symbol : b.values[sort.id];
            if (x === null || x === undefined) return 1;
            if (y === null || y === undefined) return -1;
            return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * dir;
        });
    }, [result, sort]);

    const allColumns = result?.columns ?? Object.entries(fields).map(([id, label]) => ({ id, label }));
    const columns = allColumns.filter((c) => shown.includes(c.id));
    const fieldOptions = [
        ...Object.entries(fields).map(([id, label]) => ({ id, label })),
        ...(result?.columns.filter((c) => c.id.startsWith('pine:')) ?? []),
    ];
    const open = (symbol: string) => {
        const chart: any = workspace.chart;
        void chart?.setMarket?.({ symbol, timeframe });
    };

    return (
        <div className="screener" data-testid="screener">
            <div className="screener-setup">
                <label className="inline">
                    Scan
                    <select
                        value={universe}
                        onChange={(e) => setUniverse(Number(e.target.value))}
                        data-testid="screener-universe"
                    >
                        {universes.map((u, i) => (
                            <option key={u.kind === 'watchlist' ? u.id : u.label} value={i}>
                                {u.kind === 'watchlist' ? `Watchlist: ${u.name} (${u.symbols.length})` : u.label}
                            </option>
                        ))}
                    </select>
                </label>
                {universes[universe]?.kind === 'provider' && (
                    <label className="inline">
                        First
                        <input
                            type="number"
                            min={1}
                            max={300}
                            value={limit}
                            onChange={(e) => setLimit(Number(e.target.value) || 60)}
                        />
                    </label>
                )}
                <label className="inline">
                    Bars of
                    <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                        {TIMEFRAMES.map(([v, l]) => (
                            <option key={v} value={v}>
                                {l}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="inline">
                    Pine columns
                    <select value={pine} onChange={(e) => setPine(e.target.value)} data-testid="screener-pine">
                        <option value="">none</option>
                        {scripts.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}
                            </option>
                        ))}
                    </select>
                </label>
                <Button
                    variant="ghost"
                    onClick={() => setFilters([...filters, { field: 'rsi14', op: '<', value: '', to: '' }])}
                    data-testid="screener-add-filter"
                >
                    Add filter
                </Button>
                <Button
                    variant="primary"
                    disabled={busy || universes.length === 0}
                    onClick={run}
                    data-testid="screener-run"
                >
                    {busy ? 'Scanning…' : 'Scan'}
                </Button>
                {result && (
                    <span className="muted" data-testid="screener-summary">
                        {result.matched} of {result.scanned} match · {Math.round(result.ms)} ms
                        {result.errors.length ? ` · ${result.errors.length} could not be read` : ''}
                    </span>
                )}
            </div>
            {filters.length > 0 && (
                <div className="screener-filters">
                    {filters.map((f, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: filter rows have no identity beyond their place
                        <div key={i} className="row">
                            <select
                                value={f.field}
                                onChange={(e) =>
                                    setFilters(filters.map((x, k) => (k === i ? { ...x, field: e.target.value } : x)))
                                }
                                aria-label="Field"
                            >
                                {fieldOptions.map((o) => (
                                    <option key={o.id} value={o.id}>
                                        {o.label}
                                    </option>
                                ))}
                            </select>
                            <select
                                value={f.op}
                                onChange={(e) =>
                                    setFilters(
                                        filters.map((x, k) =>
                                            k === i ? { ...x, op: e.target.value as Filter['op'] } : x,
                                        ),
                                    )
                                }
                                aria-label="Comparison"
                            >
                                {['>', '<', '>=', '<=', 'between'].map((o) => (
                                    <option key={o} value={o}>
                                        {o}
                                    </option>
                                ))}
                            </select>
                            <input
                                type="number"
                                value={f.value}
                                onChange={(e) =>
                                    setFilters(filters.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))
                                }
                                aria-label="Value"
                                data-testid="screener-filter-value"
                            />
                            {f.op === 'between' && (
                                <input
                                    type="number"
                                    value={f.to}
                                    onChange={(e) =>
                                        setFilters(filters.map((x, k) => (k === i ? { ...x, to: e.target.value } : x)))
                                    }
                                    aria-label="and"
                                />
                            )}
                            <button
                                type="button"
                                className="link danger"
                                onClick={() => setFilters(filters.filter((_, k) => k !== i))}
                            >
                                Remove
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {error && <div className="tester-error">{error}</div>}
            {result && (
                <div className="table-scroll">
                    <table className="grid-table rows-click" data-testid="screener-rows">
                        <thead>
                            <tr>
                                {[{ id: 'symbol', label: 'Symbol' }, ...columns].map((c) => (
                                    <th
                                        key={c.id}
                                        className={c.id === 'symbol' ? '' : 'num'}
                                        onClick={() =>
                                            setSort({ id: c.id, desc: sort.id === c.id ? !sort.desc : true })
                                        }
                                        title="Sort"
                                    >
                                        {c.label}
                                        {sort.id === c.id ? (sort.desc ? ' ↓' : ' ↑') : ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.symbol} onClick={() => open(r.symbol)}>
                                    <td>{r.symbol}</td>
                                    {columns.map((c) => (
                                        <td key={c.id} className={`num ${tone(c.id, r.values[c.id])}`}>
                                            {fmt(c.id, r.values[c.id])}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <details className="screener-columns">
                        <summary>Columns</summary>
                        {allColumns.map((c) => (
                            <label key={c.id} className="check">
                                <input
                                    type="checkbox"
                                    checked={shown.includes(c.id)}
                                    onChange={(e) =>
                                        setShown(e.target.checked ? [...shown, c.id] : shown.filter((x) => x !== c.id))
                                    }
                                />
                                {c.label}
                            </label>
                        ))}
                    </details>
                </div>
            )}
        </div>
    );
}
