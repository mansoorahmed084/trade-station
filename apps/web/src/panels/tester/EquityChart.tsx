import { useEffect, useMemo, useRef, useState } from 'react';
import { axisDate, axisLabels, dateTime, money, niceTicks, pct } from './format.ts';

export interface ChartSeries {
    name: string;
    /** A CSS colour: one of the chart's `--series-n` roles. */
    color: string;
    values: number[];
}

interface Props {
    time: number[];
    /** At most a few lines sharing one value axis. */
    series: ChartSeries[];
    /** Drawdown from the running peak as a percentage (≤ 0). Drawn as its own strip below, on its own axis. */
    drawdownPct?: number[];
    height?: number;
}

const LEFT = 56;
const AXIS = 20;
const STRIP = 54;
const GAP = 16;
/** Room under the last tick label, so it is not cut by the edge. */
const FOOT = 8;

/**
 * Equity over time: thin lines on one value axis, the drawdown as a separate strip beneath (never a
 * second axis on the same plot), a crosshair that reads every series at once, and each line named
 * at its end as well as in the legend.
 */
export function EquityChart({ time, series, drawdownPct, height = 250 }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(640);
    const [hover, setHover] = useState<number | null>(null);

    useEffect(() => {
        const el = host.current;
        if (!el) return;
        const measure = () => setWidth(Math.max(280, el.clientWidth));
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const n = time.length;
    // Several lines get a legend above and their names at the line ends; one line needs neither.
    const many = series.length > 1;
    const TOP = many ? 26 : 10;
    const RIGHT = many ? 92 : 16;
    const strip = drawdownPct ? STRIP + GAP : 0;
    const plotW = Math.max(40, width - LEFT - RIGHT);
    const plotH = Math.max(40, height - TOP - AXIS - strip - FOOT);
    const xOf = (i: number) => LEFT + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);

    const geometry = useMemo(() => {
        let lo = Number.POSITIVE_INFINITY;
        let hi = Number.NEGATIVE_INFINITY;
        for (const s of series)
            for (const v of s.values) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        if (!Number.isFinite(lo)) {
            lo = 0;
            hi = 1;
        }
        if (hi - lo < 1e-9) {
            lo -= 1;
            hi += 1;
        }
        const pad = (hi - lo) * 0.06;
        lo -= pad;
        hi += pad;
        const ticks = niceTicks(lo, hi, 4);
        const labels = axisLabels(ticks);
        const ddLo = drawdownPct ? Math.min(-0.5, ...drawdownPct) : -1;
        return { lo, hi, ticks, labels, ddLo };
    }, [series, drawdownPct]);

    const yOf = (v: number) => TOP + plotH - ((v - geometry.lo) / (geometry.hi - geometry.lo)) * plotH;
    const stripTop = TOP + plotH + AXIS + GAP;
    const ddY = (v: number) => stripTop + (v / geometry.ddLo) * STRIP;

    const line = (values: number[], y: (v: number) => number) => {
        let d = '';
        for (let i = 0; i < values.length; i++) d += `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${y(values[i]).toFixed(1)}`;
        return d;
    };

    // End labels, nudged apart so two lines finishing close together stay readable.
    const ends = (many ? series : [])
        .map((s) => ({ name: s.name, color: s.color, y: yOf(s.values[n - 1] ?? geometry.lo) }))
        .sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;

    const span = n > 1 ? time[n - 1] - time[0] : 0;
    const xTicks = n > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (n - 1))) : [];

    const onMove = (e: React.PointerEvent) => {
        const box = host.current?.getBoundingClientRect();
        if (!box || n === 0) return;
        const f = (e.clientX - box.left - LEFT) / plotW;
        setHover(Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
    };

    if (n === 0) return <div className="viz-empty muted">No bars in this window.</div>;
    const tipLeft = hover === null ? 0 : xOf(hover) > width / 2 ? xOf(hover) - 196 : xOf(hover) + 12;

    return (
        <div className="viz" ref={host} style={{ height }}>
            {many && (
                <div className="viz-legend">
                    {series.map((s) => (
                        <span key={s.name} className="viz-key">
                            <i style={{ background: s.color }} />
                            {s.name}
                        </span>
                    ))}
                </div>
            )}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-tracked plot; every value is also in the tables */}
            <svg
                width={width}
                height={height}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                role="img"
                aria-label={`${series.map((s) => s.name).join(' and ')} over time`}
            >
                {geometry.ticks.map((t, k) => (
                    <g key={t}>
                        <line className="viz-grid" x1={LEFT} x2={LEFT + plotW} y1={yOf(t)} y2={yOf(t)} />
                        <text className="viz-tick" x={LEFT - 8} y={yOf(t)} textAnchor="end" dominantBaseline="middle">
                            {geometry.labels[k]}
                        </text>
                    </g>
                ))}
                {xTicks.map((i, k) => (
                    <text
                        key={i}
                        className="viz-tick"
                        x={xOf(i)}
                        y={TOP + plotH + 14}
                        textAnchor={k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}
                    >
                        {axisDate(time[i], span)}
                    </text>
                ))}
                {series.map((s) => (
                    <path
                        key={s.name}
                        d={line(s.values, yOf)}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2}
                        strokeLinejoin="round"
                    />
                ))}
                {ends.map((e) => (
                    <g key={e.name}>
                        <circle
                            cx={xOf(n - 1)}
                            cy={yOf(series.find((s) => s.name === e.name)?.values[n - 1] ?? 0)}
                            r={3}
                            fill={e.color}
                        />
                        <text className="viz-end" x={LEFT + plotW + 10} y={e.y} dominantBaseline="middle">
                            {e.name}
                        </text>
                    </g>
                ))}
                {drawdownPct && (
                    <g>
                        <text className="viz-tick" x={LEFT} y={stripTop - 4}>
                            Drawdown
                        </text>
                        <line className="viz-grid" x1={LEFT} x2={LEFT + plotW} y1={stripTop} y2={stripTop} />
                        <path
                            d={`${line(drawdownPct, ddY)}L${xOf(n - 1).toFixed(1)},${stripTop}L${LEFT},${stripTop}Z`}
                            className="viz-dd-fill"
                        />
                        <path d={line(drawdownPct, ddY)} className="viz-dd-line" />
                        <text className="viz-tick" x={LEFT - 8} y={stripTop} textAnchor="end" dominantBaseline="middle">
                            0%
                        </text>
                        <text
                            className="viz-tick"
                            x={LEFT - 8}
                            y={stripTop + STRIP}
                            textAnchor="end"
                            dominantBaseline="middle"
                        >
                            {geometry.ddLo.toFixed(geometry.ddLo > -10 ? 1 : 0)}%
                        </text>
                    </g>
                )}
                {hover !== null && (
                    <g pointerEvents="none">
                        <line
                            className="viz-cross"
                            x1={xOf(hover)}
                            x2={xOf(hover)}
                            y1={TOP}
                            y2={drawdownPct ? stripTop + STRIP : TOP + plotH}
                        />
                        {series.map((s) => (
                            <circle
                                key={s.name}
                                className="viz-dot"
                                cx={xOf(hover)}
                                cy={yOf(s.values[hover])}
                                r={4.5}
                                fill={s.color}
                            />
                        ))}
                    </g>
                )}
            </svg>
            {hover !== null && (
                <div className="viz-tip" style={{ left: tipLeft, top: TOP + 4 }}>
                    <div className="viz-tip-head">{dateTime(time[hover])}</div>
                    {series.map((s) => (
                        <div key={s.name} className="viz-tip-row">
                            <i style={{ background: s.color }} />
                            <b>{money(s.values[hover])}</b>
                            <span>{s.name}</span>
                        </div>
                    ))}
                    {drawdownPct && (
                        <div className="viz-tip-row">
                            <i className="viz-tip-dd" />
                            <b>{pct(drawdownPct[hover])}</b>
                            <span>Drawdown</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
