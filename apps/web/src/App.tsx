import { chartTypes } from '@luxalgo/vela/plugin';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppContext } from './app-context.ts';
import { BottomPanel } from './BottomPanel.tsx';
import { Chart } from './Chart.tsx';
import { AlertDialog } from './dialogs/AlertDialog.tsx';
import { ChartTypeDialog } from './dialogs/ChartTypeDialog.tsx';
import { FormulaDialog } from './dialogs/FormulaDialog.tsx';
import { LayoutsDialog } from './dialogs/LayoutsDialog.tsx';
import { bindAlerts } from './lib/alert-lines.ts';
import { useAlerts } from './lib/alerts-store.ts';
import { bindAutomation, useAutomation } from './lib/automation-store.ts';
import { getChartLines, getChartMarkers, lineBoxes } from './lib/chart-lines.ts';
import { ServerClient } from './lib/client.ts';
import { bindFootprints } from './lib/footprint-feed.ts';
import { useParams } from './lib/params.ts';
import { useUi } from './lib/store.ts';
import { useTester } from './lib/tester-store.ts';
import { bindTradingLines } from './lib/trading-lines.ts';
import { bindTrading, useTrading } from './lib/trading-store.ts';
import { ConfirmOrder } from './panels/trading/ConfirmOrder.tsx';
import { QuickTrade } from './panels/trading/QuickTrade.tsx';
import { ReplayBar } from './ReplayBar.tsx';
import { RightDock } from './RightDock.tsx';
import { StatusBar } from './StatusBar.tsx';
import { Toasts } from './Toasts.tsx';

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
    const alertDraft = useUi((s) => s.alertDraft);
    const quickTrade = useTrading((s) => s.quickTrade);

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

    // Alerts live on the server: keep the list and log current, and announce fires.
    useEffect(() => useAlerts.getState().start(client), [client]);
    // Draw alert levels on the charts and follow drawings that alerts are attached to.
    useEffect(() => (workspace ? bindAlerts(workspace, client) : undefined), [workspace, client]);
    // Trading: the account's state from the server, and its orders and positions drawn on the charts.
    useEffect(() => bindTrading(client), [client]);
    useEffect(() => bindAutomation(client), [client]);
    useEffect(() => (workspace ? bindTradingLines(workspace) : undefined), [workspace]);
    // Footprints for charts set to that style.
    useEffect(() => (workspace ? bindFootprints(workspace, client) : undefined), [workspace, client]);

    useEffect(() => {
        (window as any).__ts = {
            client,
            workspace,
            ui: useUi,
            params: useParams,
            alerts: useAlerts,
            chartLines: getChartLines,
            tester: useTester,
            chartMarkers: getChartMarkers,
            trading: useTrading,
            automation: useAutomation,
            lineBoxes,
            chartTypes: () => chartTypes().map((t: any) => t.id),
        };
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
                        {workspace && quickTrade && <QuickTrade client={client} workspace={workspace} />}
                        {workspace && replayOpen && <ReplayBar workspace={workspace} />}
                        {workspace && bottomPanel && <BottomPanel client={client} workspace={workspace} />}
                    </div>
                    {providers && rightPanel && (
                        <RightDock client={client} workspace={workspace} providers={providers} />
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
                {workspace && dialog === 'alert' && alertDraft && (
                    <AlertDialog client={client} workspace={workspace} draft={alertDraft} onClose={closeDialog} />
                )}
                <ConfirmOrder />
                <Toasts />
            </div>
        </AppContext.Provider>
    );
}
