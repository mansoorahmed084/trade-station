import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { composeOnPlot, findPlots, ON_PLOT_STUDIES, type OnPlotStudy, readHeader } from '@ts/script-engine/source';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stripChartType } from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';
import { useUi } from '../lib/store.ts';
import { useTester } from '../lib/tester-store.ts';
import { type EditorMarker, MonacoEditor } from '../MonacoEditor.tsx';
import { Button, Field, Modal } from '../ui.tsx';

interface ScriptMeta {
    id: string;
    name: string;
    kind: string | null;
    author: string | null;
    license: string | null;
    origin: string | null;
    builtin: boolean;
    updatedAt: number;
}
interface Script extends ScriptMeta {
    source: string;
}

interface CompatReport {
    ok: boolean;
    version: number | null;
    kind: string | null;
    title: string | null;
    errors: { stage: string; message: string; line?: number; column?: number }[];
    unsupported: { name: string; line: number; column: number }[];
    warnings: { message: string; method?: string }[];
    inputs: number;
    plots: number;
    bars: number;
    ms: number;
}

const NEW_INDICATOR = `//@version=6
indicator("My indicator", overlay=true)
length = input.int(20, "Length", minval=1)
plot(ta.sma(close, length), "SMA", color=color.orange)
`;

const NEW_STRATEGY = `//@version=6
strategy("My strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10)
fast = ta.ema(close, input.int(9, "Fast"))
slow = ta.ema(close, input.int(21, "Slow"))
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")
plot(fast, "Fast")
plot(slow, "Slow")
`;

/** Find a `line:column` in an engine error message. */
function locate(message: string): { line?: number; column?: number } {
    const m = /\bat (\d+):(\d+)/.exec(message) ?? /\bline (\d+)(?:[,:]\s*(?:col(?:umn)?\s*)?(\d+))?/i.exec(message);
    return m ? { line: Number(m[1]), column: m[2] ? Number(m[2]) : undefined } : {};
}

const chartId = (scriptId: string) => `lib:${scriptId}`;

