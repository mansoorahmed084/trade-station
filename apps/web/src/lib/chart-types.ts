import { registerChartType } from '@luxalgo/vela/plugin';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { formatTransform, type ParsedTransform, parseTransform } from '@ts/core';

/**
 * Price-driven chart types. The server computes them as their own bar series, named by a suffix on
 * the symbol (`BINANCE:BTCUSDT.RENKOXATR14`); here they appear as ordinary entries in the chart's
 * style menu, and picking one swaps the suffix on the cell's symbol.
 */
export const DERIVED_STYLES = ['renko', 'linebreak', 'kagi', 'pnf', 'range'] as const;
export type DerivedStyle = (typeof DERIVED_STYLES)[number];

export const STYLE_LABEL: Record<DerivedStyle, string> = {
    renko: 'Renko',
    linebreak: 'Line break',
    kagi: 'Kagi',
    pnf: 'Point & figure',
    range: 'Range',
};

export interface SizeParam {
    /** `atr`: size from the Average True Range of the loaded history; `fixed`: an absolute price amount. */
    mode: 'atr' | 'fixed';
    atr: number;
    size: number;
}

export interface ChartTypeParams {
    renko: SizeParam;
    kagi: SizeParam;
    range: SizeParam;
    pnf: SizeParam & { reversal: number };
    linebreak: { lines: number };
}

export const DEFAULT_PARAMS: ChartTypeParams = {
    renko: { mode: 'atr', atr: 14, size: 10 },
    kagi: { mode: 'atr', atr: 14, size: 10 },
    range: { mode: 'atr', atr: 14, size: 10 },
    pnf: { mode: 'atr', atr: 14, size: 10, reversal: 3 },
    linebreak: { lines: 3 },
};

export const isDerived = (style: string | undefined): style is DerivedStyle =>
    !!style && (DERIVED_STYLES as readonly string[]).includes(style);

/** The symbol with any chart-type suffix removed. */
export function stripChartType(symbol: string): string {
    const dot = symbol.lastIndexOf('.');
    return dot > 0 && parseTransform(symbol.slice(dot + 1)) ? symbol.slice(0, dot) : symbol;
}

export function suffixFor(style: DerivedStyle, params: ChartTypeParams): string {
    let parsed: ParsedTransform;
    if (style === 'linebreak') parsed = { kind: 'linebreak', count: Math.max(1, Math.round(params.linebreak.lines)) };
    else {
        const p = params[style];
        const size =
            p.mode === 'atr' ? { atr: Math.max(1, Math.round(p.atr)) } : { size: Math.max(Number.MIN_VALUE, p.size) };
        parsed =
            style === 'pnf'
                ? { kind: 'pnf', ...size, count: Math.max(1, Math.round(params.pnf.reversal)) }
                : { kind: style, ...size };
    }
    return formatTransform(parsed);
}

/** The symbol a cell should load for a style: plain for candles and the like, suffixed for ours. */
export function symbolForStyle(symbol: string, style: string | undefined, params: ChartTypeParams): string {
    const base = stripChartType(symbol);
    if (!isDerived(style) || /^spread:/i.test(base)) return base;
    return `${base}.${suffixFor(style, params)}`;
}

let registered = false;
export function registerChartTypes(): void {
    if (registered) return;
    registered = true;
    for (const id of DERIVED_STYLES) registerChartType({ id, label: STYLE_LABEL[id], tickerModifier: false });
}

/** Keep every cell's symbol suffix in step with its chart style. Returns a disposer. */
export function bindChartTypes(ws: VelaWorkspace, params: () => ChartTypeParams): () => void {
    const offs = new Map<string, () => void>();
    const sync = (cellId: string, style?: string) => {
        const cell: any = ws.cell(cellId);
        const chart = cell?.chart;
        const current: string | undefined = chart?.market?.symbol;
        if (!current) return;
        const want = symbolForStyle(current, style ?? cell.requestedPriceStyle ?? cell.priceStyle, params());
        if (want !== current) void chart.setMarket({ symbol: want });
    };
    const watch = (cell: any) => {
        const id: string = cell.id;
        if (offs.has(id)) return;
        // A symbol picked from the search has no suffix: put the active chart type's back on.
        offs.set(
            id,
            cell.chart.on('market:changed', () => sync(id)),
        );
        sync(id);
    };
    for (const cell of ws.cells()) watch(cell);
    const stops = [
        ws.on('cell:created', (e: any) => {
            const cell = ws.cell(e?.id ?? e);
            if (cell) watch(cell);
        }),
        ws.on('cell:destroyed', (e: any) => {
            const id = e?.id ?? e;
            offs.get(id)?.();
            offs.delete(id);
        }),
        // Fires before the repaint, with the style being switched to.
        ws.on('cell:priceStyle', (e: any) => setTimeout(() => sync(e.id, e.to), 0)),
    ];
    return () => {
        for (const stop of stops) (stop as () => void)();
        for (const off of offs.values()) off();
    };
}

/** Re-apply the current parameters to every cell showing one of our chart types. */
export function refreshChartTypes(ws: VelaWorkspace, params: ChartTypeParams): void {
    for (const cell of ws.cells() as any[]) {
        const current: string | undefined = cell.chart?.market?.symbol;
        if (!current) continue;
        const want = symbolForStyle(current, cell.requestedPriceStyle ?? cell.priceStyle, params);
        if (want !== current) void cell.chart.setMarket({ symbol: want });
    }
}
