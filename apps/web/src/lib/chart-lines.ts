import { registerRendererLayer } from '@luxalgo/vela/plugin';

/** A horizontal level drawn across the price pane: an alert, a working order, a position. */
export interface ChartLine {
    id: string;
    price: number;
    color: string;
    text: string;
    style?: 'solid' | 'dashed';
    /** Text drawn after the label in its own box, such as a position's running P&L. */
    badge?: { text: string; color: string };
    /** Drag the line to a new price. Called once, on release, with the price it was dropped at. */
    onMove?: (price: number) => void;
    /** Adds a × to the label. */
    onClose?: () => void;
    closeTitle?: string;
}

/** A fill drawn at a bar: a triangle under the price for a buy, over it for a sell. */
export interface ChartMarker {
    time: number;
    price: number;
    side: 'buy' | 'sell';
    text?: string;
}

interface LayerData {
    /** Lines by owner (alerts, trading…), so each owner replaces only its own. */
    groups: Record<string, ChartLine[]>;
    markers: ChartMarker[];
}

/** Where things were drawn in the last frame of one layer canvas: what the pointer can hit. */
interface Frame {
    top: number;
    bottom: number;
    width: number;
    yToPrice: (y: number) => number;
    hits: { line: ChartLine; y: number; label: [number, number]; close?: [number, number] }[];
}

const LAYER = 'ts-lines';
const BUY = '#26a69a';
const SELL = '#ef5350';
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
/** How close (in CSS pixels) the pointer must be to a line to grab it. */
const GRAB = 5;
let registered = false;

/** Data by chart (what callers set) and by the chart's cell element (what a layer canvas can find). */
const byChart = new WeakMap<object, LayerData>();
const byHost = new WeakMap<Element, LayerData>();
const frames = new WeakMap<HTMLCanvasElement, Frame>();
/** The line being dragged, and where it is now. */
let dragging: { host: Element; id: string; price: number } | null = null;

