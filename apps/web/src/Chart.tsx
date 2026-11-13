import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { useEffect, useRef } from 'react';
import type { ServerClient } from './lib/client.ts';
import { ServerProvider, serverStorage } from './lib/provider.ts';

interface Props {
    client: ServerClient;
    providers: string[];
    onReady: (workspace: VelaWorkspace | null) => void;
}

/** Venue used for the first-run default chart, in order of preference. */
const DEFAULTS: Record<string, string> = { BINANCE: 'BINANCE:BTCUSDT', SYNTH: 'SYNTH:ALPHA' };

export function Chart({ client, providers, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!host.current || providers.length === 0) return;
        const venue = providers.find((p) => DEFAULTS[p]) ?? providers[0];
        const factories: Record<string, () => unknown> = {};
        for (const name of providers) factories[name.toLowerCase()] = () => new ServerProvider(client, name);

        const workspace = new VelaWorkspace(host.current, {
            layout: '1',
            symbol: DEFAULTS[venue] ?? `${venue}:`,
            timeframe: '60',
            bars: 5000,
            live: true,
            theme: 'dark',
            timezone: 'Etc/UTC',
            sidebar: true,
            autofocus: true,
            providers: factories as any,
            engines: { pine: () => new PineWorkerEngine() },
            persist: 'main',
            storage: serverStorage(client),
        } as any);
        onReady(workspace);
        return () => {
            onReady(null);
            workspace.destroy();
        };
    }, [client, providers, onReady]);

    return <div ref={host} className="chart-host" />;
}
