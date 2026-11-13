import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useEffect, useState } from 'react';
import type { ServerClient } from '../lib/client.ts';
import { Button, Modal, Tabs } from '../ui.tsx';

interface Saved {
    savedAt: number;
    data: unknown;
}
type Store = Record<string, Saved>;

const KEYS = { layouts: 'savedLayouts', templates: 'chartTemplates' } as const;
type Kind = keyof typeof KEYS;

const COPY: Record<Kind, { noun: string; hint: string }> = {
    layouts: {
        noun: 'layout',
        hint: 'A layout is the whole workspace: the chart grid, every symbol and timeframe, indicators and drawings.',
    },
    templates: {
        noun: 'template',
        hint: 'A template is the look of one chart: colours, scales, grid and status line. It is applied to the active chart.',
    },
};

/** Named, saved copies of the workspace (layouts) and of a chart's appearance (templates). */
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
        const data = kind === 'layouts' ? workspace.getState() : chart.renderer.getConfig();
        if (!data) {
            setError('Nothing to save: the chart is not ready yet.');
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
            else chart.renderer.applyConfig(store[key].data);
            onClose();
        } catch (err: any) {
            setError(err?.message ?? 'could not apply it');
        }
    };

    const names = Object.keys(store).sort((a, b) => store[b].savedAt - store[a].savedAt);

    return (
        <Modal title="Saved layouts and templates" onClose={onClose} width={520}>
            <Tabs
                tabs={[
                    { id: 'layouts', label: 'Layouts' },
                    { id: 'templates', label: 'Chart templates' },
                ]}
                value={kind}
                onChange={setKind}
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
                    <span className="muted">{new Date(store[key].savedAt).toLocaleString()}</span>
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
