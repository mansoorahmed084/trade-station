import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { describeCondition } from '@ts/alerts/template';
import type {
    Alert,
    AlertInput,
    Comparison,
    Condition,
    Frequency,
    NotifyTargets,
    Operand,
    Operator,
    PriceField,
    StudyId,
} from '@ts/alerts/types';
import { normalizeTimeframe, timeframeLabel } from '@ts/core';
import { findAlertConditions, findPlots } from '@ts/script-engine/source';
import { useEffect, useMemo, useState } from 'react';
import { useAlerts } from '../lib/alerts-store.ts';
import { stripChartType } from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';
import type { AlertDraft } from '../lib/store.ts';
import { Button, Field, Modal } from '../ui.tsx';

const STUDIES: { id: StudyId; label: string; params: [string, string, number][]; outputs?: string[] }[] = [
    { id: 'sma', label: 'Moving average (SMA)', params: [['length', 'Length', 20]] },
    { id: 'ema', label: 'Moving average (EMA)', params: [['length', 'Length', 20]] },
    { id: 'wma', label: 'Moving average (WMA)', params: [['length', 'Length', 20]] },
    { id: 'vwma', label: 'Moving average (VWMA)', params: [['length', 'Length', 20]] },
    { id: 'rma', label: 'Moving average (RMA)', params: [['length', 'Length', 14]] },
    { id: 'rsi', label: 'RSI', params: [['length', 'Length', 14]] },
    {
        id: 'macd',
        label: 'MACD',
        params: [
            ['fast', 'Fast', 12],
            ['slow', 'Slow', 26],
            ['signal', 'Signal', 9],
        ],
        outputs: ['macd', 'signal', 'hist'],
    },
    {
        id: 'bb',
        label: 'Bollinger Bands',
        params: [
            ['length', 'Length', 20],
            ['mult', 'Width', 2],
        ],
        outputs: ['basis', 'upper', 'lower'],
    },
    { id: 'atr', label: 'ATR', params: [['length', 'Length', 14]] },
    { id: 'stoch', label: 'Stochastic %K', params: [['length', 'Length', 14]] },
    { id: 'cci', label: 'CCI', params: [['length', 'Length', 20]] },
    { id: 'roc', label: 'Rate of change', params: [['length', 'Length', 10]] },
    { id: 'stdev', label: 'Standard deviation', params: [['length', 'Length', 20]] },
    {
        id: 'supertrend',
        label: 'Supertrend',
        params: [
            ['factor', 'Factor', 3],
            ['period', 'ATR length', 10],
        ],
        outputs: ['value', 'direction'],
    },
    {
        id: 'dmi',
        label: 'DMI / ADX',
        params: [
            ['length', 'Length', 14],
            ['smoothing', 'Smoothing', 14],
        ],
        outputs: ['adx', 'plus', 'minus'],
    },
    {
        id: 'donchian',
        label: 'Donchian channel',
        params: [['length', 'Length', 20]],
        outputs: ['basis', 'upper', 'lower'],
    },
    { id: 'highest', label: 'Highest high', params: [['length', 'Length', 20]] },
    { id: 'lowest', label: 'Lowest low', params: [['length', 'Length', 20]] },
    { id: 'obv', label: 'On-balance volume', params: [] },
    { id: 'vwap', label: 'VWAP', params: [] },
];

const OPERATORS: { id: Operator; label: string; shape: 'pair' | 'channel' | 'move' }[] = [
    { id: 'crossing', label: 'Crossing', shape: 'pair' },
    { id: 'crossing_up', label: 'Crossing up', shape: 'pair' },
    { id: 'crossing_down', label: 'Crossing down', shape: 'pair' },
    { id: 'greater', label: 'Greater than', shape: 'pair' },
    { id: 'less', label: 'Less than', shape: 'pair' },
    { id: 'entering_channel', label: 'Entering channel', shape: 'channel' },
    { id: 'exiting_channel', label: 'Exiting channel', shape: 'channel' },
    { id: 'inside_channel', label: 'Inside channel', shape: 'channel' },
    { id: 'outside_channel', label: 'Outside channel', shape: 'channel' },
    { id: 'moving_up', label: 'Moving up by', shape: 'move' },
    { id: 'moving_down', label: 'Moving down by', shape: 'move' },
    { id: 'moving_up_pct', label: 'Moving up by %', shape: 'move' },
    { id: 'moving_down_pct', label: 'Moving down by %', shape: 'move' },
];

