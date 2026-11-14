import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useAlerts } from './lib/alerts-store.ts';
import type { ServerClient } from './lib/client.ts';
import { type RightPanel, useUi } from './lib/store.ts';
import { Alerts } from './panels/Alerts.tsx';
import { DomLadder } from './panels/trading/DomLadder.tsx';
import { OrderTicket } from './panels/trading/OrderTicket.tsx';
import { Watchlist } from './panels/Watchlist.tsx';

/** The column beside the chart: watchlist, alerts, the order ticket and the depth ladder. */
export function RightDock({
    client,
    workspace,
    providers,
}: {
    client: ServerClient;
    workspace: VelaWorkspace | null;
    providers: string[];
}) {
    const panel = useUi((s) => s.rightPanel);
    const show = useUi((s) => s.showRightPanel);
    const unseen = useAlerts((s) => s.unseen);
    if (!panel) return null;
    const tabs: { id: RightPanel; label: string }[] = [
        { id: 'watchlist', label: 'Watchlist' },
        { id: 'alerts', label: unseen > 0 && panel !== 'alerts' ? `Alerts (${unseen})` : 'Alerts' },
        { id: 'trade', label: 'Trade' },
        { id: 'dom', label: 'Depth' },
    ];
    return (
        <div className="right-dock" data-testid="right-dock">
            <div className="dock-tabs">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        className={`tab ${panel === t.id ? 'tab-on' : ''}`}
                        onClick={() => show(t.id)}
                        data-testid={`dock-tab-${t.id}`}
                    >
                        {t.label}
                    </button>
                ))}
                <span className="spacer" />
                <button type="button" className="icon-btn" title="Close" onClick={() => show(null)}>
                    ×
                </button>
            </div>
            <ErrorBoundary key={panel} name={tabs.find((t) => t.id === panel)?.label ?? 'This panel'}>
                {panel === 'watchlist' && <Watchlist client={client} workspace={workspace} providers={providers} />}
                {panel === 'alerts' && <Alerts client={client} />}
                {panel === 'trade' && workspace && <OrderTicket client={client} workspace={workspace} />}
                {panel === 'dom' && workspace && <DomLadder client={client} workspace={workspace} />}
            </ErrorBoundary>
        </div>
    );
}