export function ScriptEditor({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const [library, setLibrary] = useState<ScriptMeta[]>([]);
    const [filter, setFilter] = useState('');
    const [current, setCurrent] = useState<Script | null>(null);
    const [name, setName] = useState('');
    const [source, setSource] = useState('');
    const [docId, setDocId] = useState('none');
    const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
    const [report, setReport] = useState<CompatReport | null>(null);
    const [runError, setRunError] = useState<{ message: string; line?: number; column?: number } | null>(null);
    const [busy, setBusy] = useState(false);
    const [importing, setImporting] = useState(false);
    const [onPlot, setOnPlot] = useState(false);
    const [onChart, setOnChart] = useState(false);
    const reveal = useRef<(line: number, column?: number) => void>(() => {});
    const draftCount = useRef(0);

    const dirty = current ? source !== current.source || name !== current.name : source.trim().length > 0;

    const refresh = useCallback(async () => {
        setLibrary(await client.json<ScriptMeta[]>('/api/scripts'));
    }, [client]);

    const open = useCallback(
        async (id: string) => {
            const script = await client.json<Script>(`/api/scripts/${id}`);
            setCurrent(script);
            setName(script.name);
            setSource(script.source);
            setDocId(script.id);
            setReport(null);
            setRunError(null);
            setStatus(null);
        },
        [client],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: load the library once, then open its first script
    useEffect(() => {
        refresh()
            .then(async () => {
                const list = await client.json<ScriptMeta[]>('/api/scripts');
                if (list[0]) await open(list[0].id);
            })
            .catch((err) => setStatus({ kind: 'error', text: err.message }));
    }, []);

    // Track whether the open script is on the active chart.
    useEffect(() => {
        const read = () => {
            const chart: any = workspace.chart;
            setOnChart(!!chart?.indicators?.().some((h: any) => h.id === chartId(docId)));
        };
        read();
        const timer = setInterval(read, 700);
        return () => clearInterval(timer);
    }, [workspace, docId]);

    const startNew = (template: string, title: string) => {
        draftCount.current++;
        setCurrent(null);
        setName(title);
        setSource(template);
        setDocId(`draft-${draftCount.current}`);
        setReport(null);
        setRunError(null);
        setStatus(null);
    };

    const save = useCallback(async (): Promise<Script | null> => {
        if (!source.trim()) return null;
        setBusy(true);
        try {
            let saved: Script;
            if (current && !current.builtin)
                saved = await client.post<Script>(`/api/scripts/${current.id}`, { name, source }, 'PUT');
            else {
                // Bundled scripts are never overwritten: saving one creates your own copy.
                const copyName = current?.builtin && name === current.name ? `${name} (copy)` : name;
                saved = await client.post<Script>('/api/scripts', { name: copyName, source });
            }
            // Keep the chart indicator attached to the script under its saved id.
            const chart: any = workspace.chart;
            const old = chart.indicators().find((h: any) => h.id === chartId(docId));
            setCurrent(saved);
            setName(saved.name);
            setDocId(saved.id);
            if (old && saved.id !== docId) {
                old.remove();
                void chart.runIndicator(saved.source, {
                    id: chartId(saved.id),
                    title: readHeader(saved.source).title ?? saved.name,
                });
            }
            await refresh();
            setStatus({ kind: 'ok', text: `Saved "${saved.name}"` });
            return saved;
        } catch (err: any) {
            setStatus({ kind: 'error', text: `Save failed: ${err.message}` });
            return null;
        } finally {
            setBusy(false);
        }
    }, [client, current, name, source, docId, workspace, refresh]);

    /** Put the script on the active chart, or swap its code in place if it is already there. */
    const run = useCallback(async () => {
        const chart: any = workspace.chart;
        if (!chart || !source.trim()) return;
        setBusy(true);
        setRunError(null);
        try {
            const existing = chart.indicators().find((h: any) => h.id === chartId(docId));
            const title = readHeader(source).title ?? name;
            const result = existing
                ? await existing.updateCode(source)
                : await chart.runIndicator(source, { id: chartId(docId), title });
            if (result.ok) {
                setStatus({ kind: 'ok', text: existing ? 'Updated on the chart' : 'Added to the chart' });
                setOnChart(true);
            } else {
                const message = String(result.error?.message ?? 'the script failed').split('\n')[0];
                setRunError({ message, ...locate(String(result.error?.message ?? '')) });
                setStatus({
                    kind: 'error',
                    text: existing
                        ? 'The script failed; the chart keeps the previous version.'
                        : 'The script failed and was not added.',
                });
            }
        } finally {
            setBusy(false);
        }
    }, [workspace, source, docId, name]);

    const removeFromChart = () => {
        const chart: any = workspace.chart;
        chart
            .indicators()
            .find((h: any) => h.id === chartId(docId))
            ?.remove();
        setOnChart(false);
        setStatus({ kind: 'info', text: 'Removed from the chart' });
    };

    const check = useCallback(async () => {
        const chart: any = workspace.chart;
        const symbol = stripChartType(String(chart?.market?.symbol ?? ''));
        setBusy(true);
        try {
            const result = await client.post<CompatReport>('/api/scripts/check', {
                source,
                symbol,
                timeframe: chart?.market?.timeframe ?? '60',
            });
            setReport(result);
            setStatus(null);
        } catch (err: any) {
            setStatus({ kind: 'error', text: `Check failed: ${err.message}` });
        } finally {
            setBusy(false);
        }
    }, [client, workspace, source]);

    const remove = async () => {
        if (!current || !confirm(`Delete "${current.name}" from the library?`)) return;
        await client.json(`/api/scripts/${current.id}`, { method: 'DELETE' });
        const chart: any = workspace.chart;
        chart
            .indicators()
            .find((h: any) => h.id === chartId(current.id))
            ?.remove();
        await refresh();
        startNew(NEW_INDICATOR, 'My indicator');
    };

    const markers = useMemo<EditorMarker[]>(() => {
        const out: EditorMarker[] = [];
        if (runError?.line)
            out.push({ message: runError.message, line: runError.line, column: runError.column, severity: 'error' });
        for (const e of report?.errors ?? [])
            if (e.line) out.push({ message: e.message, line: e.line, column: e.column, severity: 'error' });
        for (const u of report?.unsupported ?? [])
            if (u.line)
                out.push({
                    message: `${u.name} is not available in this runtime`,
                    line: u.line,
                    column: u.column,
                    severity: 'error',
                });
        return out;
    }, [runError, report]);

    const shown = library.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));

    return (
        <div className="script-panel" data-testid="script-panel">
            <div className="script-library">
                <div className="row" style={{ padding: 6 }}>
                    <input
                        className="text grow"
                        placeholder="Search scripts…"
                        aria-label="Search scripts"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                    />
                </div>
                <div className="row" style={{ padding: '0 6px 6px', flexWrap: 'wrap' }}>
                    <Button onClick={() => startNew(NEW_INDICATOR, 'My indicator')}>+ Indicator</Button>
                    <Button onClick={() => startNew(NEW_STRATEGY, 'My strategy')}>+ Strategy</Button>
                    <Button onClick={() => setImporting(true)}>Import…</Button>
                </div>
                <div className="script-list">
                    {shown.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className={`script-item ${current?.id === s.id ? 'on' : ''}`}
                            onClick={() => void open(s.id)}
                            title={s.origin ?? s.name}
                        >
                            <span className="script-name">{s.name}</span>
                            <span className="script-tags">
                                <span className={`tag tag-${s.kind ?? 'none'}`}>
                                    {s.kind === 'strategy' ? 'S' : 'I'}
                                </span>
                                {s.builtin && (
                                    <span className="tag">{s.id.startsWith('example-') ? 'example' : 'built-in'}</span>
                                )}
                            </span>
                        </button>
                    ))}
                    {shown.length === 0 && <div className="empty">No scripts match.</div>}
                </div>
            </div>
            <div className="script-main">
                <div className="script-bar">
                    <input
                        className="text script-title"
                        aria-label="Script name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                    />
                    {dirty && <span className="muted">unsaved</span>}
                    <Button onClick={() => void save()} disabled={busy || !dirty} title="Save (⌘S / Ctrl+S)">
                        Save
                    </Button>
                    <Button
                        variant="primary"
                        onClick={() => void run()}
                        disabled={busy || !source.trim()}
                        title="⌘Enter / Ctrl+Enter"
                    >
                        {onChart ? 'Update on chart' : 'Add to chart'}
                    </Button>
                    {onChart && <Button onClick={removeFromChart}>Remove from chart</Button>}
                    <Button onClick={() => void check()} disabled={busy || !source.trim()}>
                        Check compatibility
                    </Button>
                    {readHeader(source).kind === 'strategy' && (
                        <Button
                            onClick={() => {
                                // A saved, unchanged script is tested by reference; anything else as it stands in the editor.
                                if (current && !dirty) {
                                    useTester.getState().patch({
                                        choice: { kind: 'pine', scriptId: current.id },
                                        result: null,
                                        error: null,
                                        tab: 'overview',
                                    });
                                } else
                                    useTester
                                        .getState()
                                        .testDraft(readHeader(source).title ?? (name || 'Strategy'), source);
                                useUi.getState().showBottomPanel('tester');
                            }}
                            disabled={busy || !source.trim()}
                            title="Run this strategy over history in the strategy tester"
                            data-testid="test-strategy"
                        >
                            Test strategy
                        </Button>
                    )}
                    <Button
                        onClick={() => setOnPlot(true)}
                        disabled={busy || !source.trim()}
                        title="Indicator on indicator: apply a study to one of this script's plots"
                    >
                        Study on plot…
                    </Button>
                    <span className="spacer" />
                    {current && (
                        <Button variant="danger" onClick={() => void remove()}>
                            Delete
                        </Button>
                    )}
                </div>
                {current && (current.author || current.license) && (
                    <div className="script-attribution">
                        {current.author && <span>Author: {current.author}</span>}
                        {current.license && <span>Licence: {current.license}</span>}
                        {current.origin && <span className="muted">{current.origin}</span>}
                    </div>
                )}
                <div className="script-editor">
                    <MonacoEditor
                        docId={docId}
                        value={source}
                        markers={markers}
                        onChange={setSource}
                        onSave={() => void save()}
                        onRun={() => void run()}
                        onReady={(fn) => {
                            reveal.current = fn;
                        }}
                    />
                </div>
                <div className="script-output" data-testid="script-output">
                    {status && <div className={`out-${status.kind}`}>{status.text}</div>}
                    {runError && (
                        <button
                            type="button"
                            className="out-link out-error"
                            onClick={() => runError.line && reveal.current(runError.line, runError.column)}
                        >
                            {runError.line ? `Line ${runError.line}: ` : ''}
                            {runError.message}
                        </button>
                    )}
                    {report && <Report report={report} onJump={(line, column) => reveal.current(line, column)} />}
                    {!status && !runError && !report && (
                        <span className="muted">
                            ⌘/Ctrl+Enter adds the script to the active chart. ⌘/Ctrl+S saves it.
                        </span>
                    )}
                </div>
            </div>
            {onPlot && (
                <OnPlotDialog
                    source={source}
                    workspace={workspace}
                    onClose={() => setOnPlot(false)}
                    onOpen={(composed, title) => {
                        setOnPlot(false);
                        startNew(composed, title);
                    }}
                />
            )}
            {importing && (
                <ImportDialog
                    client={client}
                    workspace={workspace}
                    onClose={() => setImporting(false)}
                    onSaved={async (id) => {
                        setImporting(false);
                        await refresh();
                        await open(id);
                    }}
                />
            )}
        </div>
    );
}