const FREQUENCIES: { id: Frequency; label: string; hint: string }[] = [
    { id: 'once', label: 'Only once', hint: 'Fires the first time the condition is met, then stops.' },
    { id: 'once_per_bar', label: 'Once per bar', hint: 'Fires the moment the condition is met, at most once per bar.' },
    {
        id: 'once_per_bar_close',
        label: 'Once per bar close',
        hint: 'Fires only if the condition holds when a bar closes. Avoids signals that vanish mid-bar.',
    },
    {
        id: 'every_time',
        label: 'Every time',
        hint: 'Fires each time the condition becomes met, and re-arms on each new bar.',
    },
];

const TIMEFRAMES = ['1S', '15S', '1', '3', '5', '15', '30', '60', '240', '1D', '1W'];
const LINE_TYPES: Record<string, 'both' | 'right'> = {
    hline: 'both',
    hray: 'right',
    trendline: 'right',
    ray: 'right',
    extendedline: 'both',
};

interface ScriptInfo {
    plots: string[];
    conditions: string[];
}

type OperandKind = Operand['type'];
interface OperandDraft {
    type: OperandKind;
    field: PriceField;
    value: string;
    study: StudyId;
    params: Record<string, string>;
    output: string;
    scriptId: string;
    plot: string;
    line: Extract<Operand, { type: 'line' }> | null;
}

interface Row {
    kind: 'compare' | 'script';
    left: OperandDraft;
    op: Operator;
    right: OperandDraft;
    upper: OperandDraft;
    lower: OperandDraft;
    amount: string;
    bars: string;
    scriptId: string;
    title: string;
}

const blank = (type: OperandKind = 'price', value = ''): OperandDraft => ({
    type,
    field: 'close',
    value,
    study: 'sma',
    params: {},
    output: '',
    scriptId: '',
    plot: '',
    line: null,
});

function toDraft(op: Operand | undefined, fallback: OperandDraft): OperandDraft {
    if (!op) return fallback;
    switch (op.type) {
        case 'price':
            return { ...blank('price'), field: op.field ?? 'close' };
        case 'value':
            return blank('value', String(op.value));
        case 'indicator':
            return {
                ...blank('indicator'),
                study: op.study,
                params: Object.fromEntries(Object.entries(op.params ?? {}).map(([k, v]) => [k, String(v)])),
                output: op.output ?? '',
            };
        case 'plot':
            return { ...blank('plot'), scriptId: op.scriptId ?? '', plot: op.plot };
        case 'line':
            return { ...blank('line'), line: op };
    }
}

function fromDraft(d: OperandDraft, where: string): Operand {
    switch (d.type) {
        case 'price':
            return d.field === 'close' ? { type: 'price' } : { type: 'price', field: d.field };
        case 'value': {
            const value = Number(d.value);
            if (d.value.trim() === '' || !Number.isFinite(value)) throw new Error(`${where}: enter a number`);
            return { type: 'value', value };
        }
        case 'indicator': {
            const spec = STUDIES.find((s) => s.id === d.study)!;
            const params: Record<string, number> = {};
            for (const [key, , def] of spec.params) params[key] = Number(d.params[key] ?? def) || def;
            const out: Operand = { type: 'indicator', study: d.study, params };
            if (spec.outputs) out.output = d.output || spec.outputs[0];
            return out;
        }
        case 'plot':
            if (!d.scriptId || !d.plot) throw new Error(`${where}: choose a script and one of its plots`);
            return { type: 'plot', scriptId: d.scriptId, plot: d.plot };
        case 'line':
            if (!d.line) throw new Error(`${where}: choose a drawing`);
            return d.line;
    }
}

