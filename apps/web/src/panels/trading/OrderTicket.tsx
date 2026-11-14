import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { PlaceOrderRequest } from '@ts/oms/types';
import { useMemo, useState } from 'react';
import type { ServerClient } from '../../lib/client.ts';
import { describeOrder, placeOrder, type TicketState, useTrading } from '../../lib/trading-store.ts';
import { useChartMarket } from '../../lib/use-chart-market.ts';
import { priceDecimals, useQuote } from '../../lib/use-quote.ts';
import { AccountBadge } from './AccountBadge.tsx';

const TYPES: { id: TicketState['type']; label: string }[] = [
    { id: 'market', label: 'Market' },
    { id: 'limit', label: 'Limit' },
    { id: 'stop', label: 'Stop' },
    { id: 'stop_limit', label: 'Stop limit' },
    { id: 'trailing_stop', label: 'Trailing' },
];

const num = (s: string): number | undefined => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const floorTo = (v: number, step: number) => (step > 0 ? Number((Math.floor(v / step + 1e-9) * step).toFixed(10)) : v);
const fmt = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** The order ticket: everything about one order on the active chart's symbol. */
export function OrderTicket({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const market = useChartMarket(workspace);
    const symbol = market?.symbol;
    const quote = useQuote(client, symbol);
    const t = useTrading((s) => s.ticket);
    const set = useTrading((s) => s.setTicket);
    const account = useTrading((s) => s.account);
    const position = useTrading((s) => (symbol ? s.positions[symbol] : undefined));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const info = quote?.info;
    const tick = info?.tickSize ?? 0.01;
    const lot = info?.lotSize ?? 0.001;
    const decimals = priceDecimals(tick);
    const last = position?.lastPrice ?? quote?.last ?? null;
    const buy = t.side === 'buy';

    /** The price the order is expected to trade at: what sizing and the bracket checks are measured from. */
    const entry = useMemo(() => {
        if (t.type === 'limit' || t.type === 'stop_limit') return num(t.limit) ?? last ?? undefined;
        if (t.type === 'stop') return num(t.stop) ?? last ?? undefined;
        return last ?? undefined;
    }, [t.type, t.limit, t.stop, last]);

    const sl = t.slOn ? num(t.sl) : undefined;
    const tp = t.tpOn ? num(t.tp) : undefined;
    const qty = useMemo(() => {
        if (t.sizing === 'units') return num(t.qty) ?? 0;
        if (!entry) return 0;
        if (t.sizing === 'value') return floorTo((num(t.value) ?? 0) / entry, lot);
        // Risk: lose this share of equity if the stop loss is hit.
        if (sl === undefined || !account) return 0;
        const perUnit = Math.abs(entry - sl);
        return perUnit > 0 ? floorTo((((num(t.riskPct) ?? 0) / 100) * account.equity) / perUnit, lot) : 0;
    }, [t.sizing, t.qty, t.value, t.riskPct, entry, sl, lot, account]);

    /** Start a price field from the market, a sensible distance away, when it is switched on empty. */
    const seed = (pct: number) => (last ? (last * (1 + pct / 100)).toFixed(decimals) : '');
    const chooseType = (type: TicketState['type']) => {
        const patch: Partial<TicketState> = { type };
        if ((type === 'limit' || type === 'stop_limit') && !t.limit) patch.limit = seed(buy ? -0.5 : 0.5);
        if ((type === 'stop' || type === 'stop_limit') && !t.stop) patch.stop = seed(buy ? 0.5 : -0.5);
        if (type === 'trailing_stop' && !t.trail && last) patch.trail = (last * 0.01).toFixed(decimals);
        set(patch);
    };
    const toggleLeg = (leg: 'tp' | 'sl', on: boolean) => {
        const base = entry ?? last;
        const away = leg === 'tp' ? (buy ? 1 : -1) * 2 : buy ? -1 : 1;
        set(
            leg === 'tp'
                ? { tpOn: on, tp: on && !t.tp && base ? (base * (1 + away / 100)).toFixed(decimals) : t.tp }
                : { slOn: on, sl: on && !t.sl && base ? (base * (1 + away / 100)).toFixed(decimals) : t.sl },
        );
    };

    const request: PlaceOrderRequest | null = symbol
        ? {
              symbol,
              side: t.side,
              type: t.type,
              qty,
              limit: t.type === 'limit' || t.type === 'stop_limit' ? num(t.limit) : undefined,
              stop: t.type === 'stop' || t.type === 'stop_limit' ? num(t.stop) : undefined,
              trailDistance: t.type === 'trailing_stop' ? num(t.trail) : undefined,
              tif: t.tif,
              bracket: tp !== undefined || sl !== undefined ? { takeProfit: tp, stopLoss: sl } : undefined,
              source: 'ticket',
          }
        : null;
    const value = entry && qty ? entry * qty : 0;
    const risk = entry && sl !== undefined ? Math.abs(entry - sl) * qty : null;
    const reward = entry && tp !== undefined ? Math.abs(tp - entry) * qty : null;

    const submit = async () => {
        if (!request) return;
        setBusy(true);
        setError(null);
        try {
            const order = await placeOrder(request);
            if (order?.status === 'rejected') setError(order.reason ?? 'rejected');
        } catch (err: any) {
            setError(String(err?.message ?? err));
        } finally {
            setBusy(false);
        }
    };

    const field = (label: string, key: 'limit' | 'stop' | 'trail', hint?: string) => (
        <label className="tk-field">
            <span>{label}</span>
            <input
                type="number"
                step={tick}
                value={t[key]}
                onChange={(e) => set({ [key]: e.target.value })}
                data-testid={`ticket-${key}`}
            />
            {hint && <small className="muted">{hint}</small>}
        </label>
    );
    const distance = (price: number | undefined) =>
        price !== undefined && entry
            ? `${(((price - entry) / entry) * 100).toFixed(2)}% · ${Math.round(Math.abs(price - entry) / tick).toLocaleString('en-US')} ticks`
            : '';

    return (
        <div className="ticket" data-testid="order-ticket">
            <div className="tk-head">
                <AccountBadge account={account} />
                <span className="muted">{account?.name ?? 'Paper trading'}</span>
                <span className="spacer" />
                <span className="muted" title="Buying power">
                    {account ? `${fmt(account.buyingPower)} ${account.currency}` : ''}
                </span>
            </div>
            <div className="tk-symbol">
                <b data-testid="ticket-symbol">{symbol ?? '—'}</b>
                <span className="tk-last">{last !== null ? fmt(last, decimals) : '…'}</span>
            </div>
            <div className="tk-sides">
                <button
                    type="button"
                    className={`tk-side sell ${!buy ? 'on' : ''}`}
                    onClick={() => set({ side: 'sell' })}
                    data-testid="ticket-sell"
                >
                    <span>Sell</span>
                    <b>{last !== null ? fmt(last, decimals) : ''}</b>
                </button>
                <button
                    type="button"
                    className={`tk-side buy ${buy ? 'on' : ''}`}
                    onClick={() => set({ side: 'buy' })}
                    data-testid="ticket-buy"
                >
                    <span>Buy</span>
                    <b>{last !== null ? fmt(last, decimals) : ''}</b>
                </button>
            </div>
            <div className="seg tk-types">
                {TYPES.map((x) => (
                    <button
                        key={x.id}
                        type="button"
                        className={t.type === x.id ? 'on' : ''}
                        onClick={() => chooseType(x.id)}
                        data-testid={`ticket-type-${x.id}`}
                    >
                        {x.label}
                    </button>
                ))}
            </div>
            {(t.type === 'stop' || t.type === 'stop_limit') && field('Stop price', 'stop', distance(num(t.stop)))}
            {(t.type === 'limit' || t.type === 'stop_limit') && field('Limit price', 'limit', distance(num(t.limit)))}
            {t.type === 'trailing_stop' &&
                field(
                    'Trail by',
                    'trail',
                    last && num(t.trail)
                        ? `stop starts at ${fmt(buy ? last + num(t.trail)! : last - num(t.trail)!, decimals)}`
                        : '',
                )}
            <div className="tk-field">
                <span>Size</span>
                <div className="row">
                    <input
                        type="number"
                        className="grow"
                        min={0}
                        step={t.sizing === 'units' ? lot : 'any'}
                        value={t.sizing === 'units' ? t.qty : t.sizing === 'value' ? t.value : t.riskPct}
                        onChange={(e) =>
                            set(
                                t.sizing === 'units'
                                    ? { qty: e.target.value }
                                    : t.sizing === 'value'
                                      ? { value: e.target.value }
                                      : { riskPct: e.target.value },
                            )
                        }
                        data-testid="ticket-qty"
                    />
                    <select
                        value={t.sizing}
                        onChange={(e) => set({ sizing: e.target.value as TicketState['sizing'] })}
                        aria-label="Size in"
                    >
                        <option value="units">{info?.baseCurrency ?? 'Units'}</option>
                        <option value="value">{info?.currency ?? 'Value'}</option>
                        <option value="risk">% risk</option>
                    </select>
                </div>
                <small className="muted">
                    {t.sizing !== 'units' &&
                        `${qty.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${info?.baseCurrency ?? 'units'} · `}
                    {t.sizing === 'risk' && !t.slOn
                        ? 'set a stop loss to size by risk'
                        : `value ${fmt(value)} ${info?.currency ?? ''}`}
                </small>
            </div>
            {(['tp', 'sl'] as const).map((leg) => {
                const on = leg === 'tp' ? t.tpOn : t.slOn;
                const price = leg === 'tp' ? tp : sl;
                return (
                    <div key={leg} className="tk-field">
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => toggleLeg(leg, e.target.checked)}
                                data-testid={`ticket-${leg}-on`}
                            />
                            {leg === 'tp' ? 'Take profit' : 'Stop loss'}
                        </label>
                        {on && (
                            <>
                                <input
                                    type="number"
                                    step={tick}
                                    value={leg === 'tp' ? t.tp : t.sl}
                                    onChange={(e) =>
                                        set(leg === 'tp' ? { tp: e.target.value } : { sl: e.target.value })
                                    }
                                    data-testid={`ticket-${leg}`}
                                />
                                <small className="muted">{distance(price)}</small>
                            </>
                        )}
                    </div>
                );
            })}
            <div className="row tk-tif">
                <label className="inline">
                    Time in force
                    <select value={t.tif} onChange={(e) => set({ tif: e.target.value as TicketState['tif'] })}>
                        <option value="GTC">Good till cancelled</option>
                        <option value="DAY">Day</option>
                        <option value="IOC">Immediate or cancel</option>
                    </select>
                </label>
            </div>
            {(risk !== null || reward !== null) && (
                <div className="tk-rr muted">
                    {risk !== null && <span>Risk {fmt(risk)}</span>}
                    {reward !== null && <span>Reward {fmt(reward)}</span>}
                    {risk !== null && reward !== null && risk > 0 && <span>R:R {(reward / risk).toFixed(2)}</span>}
                </div>
            )}
            <button
                type="button"
                className={`tk-submit ${buy ? 'buy' : 'sell'}`}
                disabled={busy || !request || !(qty > 0)}
                onClick={submit}
                data-testid="ticket-submit"
            >
                {request && qty > 0 ? describeOrder(request) : buy ? 'Buy' : 'Sell'}
            </button>
            {error && (
                <div className="error-text" data-testid="ticket-error">
                    {error}
                </div>
            )}
            {position && (
                <div className="tk-position muted">
                    Position {position.qty > 0 ? 'long' : 'short'}{' '}
                    {Math.abs(position.qty).toLocaleString('en-US', { maximumFractionDigits: 8 })} at{' '}
                    {fmt(position.avgPrice, decimals)} ·{' '}
                    <span className={position.unrealizedPnl >= 0 ? 'pos' : 'neg'}>
                        {position.unrealizedPnl >= 0 ? '+' : '−'}
                        {fmt(Math.abs(position.unrealizedPnl))}
                    </span>
                </div>
            )}
        </div>
    );
}
