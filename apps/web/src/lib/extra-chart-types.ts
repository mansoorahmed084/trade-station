import { registerChartType, registerRendererLayer } from '@luxalgo/vela/plugin';
import { type FootprintBar, niceStep, type TpoSession, tpoProfiles } from '@ts/core';

/**
 * Chart types the engine does not draw itself: Volume candles, HLC area, High-low and TPO. Each is
 * a registered price style that turns the base candles off and paints the bars on its own layer.
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

const TPO_PERIOD = 30 * 60_000;
const TPO_SESSION = 86_400_000;
/** The last profiles worked out, reused while the bars and the row size stay the same. */
let tpoCache: { bars: unknown; from: number; to: number; row: number; sessions: TpoSession[] } | null = null;

/**
 * TPO: one column per (UTC) day, a letter per 30-minute period at every price band it traded,
 * the point of control and the value area shaded, and the initial balance as a bar on the left.
 */
const paintTpo: Painter = (ctx, args) => {
    const bars = args.bars as { time: number; high: number; low: number; close: number }[];
    const top = args.bounds.top;
    const height = args.bounds.height;
    if (args.coords.barInterval > TPO_PERIOD) {
        ctx.fillStyle = '#7d8590';
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
        ctx.fillText('TPO needs bars of 30 minutes or less: pick a shorter timeframe.', 12, top + 40);
        return;
    }
    // Rows about 12 px tall, on a round price step.
    const pricePerPx =
        Math.abs(
            args.coords.yToPrice(top, args.scale, args.bounds) -
                args.coords.yToPrice(top + height, args.scale, args.bounds),
        ) / height;
    const row = niceStep(pricePerPx * 12);
    const view = args.coords.visibleTimeRange();
    const from = Math.floor(view.from / TPO_SESSION) * TPO_SESSION;
    const to = view.to;
    if (!tpoCache || tpoCache.bars !== bars || tpoCache.from !== from || tpoCache.to < to || tpoCache.row !== row) {
        const inView = bars.filter((b) => b.time >= from && b.time <= to + TPO_SESSION);
        tpoCache = {
            bars,
            from,
            to: to + TPO_SESSION,
            row,
            sessions: tpoProfiles(inView, { rowSize: row, periodMs: TPO_PERIOD, sessionMs: TPO_SESSION }),
        };
    }
    const half = args.coords.pxPerBar() / 2;
    const y = (p: number) => args.coords.priceToY(p, args.scale, args.bounds);
    const rowPx = Math.max(1, Math.abs(y(0) - y(row)));
    ctx.textBaseline = 'middle';
    for (const s of tpoCache.sessions) {
        const x0 = args.coords.timeToX(s.start) - half;
        const x1 = args.coords.timeToX(s.end) - half;
        if (x1 < 0 || x0 > args.coords.width) continue;
        // Session divider.
        ctx.strokeStyle = 'rgba(125, 133, 144, 0.35)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, top);
        ctx.lineTo(Math.round(x0) + 0.5, top + height);
        ctx.stroke();
        ctx.setLineDash([]);
        const widest = s.rows.reduce((m, r) => Math.max(m, r.letters.length), 1);
        const cw = Math.min(8, Math.max(1, (x1 - x0 - 10) / widest));
        const text = cw >= 6 && rowPx >= 9;
        ctx.font = `${Math.min(11, Math.floor(rowPx) - 1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        for (const r of s.rows) {
            const yTop = y(r.price + row);
            const yMid = yTop + rowPx / 2;
            const inValue = r.price >= s.val && r.price <= s.vah;
            const poc = r.price === s.poc;
            if (poc) {
                ctx.fillStyle = 'rgba(227, 179, 65, 0.22)';
                ctx.fillRect(x0 + 6, yTop, x1 - x0 - 8, rowPx);
            } else if (inValue) {
                ctx.fillStyle = 'rgba(76, 141, 255, 0.08)';
                ctx.fillRect(x0 + 6, yTop, x1 - x0 - 8, rowPx);
            }
            const color = poc ? '#e3b341' : inValue ? '#d0d7de' : '#7d8590';
            for (let k = 0; k < r.letters.length; k++) {
                const x = x0 + 8 + k * cw;
                if (text) {
                    ctx.fillStyle = color;
                    ctx.fillText(r.letters[k], x, yMid);
                } else {
                    ctx.fillStyle = color;
                    ctx.fillRect(x, yTop + 1, Math.max(1, cw - 1), Math.max(1, rowPx - 2));
                }
            }
        }
        // Initial balance.
        if (Number.isFinite(s.ibHigh)) {
            ctx.fillStyle = '#4c8dff';
            ctx.fillRect(x0 + 2, y(s.ibHigh), 3, Math.max(1, y(s.ibLow) - y(s.ibHigh)));
        }
    }
};

/** What the footprint feed pushes to the footprint layer. */
export interface FootprintData {
    rowSize: number;
    byTime: Record<number, FootprintBar>;
    note?: string;
}

const volumeText = (v: number) =>
    v >= 1e6
        ? `${(v / 1e6).toFixed(1)}M`
        : v >= 1e4
          ? `${(v / 1e3).toFixed(1)}K`
          : v >= 100
            ? v.toFixed(0)
            : v >= 10
              ? v.toFixed(1)
              : v.toFixed(2);

/**
 * Volume footprint: each bar as a column of price levels with the volume sold at the bid and bought
 * at the ask ("sell × buy"), shaded by which side dominated; a heat column when there is no room for
 * numbers; the busiest level outlined and the bar's delta underneath.
 */
const paintFootprint: Painter = (ctx, args, from, to) => {
    const data = args.data as FootprintData | undefined;
    const bars = args.bars as { time: number; open: number; high: number; low: number; close: number }[];
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const note = !data?.byTime ? 'Loading footprints…' : data.note;
    if (note) {
        ctx.fillStyle = '#7d8590';
        ctx.fillText(note, 12, args.bounds.top + 40);
    }
    const byTime = data?.byTime ?? {};
    const y = (p: number) => args.coords.priceToY(p, args.scale, args.bounds);
    const row = data?.rowSize ?? 1;
    const rowPx = Math.abs(y(0) - y(row));
    const colW = Math.max(2, args.coords.pxPerBar() * 0.92);
    let most = 0;
    for (let i = from; i <= to; i++) {
        const fp = byTime[bars[i].time];
        if (fp) for (const l of fp.levels) most = Math.max(most, l.buy + l.sell);
    }
    const numbers = colW >= 64 && rowPx >= 11;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = from; i <= to; i++) {
        const b = bars[i];
        const x = args.coords.timeToX(b.time);
        const left = x - colW / 2;
        const up = b.close >= b.open;
        // A slim candle down the column's left edge.
        ctx.strokeStyle = up ? UP : DOWN;
        ctx.fillStyle = up ? UP : DOWN;
        ctx.beginPath();
        ctx.moveTo(Math.round(left + 2) + 0.5, y(b.high));
        ctx.lineTo(Math.round(left + 2) + 0.5, y(b.low));
        ctx.stroke();
        const bodyTop = y(Math.max(b.open, b.close));
        ctx.fillRect(left + 1, bodyTop, 3, Math.max(1, y(Math.min(b.open, b.close)) - bodyTop));
        const fp = byTime[b.time];
        if (!fp) continue;
        const cellLeft = left + 6;
        const cellW = colW - 7;
        for (const l of fp.levels) {
            const top = y(l.price + row);
            const total = l.buy + l.sell;
            const buyShare = total > 0 ? l.buy / total : 0.5;
            // Shading carries the information when there is no room for numbers: make it stronger then.
            const strength = most > 0 ? (numbers ? 0.12 : 0.3) + (numbers ? 0.6 : 0.7) * (total / most) : 0.2;
            ctx.fillStyle =
                buyShare >= 0.5
                    ? `rgba(38, 166, 154, ${strength * (buyShare - 0.5) * 2 + 0.08})`
                    : `rgba(239, 83, 80, ${strength * (0.5 - buyShare) * 2 + 0.08})`;
            ctx.fillRect(cellLeft, top, cellW, Math.max(1, rowPx - (rowPx > 4 ? 1 : 0)));
            if (numbers) {
                ctx.font = `${Math.min(11, Math.floor(rowPx) - 1)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
                ctx.fillStyle = '#d0d7de';
                ctx.fillText(`${volumeText(l.sell)} × ${volumeText(l.buy)}`, cellLeft + cellW / 2, top + rowPx / 2);
            }
        }
        if (Number.isFinite(fp.poc)) {
            ctx.strokeStyle = '#e3b341';
            ctx.lineWidth = 1;
            ctx.strokeRect(cellLeft + 0.5, y(fp.poc + row) + 0.5, cellW - 1, Math.max(1, rowPx - 1));
        }
        if (colW >= 34) {
            ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
            ctx.fillStyle = fp.delta >= 0 ? UP : DOWN;
            ctx.fillText(`${fp.delta >= 0 ? '+' : '−'}${volumeText(Math.abs(fp.delta))}`, x, y(b.low) + 10);
        }
    }
    ctx.textAlign = 'start';
};

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
    {
        id: 'footprint',
        label: 'Volume footprint',
        icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M2 2v12"/><rect x="5" y="2" width="9" height="3"/><rect x="5" y="6.5" width="9" height="3" fill="currentColor" fill-opacity=".4"/><rect x="5" y="11" width="9" height="3"/></svg>',
        needsVolume: true,
        paint: paintFootprint,
    },
    {
        id: 'tpo',
        label: 'TPO (market profile)',
        icon: '<svg viewBox="0 0 16 16" fill="currentColor"><text x="1" y="5" font-size="5" font-family="monospace">AB</text><text x="1" y="10" font-size="5" font-family="monospace">ABCD</text><text x="1" y="15" font-size="5" font-family="monospace">BC</text></svg>',
        paint: paintTpo,
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