function toRows(
    condition: Condition | undefined,
    price: number,
): { rows: Row[]; join: 'all' | 'any'; editable: boolean } {
    const fresh = (): Row => ({
        kind: 'compare',
        left: blank('price'),
        op: 'crossing',
        right: blank('value', Number.isFinite(price) ? String(price) : ''),
        upper: blank('value'),
        lower: blank('value'),
        amount: '1',
        bars: '1',
        scriptId: '',
        title: '',
    });
    const leaf = (c: Condition): Row | null => {
        if ('scriptAlert' in c)
            return {
                ...fresh(),
                kind: 'script',
                scriptId: c.scriptAlert.scriptId ?? '',
                title: c.scriptAlert.title ?? '',
            };
        if ('op' in c) {
            return {
                ...fresh(),
                left: toDraft(c.left, blank('price')),
                op: c.op,
                right: toDraft(c.right, blank('value')),
                upper: toDraft(c.upper, blank('value')),
                lower: toDraft(c.lower, blank('value')),
                amount: String(c.amount ?? 1),
                bars: String(c.bars ?? 1),
            };
        }
        return null;
    };
    if (!condition) return { rows: [fresh()], join: 'all', editable: true };
    const single = leaf(condition);
    if (single) return { rows: [single], join: 'all', editable: true };
    const children = 'all' in condition ? condition.all : (condition as { any: Condition[] }).any;
    const rows = children.map(leaf);
    // Groups inside groups can be saved through the API but not drawn in this form.
    if (rows.some((r) => r === null)) return { rows: [fresh()], join: 'all', editable: false };
    return { rows: rows as Row[], join: 'all' in condition ? 'all' : 'any', editable: true };
}

function fromRows(rows: Row[], join: 'all' | 'any'): Condition {
    const leaves = rows.map((r, i): Condition => {
        const where = rows.length > 1 ? `Condition ${i + 1}` : 'Condition';
        if (r.kind === 'script') {
            if (!r.scriptId) throw new Error(`${where}: choose a script`);
            return { scriptAlert: r.title ? { scriptId: r.scriptId, title: r.title } : { scriptId: r.scriptId } };
        }
        const shape = OPERATORS.find((o) => o.id === r.op)!.shape;
        const c: Comparison = { left: fromDraft(r.left, where), op: r.op };
        if (shape === 'pair') c.right = fromDraft(r.right, where);
        else if (shape === 'channel') {
            c.upper = fromDraft(r.upper, `${where}, upper bound`);
            c.lower = fromDraft(r.lower, `${where}, lower bound`);
        } else {
            c.amount = Number(r.amount);
            c.bars = Math.max(1, Math.round(Number(r.bars) || 1));
            if (!(c.amount > 0)) throw new Error(`${where}: the amount must be greater than zero`);
        }
        return c;
    });
    return leaves.length === 1 ? leaves[0] : join === 'all' ? { all: leaves } : { any: leaves };
}

