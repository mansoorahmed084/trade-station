import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { normalizeTimeframe } from '@ts/core';
import { useEffect, useState } from 'react';
import { stripChartType } from './chart-types.ts';

/** The symbol and timeframe of the active chart, without any chart-type suffix. */
export function useChartMarket(workspace: VelaWorkspace): { symbol: string; timeframe: string } | null {
    const [market, setMarket] = useState<{ symbol: string; timeframe: string } | null>(null);
    useEffect(() => {
        const read = () => {
            const m = (workspace.chart as any)?.market;
            const symbol = stripChartType(String(m?.symbol ?? ''));
            if (!symbol) return;
            let timeframe = String(m?.timeframe ?? '60');
            try {
                timeframe = normalizeTimeframe(timeframe);
            } catch {}
            setMarket((prev) =>
                prev && prev.symbol === symbol && prev.timeframe === timeframe ? prev : { symbol, timeframe },
            );
        };
        read();
        const timer = setInterval(read, 500);
        return () => clearInterval(timer);
    }, [workspace]);
    return market;
}
