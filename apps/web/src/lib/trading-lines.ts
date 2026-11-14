import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { OrderState } from '@ts/oms/types';
import { bindChartLineInteraction, type ChartLine, setChartLines } from './chart-lines.ts';
import { stripChartType } from './chart-types.ts';
import {
    cancelOrder,
    closePosition,
    modifyOrder,
    openOrders,
    setPositionBrackets,
    useTrading,
} from './trading-store.ts';

const COLOR = {
    buy: '#2f7cf6',
    sell: '#e04f5f',
    long: '#26a69a',
    short: '#ef5350',
    target: '#26a69a',
    stop: '#e8a33d',
};
const GROUP = 'trading';

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });
const money = (n: number) =>
    `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TYPE: Record<OrderState['type'], string> = {
    market: 'MKT',
    limit: 'LMT',
    stop: 'STP',
    stop_limit: 'STP LMT',
    trailing_stop: 'TRAIL',
};

/** The lines one symbol's position and orders draw on a chart. */
export function tradingLines(symbol: string): ChartLine[] {
    const { positions, orders } = useTrading.getState();
    const lines: ChartLine[] = [];
    const position = positions[symbol];
    if (position && position.qty !== 0) {
        const long = position.qty > 0;
        lines.push({
            id: `pos:${symbol}`,
            price: position.avgPrice,
            color: long ? COLOR.long : COLOR.short,
            text: `${long ? 'LONG' : 'SHORT'} ${qty(Math.abs(position.qty))}`,
            style: 'solid',
            badge: {
                text: money(position.unrealizedPnl),
                color: position.unrealizedPnl >= 0 ? COLOR.long : COLOR.short,
            },
            onClose: () => void closePosition(symbol, undefined, true).catch(() => {}),
            closeTitle: 'Close the position',
        });
    }
    const open = openOrders(orders, symbol);
    const byId = new Map(open.map((o) => [o.id, o]));
    for (const o of open) {
        const waiting = o.status === 'inactive';
        const exit = o.role === 'take_profit' || o.role === 'stop_loss';
        const parent = o.parentId ? (byId.get(o.parentId) ?? orders[o.parentId]) : undefined;
        if (exit) {
            const target = o.role === 'take_profit';
            const price = target ? o.limit! : o.stop!;
            lines.push({
                id: o.id,
                price,
                color: target ? COLOR.target : COLOR.stop,
                text: `${target ? 'TP' : 'SL'} ${qty(o.qty)}${waiting ? ' (waits for entry)' : ''}`,
                style: waiting ? 'dashed' : 'solid',
                onMove: (p) => {
                    // A leg waiting for its entry belongs to the entry's bracket; a working one is an order of its own.
                    const leg = target ? 'takeProfit' : 'stopLoss';
                    if (waiting && parent) void modifyOrder(parent.id, { bracket: { [leg]: p } }).catch(() => {});
                    else if (!o.parentId) void setPositionBrackets(symbol, { [leg]: p }).catch(() => {});
                    else void modifyOrder(o.id, target ? { limit: p } : { stop: p }).catch(() => {});
                },
                onClose: () => {
                    const leg = target ? 'takeProfit' : 'stopLoss';
                    if (waiting && parent) void modifyOrder(parent.id, { bracket: { [leg]: null } }).catch(() => {});
                    else if (!o.parentId) void setPositionBrackets(symbol, { [leg]: null }).catch(() => {});
                    else void cancelOrder(o.id).catch(() => {});
                },
                closeTitle: `Remove the ${target ? 'target' : 'stop'}`,
            });
            continue;
        }
        const color = o.side === 'buy' ? COLOR.buy : COLOR.sell;
        const label = `${o.side === 'buy' ? 'BUY' : 'SELL'} ${TYPE[o.type]} ${qty(o.qty)}`;
        const cancel = () => void cancelOrder(o.id).catch(() => {});
        if (o.type === 'limit' || o.type === 'stop_limit') {
            lines.push({
                id: `${o.id}:limit`,
                price: o.limit!,
                color,
                text: o.type === 'stop_limit' ? `${label} · limit` : label,
                onMove: (p) => void modifyOrder(o.id, { limit: p }).catch(() => {}),
                onClose: cancel,
                closeTitle: 'Cancel the order',
            });
        }
        if (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop') {
            lines.push({
                id: `${o.id}:stop`,
                price: o.stop!,
                color,
                text: o.type === 'stop_limit' ? `${label} · stop` : label,
                style: o.type === 'trailing_stop' ? 'dashed' : undefined,
                // A trailing stop moves by itself; it can only be cancelled from the chart.
                onMove:
                    o.type === 'trailing_stop' ? undefined : (p) => void modifyOrder(o.id, { stop: p }).catch(() => {}),
                onClose: cancel,
                closeTitle: 'Cancel the order',
            });
        }
    }
    return lines;
}

/** Draw every account position and working order on each chart showing that symbol, and keep them current. */
export function bindTradingLines(ws: VelaWorkspace): () => void {
    let scheduled = false;
    const paint = () => {
        scheduled = false;
        for (const cell of ws.cells() as any[]) {
            const symbol = stripChartType(String(cell.chart?.market?.symbol ?? '')).toUpperCase();
            setChartLines(cell, symbol ? tradingLines(symbol) : [], GROUP);
        }
    };
    // Positions are re-marked several times a second: draw at most once a frame.
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(paint);
    };
    const offs: (() => void)[] = [];
    const watched = new Set<string>();
    const watch = () => {
        for (const cell of ws.cells() as any[]) {
            if (watched.has(cell.id)) continue;
            watched.add(cell.id);
            offs.push(cell.chart.on('market:changed', schedule));
        }
    };
    watch();
    paint();
    offs.push(
        ws.on('cell:created', () => {
            watch();
            schedule();
        }) as unknown as () => void,
        useTrading.subscribe((s, prev) => {
            if (s.orders !== prev.orders || s.positions !== prev.positions) schedule();
        }),
        bindChartLineInteraction(ws),
    );
    return () => {
        for (const off of offs) off();
        for (const cell of ws.cells() as any[]) setChartLines(cell, [], GROUP);
    };
}