function OperandEditor(props: {
    value: OperandDraft;
    onChange: (next: OperandDraft) => void;
    scripts: { id: string; name: string }[];
    info: Record<string, ScriptInfo>;
    drawings: { id: string; label: string; operand: Extract<Operand, { type: 'line' }> }[];
    label: string;
}) {
    const { value: v, onChange } = props;
    const spec = STUDIES.find((s) => s.id === v.study)!;
    return (
        <div className="operand">
            <select
                className="text"
                aria-label={`${props.label} type`}
                value={v.type}
                onChange={(e) => onChange({ ...v, type: e.target.value as OperandKind })}
            >
                <option value="price">Price</option>
                <option value="value">Value</option>
                <option value="indicator">Indicator</option>
                <option value="plot">Script plot</option>
                <option value="line">Drawing</option>
            </select>
            {v.type === 'price' && (
                <select
                    className="text"
                    aria-label={`${props.label} field`}
                    value={v.field}
                    onChange={(e) => onChange({ ...v, field: e.target.value as PriceField })}
                >
                    {(['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'] as PriceField[]).map((f) => (
                        <option key={f} value={f}>
                            {f === 'close' ? 'Last / close' : f}
                        </option>
                    ))}
                </select>
            )}
            {v.type === 'value' && (
                <input
                    className="text num"
                    aria-label={`${props.label} value`}
                    type="number"
                    step="any"
                    value={v.value}
                    onChange={(e) => onChange({ ...v, value: e.target.value })}
                    onKeyDown={(e) => e.stopPropagation()}
                />
            )}
            {v.type === 'indicator' && (
                <>
                    <select
                        className="text"
                        aria-label={`${props.label} study`}
                        value={v.study}
                        onChange={(e) => onChange({ ...v, study: e.target.value as StudyId, params: {}, output: '' })}
                    >
                        {STUDIES.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.label}
                            </option>
                        ))}
                    </select>
                    {spec.params.map(([key, label, def]) => (
                        <input
                            key={key}
                            className="text num-sm"
                            type="number"
                            step="any"
                            title={label}
                            aria-label={label}
                            value={v.params[key] ?? String(def)}
                            onChange={(e) => onChange({ ...v, params: { ...v.params, [key]: e.target.value } })}
                            onKeyDown={(e) => e.stopPropagation()}
                        />
                    ))}
                    {spec.outputs && (
                        <select
                            className="text"
                            aria-label="Line"
                            value={v.output || spec.outputs[0]}
                            onChange={(e) => onChange({ ...v, output: e.target.value })}
                        >
                            {spec.outputs.map((o) => (
                                <option key={o} value={o}>
                                    {o}
                                </option>
                            ))}
                        </select>
                    )}
                </>
            )}
            {v.type === 'plot' && (
                <>
                    <select
                        className="text"
                        aria-label={`${props.label} script`}
                        value={v.scriptId}
                        onChange={(e) => onChange({ ...v, scriptId: e.target.value, plot: '' })}
                    >
                        <option value="">Choose a script…</option>
                        {props.scripts.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}
                            </option>
                        ))}
                    </select>
                    <select
                        className="text"
                        aria-label={`${props.label} plot`}
                        value={v.plot}
                        onChange={(e) => onChange({ ...v, plot: e.target.value })}
                        disabled={!v.scriptId}
                    >
                        <option value="">Choose a plot…</option>
                        {(props.info[v.scriptId]?.plots ?? []).map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                </>
            )}
            {v.type === 'line' &&
                (props.drawings.length === 0 && !v.line ? (
                    <span className="muted">Draw a trend line, ray or horizontal line on the chart first.</span>
                ) : (
                    <select
                        className="text"
                        aria-label={`${props.label} drawing`}
                        value={v.line?.drawingId ?? ''}
                        onChange={(e) =>
                            onChange({
                                ...v,
                                line: props.drawings.find((d) => d.id === e.target.value)?.operand ?? null,
                            })
                        }
                    >
                        <option value="">
                            {v.line && !props.drawings.some((d) => d.id === v.line?.drawingId)
                                ? 'Saved line'
                                : 'Choose a drawing…'}
                        </option>
                        {props.drawings.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.label}
                            </option>
                        ))}
                    </select>
                ))}
        </div>
    );
}

