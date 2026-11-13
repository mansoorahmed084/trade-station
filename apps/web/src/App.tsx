import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppContext } from './app-context.ts';
import { Chart } from './Chart.tsx';
import { ServerClient } from './lib/client.ts';
import { StatusBar } from './StatusBar.tsx';

export function App() {
    const client = useMemo(() => new ServerClient(), []);
    const [providers, setProviders] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [workspace, setWorkspace] = useState<VelaWorkspace | null>(null);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const load = () => {
            client
                .providers()
                .then((list) => {
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
        (window as any).__ts = { client, workspace };
    }, [client, workspace]);

    const onReady = useCallback((ws: VelaWorkspace | null) => setWorkspace(ws), []);
    const services = useMemo(() => ({ client, workspace }), [client, workspace]);

    return (
        <AppContext.Provider value={services}>
            <div className="app">
                <div className="main">
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
                </div>
                <StatusBar client={client} />
            </div>
        </AppContext.Provider>
    );
}
