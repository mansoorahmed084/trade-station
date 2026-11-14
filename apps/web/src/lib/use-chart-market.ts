import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { normalizeTimeframe } from '@ts/core';
import { useEffect, useState } from 'react';
import { stripChartType } from './chart-types.ts';

function readMarket(workspace: VelaWorkspace): { symbol: string; timeframe: string } | null {
    let m: any;
    try {
        m = (workspace.chart as any)?.market;
    } catch {
        // The workspace is being rebuilt or torn down: no active chart for a moment.
        return null;
    }
    const symbol = stripChartType(String(m?.symbol ?? ''));
    if (!symbol) return null;
    let timeframe = String(m?.timeframe ?? '60');
    try {
        timeframe = normalizeTimeframe(timeframe);
    } catch {}
    return { symbol, timeframe };
}

/** The symbol and timeframe of the active chart, without any chart-type suffix. Known from the first render. */
export function useChartMarket(workspace: VelaWorkspace): { symbol: string; timeframe: string } | null {
    const [market, setMarket] = useState(() => readMarket(workspace));
    useEffect(() => {
        const read = () => {
            const next = readMarket(workspace);
            if (!next) return;
            setMarket((prev) =>
                prev && prev.symbol === next.symbol && prev.timeframe === next.timeframe ? prev : next,
            );
        };
        read();
        const timer = setInterval(read, 500);
        return () => clearInterval(timer);
    }, [workspace]);
    return market;
}