function Report({ report, onJump }: { report: CompatReport; onJump?: (line: number, column?: number) => void }) {
    return (
        <div className="report" data-testid="compat-report">
            <div className={report.ok && report.unsupported.length === 0 ? 'out-ok' : 'out-error'}>
                {report.ok && report.unsupported.length === 0
                    ? `Compatible: ${report.kind ?? 'script'} "${report.title ?? ''}" ran over ${report.bars} bars in ${report.ms.toFixed(0)} ms (${report.plots} plots, ${report.inputs} inputs, Pine v${report.version ?? '?'}).`
                    : report.ok
                      ? 'It runs, but references built-ins this runtime does not have:'
                      : 'Not compatible as written:'}
            </div>
            {report.errors.map((e) => (
                <button
                    type="button"
                    key={`${e.stage}:${e.line ?? 0}:${e.message}`}
                    className="out-link out-error"
                    onClick={() => e.line && onJump?.(e.line, e.column)}
                >
                    {e.stage === 'compile' ? 'Syntax' : 'Runtime'} error{e.line ? `, line ${e.line}` : ''}: {e.message}
                </button>
            ))}
            {report.unsupported.map((u) => (
                <button
                    type="button"
                    key={u.name}
                    className="out-link out-error"
                    onClick={() => u.line && onJump?.(u.line, u.column)}
                >
                    Not available: <code>{u.name}</code>
                    {u.line ? ` (line ${u.line})` : ''}
                </button>
            ))}
            {report.warnings.map((w) => (
                <div key={w.message} className="out-warn">
                    Warning: {w.message}
                </div>
            ))}
        </div>
    );
}

