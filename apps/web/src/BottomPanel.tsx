import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback } from 'react';
import type { ServerClient } from './lib/client.ts';
import { type BottomPanel as PanelId, useUi } from './lib/store.ts';
import { ScriptEditor } from './panels/ScriptEditor.tsx';

const TABS: { id: PanelId; label: string }[] = [{ id: 'editor', label: 'Pine editor' }];

/** The dock under the chart: the script editor now; the strategy tester and trading panels join it later. */
export function BottomPanel({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const panel = useUi((s) => s.bottomPanel);
    const height = useUi((s) => s.bottomHeight);
    const setHeight = useUi((s) => s.setBottomHeight);
    const toggle = useUi((s) => s.toggleBottomPanel);

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
                        onClick={() => panel !== t.id && toggle(t.id)}
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
                {panel === 'editor' && <ScriptEditor client={client} workspace={workspace} />}
            </div>
        </div>
    );
}
