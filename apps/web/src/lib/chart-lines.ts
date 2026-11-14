import { registerRendererLayer } from '@luxalgo/vela/plugin';

/** A horizontal level drawn across the price pane: an alert now, orders and positions later. */
export interface ChartLine {
    id: string;
    price: number;
    color: string;
    text: string;
    style?: 'solid' | 'dashed';
}

/** A fill drawn at a bar: a triangle under the price for a buy, over it for a sell. */
export interface ChartMarker {
    time: number;
    price: number;
    side: 'buy' | 'sell';
    text?: string;
}

interface LayerData {
    lines: ChartLine[];
    markers: ChartMarker[];
}

const LAYER = 'ts-lines';
const BUY = '#26a69a';
const SELL = '#ef5350';
let registered = false;

/** Lines by chart (what callers set) and by the chart's cell element (what a layer canvas can find). */
const byChart = new WeakMap<object, LayerData>();
const byHost = new WeakMap<Element, LayerData>();

/** Register the layer that paints our own price levels. Must run before a chart is built. */
export function registerChartLines(): void {
    if (registered) return;
    registered = true;
    registerRendererLayer({
        id: LAYER,
        placement: 'above-data',
        create: () => {
            let canvas: HTMLCanvasElement | null = null;
            return {
                mount(c: HTMLCanvasElement) {
                    canvas = c;
                },
                render(args: any) {
                    const ctx = canvas?.getContext('2d');
                    if (!canvas || !ctx) return;
                    const dpr: number = args.coords.dpr || 1;
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    // Lines arrive on the layer's data channel; failing that, find them through the cell this canvas sits in.
                    const cell = canvas.closest('.vela-cell');
                    const data: LayerData | undefined =
                        (args.data as LayerData | undefined) ?? (cell ? byHost.get(cell) : undefined);
                    const lines = data?.lines ?? [];
                    const markers = data?.markers ?? [];
                    if (lines.length === 0 && markers.length === 0) return;
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    const width: number = args.coords.width;
                    const top: number = args.bounds.top;
                    const bottom = top + args.bounds.height;
                    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
                    ctx.textBaseline = 'middle';
                    for (const line of lines) {
                        const y = Math.round(args.coords.priceToY(line.price, args.scale, args.bounds)) + 0.5;
                        if (!(y >= top && y <= bottom)) continue;
                        ctx.strokeStyle = line.color;
                        ctx.lineWidth = 1;
                        ctx.setLineDash(line.style === 'solid' ? [] : [5, 4]);
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        ctx.lineTo(width, y);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        const w = Math.min(width - 16, ctx.measureText(line.text).width + 12);
                        ctx.fillStyle = line.color;
                        ctx.beginPath();
                        ctx.roundRect(8, y - 9, w, 18, 3);
                        ctx.fill();
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(line.text, 14, y, w - 12);
                    }
                    if (markers.length === 0) return;
                    // Fills: only those on screen, and their labels only while there is room for them.
                    ctx.textAlign = 'center';
                    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
                    const visible: { x: number; y: number; m: ChartMarker }[] = [];
                    for (const m of markers) {
                        const x = args.coords.timeToX(m.time);
                        if (!(x >= -8 && x <= width + 8)) continue;
                        const y = args.coords.priceToY(m.price, args.scale, args.bounds);
                        if (!(y >= top - 8 && y <= bottom + 8)) continue;
                        visible.push({ x, y, m });
                    }
                    const labels = visible.length <= 60;
                    for (const { x, y, m } of visible) {
                        const buy = m.side === 'buy';
                        const tip = buy ? y + 5 : y - 5;
                        const base = buy ? tip + 9 : tip - 9;
                        ctx.fillStyle = buy ? BUY : SELL;
                        ctx.strokeStyle = '#0e1116';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(x, tip);
                        ctx.lineTo(x - 5.5, base);
                        ctx.lineTo(x + 5.5, base);
                        ctx.closePath();
                        ctx.stroke();
                        ctx.fill();
                        if (labels && m.text) {
                            ctx.fillStyle = '#d0d7de';
                            ctx.fillText(m.text, x, buy ? base + 9 : base - 9);
                        }
                    }
                    ctx.textAlign = 'start';
                },
            };
        },
    });
}

const EMPTY: LayerData = { lines: [], markers: [] };

function push(cell: { chart: any; host?: Element | null }, patch: Partial<LayerData>): void {
    const chart = cell?.chart;
    if (!chart) return;
    const data: LayerData = { ...(byChart.get(chart) ?? EMPTY), ...patch };
    byChart.set(chart, data);
    if (cell.host) byHost.set(cell.host, data);
    // The chart engine's public surface has no way to push data to a layer, so this uses the inner
    // renderer's channel when it is there, and otherwise leaves the data where the layer can find
    // it and asks the chart to repaint.
    const inner = chart.renderer?.renderer;
    if (typeof inner?.setNativeData === 'function') inner.setNativeData(LAYER, data);
    else chart.resize?.();
}

/** Replace the levels shown on one chart cell (`{ chart, host }`, as the workspace hands them out). */
export function setChartLines(cell: { chart: any; host?: Element | null }, lines: ChartLine[]): void {
    push(cell, { lines });
}

/** Replace the fills marked on one chart cell. */
export function setChartMarkers(cell: { chart: any; host?: Element | null }, markers: ChartMarker[]): void {
    push(cell, { markers });
}

/** The levels last given to a chart. */
export function getChartLines(chart: any): ChartLine[] {
    return (chart && byChart.get(chart)?.lines) ?? [];
}

/** The fills last given to a chart. */
export function getChartMarkers(chart: any): ChartMarker[] {
    return (chart && byChart.get(chart)?.markers) ?? [];
}
