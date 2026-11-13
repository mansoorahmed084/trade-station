import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { Alert, Condition } from '@ts/alerts/types';
import { useAlerts } from './alerts-store.ts';
import { type ChartLine, setChartLines } from './chart-lines.ts';
import { stripChartType } from './chart-types.ts';
import type { ServerClient } from './client.ts';

/** Fixed price levels an alert watches: the value side of price comparisons and channel bounds. */
export function alertLevels(condition: Condition): number[] {
    if ('op' in condition) {
        if (condition.left.type !== 'price') return [];
        const out: number[] = [];
        for (const op of [condition.right, condition.upper, condition.lower])
            if (op?.type === 'value') out.push(op.value);
        return out;
    }
    if ('all' in condition) return condition.all.flatMap(alertLevels);
    if ('any' in condition) return condition.any.flatMap(alertLevels);
    return [];
}

function linesFor(symbol: string, alerts: Alert[]): ChartLine[] {
    const out: ChartLine[] = [];
    for (const alert of alerts) {
        if (!alert.active || !alert.symbols.some((s) => s.toUpperCase() === symbol)) continue;
        alertLevels(alert.condition).forEach((price, i) => {
            out.push({ id: `${alert.id}:${i}`, price, color: '#e3a008', text: `🔔 ${alert.name}` });
        });
    }
    return out;
}

/**
 * Keep the chart in step with the alerts: draw the level of each price alert on charts of its
 * symbol, and follow a drawing an alert is attached to when the drawing is moved or removed.
 */
export function bindAlerts(ws: VelaWorkspace, client: ServerClient): () => void {
    const offs = new Map<string, (() => void)[]>();

    const paint = () => {
        const { alerts } = useAlerts.getState();
        for (const cell of ws.cells() as any[]) {
            const symbol = stripChartType(String(cell.chart?.market?.symbol ?? '')).toUpperCase();
            setChartLines(cell, linesFor(symbol, alerts));
        }
    };

    /** Rewrite every `line` operand tied to a drawing. Returns null when the condition does not use it. */
    const retarget = (
        condition: Condition,
        drawingId: string,
        anchors: { time: number; price: number }[],
    ): Condition | null => {
        let touched = false;
        const operand = (op: any) => {
            if (op?.type !== 'line' || op.drawingId !== drawingId) return op;
            touched = true;
            const a = anchors[0];
            const b = anchors[1] ?? anchors[0];
            return {
                ...op,
                a: { time: a.time, price: a.price },
                b: { time: b.time === a.time && anchors.length > 1 ? b.time + 1 : b.time, price: b.price },
            };
        };
        const walk = (c: Condition): Condition => {
            if ('op' in c)
                return {
                    ...c,
                    left: operand(c.left),
                    right: operand(c.right),
                    upper: operand(c.upper),
                    lower: operand(c.lower),
                };
            if ('all' in c) return { all: c.all.map(walk) };
            if ('any' in c) return { any: c.any.map(walk) };
            return c;
        };
        const next = walk(condition);
        return touched ? next : null;
    };

    const uses = (condition: Condition, drawingId: string): boolean =>
        retarget(condition, drawingId, [{ time: 0, price: 0 }]) !== null;

    const watch = (cell: any) => {
        const id: string = cell.id;
        if (offs.has(id)) return;
        const chart = cell.chart;
        offs.set(id, [
            chart.on('market:changed', paint),
            chart.on('drawing:edited', (e: any) => {
                const drawing = chart.drawings.all().find((d: any) => d.id === e?.id);
                if (!drawing?.anchors?.length) return;
                for (const alert of useAlerts.getState().alerts) {
                    const condition = retarget(alert.condition, drawing.id, drawing.anchors);
                    if (condition)
                        void useAlerts
                            .getState()
                            .save(client, { condition }, alert.id)
                            .catch(() => {});
                }
            }),
            chart.on('drawing:removed', (e: any) => {
                // An alert on a line that no longer exists is paused rather than left watching a ghost.
                for (const alert of useAlerts.getState().alerts) {
                    if (alert.active && e?.id && uses(alert.condition, e.id)) {
                        void useAlerts
                            .getState()
                            .setActive(client, alert.id, false)
                            .catch(() => {});
                        useAlerts
                            .getState()
                            .toast({
                                title: 'Alert paused',
                                text: `"${alert.name}" was attached to a drawing that has been removed.`,
                                kind: 'info',
                            });
                    }
                }
            }),
        ]);
    };

    for (const cell of ws.cells()) watch(cell);
    paint();
    const stops = [
        ws.on('cell:created', (e: any) => {
            const cell = ws.cell(e?.id ?? e);
            if (cell) watch(cell);
            paint();
        }),
        ws.on('cell:destroyed', (e: any) => {
            const id = e?.id ?? e;
            for (const off of offs.get(id) ?? []) off();
            offs.delete(id);
        }),
        useAlerts.subscribe((state, prev) => {
            if (state.alerts !== prev.alerts) paint();
        }),
    ];
    return () => {
        for (const stop of stops) (stop as () => void)();
        for (const list of offs.values()) for (const off of list) off();
    };
}
