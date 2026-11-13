import { describeCondition } from '@ts/alerts/template';
import type { Alert } from '@ts/alerts/types';
import { timeframeLabel } from '@ts/core';
import { useEffect, useState } from 'react';
import { useAlerts } from '../lib/alerts-store.ts';
import type { ServerClient } from '../lib/client.ts';
import { useUi } from '../lib/store.ts';
import { Button, Tabs } from '../ui.tsx';

const FREQ: Record<Alert['frequency'], string> = {
    once: 'once',
    once_per_bar: 'once per bar',
    once_per_bar_close: 'on bar close',
    every_time: 'every time',
};

const ago = (t: number): string => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
};

const ticker = (symbol: string) => symbol.slice(symbol.indexOf(':') + 1);

function status(alert: Alert): { label: string; cls: string } {
    if (alert.active) return { label: 'Active', cls: 'on' };
    if (alert.frequency === 'once' && alert.state.fireCount > 0) return { label: 'Triggered', cls: 'done' };
    if (alert.expiresAt !== null && alert.expiresAt <= Date.now()) return { label: 'Expired', cls: 'off' };
    return { label: 'Paused', cls: 'off' };
}

export function Alerts({ client }: { client: ServerClient }) {
    const alerts = useAlerts((s) => s.alerts);
    const log = useAlerts((s) => s.log);
    const loaded = useAlerts((s) => s.loaded);
    const setActive = useAlerts((s) => s.setActive);
    const remove = useAlerts((s) => s.remove);
    const clearLog = useAlerts((s) => s.clearLog);
    const markSeen = useAlerts((s) => s.markSeen);
    const toast = useAlerts((s) => s.toast);
    const openDialog = useUi((s) => s.openAlertDialog);
    const [tab, setTab] = useState<'alerts' | 'log'>('alerts');
    const [, setNow] = useState(0);
    const [permission, setPermission] = useState(
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    );

    useEffect(() => {
        markSeen();
        const timer = setInterval(() => setNow((n) => n + 1), 15_000);
        return () => clearInterval(timer);
    }, [markSeen]);
    useEffect(() => {
        if (tab === 'log') markSeen();
    }, [tab, markSeen]);

    const act = (work: Promise<unknown>) =>
        work.catch((err: Error) => toast({ title: 'Alerts', text: err.message, kind: 'error' }));

    return (
        <div className="dock-content" data-testid="alerts-panel">
            <div className="panel-head">
                <Button variant="primary" onClick={() => openDialog({})}>
                    + Create alert
                </Button>
                <span className="grow" />
                {permission === 'default' && (
                    <Button
                        title="Show alerts as system notifications when this tab is in the background"
                        onClick={() => void Notification.requestPermission().then(setPermission)}
                    >
                        Desktop alerts
                    </Button>
                )}
            </div>
            <div style={{ padding: '0 8px' }}>
                <Tabs
                    tabs={[
                        { id: 'alerts', label: `Alerts (${alerts.length})` },
                        { id: 'log', label: `Log (${log.length})` },
                    ]}
                    value={tab}
                    onChange={setTab}
                />
            </div>
            <div className="panel-body">
                {tab === 'alerts' ? (
                    <>
                        {loaded && alerts.length === 0 && (
                            <div className="empty">
                                No alerts yet. Create one here, or right-click the chart and choose “Add alert”. Alerts
                                run on the server, so they keep working when this page is closed.
                            </div>
                        )}
                        {alerts.map((a) => {
                            const st = status(a);
                            return (
                                <div className="alert-item" key={a.id} data-testid="alert-item">
                                    <div className="alert-top">
                                        <span className={`pill pill-${st.cls}`}>{st.label}</span>
                                        <span className="alert-name" title={a.name}>
                                            {a.name}
                                        </span>
                                    </div>
                                    <div className="alert-meta">
                                        {a.symbols.length === 1 ? ticker(a.symbols[0]) : `${a.symbols.length} symbols`}{' '}
                                        · {timeframeLabel(a.timeframe)} · {FREQ[a.frequency]}
                                    </div>
                                    <div className="alert-meta" title={describeCondition(a.condition)}>
                                        {describeCondition(a.condition)}
                                    </div>
                                    <div className="alert-foot">
                                        <span className="muted">
                                            {a.state.fireCount > 0
                                                ? `Fired ${a.state.fireCount}×, last ${ago(a.state.lastFiredAt ?? 0)}`
                                                : 'Not fired yet'}
                                        </span>
                                        <span className="grow" />
                                        <button
                                            type="button"
                                            className="link"
                                            onClick={() => void act(setActive(client, a.id, !a.active))}
                                        >
                                            {a.active ? 'Pause' : 'Resume'}
                                        </button>
                                        <button
                                            type="button"
                                            className="link"
                                            onClick={() => openDialog({ editId: a.id })}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            className="link danger"
                                            onClick={() => {
                                                if (confirm(`Delete the alert "${a.name}"?`))
                                                    void act(remove(client, a.id));
                                            }}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </>
                ) : (
                    <>
                        {log.length === 0 ? (
                            <div className="empty">Nothing has fired yet.</div>
                        ) : (
                            <div style={{ padding: '6px 8px' }}>
                                <Button
                                    onClick={() => {
                                        if (confirm('Clear the whole alert log?')) void act(clearLog(client));
                                    }}
                                >
                                    Clear log
                                </Button>
                            </div>
                        )}
                        {log.map((e) => {
                            const failed = e.deliveries.filter((d) => !d.ok);
                            return (
                                <div className="alert-item" key={e.id} data-testid="log-item">
                                    <div className="alert-top">
                                        <span className="alert-name">{e.alertName}</span>
                                        {e.late && (
                                            <span
                                                className="pill pill-done"
                                                title="Found while replaying bars that closed while the server was down"
                                            >
                                                missed
                                            </span>
                                        )}
                                    </div>
                                    <div className="alert-meta log-message">{e.message}</div>
                                    <div className="alert-foot">
                                        <span className="muted">
                                            {ticker(e.symbol)} ·{' '}
                                            {new Date(e.time).toISOString().slice(0, 19).replace('T', ' ')} UTC
                                        </span>
                                        <span className="grow" />
                                        {failed.length > 0 && (
                                            <span
                                                className="down"
                                                title={failed
                                                    .map((d) => `${d.channel}: ${d.detail ?? 'failed'}`)
                                                    .join('\n')}
                                            >
                                                {failed.map((d) => d.channel).join(', ')} failed
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </>
                )}
            </div>
        </div>
    );
}
