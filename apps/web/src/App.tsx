import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppContext } from './app-context.ts';
import { BottomPanel } from './BottomPanel.tsx';
import { Chart } from './Chart.tsx';
import { ChartTypeDialog } from './dialogs/ChartTypeDialog.tsx';
import { FormulaDialog } from './dialogs/FormulaDialog.tsx';
import { LayoutsDialog } from './dialogs/LayoutsDialog.tsx';
import { ServerClient } from './lib/client.ts';
import { useParams } from './lib/params.ts';
import { useUi } from './lib/store.ts';
import { Watchlist } from './panels/Watchlist.tsx';
import { ReplayBar } from './ReplayBar.tsx';
import { StatusBar } from './StatusBar.tsx';

export function App() {
    const client = useMemo(() => new ServerClient(), []);
    const [providers, setProviders] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [workspace, setWorkspace] = useState<VelaWorkspace | null>(null);
    const rightPanel = useUi((s) => s.rightPanel);
    const replayOpen = useUi((s) => s.replayOpen);
    const bottomPanel = useUi((s) => s.bottomPanel);
    const bottomHeight = useUi((s) => s.bottomHeight);
    const dialog = useUi((s) => s.dialog);
    const setDialog = useUi((s) => s.setDialog);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const load = () => {
            Promise.all([client.providers(), useParams.getState().load(client)])
                .then(([list]) => {
                    if (cancelled) return;
                    setProviders(list);
                    setError(null);
                })
                .catch((err: Error) => {
                    if (cancelled) return;
                    setError(err.message);
                    timer = setTimeout(load, 1500);
                });
        };
        load();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [client]);

    useEffect(() => {
        (window as any).__ts = { client, workspace, ui: useUi, params: useParams };
    }, [client, workspace]);

    // The chart must re-measure itself when a panel beside or below it opens or closes.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the panel flags are the trigger
    useEffect(() => {
        const chart: any = workspace?.chart;
        const id = requestAnimationFrame(() => {
            for (const cell of (workspace?.cells() ?? []) as any[]) cell.chart?.resize?.();
            chart?.resize?.();
        });
        return () => cancelAnimationFrame(id);
    }, [workspace, rightPanel, replayOpen, bottomPanel, bottomHeight]);

    const onReady = useCallback((ws: VelaWorkspace | null) => setWorkspace(ws), []);
    const services = useMemo(() => ({ client, workspace }), [client, workspace]);
    const closeDialog = useCallback(() => setDialog(null), [setDialog]);

    return (
        <AppContext.Provider value={services}>
            <div className="app">
                <div className="main">
                    <div className="center">
                        {providers ? (
                            providers.length ? (
                                <Chart client={client} providers={providers} onReady={onReady} />
                            ) : (
                                <div className="notice">
                                    The server reports no market-data providers. Check TS_PROVIDERS.
                                </div>
                            )
                        ) : (
                            <div className="notice">
                                {error ? `Waiting for the server on :8787 — ${error}` : 'Loading…'}
                            </div>
                        )}
                        {workspace && replayOpen && <ReplayBar workspace={workspace} />}
                        {workspace && bottomPanel && <BottomPanel client={client} workspace={workspace} />}
                    </div>
                    {providers && rightPanel === 'watchlist' && (
                        <Watchlist client={client} workspace={workspace} providers={providers} />
                    )}
                </div>
                <StatusBar client={client} />
                {workspace && dialog === 'layouts' && (
                    <LayoutsDialog client={client} workspace={workspace} onClose={closeDialog} />
                )}
                {workspace && dialog === 'formula' && (
                    <FormulaDialog client={client} workspace={workspace} onClose={closeDialog} />
                )}
                {workspace && dialog === 'chartType' && (
                    <ChartTypeDialog client={client} workspace={workspace} onClose={closeDialog} />
                )}
            </div>
        </AppContext.Provider>
    );
}