const EMPTY: LayerData = { groups: {}, markers: [] };
const linesOf = (data: LayerData | undefined) => (data ? Object.values(data.groups).flat() : []);

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
                    c.dataset.tsLayer = LAYER;
                },
                render(args: any) {
                    const ctx = canvas?.getContext('2d');
                    if (!canvas || !ctx) return;
                    const dpr: number = args.coords.dpr || 1;
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    // Data arrives on the layer's channel; failing that, find it through the cell this canvas sits in.
                    const cell = canvas.closest('.vela-cell');
                    const data: LayerData | undefined =
                        (args.data as LayerData | undefined) ?? (cell ? byHost.get(cell) : undefined);
                    const width: number = args.coords.width;
                    const top: number = args.bounds.top;
                    const bottom = top + args.bounds.height;
                    const frame: Frame = {
                        top,
                        bottom,
                        width,
                        yToPrice: (y) => args.coords.yToPrice(y, args.scale, args.bounds),
                        hits: [],
                    };
                    frames.set(canvas, frame);
                    const lines = linesOf(data);
                    const markers = data?.markers ?? [];
                    if (lines.length === 0 && markers.length === 0) return;
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.font = FONT;
                    ctx.textBaseline = 'middle';
                    for (const line of lines) {
                        const moving = dragging && dragging.id === line.id && cell === dragging.host;
                        const price = moving ? dragging!.price : line.price;
                        const y = Math.round(args.coords.priceToY(price, args.scale, args.bounds)) + 0.5;
                        if (!(y >= top && y <= bottom)) continue;
                        ctx.strokeStyle = line.color;
                        ctx.lineWidth = moving ? 2 : 1;
                        ctx.setLineDash(line.style === 'solid' ? [] : [5, 4]);
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        ctx.lineTo(width, y);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        const text = moving ? `${line.text} → ${formatLike(price, line.price)}` : line.text;
                        let x = 8;
                        const w = Math.min(width - 60, ctx.measureText(text).width + 12);
                        ctx.fillStyle = line.color;
                        ctx.beginPath();
                        ctx.roundRect(x, y - 9, w, 18, 3);
                        ctx.fill();
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(text, x + 6, y, w - 12);
                        const hit: Frame['hits'][number] = { line, y, label: [x, x + w] };
                        x += w + 2;
                        if (line.badge) {
                            const bw = ctx.measureText(line.badge.text).width + 12;
                            ctx.fillStyle = '#0e1116';
                            ctx.strokeStyle = line.badge.color;
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            ctx.roundRect(x, y - 9, bw, 18, 3);
                            ctx.fill();
                            ctx.stroke();
                            ctx.fillStyle = line.badge.color;
                            ctx.fillText(line.badge.text, x + 6, y, bw - 12);
                            x += bw + 2;
                        }
                        if (line.onClose) {
                            ctx.fillStyle = line.color;
                            ctx.beginPath();
                            ctx.roundRect(x, y - 9, 18, 18, 3);
                            ctx.fill();
                            ctx.strokeStyle = '#ffffff';
                            ctx.lineWidth = 1.5;
                            ctx.beginPath();
                            ctx.moveTo(x + 5.5, y - 3.5);
                            ctx.lineTo(x + 12.5, y + 3.5);
                            ctx.moveTo(x + 12.5, y - 3.5);
                            ctx.lineTo(x + 5.5, y + 3.5);
                            ctx.stroke();
                            hit.close = [x, x + 18];
                        }
                        frame.hits.push(hit);
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

/** A dragged price shown with as many decimals as the original. */
function formatLike(price: number, like: number): string {
    const decimals = Math.min(8, Math.max(2, (String(like).split('.')[1] ?? '').length));
    return price.toFixed(decimals);
}

function push(cell: { chart: any; host?: Element | null }, patch: (data: LayerData) => LayerData): void {
    const chart = cell?.chart;
    if (!chart) return;
    const data = patch(byChart.get(chart) ?? EMPTY);
    byChart.set(chart, data);
    if (cell.host) byHost.set(cell.host, data);
    // The chart engine's public surface has no way to push data to a layer, so this uses the inner
    // renderer's channel when it is there, and otherwise leaves the data where the layer can find
    // it and asks the chart to repaint.
    const inner = chart.renderer?.renderer;
    if (typeof inner?.setNativeData === 'function') inner.setNativeData(LAYER, data);
    else chart.resize?.();
}

/** Replace one owner's levels on one chart cell (`{ chart, host }`, as the workspace hands them out). */
export function setChartLines(cell: { chart: any; host?: Element | null }, lines: ChartLine[], group = 'alerts'): void {
    push(cell, (d) => ({ ...d, groups: { ...d.groups, [group]: lines } }));
}

/** Replace the fills marked on one chart cell. */
export function setChartMarkers(cell: { chart: any; host?: Element | null }, markers: ChartMarker[]): void {
    push(cell, (d) => ({ ...d, markers }));
}

/** The levels last given to a chart, of one owner or of all. */
export function getChartLines(chart: any, group?: string): ChartLine[] {
    const data = chart ? byChart.get(chart) : undefined;
    if (!data) return [];
    return group ? (data.groups[group] ?? []) : linesOf(data);
}

/** The fills last given to a chart. */
export function getChartMarkers(chart: any): ChartMarker[] {
    return (chart && byChart.get(chart)?.markers) ?? [];
}

/** The line (and the part of it) under a pointer, from the last frame drawn in that cell. */
function hitTest(host: Element, clientX: number, clientY: number) {
    for (const canvas of host.querySelectorAll<HTMLCanvasElement>(`canvas[data-ts-layer="${LAYER}"]`)) {
        const frame = frames.get(canvas);
        if (!frame) continue;
        const box = canvas.getBoundingClientRect();
        const x = clientX - box.left;
        const y = clientY - box.top;
        if (x < 0 || x > frame.width || y < frame.top || y > frame.bottom) continue;
        // Nearest line first, so two close levels can still be told apart.
        let best: { hit: Frame['hits'][number]; d: number } | null = null;
        for (const hit of frame.hits) {
            const onLabel = Math.abs(y - hit.y) <= 9 && x >= hit.label[0] && x <= (hit.close?.[1] ?? hit.label[1]);
            const d = Math.abs(y - hit.y);
            if ((onLabel || d <= GRAB) && (!best || d < best.d)) best = { hit, d };
        }
        if (!best) continue;
        const { hit } = best;
        const part = hit.close && x >= hit.close[0] && x <= hit.close[1] && Math.abs(y - hit.y) <= 9 ? 'close' : 'body';
        if (part === 'body' && !hit.line.onMove) continue;
        return { line: hit.line, part, frame, canvas } as const;
    }
    return null;
}

/**
 * Let lines be dragged and closed with the pointer, on every cell of a workspace. The chart does
 * not see a press that lands on one of our lines, so dragging a line never pans the chart.
 */
export function bindChartLineInteraction(ws: { cells(): unknown[] }): () => void {
    const bound = new WeakSet<Element>();
    const cleanups: (() => void)[] = [];
    const bind = () => {
        for (const cell of ws.cells() as any[]) {
            const host: Element | null | undefined = cell?.host;
            if (!host || bound.has(host)) continue;
            bound.add(host);
            let hovering: HTMLElement | null = null;
            let previousCursor = '';
            const down = (e: PointerEvent) => {
                if (e.button !== 0) return;
                const hit = hitTest(host, e.clientX, e.clientY);
                if (!hit) return;
                e.stopPropagation();
                e.preventDefault();
                if (hit.part === 'close') {
                    hit.line.onClose?.();
                    return;
                }
                const line = hit.line;
                const box = hit.canvas.getBoundingClientRect();
                dragging = { host, id: line.id, price: line.price };
                const repaint = () => push(cell, (d) => ({ ...d }));
                const move = (ev: PointerEvent) => {
                    ev.preventDefault();
                    const y = Math.min(hit.frame.bottom, Math.max(hit.frame.top, ev.clientY - box.top));
                    const price = hit.frame.yToPrice(y);
                    if (dragging && Number.isFinite(price)) dragging.price = price;
                    repaint();
                };
                const up = () => {
                    window.removeEventListener('pointermove', move, true);
                    window.removeEventListener('pointerup', up, true);
                    const done = dragging;
                    dragging = null;
                    repaint();
                    // A click without a move is not a change.
                    if (done && Math.abs(done.price - line.price) > Math.abs(line.price) * 1e-9)
                        line.onMove?.(done.price);
                };
                window.addEventListener('pointermove', move, true);
                window.addEventListener('pointerup', up, true);
            };
            // The chart may listen for mouse rather than pointer events: keep those from it as well.
            const swallow = (e: MouseEvent) => {
                if (e.button === 0 && hitTest(host, e.clientX, e.clientY)) {
                    e.stopPropagation();
                    e.preventDefault();
                }
            };
            const hover = (e: PointerEvent) => {
                if (dragging) return;
                const hit = hitTest(host, e.clientX, e.clientY);
                const target = e.target as HTMLElement;
                if (hit) {
                    if (hovering !== target) {
                        if (hovering) hovering.style.cursor = previousCursor;
                        hovering = target;
                        previousCursor = target.style.cursor;
                    }
                    target.style.cursor = hit.part === 'close' ? 'pointer' : 'ns-resize';
                } else if (hovering) {
                    hovering.style.cursor = previousCursor;
                    hovering = null;
                }
            };
            host.addEventListener('pointerdown', down as EventListener, true);
            host.addEventListener('mousedown', swallow as EventListener, true);
            host.addEventListener('pointermove', hover as EventListener, true);
            cleanups.push(() => {
                host.removeEventListener('pointerdown', down as EventListener, true);
                host.removeEventListener('mousedown', swallow as EventListener, true);
                host.removeEventListener('pointermove', hover as EventListener, true);
            });
        }
    };
    bind();
    // Cells come and go with layouts.
    const timer = setInterval(bind, 1000);
    return () => {
        clearInterval(timer);
        for (const c of cleanups.splice(0)) c();
    };
}

/** Where each line's label was last drawn in a cell, in page coordinates (for tests and tooling). */
export function lineBoxes(host: Element): { id: string; x: number; y: number; closeX?: number; price: number }[] {
    const out: { id: string; x: number; y: number; closeX?: number; price: number }[] = [];
    for (const canvas of host.querySelectorAll<HTMLCanvasElement>(`canvas[data-ts-layer="${LAYER}"]`)) {
        const frame = frames.get(canvas);
        if (!frame) continue;
        const box = canvas.getBoundingClientRect();
        for (const hit of frame.hits) {
            out.push({
                id: hit.line.id,
                x: box.left + (hit.label[0] + hit.label[1]) / 2,
                y: box.top + hit.y,
                closeX: hit.close ? box.left + (hit.close[0] + hit.close[1]) / 2 : undefined,
                price: hit.line.price,
            });
        }
    }
    return out;
}
