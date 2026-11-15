import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { normalizeTimeframe, timeframeMs } from '@ts/core';
import { stripChartType } from './chart-types.ts';
import type { ServerClient } from './client.ts';
import type { FootprintData } from './extra-chart-types.ts';

const LAYER = 'ts-style-footprint';

/** Hand data to a renderer layer of one chart cell (the inner renderer's channel, as for chart lines). */
function push(chart: any, data: FootprintData | undefined): void {
    const inner = chart?.renderer?.renderer;
    if (typeof inner?.setNativeData === 'function') inner.setNativeData(LAYER, data);
    else chart?.resize?.();
}

/**
 * Feed footprints to every chart set to the footprint style: the bars in view, refreshed when the
 * view moves, and the bar still forming every two seconds while the chart shows the latest bars.
 */
export function bindFootprints(ws: VelaWorkspace, client: ServerClient): () => void {
    const state = new WeakMap<object, { key: string; at: number; busy: boolean; shown: boolean }>();
    const tick = () => {
        for (const cell of ws.cells() as any[]) {
            const chart = cell?.chart;
            if (!chart) continue;
            let s = state.get(chart);
            if (!s) {
                s = { key: '', at: 0, busy: false, shown: false };
                state.set(chart, s);
            }
            if (chart.renderer?.get?.('priceStyle') !== 'footprint') {
                if (s.shown) {
                    push(chart, undefined);
                    s.shown = false;
                    s.key = '';
                }
                continue;
            }
            const symbol = stripChartType(String(chart.market?.symbol ?? ''));
            let tf: string;
            try {
                tf = normalizeTimeframe(String(chart.market?.timeframe ?? ''));
            } catch {
                continue;
            }
            const ms = timeframeMs(tf);
            const now = Date.now();
            if (!s.shown) {
                // Footprints need room: on switching to them, show about the last 30 bars.
                const end = Math.floor(now / ms) * ms;
                chart.setVisibleRange?.({ from: end - 30 * ms, to: end + ms });
                push(chart, undefined);
                s.shown = true;
            }
            const range = chart.getVisibleRange?.() as { from: number; to: number } | null;
            if (!symbol || !range) continue;
            const live = range.to >= now - 2 * ms;
            const count = Math.min(300, Math.max(1, Math.ceil((range.to - range.from) / ms) + 2));
            const key = `${symbol}|${tf}|${count}|${live ? 'live' : Math.round(range.to)}`;
            if (s.busy || (key === s.key && (!live || now - s.at < 2000))) continue;
            s.busy = true;
            const q = new URLSearchParams({ symbol, tf, bars: String(count) });
            if (!live) q.set('to', String(Math.round(range.to)));
            client
                .json<{ rowSize: number; bars: FootprintData['byTime'][number][]; truncated: boolean }>(
                    `/api/footprint?${q}`,
                )
                .then((r) => {
                    const data: FootprintData = {
                        rowSize: r.rowSize,
                        byTime: Object.fromEntries(r.bars.map((b) => [b.time, b])),
                        note: r.truncated
                            ? 'Showing part of the trades: there were too many to read for this range.'
                            : undefined,
                    };
                    push(chart, data);
                    s.shown = true;
                    s.key = key;
                    s.at = Date.now();
                })
                .catch((err) => {
                    push(chart, { rowSize: 1, byTime: {}, note: `No footprints: ${err?.message ?? err}` });
                    s.shown = true;
                    s.key = key;
                    s.at = Date.now();
                })
                .finally(() => {
                    s.busy = false;
                });
        }
    };
    const timer = setInterval(tick, 500);
    tick();
    return () => clearInterval(timer);
}