/** Paste a script from elsewhere, see whether it will run, and save it with its attribution. */
function ImportDialog({
    client,
    workspace,
    onClose,
    onSaved,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    onClose: () => void;
    onSaved: (id: string) => void;
}) {
    const [source, setSource] = useState('');
    const [author, setAuthor] = useState('');
    const [license, setLicense] = useState('');
    const [origin, setOrigin] = useState('');
    const [report, setReport] = useState<CompatReport | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const check = async () => {
        const chart: any = workspace.chart;
        setBusy(true);
        setError(null);
        try {
            setReport(
                await client.post<CompatReport>('/api/scripts/check', {
                    source,
                    symbol: stripChartType(String(chart?.market?.symbol ?? '')),
                    timeframe: chart?.market?.timeframe ?? '60',
                }),
            );
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const save = async () => {
        setBusy(true);
        setError(null);
        try {
            const saved = await client.post<Script>('/api/scripts', { source, author, license, origin });
            onSaved(saved.id);
        } catch (err: any) {
            setError(err.message);
            setBusy(false);
        }
    };

    return (
        <Modal title="Import a Pine script" onClose={onClose} width={680}>
            <p className="muted" style={{ marginTop: 0 }}>
                Paste the source of an open-source script, for example from the “Source code” tab of a TradingView
                script page. Invite-only and protected scripts cannot be imported: their source is not published.
            </p>
            <textarea
                className="text import-source"
                aria-label="Script source"
                placeholder="//@version=6&#10;indicator(…)"
                spellCheck={false}
                value={source}
                onChange={(e) => {
                    setSource(e.target.value);
                    setReport(null);
                }}
                onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="row" style={{ alignItems: 'flex-start', marginTop: 10 }}>
                <div className="grow">
                    <Field label="Author">
                        <input
                            className="text"
                            value={author}
                            onChange={(e) => setAuthor(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder="e.g. LuxAlgo"
                        />
                    </Field>
                </div>
                <div className="grow">
                    <Field label="Licence">
                        <input
                            className="text"
                            value={license}
                            onChange={(e) => setLicense(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder="e.g. CC BY-NC-SA 4.0"
                        />
                    </Field>
                </div>
            </div>
            <Field
                label="Where it came from"
                hint="Kept with the script so the attribution its licence asks for is never lost."
            >
                <input
                    className="text"
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="https://…"
                />
            </Field>
            {report && <Report report={report} />}
            {error && <div className="error">{error}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <Button onClick={() => void check()} disabled={busy || !source.trim()}>
                    Check compatibility
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={busy || !source.trim()}>
                    Save to library
                </Button>
            </div>
        </Modal>
    );
}

/** Indicator on indicator: pick one of the open script's plots and a study to compute on it. */
function OnPlotDialog({
    source,
    workspace,
    onClose,
    onOpen,
}: {
    source: string;
    workspace: VelaWorkspace;
    onClose: () => void;
    onOpen: (source: string, title: string) => void;
}) {
    const plots = useMemo(() => findPlots(source), [source]);
    const isIndicator = readHeader(source).kind === 'indicator';
    const [plot, setPlot] = useState(0);
    const [study, setStudy] = useState<OnPlotStudy>('sma');
    const [length, setLength] = useState(14);
    const [mult, setMult] = useState(2);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const build = () => composeOnPlot(source, plot, study, length, mult);

    const add = async () => {
        setBusy(true);
        setError(null);
        try {
            const chart: any = workspace.chart;
            const built = build();
            const result = await chart.runIndicator(built.source, { title: built.title });
            if (result.ok) onClose();
            else setError(String(result.error?.message ?? 'the script failed').split('\n')[0]);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Study on plot" onClose={onClose} width={440}>
            {!isIndicator || plots.length === 0 ? (
                <p className="muted">
                    {isIndicator
                        ? 'This script has no plot() calls to build on.'
                        : 'A study can be applied to an indicator script, not to a strategy or library.'}
                </p>
            ) : (
                <>
                    <p className="muted" style={{ marginTop: 0 }}>
                        Computes a study on one of this script’s plots and adds the result as its own indicator. The
                        original plots are hidden in the new script; the chosen plot is kept as a grey line for
                        reference.
                    </p>
                    <Field label="Plot">
                        <select
                            className="text"
                            aria-label="Plot"
                            value={plot}
                            onChange={(e) => setPlot(Number(e.target.value))}
                        >
                            {plots.map((p, i) => (
                                <option key={p.end} value={i}>
                                    {p.title} — {p.expr.length > 40 ? `${p.expr.slice(0, 40)}…` : p.expr}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <div className="row" style={{ alignItems: 'flex-start' }}>
                        <div className="grow">
                            <Field label="Study">
                                <select
                                    className="text"
                                    aria-label="Study"
                                    value={study}
                                    onChange={(e) => setStudy(e.target.value as OnPlotStudy)}
                                >
                                    {ON_PLOT_STUDIES.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.label}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        </div>
                        <Field label="Length">
                            <input
                                className="text"
                                aria-label="Length"
                                type="number"
                                min={1}
                                max={500}
                                style={{ width: 80 }}
                                value={length}
                                onChange={(e) => setLength(Math.max(1, Number(e.target.value) || 1))}
                            />
                        </Field>
                        {study === 'bb' && (
                            <Field label="Width">
                                <input
                                    className="text"
                                    type="number"
                                    min={0.1}
                                    step={0.1}
                                    style={{ width: 70 }}
                                    value={mult}
                                    onChange={(e) => setMult(Math.max(0.1, Number(e.target.value) || 2))}
                                />
                            </Field>
                        )}
                    </div>
                    {error && <div className="error">{error}</div>}
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button
                            onClick={() => {
                                const built = build();
                                onOpen(built.source, built.title);
                            }}
                        >
                            Open in editor
                        </Button>
                        <Button variant="primary" onClick={() => void add()} disabled={busy}>
                            Add to chart
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
