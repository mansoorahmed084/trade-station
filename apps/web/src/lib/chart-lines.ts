import { registerRendererLayer } from '@luxalgo/vela/plugin';

/** A horizontal level drawn across the price pane: an alert now, orders and positions later. */
export interface ChartLine {
    id: string;
    price: number;
    color: string;
    text: string;
    style?: 'solid' | 'dashed';
}

const LAYER = 'ts-lines';
let registered = false;

/** Lines by chart (what callers set) and by the chart's cell element (what a layer canvas can find). */
const byChart = new WeakMap<object, ChartLine[]>();
const byHost = new WeakMap<Element, ChartLine[]>();

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
                    const lines: ChartLine[] =
                        (args.data as { lines?: ChartLine[] } | undefined)?.lines ??
                        (cell ? byHost.get(cell) : undefined) ??
                        [];
                    if (lines.length === 0) return;
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
                },
            };
        },
    });
}

/**
 * Replace the levels shown on one chart cell (`{ chart, host }`, as the workspace hands them out).
 * The chart engine's public surface has no way to push data to a layer, so this uses the inner
 * renderer's channel when it is there, and otherwise leaves the lines where the layer can find them
 * and asks the chart to repaint.
 */
export function setChartLines(cell: { chart: any; host?: Element | null }, lines: ChartLine[]): void {
    const chart = cell?.chart;
    if (!chart) return;
    byChart.set(chart, lines);
    if (cell.host) byHost.set(cell.host, lines);
    const inner = chart.renderer?.renderer;
    if (typeof inner?.setNativeData === 'function') inner.setNativeData(LAYER, { lines });
    else chart.resize?.();
}

/** The levels last given to a chart. */
export function getChartLines(chart: any): ChartLine[] {
    return (chart && byChart.get(chart)) ?? [];
}
