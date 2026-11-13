import { VelaWorkspace } from '@luxalgo/vela/workspace';
import { PineWorkerEngine } from '@luxalgo/vela-pinets';
import { useEffect, useRef } from 'react';
import { bindChartTypes } from './lib/chart-types.ts';
import type { ServerClient } from './lib/client.ts';
import { useParams } from './lib/params.ts';
import { ServerProvider, serverStorage } from './lib/provider.ts';
import { setupVela } from './lib/vela-setup.ts';

interface Props {
    client: ServerClient;
    providers: string[];
    onReady: (workspace: VelaWorkspace | null) => void;
}

/** Venue used for the first-run default chart, in order of preference. */
const DEFAULTS: Record<string, string> = { BINANCE: 'BINANCE:BTCUSDT', SYNTH: 'SYNTH:ALPHA' };

/** Topbar presets. Any other value can be typed on the chart: `7` is seven minutes, `2H`, `10S`, `3D`… */
const TIMEFRAMES = ['1S', '5S', '15S', '30S', '1', '3', '5', '15', '30', '45', '60', '120', '240', '1D', '1W', '1M'];

export function Chart({ client, providers, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!host.current || providers.length === 0) return;
        setupVela();
        const venue = providers.find((p) => DEFAULTS[p]) ?? providers[0];
        const factories: Record<string, () => unknown> = {};
        for (const name of providers) factories[name.toLowerCase()] = () => new ServerProvider(client, name);
        // Formulas (`SPREAD:A/B`) are served by the server like any venue, reachable only by prefix.
        factories.spread = () => new ServerProvider(client, 'SPREAD');

        const workspace = new VelaWorkspace(host.current, {
            layout: '1',
            symbol: DEFAULTS[venue] ?? `${venue}:`,
            timeframe: '60',
            bars: 5000,
            live: true,
            theme: 'dark',
            timezone: 'Etc/UTC',
            timeframes: TIMEFRAMES,
            sidebar: true,
            autofocus: true,
            maxWebglCells: 8,
            providers: factories as any,
            engines: { pine: () => new PineWorkerEngine() },
            persist: 'main',
            storage: serverStorage(client),
        } as any);
        const unbind = bindChartTypes(workspace, () => useParams.getState().chartTypes);
        onReady(workspace);
        return () => {
            onReady(null);
            unbind();
            workspace.destroy();
        };
    }, [client, providers, onReady]);

    return <div ref={host} className="chart-host" />;
}
