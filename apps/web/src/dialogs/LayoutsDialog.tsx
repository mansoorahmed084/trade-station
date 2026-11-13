import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { readHeader } from '@ts/script-engine/source';
import { useEffect, useState } from 'react';
import type { ServerClient } from '../lib/client.ts';
import { Button, Modal, Tabs } from '../ui.tsx';

interface Saved {
    savedAt: number;
    data: unknown;
}
type Store = Record<string, Saved>;

const KEYS = { layouts: 'savedLayouts', templates: 'chartTemplates', indicators: 'indicatorTemplates' } as const;
type Kind = keyof typeof KEYS;

const COPY: Record<Kind, { noun: string; hint: string }> = {
    layouts: {
        noun: 'layout',
        hint: 'A layout is the whole workspace: the chart grid, every symbol and timeframe, indicators and drawings.',
    },
    templates: {
        noun: 'template',
        hint: 'A chart template is the look of one chart: colours, scales, grid and status line. It is applied to the active chart.',
    },
    indicators: {
        noun: 'indicator set',
        hint: 'An indicator set is every indicator on the active chart. Loading one adds them to the active chart with their default inputs.',
    },
};

interface IndicatorSet {
    scripts: { title: string; source: string; language?: string }[];
    natives: string[];
}

/** What is on a chart, in a form that can be added to another chart. Volume is left out: charts add it themselves. */
function captureIndicators(chart: any): IndicatorSet {
    const set: IndicatorSet = { scripts: [], natives: [] };
    for (const h of chart.indicators()) {
        if (h.source) set.scripts.push({ title: h.title, source: h.source, language: h.language });
        else if (h.nativeType && h.nativeType !== 'volume') set.natives.push(h.nativeType);
    }
    return set;
}

function applyIndicators(chart: any, set: IndicatorSet): number {
    let added = 0;
    for (const type of set.natives ?? []) {
        chart.addNativeIndicator(type);
        added++;
    }
    for (const s of set.scripts ?? []) {
        const title = readHeader(s.source).title ?? (s.title && s.title !== 'Indicator' ? s.title : undefined);
        chart.addIndicator(s.source, { ...(s.language ? { language: s.language } : {}), ...(title ? { title } : {}) });
        added++;
    }
    return added;
}

/** Named, saved copies of the workspace (layouts), a chart's appearance (templates) and its indicators (sets). */
export function LayoutsDialog({
    client,
    workspace,
    onClose,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    onClose: () => void;
}) {
    const [kind, setKind] = useState<Kind>('layouts');
    const [store, setStore] = useState<Store>({});
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setStore({});
        client.kvGet(KEYS[kind]).then((raw) => {
            if (cancelled || !raw) return;
            try {
                setStore(JSON.parse(raw) as Store);
            } catch {}
        });
        return () => {
            cancelled = true;
        };
    }, [client, kind]);

    const persist = (next: Store) => {
        setStore(next);
        client.kvSet(KEYS[kind], JSON.stringify(next));
    };

    const save = () => {
        const key = name.trim();
        if (!key) return;
        if (store[key] && !confirm(`Replace the saved ${COPY[kind].noun} "${key}"?`)) return;
        const chart: any = workspace.chart;
        let data: unknown;
        if (kind === 'layouts') data = workspace.getState();
        else if (kind === 'templates') data = chart.renderer.getConfig();
        else {
            const set = captureIndicators(chart);
            data = set.scripts.length + set.natives.length > 0 ? set : null;
        }
        if (!data) {
            setError(
                kind === 'indicators'
                    ? 'The active chart has no indicators to save.'
                    : 'Nothing to save: the chart is not ready yet.',
            );
            return;
        }
        persist({ ...store, [key]: { savedAt: Date.now(), data } });
        setName('');
        setError(null);
    };

    const load = (key: string) => {
        try {
            const chart: any = workspace.chart;
            if (kind === 'layouts') workspace.applyState(store[key].data as any);
            else if (kind === 'templates') chart.renderer.applyConfig(store[key].data);
            else applyIndicators(chart, store[key].data as IndicatorSet);
            onClose();
        } catch (err: any) {
            setError(err?.message ?? 'could not apply it');
        }
    };

    const names = Object.keys(store).sort((a, b) => store[b].savedAt - store[a].savedAt);
    const describe = (saved: Saved): string => {
        if (kind !== 'indicators') return '';
        const set = saved.data as IndicatorSet;
        return `${(set.scripts?.length ?? 0) + (set.natives?.length ?? 0)} indicators`;
    };

    return (
        <Modal title="Saved layouts and templates" onClose={onClose} width={560}>
            <Tabs
                tabs={[
                    { id: 'layouts', label: 'Layouts' },
                    { id: 'templates', label: 'Chart templates' },
                    { id: 'indicators', label: 'Indicator sets' },
                ]}
                value={kind}
                onChange={(k) => {
                    setKind(k);
                    setError(null);
                }}
            />
            <p className="muted" style={{ marginTop: 0 }}>
                {COPY[kind].hint}
            </p>
            <div className="row" style={{ marginBottom: 12 }}>
                <input
                    className="text grow"
                    placeholder={`Name for the current ${COPY[kind].noun}`}
                    aria-label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') save();
                    }}
                />
                <Button variant="primary" onClick={save} disabled={!name.trim()}>
                    Save current
                </Button>
            </div>
            {error && <div className="error">{error}</div>}
            {names.length === 0 && <div className="empty">No saved {COPY[kind].noun}s yet.</div>}
            {names.map((key) => (
                <div className="list-row" key={key}>
                    <span className="grow">{key}</span>
                    <span className="muted">
                        {describe(store[key])} {new Date(store[key].savedAt).toLocaleString()}
                    </span>
                    <Button onClick={() => load(key)}>Load</Button>
                    <Button
                        variant="danger"
                        onClick={() => {
                            if (!confirm(`Delete the saved ${COPY[kind].noun} "${key}"?`)) return;
                            const next = { ...store };
                            delete next[key];
                            persist(next);
                        }}
                    >
                        Delete
                    </Button>
                </div>
            ))}
        </Modal>
    );
}
