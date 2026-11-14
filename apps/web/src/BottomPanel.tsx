import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback } from 'react';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import type { ServerClient } from './lib/client.ts';
import { type BottomPanel as PanelId, useUi } from './lib/store.ts';
import { Automation } from './panels/automation/Automation.tsx';
import { Screener } from './panels/Screener.tsx';
import { ScriptEditor } from './panels/ScriptEditor.tsx';
import { StrategyTester } from './panels/StrategyTester.tsx';
import { AccountManager } from './panels/trading/AccountManager.tsx';

const TABS: { id: PanelId; label: string }[] = [
    { id: 'editor', label: 'Pine editor' },
    { id: 'tester', label: 'Strategy tester' },
    { id: 'trading', label: 'Account' },
    { id: 'automation', label: 'Automation' },
    { id: 'screener', label: 'Screener' },
];

/** The dock under the chart: the script editor, the strategy tester and the account manager. */
export function BottomPanel({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const panel = useUi((s) => s.bottomPanel);
    const height = useUi((s) => s.bottomHeight);
    const setHeight = useUi((s) => s.setBottomHeight);
    const toggle = useUi((s) => s.toggleBottomPanel);
    const show = useUi((s) => s.showBottomPanel);

    const startResize = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = useUi.getState().bottomHeight;
            const move = (ev: MouseEvent) => setHeight(startH + (startY - ev.clientY));
            const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
        },
        [setHeight],
    );

    if (!panel) return null;
    return (
        <div className="bottom-panel" style={{ height }} data-testid="bottom-panel">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag handle */}
            <div className="resize-handle" onMouseDown={startResize} title="Drag to resize" />
            <div className="bottom-tabs">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        className={`tab ${panel === t.id ? 'tab-on' : ''}`}
                        onClick={() => show(t.id)}
                        data-testid={`bottom-tab-${t.id}`}
                    >
                        {t.label}
                    </button>
                ))}
                <span className="spacer" />
                <button type="button" className="icon-btn" title="Close panel" onClick={() => toggle(panel)}>
                    ×
                </button>
            </div>
            <div className="bottom-body">
                <ErrorBoundary key={panel} name={TABS.find((t) => t.id === panel)?.label ?? 'This panel'}>
                    {panel === 'editor' && <ScriptEditor client={client} workspace={workspace} />}
                    {panel === 'tester' && <StrategyTester client={client} workspace={workspace} />}
                    {panel === 'trading' && <AccountManager workspace={workspace} />}
                    {panel === 'automation' && <Automation client={client} workspace={workspace} />}
                    {panel === 'screener' && <Screener client={client} workspace={workspace} />}
                </ErrorBoundary>
            </div>
        </div>
    );
}
