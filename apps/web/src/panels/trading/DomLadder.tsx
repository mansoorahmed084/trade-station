import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { OrderState } from '@ts/oms/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServerClient } from '../../lib/client.ts';
import { cancelOrder, openOrders, placeOrder, useTrading } from '../../lib/trading-store.ts';
import { useChartMarket } from '../../lib/use-chart-market.ts';
import { priceDecimals, useQuote } from '../../lib/use-quote.ts';
import { AccountBadge } from './AccountBadge.tsx';

interface Book {
    bids: [number, number][];
    asks: [number, number][];
}

const ROWS = 41;
const GROUPS = [1, 2, 5, 10, 25, 100];
const qty = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 4 });

/**
 * The depth ladder: prices down the middle, resting size either side, and our own orders at their
 * prices. A click on the buy side places a buy at that price — a limit below the market, a stop
 * above it — and the sell side the other way round.
 */
export function DomLadder({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const market = useChartMarket(workspace);
    const symbol = market?.symbol;
    const quote = useQuote(client, symbol, 700);
    const orders = useTrading((s) => s.orders);
    const position = useTrading((s) => (symbol ? s.positions[symbol] : undefined));
    const account = useTrading((s) => s.account);
    const size = useTrading((s) => s.ticket.qty);
    const setTicket = useTrading((s) => s.setTicket);
    const [book, setBook] = useState<Book>({ bids: [], asks: [] });
    const [group, setGroup] = useState(1);
    const [center, setCenter] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const lastSymbol = useRef<string | undefined>(undefined);

    const tick = quote?.info?.tickSize ?? 0.01;
    const step = tick * group;
    const decimals = priceDecimals(step);
    const last = position?.lastPrice ?? quote?.last ?? null;

    // The book, refreshed while the ladder is open.
    useEffect(() => {
        if (!symbol) return;
        let live = true;
        const read = async () => {
            try {
                const b = await client.json<Book>(`/api/depth?symbol=${encodeURIComponent(symbol)}&levels=100`);
                if (live) {
                    setBook(b);
                    setError(null);
                }
            } catch (err: any) {
                if (live) setError(String(err?.message ?? err));
            }
        };
        void read();
        const timer = setInterval(read, 700);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [client, symbol]);

    // Keep the market near the middle: re-centre on a new symbol, or when price leaves the middle third.
    const snap = (p: number) => Number((Math.round(p / step) * step).toFixed(10));
    useEffect(() => {
        if (last === null) return;
        const mid = snap(last);
        if (lastSymbol.current !== symbol || center === null || Math.abs(mid - center) > (ROWS / 6) * step) {
            lastSymbol.current = symbol;
            setCenter(mid);
        }
    });

    const rows = useMemo(() => {
        if (center === null) return [];
        const out: number[] = [];
        const half = Math.floor(ROWS / 2);
        for (let k = half; k >= -half; k--) out.push(Number((center + k * step).toFixed(10)));
        return out;
    }, [center, step]);

    // Book sizes summed into the ladder's rows.
    const sizes = useMemo(() => {
        const bid = new Map<number, number>();
        const ask = new Map<number, number>();
        const bucket = (p: number, up: boolean) =>
            Number(((up ? Math.ceil(p / step - 1e-9) : Math.floor(p / step + 1e-9)) * step).toFixed(10));
        for (const [p, q] of book.bids) bid.set(bucket(p, false), (bid.get(bucket(p, false)) ?? 0) + q);
        for (const [p, q] of book.asks) ask.set(bucket(p, true), (ask.get(bucket(p, true)) ?? 0) + q);
        let max = 0;
        for (const v of [...bid.values(), ...ask.values()]) max = Math.max(max, v);
        return { bid, ask, max };
    }, [book, step]);

    // Our orders by the row they rest on.
    const mine = useMemo(() => {
        const buys = new Map<number, OrderState[]>();
        const sells = new Map<number, OrderState[]>();
        for (const o of openOrders(orders, symbol)) {
            const price = o.type === 'limit' || (o.type === 'stop_limit' && o.limit !== undefined) ? o.limit : o.stop;
            if (price === undefined) continue;
            const row = Number((Math.round(price / step) * step).toFixed(10));
            const map = o.side === 'buy' ? buys : sells;
            map.set(row, [...(map.get(row) ?? []), o]);
        }
        return { buys, sells };
    }, [orders, symbol, step]);

    const lastRow = last === null ? null : snap(last);
    const avgRow = position ? snap(position.avgPrice) : null;
    const units = Number(size);

    const send = async (side: 'buy' | 'sell', price: number) => {
        if (!symbol || last === null || !(units > 0)) return;
        // Below the market a buy waits as a limit; above it, as a stop. The other way round for a sell.
        const type = side === 'buy' ? (price <= last ? 'limit' : 'stop') : price >= last ? 'limit' : 'stop';
        await placeOrder(
            {
                symbol,
                side,
                type,
                qty: units,
                limit: type === 'limit' ? price : undefined,
                stop: type === 'stop' ? price : undefined,
                source: 'dom',
            },
            true,
        ).catch(() => {});
    };

    const orderCell = (list: OrderState[] | undefined) =>
        list?.map((o) => (
            <button
                key={o.id}
                type="button"
                className={`dom-order ${o.side}`}
                title={`Cancel this ${o.type.replace('_', ' ')} order`}
                onClick={(e) => {
                    e.stopPropagation();
                    void cancelOrder(o.id).catch(() => {});
                }}
            >
                {qty(o.qty)}{' '}
                {o.type === 'limit'
                    ? 'LMT'
                    : o.type === 'stop'
                      ? 'STP'
                      : o.type === 'stop_limit'
                        ? 'S/L'
                        : o.type === 'trailing_stop'
                          ? 'TRL'
                          : ''}{' '}
                ×
            </button>
        ));

    return (
        <div className="dom" data-testid="dom">
            <div className="dom-head">
                <AccountBadge account={account} />
                <b>{symbol ?? '—'}</b>
                <span className="spacer" />
                <label
                    className="inline"
                    title="Size of each order placed from the ladder (shared with the order ticket)"
                >
                    Size
                    <input
                        type="number"
                        min={0}
                        value={size}
                        onChange={(e) => setTicket({ qty: e.target.value, sizing: 'units' })}
                        data-testid="dom-qty"
                    />
                </label>
                <select value={group} onChange={(e) => setGroup(Number(e.target.value))} aria-label="Ticks per row">
                    {GROUPS.map((g) => (
                        <option key={g} value={g}>
                            {g} tick{g === 1 ? '' : 's'}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => last !== null && setCenter(snap(last))}
                    title="Centre on the market"
                >
                    Centre
                </button>
            </div>
            {error && <div className="tester-note">{error}</div>}
            <div className="dom-grid" data-testid="dom-rows">
                <div className="dom-row dom-labels">
                    <span>Buy</span>
                    <span>Bids</span>
                    <span>Price</span>
                    <span>Asks</span>
                    <span>Sell</span>
                </div>
                {rows.map((p) => {
                    const bid = sizes.bid.get(p);
                    const ask = sizes.ask.get(p);
                    const cls = [
                        'dom-row',
                        p === lastRow ? 'is-last' : '',
                        p === avgRow ? (position!.qty > 0 ? 'is-long' : 'is-short') : '',
                    ].join(' ');
                    return (
                        <div key={p} className={cls} data-price={p}>
                            <button
                                type="button"
                                className="dom-cell dom-buy"
                                onClick={() => void send('buy', p)}
                                title={
                                    last !== null
                                        ? `Buy ${size} at ${p.toFixed(decimals)} (${p <= last ? 'limit' : 'stop'})`
                                        : ''
                                }
                            >
                                {orderCell(mine.buys.get(p))}
                            </button>
                            <span className="dom-cell dom-size bid">
                                {bid !== undefined && (
                                    <>
                                        <i style={{ width: `${(bid / (sizes.max || 1)) * 100}%` }} />
                                        <em>{qty(bid)}</em>
                                    </>
                                )}
                            </span>
                            <span className="dom-cell dom-price">{p.toFixed(decimals)}</span>
                            <span className="dom-cell dom-size ask">
                                {ask !== undefined && (
                                    <>
                                        <i style={{ width: `${(ask / (sizes.max || 1)) * 100}%` }} />
                                        <em>{qty(ask)}</em>
                                    </>
                                )}
                            </span>
                            <button
                                type="button"
                                className="dom-cell dom-sell"
                                onClick={() => void send('sell', p)}
                                title={
                                    last !== null
                                        ? `Sell ${size} at ${p.toFixed(decimals)} (${p >= last ? 'limit' : 'stop'})`
                                        : ''
                                }
                            >
                                {orderCell(mine.sells.get(p))}
                            </button>
                        </div>
                    );
                })}
            </div>
            {position && (
                <div className="dom-foot muted">
                    {position.qty > 0 ? 'Long' : 'Short'} {qty(Math.abs(position.qty))} at{' '}
                    {position.avgPrice.toFixed(decimals)} ·{' '}
                    <span className={position.unrealizedPnl >= 0 ? 'pos' : 'neg'}>
                        {position.unrealizedPnl >= 0 ? '+' : '−'}
                        {Math.abs(position.unrealizedPnl).toFixed(2)}
                    </span>
                </div>
            )}
        </div>
    );
}
