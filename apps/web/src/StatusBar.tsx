import { useEffect, useState } from 'react';
import type { ConnectionStatus, PerfSnapshot, ServerClient } from './lib/client.ts';
import { useTrading } from './lib/trading-store.ts';
import { KillSwitch } from './panels/automation/KillSwitch.tsx';
import { AccountBadge } from './panels/trading/AccountBadge.tsx';

const LABEL: Record<ConnectionStatus, string> = {
    open: 'Connected',
    connecting: 'Connecting…',
    closed: 'Disconnected — retrying',
};

export function StatusBar({ client }: { client: ServerClient }) {
    const [status, setStatus] = useState(client.status);
    const [perf, setPerf] = useState<PerfSnapshot>(client.perf());
    const [now, setNow] = useState(Date.now());
    const account = useTrading((s) => s.account);

    useEffect(() => {
        const off = client.events.on('status', setStatus);
        const timer = setInterval(() => {
            setPerf(client.perf());
            setNow(Date.now());
        }, 1000);
        return () => {
            off();
            clearInterval(timer);
        };
    }, [client]);

    return (
        <div className="statusbar">
            <span className={`dot dot-${status}`} />
            <span>{LABEL[status]}</span>
            {perf.rttMs !== null && <span className="muted">round trip {perf.rttMs.toFixed(1)} ms</span>}
            {perf.samples > 0 && (
                <span className="muted" title="Server send to the next painted frame, over recent live updates">
                    live update to screen: median {perf.pixelP50.toFixed(0)} ms · p95 {perf.pixelP95.toFixed(0)} ms
                </span>
            )}
            <span className="spacer" />
            {account && (
                <span className="status-account" title={`Orders go to ${account.name}`}>
                    <AccountBadge account={account} />
                    <span className="muted">
                        equity{' '}
                        {account.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </span>
            )}
            <KillSwitch />
            <span className="muted">{new Date(now).toISOString().slice(11, 19)} UTC</span>
        </div>
    );
}