export function AlertDialog({
    client,
    workspace,
    draft,
    onClose,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    draft: AlertDraft;
    onClose: () => void;
}) {
    const existing = useAlerts((s) => (draft.editId ? s.alerts.find((a) => a.id === draft.editId) : undefined));
    const channels = useAlerts((s) => s.channels);
    const save = useAlerts((s) => s.save);
    const chart: any = workspace.chart;
    const base: Partial<Alert> = existing ?? draft.preset ?? {};
    const chartSymbol = stripChartType(String(chart?.market?.symbol ?? ''));
    // biome-ignore lint/correctness/useExhaustiveDependencies: computed once when the dialog opens
    const initial = useMemo(() => toRows(base.condition, Number.NaN), []);
    const [rows, setRows] = useState<Row[]>(initial.rows);
    const [join, setJoin] = useState<'all' | 'any'>(initial.join);
    const [symbolMode, setSymbolMode] = useState<'symbol' | 'watchlist'>(
        (base.symbols?.length ?? 1) > 1 ? 'watchlist' : 'symbol',
    );
    const [symbol, setSymbol] = useState(base.symbols?.[0] ?? chartSymbol);
    const [watchlists, setWatchlists] = useState<{ id: string; name: string; symbols: string[] }[]>([]);
    const [watchlistId, setWatchlistId] = useState('');
    const [timeframe, setTimeframe] = useState(() => {
        try {
            return normalizeTimeframe(base.timeframe ?? String(chart?.market?.timeframe ?? '60'));
        } catch {
            return '60';
        }
    });
    const [frequency, setFrequency] = useState<Frequency>(base.frequency ?? 'once_per_bar');
    const [cooldown, setCooldown] = useState(String(Math.round((base.cooldownMs ?? 0) / 1000)));
    const [expiry, setExpiry] = useState<'never' | 'custom'>(base.expiresAt ? 'custom' : 'never');
    const [expiresAt, setExpiresAt] = useState(() =>
        new Date(base.expiresAt ?? Date.now() + 30 * 86_400_000).toISOString().slice(0, 16),
    );
    const [name, setName] = useState(existing?.name ?? draft.preset?.name ?? '');
    const [message, setMessage] = useState(base.message ?? '');
    const [notify, setNotify] = useState<NotifyTargets>(base.notify ?? { app: true, sound: true });
    const [scripts, setScripts] = useState<{ id: string; name: string }[]>([]);
    const [info, setInfo] = useState<Record<string, ScriptInfo>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    // Lines on the active chart that an alert can follow.
    const drawings = useMemo(() => {
        const out: { id: string; label: string; operand: Extract<Operand, { type: 'line' }> }[] = [];
        for (const d of (chart?.drawings?.all?.() ?? []) as any[]) {
            const extend = LINE_TYPES[d.type];
            const a = d.anchors?.[0];
            if (!extend || !a) continue;
            const b = d.anchors[1] ?? a;
            const flat = d.anchors.length < 2 || a.price === b.price;
            out.push({
                id: d.id,
                label: flat
                    ? `Horizontal line at ${a.price}`
                    : `Trend line ${a.price.toFixed(2)} → ${b.price.toFixed(2)}`,
                operand: {
                    type: 'line',
                    a: { time: a.time, price: a.price },
                    b: { time: d.anchors.length < 2 ? a.time + 1 : b.time, price: b.price },
                    extend,
                    drawingId: d.id,
                },
            });
        }
        return out;
    }, [chart]);

    // A new alert starts at the current price: a level worth crossing, and never an empty box.
    const [lastPrice, setLastPrice] = useState(Number.NaN);
    useEffect(() => {
        if (!chartSymbol) return;
        let cancelled = false;
        client
            .json<{ last?: number }[]>(`/api/quotes?symbols=${encodeURIComponent(base.symbols?.[0] ?? chartSymbol)}`)
            .then(([quote]) => {
                if (cancelled || typeof quote?.last !== 'number') return;
                setLastPrice(quote.last);
                // Only fill boxes the user has not touched.
                setRows((rs) =>
                    rs.map((r) =>
                        r.kind === 'compare' && r.right.type === 'value' && r.right.value === ''
                            ? { ...r, right: { ...r.right, value: String(quote.last) } }
                            : r,
                    ),
                );
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the dialog opens
    }, []);

    useEffect(() => {
        client
            .json<{ id: string; name: string }[]>('/api/scripts')
            .then(setScripts)
            .catch(() => {});
        client.kvGet('watchlists').then((raw) => {
            try {
                const doc = JSON.parse(raw ?? 'null');
                const lists = (doc?.lists ?? []).map((l: any) => ({
                    id: l.id,
                    name: l.name,
                    symbols: l.items.filter((i: any) => i.kind === 'symbol').map((i: any) => i.symbol),
                }));
                setWatchlists(lists);
                if (lists[0]) setWatchlistId((id) => id || lists[0].id);
            } catch {}
        });
    }, [client]);

    // Load plot and alertcondition titles for every script the form refers to.
    const wanted = rows
        .flatMap((r) => [r.scriptId, r.left.scriptId, r.right.scriptId, r.upper.scriptId, r.lower.scriptId])
        .filter(Boolean)
        .join(',');
    useEffect(() => {
        for (const id of wanted.split(',').filter(Boolean)) {
            if (info[id]) continue;
            client
                .json<{ source: string }>(`/api/scripts/${id}`)
                .then((s) =>
                    setInfo((cur) => ({
                        ...cur,
                        [id]: {
                            plots: findPlots(s.source).map((p) => p.title),
                            conditions: findAlertConditions(s.source),
                        },
                    })),
                )
                .catch(() => {});
        }
    }, [wanted, client, info]);

    const patch = (i: number, change: Partial<Row>) =>
        setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...change } : r)));

    const build = (): AlertInput => {
        const condition = initial.editable ? fromRows(rows, join) : (base.condition as Condition);
        const symbols =
            symbolMode === 'watchlist'
                ? (watchlists.find((w) => w.id === watchlistId)?.symbols ?? [])
                : [symbol.trim()];
        if (symbols.length === 0 || !symbols[0])
            throw new Error(symbolMode === 'watchlist' ? 'That watchlist has no symbols.' : 'Enter a symbol.');
        const clean: NotifyTargets = { app: notify.app !== false, sound: !!notify.sound };
        if (notify.webhook?.url?.trim())
            clean.webhook = { url: notify.webhook.url.trim(), secret: notify.webhook.secret?.trim() || undefined };
        if (notify.discord?.url?.trim()) clean.discord = { url: notify.discord.url.trim() };
        if (notify.telegram?.chatId?.trim()) clean.telegram = { chatId: notify.telegram.chatId.trim() };
        if (notify.email?.to?.trim()) clean.email = { to: notify.email.to.trim() };
        return {
            name: name.trim() || undefined,
            symbols,
            timeframe,
            condition,
            frequency,
            cooldownMs: Math.max(0, Number(cooldown) || 0) * 1000,
            expiresAt: expiry === 'never' ? null : new Date(`${expiresAt}Z`).getTime(),
            message,
            notify: clean,
        };
    };

    let summary = '';
    try {
        summary = describeCondition(initial.editable ? fromRows(rows, join) : (base.condition as Condition));
    } catch {}

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await save(client, build(), existing?.id);
            onClose();
        } catch (err: any) {
            setError(err?.message ?? 'could not save the alert');
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (!existing) return;
        setBusy(true);
        setError(null);
        try {
            await save(client, build(), existing.id);
            const event = await client.post<{ deliveries: { channel: string; ok: boolean; detail?: string }[] }>(
                `/api/alerts/${existing.id}/test`,
                {},
            );
            setTestResult(
                event.deliveries
                    .map((d) => `${d.channel}: ${d.ok ? 'sent' : `failed (${d.detail ?? 'unknown'})`}`)
                    .join(' · ') || 'No channels are enabled.',
            );
        } catch (err: any) {
            setError(err?.message ?? 'test failed');
        } finally {
            setBusy(false);
        }
    };

    const stop = (e: React.KeyboardEvent) => e.stopPropagation();

    return (
        <Modal title={existing ? 'Edit alert' : 'Create alert'} onClose={onClose} width={640}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                    <Field label="Watch">
                        <div className="row">
                            <select
                                className="text"
                                aria-label="Watch what"
                                value={symbolMode}
                                onChange={(e) => setSymbolMode(e.target.value as 'symbol' | 'watchlist')}
                            >
                                <option value="symbol">One symbol</option>
                                <option value="watchlist">A watchlist</option>
                            </select>
                            {symbolMode === 'symbol' ? (
                                <input
                                    className="text grow"
                                    aria-label="Symbol"
                                    value={symbol}
                                    onChange={(e) => setSymbol(e.target.value)}
                                    onKeyDown={stop}
                                />
                            ) : watchlists.length === 0 ? (
                                <span className="muted grow">
                                    No watchlists yet. Open the Watchlist tab to create one.
                                </span>
                            ) : (
                                <select
                                    className="text grow"
                                    aria-label="Watchlist"
                                    value={watchlistId}
                                    onChange={(e) => setWatchlistId(e.target.value)}
                                >
                                    {watchlists.map((w) => (
                                        <option key={w.id} value={w.id}>
                                            {w.name} ({w.symbols.length} symbols)
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                    </Field>
                </div>
                <Field label="Timeframe">
                    <select
                        className="text"
                        aria-label="Timeframe"
                        value={timeframe}
                        onChange={(e) => setTimeframe(e.target.value)}
                    >
                        {[...new Set([timeframe, ...TIMEFRAMES])].map((tf) => (
                            <option key={tf} value={tf}>
                                {timeframeLabel(tf)}
                            </option>
                        ))}
                    </select>
                </Field>
            </div>

            <div className="field-label" style={{ marginBottom: 4 }}>
                Condition
            </div>
            {!initial.editable ? (
                <p className="muted">
                    This alert uses nested groups, which this form cannot edit. Its condition is kept as it is:{' '}
                    {summary}
                </p>
            ) : (
                <>
                    {rows.map((r, i) => {
                        const shape = OPERATORS.find((o) => o.id === r.op)!.shape;
                        const common = { scripts, info, drawings };
                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity beyond their position
                            <div className="condition-row" key={i} data-testid="condition-row">
                                {i > 0 && (
                                    <select
                                        className="text join"
                                        aria-label="Combine with"
                                        value={join}
                                        onChange={(e) => setJoin(e.target.value as 'all' | 'any')}
                                    >
                                        <option value="all">AND</option>
                                        <option value="any">OR</option>
                                    </select>
                                )}
                                <select
                                    className="text"
                                    aria-label="Condition kind"
                                    value={r.kind}
                                    onChange={(e) => patch(i, { kind: e.target.value as Row['kind'] })}
                                >
                                    <option value="compare">Compare</option>
                                    <option value="script">Script alert</option>
                                </select>
                                {r.kind === 'script' ? (
                                    <>
                                        <select
                                            className="text"
                                            aria-label="Alert script"
                                            value={r.scriptId}
                                            onChange={(e) => patch(i, { scriptId: e.target.value, title: '' })}
                                        >
                                            <option value="">Choose a script…</option>
                                            {scripts.map((s) => (
                                                <option key={s.id} value={s.id}>
                                                    {s.name}
                                                </option>
                                            ))}
                                        </select>
                                        <select
                                            className="text"
                                            aria-label="Which alert"
                                            value={r.title}
                                            onChange={(e) => patch(i, { title: e.target.value })}
                                            disabled={!r.scriptId}
                                        >
                                            <option value="">Any alert() call</option>
                                            {(info[r.scriptId]?.conditions ?? []).map((t) => (
                                                <option key={t} value={t}>
                                                    {t}
                                                </option>
                                            ))}
                                        </select>
                                    </>
                                ) : (
                                    <>
                                        <OperandEditor
                                            {...common}
                                            label="Left"
                                            value={r.left}
                                            onChange={(left) => patch(i, { left })}
                                        />
                                        <select
                                            className="text"
                                            aria-label="Operator"
                                            value={r.op}
                                            onChange={(e) => patch(i, { op: e.target.value as Operator })}
                                        >
                                            {OPERATORS.map((o) => (
                                                <option key={o.id} value={o.id}>
                                                    {o.label}
                                                </option>
                                            ))}
                                        </select>
                                        {shape === 'pair' && (
                                            <OperandEditor
                                                {...common}
                                                label="Right"
                                                value={r.right}
                                                onChange={(right) => patch(i, { right })}
                                            />
                                        )}
                                        {shape === 'channel' && (
                                            <>
                                                <OperandEditor
                                                    {...common}
                                                    label="Lower"
                                                    value={r.lower}
                                                    onChange={(lower) => patch(i, { lower })}
                                                />
                                                <span className="muted">to</span>
                                                <OperandEditor
                                                    {...common}
                                                    label="Upper"
                                                    value={r.upper}
                                                    onChange={(upper) => patch(i, { upper })}
                                                />
                                            </>
                                        )}
                                        {shape === 'move' && (
                                            <>
                                                <input
                                                    className="text num-sm"
                                                    aria-label="Amount"
                                                    type="number"
                                                    step="any"
                                                    value={r.amount}
                                                    onChange={(e) => patch(i, { amount: e.target.value })}
                                                    onKeyDown={stop}
                                                />
                                                <span className="muted">within</span>
                                                <input
                                                    className="text num-sm"
                                                    aria-label="Bars"
                                                    type="number"
                                                    min={1}
                                                    value={r.bars}
                                                    onChange={(e) => patch(i, { bars: e.target.value })}
                                                    onKeyDown={stop}
                                                />
                                                <span className="muted">bars</span>
                                            </>
                                        )}
                                    </>
                                )}
                                {rows.length > 1 && (
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        title="Remove condition"
                                        onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}
                                    >
                                        ×
                                    </button>
                                )}
                            </div>
                        );
                    })}
                    <div className="row" style={{ margin: '4px 0 10px' }}>
                        <Button
                            onClick={() => setRows((rs) => [...rs, toRows(undefined, lastPrice).rows[0]])}
                            disabled={rows.length >= 10}
                        >
                            + Add condition
                        </Button>
                        <span className="muted" data-testid="condition-summary">
                            {summary}
                        </span>
                    </div>
                </>
            )}

            <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                    <Field label="Trigger" hint={FREQUENCIES.find((f) => f.id === frequency)?.hint}>
                        <select
                            className="text"
                            aria-label="Trigger"
                            value={frequency}
                            onChange={(e) => setFrequency(e.target.value as Frequency)}
                        >
                            {FREQUENCIES.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {f.label}
                                </option>
                            ))}
                        </select>
                    </Field>
                </div>
                <Field label="Quiet time (s)">
                    <input
                        className="text num-sm"
                        aria-label="Quiet time"
                        type="number"
                        min={0}
                        value={cooldown}
                        onChange={(e) => setCooldown(e.target.value)}
                        onKeyDown={stop}
                    />
                </Field>
                <Field label="Expires">
                    <div className="row">
                        <select
                            className="text"
                            aria-label="Expires"
                            value={expiry}
                            onChange={(e) => setExpiry(e.target.value as 'never' | 'custom')}
                        >
                            <option value="never">Never</option>
                            <option value="custom">At (UTC)</option>
                        </select>
                        {expiry === 'custom' && (
                            <input
                                className="text"
                                type="datetime-local"
                                aria-label="Expiry time"
                                value={expiresAt}
                                onChange={(e) => setExpiresAt(e.target.value)}
                            />
                        )}
                    </div>
                </Field>
            </div>

            <Field label="Name">
                <input
                    className="text"
                    aria-label="Alert name"
                    placeholder={summary || 'Named after its condition when left empty'}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={stop}
                />
            </Field>
            <Field
                label="Message"
                hint={
                    'Placeholders: {{ticker}} {{exchange}} {{interval}} {{open}} {{high}} {{low}} {{close}} {{volume}} {{time}} {{timenow}} {{alert_name}} {{left}} {{right}} {{plot("Title")}}'
                }
            >
                <textarea
                    className="text"
                    aria-label="Message"
                    rows={2}
                    placeholder="{{alert_name}}: {{ticker}} at {{close}}"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={stop}
                />
            </Field>

            <div className="field-label" style={{ marginBottom: 4 }}>
                Notify
            </div>
            <div className="notify-grid">
                <label className="row">
                    <input
                        type="checkbox"
                        checked={notify.app !== false}
                        onChange={(e) => setNotify({ ...notify, app: e.target.checked })}
                    />{' '}
                    In the app
                </label>
                <label className="row">
                    <input
                        type="checkbox"
                        checked={!!notify.sound}
                        onChange={(e) => setNotify({ ...notify, sound: e.target.checked })}
                    />{' '}
                    Play a sound
                </label>
                <input
                    className="text"
                    aria-label="Webhook URL"
                    placeholder="Webhook URL (https://…)"
                    value={notify.webhook?.url ?? ''}
                    onChange={(e) => setNotify({ ...notify, webhook: { ...notify.webhook, url: e.target.value } })}
                    onKeyDown={stop}
                />
                <input
                    className="text"
                    aria-label="Webhook secret"
                    placeholder="Signing secret (optional)"
                    value={notify.webhook?.secret ?? ''}
                    onChange={(e) =>
                        setNotify({ ...notify, webhook: { url: notify.webhook?.url ?? '', secret: e.target.value } })
                    }
                    onKeyDown={stop}
                />
                <input
                    className="text"
                    aria-label="Discord webhook"
                    placeholder="Discord webhook URL"
                    value={notify.discord?.url ?? ''}
                    onChange={(e) => setNotify({ ...notify, discord: { url: e.target.value } })}
                    onKeyDown={stop}
                />
                <input
                    className="text"
                    aria-label="Telegram chat"
                    placeholder={
                        channels.telegram ? 'Telegram chat id' : 'Telegram: set TS_TELEGRAM_TOKEN on the server'
                    }
                    disabled={!channels.telegram}
                    value={notify.telegram?.chatId ?? ''}
                    onChange={(e) => setNotify({ ...notify, telegram: { chatId: e.target.value } })}
                    onKeyDown={stop}
                />
                <input
                    className="text"
                    aria-label="Email"
                    placeholder={channels.email ? 'Email address' : 'Email: set TS_SMTP_URL on the server'}
                    disabled={!channels.email}
                    value={notify.email?.to ?? ''}
                    onChange={(e) => setNotify({ ...notify, email: { to: e.target.value } })}
                    onKeyDown={stop}
                />
            </div>

            {error && (
                <div className="error" data-testid="alert-error">
                    {error}
                </div>
            )}
            {testResult && <div className="out-info">Test: {testResult}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                {existing && (
                    <Button onClick={() => void test()} disabled={busy}>
                        Save and send a test
                    </Button>
                )}
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={() => void submit()} disabled={busy}>
                    {existing ? 'Save' : 'Create'}
                </Button>
            </div>
        </Modal>
    );
}
