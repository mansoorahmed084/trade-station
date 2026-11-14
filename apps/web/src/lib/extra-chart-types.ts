import { registerChartType, registerRendererLayer } from '@luxalgo/vela/plugin';

/**
 * Chart types the engine does not draw itself: Volume candles, HLC area and High-low. Each is a
 * registered price style that turns the base candles off and paints the bars on its own layer.
 */

const UP = '#26a69a';
const DOWN = '#ef5350';
const UP_FILL = 'rgba(38, 166, 154, 0.22)';
const DOWN_FILL = 'rgba(239, 83, 80, 0.22)';
const LINE = '#4c8dff';

type Painter = (ctx: CanvasRenderingContext2D, args: any, from: number, to: number) => void;

/** Lay a path through one field of a list of points (the caller strokes or fills it). */
function traceWith(ctx: CanvasRenderingContext2D) {
    return <K extends string>(pts: Record<K | 'x', number>[], key: K) => {
        for (let k = 0; k < pts.length; k++) {
            if (k) ctx.lineTo(pts[k].x, pts[k][key]);
            else ctx.moveTo(pts[k].x, pts[k][key]);
        }
    };
}

const TYPES: { id: string; label: string; icon: string; needsVolume?: boolean; paint: Painter }[] = [
    {
        id: 'volumecandles',
        label: 'Volume candles',
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M3 3v10M11 2v12"/><rect x="1.5" y="5" width="3" height="5" fill="currentColor"/><rect x="8" y="4" width="6" height="7"/></svg>',
        needsVolume: true,
        // Candles whose width follows the bar's volume: the busiest visible bar is full width.
        paint(ctx, args, from, to) {
            const bars = args.bars;
            const px = args.coords.pxPerBar();
            let max = 0;
            for (let i = from; i <= to; i++) max = Math.max(max, bars[i].volume || 0);
            const y = (p: number) => args.coords.priceToY(p, args.scale, args.bounds);
            for (let i = from; i <= to; i++) {
                const b = bars[i];
                const x = args.coords.timeToX(b.time);
                const up = b.close >= b.open;
                const w = Math.max(1, (max > 0 ? (b.volume || 0) / max : 1) * px * 0.9);
                ctx.strokeStyle = up ? UP : DOWN;
                ctx.fillStyle = up ? UP : DOWN;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(Math.round(x) + 0.5, y(b.high));
                ctx.lineTo(Math.round(x) + 0.5, y(b.low));
                ctx.stroke();
                const top = y(Math.max(b.open, b.close));
                const bottom = y(Math.min(b.open, b.close));
                ctx.fillRect(x - w / 2, top, w, Math.max(1, bottom - top));
            }
        },
    },
    {
        id: 'hlcarea',
        label: 'HLC area',
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M1 6l4-3 4 2 6-3" /><path d="M1 12l4-2 4 1 6-3"/><path d="M1 9l4-2.5 4 1.5 6-3" stroke-width="1.6"/></svg>',
        // The high and the low as bands around the close: green above it, red below.
        paint(ctx, args, from, to) {
            const bars = args.bars;
            const pts: { x: number; h: number; l: number; c: number }[] = [];
            for (let i = from; i <= to; i++) {
                const b = bars[i];
                pts.push({
                    x: args.coords.timeToX(b.time),
                    h: args.coords.priceToY(b.high, args.scale, args.bounds),
                    l: args.coords.priceToY(b.low, args.scale, args.bounds),
                    c: args.coords.priceToY(b.close, args.scale, args.bounds),
                });
            }
            if (pts.length < 2) return;
            const trace = traceWith(ctx);
            const band = (a: 'h' | 'l', fill: string) => {
                ctx.beginPath();
                trace(pts, a);
                for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k].x, pts[k].c);
                ctx.closePath();
                ctx.fillStyle = fill;
                ctx.fill();
            };
            band('h', UP_FILL);
            band('l', DOWN_FILL);
            const line = (a: 'h' | 'l' | 'c', color: string, width: number) => {
                ctx.beginPath();
                trace(pts, a);
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.stroke();
            };
            line('h', UP, 1);
            line('l', DOWN, 1);
            line('c', LINE, 1.6);
        },
    },
    {
        id: 'highlow',
        label: 'High-low',
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><rect x="2" y="3" width="3" height="8" fill="currentColor"/><rect x="7" y="5" width="3" height="9"/><rect x="12" y="2" width="2.5" height="6" fill="currentColor"/></svg>',
        // Each bar as a block from its low to its high, coloured by its direction.
        paint(ctx, args, from, to) {
            const bars = args.bars;
            const w = Math.max(1, args.coords.pxPerBar() * 0.7);
            for (let i = from; i <= to; i++) {
                const b = bars[i];
                const x = args.coords.timeToX(b.time);
                const top = args.coords.priceToY(b.high, args.scale, args.bounds);
                const bottom = args.coords.priceToY(b.low, args.scale, args.bounds);
                ctx.fillStyle = b.close >= b.open ? UP : DOWN;
                ctx.fillRect(x - w / 2, top, w, Math.max(1, bottom - top));
            }
        },
    },
];

let registered = false;

/** Register the extra chart types and their layers. Must run before a chart is built. */
export function registerExtraChartTypes(): void {
    if (registered) return;
    registered = true;
    for (const type of TYPES) {
        registerChartType({
            id: type.id,
            label: type.label,
            icon: type.icon,
            basePainting: 'none',
            supports: (facts: any) => facts.ohlc !== false && (!type.needsVolume || facts.volume !== false),
        });
        registerRendererLayer({
            id: `ts-style-${type.id}`,
            placement: 'above-data',
            create: () => {
                let canvas: HTMLCanvasElement | null = null;
                return {
                    mount(c: HTMLCanvasElement) {
                        canvas = c;
                        c.dataset.tsStyle = type.id;
                    },
                    render(args: any) {
                        const ctx = canvas?.getContext('2d');
                        if (!canvas || !ctx) return;
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        if (args.priceStyle !== type.id || !args.bars?.length) return;
                        const dpr: number = args.coords.dpr || 1;
                        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                        // Only the bars on screen, plus one either side so lines reach the edges.
                        const range = args.coords.visibleLogicalRange();
                        const from = Math.max(0, Math.floor(range.from) - 1);
                        const to = Math.min(args.bars.length - 1, Math.ceil(range.to) + 1);
                        if (to < from) return;
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(0, args.bounds.top, args.coords.width, args.bounds.height);
                        ctx.clip();
                        type.paint(ctx, args, from, to);
                        ctx.restore();
                    },
                };
            },
        });
    }
}

export const EXTRA_CHART_TYPES = TYPES.map((t) => ({ id: t.id, label: t.label }));
