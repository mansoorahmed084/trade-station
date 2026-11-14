import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { OrderState, PositionState } from '@ts/oms/types';
import { useMemo, useState } from 'react';
import {
    cancelAll,
    cancelOrder,
    closePosition,
    type Limits,
    modifyOrder,
    openOrders,
    resetPaper,
    reversePosition,
    saveLimits,
    setPositionBrackets,
    switchAccount,
    useTrading,
} from '../../lib/trading-store.ts';
import { Button, Tabs } from '../../ui.tsx';
import { AccountBadge } from './AccountBadge.tsx';

type Tab = 'positions' | 'orders' | 'fills' | 'history' | 'settings';

const fmt = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const qty = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 8 });
const px = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 8 });
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const time = (ms: number) => new Date(ms).toISOString().slice(5, 19).replace('T', ' ');
const TYPE: Record<OrderState['type'], string> = {
    market: 'Market',
    limit: 'Limit',
    stop: 'Stop',
    stop_limit: 'Stop limit',
    trailing_stop: 'Trailing stop',
};
const ROLE: Record<OrderState['role'], string> = {
    entry: '',
    close: 'close',
    take_profit: 'take profit',
    stop_loss: 'stop loss',
};

/** A price that saves on Enter or when the field loses focus with a changed value. */
function PriceCell({
    value,
    onSave,
    label,
}: {
    value: number | undefined;
    onSave: (v: number | null) => void;
    label: string;
}) {
    const [text, setText] = useState<string | null>(null);
    const shown = text ?? (value === undefined ? '' : String(value));
    const commit = () => {
        if (text === null) return;
        const t = text.trim();
        setText(null);
        if (t === '' && value !== undefined) onSave(null);
        else if (t !== '' && Number(t) !== value && Number.isFinite(Number(t))) onSave(Number(t));
    };
    return (
        <input
            className="cell-input"
            type="number"
            aria-label={label}
            placeholder="—"
            value={shown}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setText(null);
            }}
        />
    );
}

/** Account manager: the account's figures, positions, working orders, fills and history. */
export function AccountManager({ workspace }: { workspace: VelaWorkspace }) {
    const account = useTrading((s) => s.account);
    const accounts = useTrading((s) => s.accounts);
    const accountId = useTrading((s) => s.accountId);
    const orders = useTrading((s) => s.orders);
    const positions = useTrading((s) => s.positions);
    const executions = useTrading((s) => s.executions);
    const [tab, setTab] = useState<Tab>('positions');

    const posList = Object.values(positions).sort((a, b) => a.symbol.localeCompare(b.symbol));
    const working = openOrders(orders);
    const history = useMemo(
        () =>
            Object.values(orders)
                .filter((o) => o.status !== 'working' && o.status !== 'inactive')
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, 500),
        [orders],
    );
    const show = (symbol: string) => {
        const chart: any = workspace.chart;
        if (chart?.setMarket && chart.market?.symbol !== symbol) void chart.setMarket({ symbol });
    };

    const tabs: { id: Tab; label: string }[] = [
        { id: 'positions', label: `Positions (${posList.length})` },
        { id: 'orders', label: `Orders (${working.length})` },
        { id: 'fills', label: 'Fills' },
        { id: 'history', label: 'History' },
        { id: 'settings', label: 'Settings' },
    ];

    return (
        <div className="acct" data-testid="account-manager">
            <div className="acct-head">
                <AccountBadge account={account} />
                <select
                    value={accountId}
                    aria-label="Account"
                    data-testid="account-select"
                    onChange={(e) => void switchAccount(e.target.value).catch(() => {})}
                >
                    {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                            {a.name}
                            {a.kind === 'paper' ? '' : a.kind === 'sandbox' ? ' (testnet)' : ' (LIVE)'}
                        </option>
                    ))}
                </select>
                {account && (
                    <div className="acct-figures" data-testid="account-figures">
                        <span>
                            <small>Balance</small>
                            <b>{fmt(account.balance)}</b>
                        </span>
                        <span>
                            <small>Equity</small>
                            <b>{fmt(account.equity)}</b>
                        </span>
                        <span>
                            <small>Unrealised</small>
                            <b className={tone(account.unrealizedPnl)}>{signed(account.unrealizedPnl)}</b>
                        </span>
                        <span>
                            <small>Realised</small>
                            <b className={tone(account.realizedPnl)}>{signed(account.realizedPnl)}</b>
                        </span>
                        <span>
                            <small>Today</small>
                            <b className={tone(account.dayPnl)}>{signed(account.dayPnl)}</b>
                        </span>
                        <span>
                            <small>Buying power</small>
                            <b>{fmt(account.buyingPower)}</b>
                        </span>
                        <span>
                            <small>Commission</small>
                            <b>{fmt(account.commissionPaid)}</b>
                        </span>
                    </div>
                )}
                <span className="spacer" />
                {working.length > 0 && (
                    <Button variant="ghost" onClick={() => void cancelAll().catch(() => {})} data-testid="cancel-all">
                        Cancel all orders
                    </Button>
                )}
            </div>
            <Tabs tabs={tabs} value={tab} onChange={setTab} />
            <div className="acct-body">
                {tab === 'positions' && <Positions positions={posList} onShow={show} />}
                {tab === 'orders' && <Orders orders={working} onShow={show} />}
                {tab === 'fills' && (
                    <table className="grid-table" data-testid="fills">
                        <thead>
                            <tr>
                                <th>Time (UTC)</th>
                                <th>Symbol</th>
                                <th>Side</th>
                                <th className="num">Quantity</th>
                                <th className="num">Price</th>
                                <th className="num">Commission</th>
                                <th className="num">Realised</th>
                            </tr>
                        </thead>
                        <tbody>
                            {executions.map((e) => (
                                <tr key={e.id}>
                                    <td>{time(e.time)}</td>
                                    <td>{e.symbol}</td>
                                    <td className={e.side === 'buy' ? 'buy-text' : 'sell-text'}>
                                        {e.side === 'buy' ? 'Buy' : 'Sell'}
                                    </td>
                                    <td className="num">{qty(e.qty)}</td>
                                    <td className="num">{px(e.price)}</td>
                                    <td className="num">{fmt(e.commission)}</td>
                                    <td className={`num ${tone(e.realizedPnl)}`}>
                                        {e.realizedPnl ? signed(e.realizedPnl) : ''}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {tab === 'history' && (
                    <table className="grid-table" data-testid="history">
                        <thead>
                            <tr>
                                <th>Updated (UTC)</th>
                                <th>Symbol</th>
                                <th>Side</th>
                                <th>Type</th>
                                <th className="num">Quantity</th>
                                <th className="num">Price</th>
                                <th>Status</th>
                                <th className="num">Filled at</th>
                                <th>Note</th>
                            </tr>
                        </thead>
                        <tbody>
                            {history.map((o) => (
                                <tr key={o.id}>
                                    <td>{time(o.updatedAt)}</td>
                                    <td>{o.symbol}</td>
                                    <td className={o.side === 'buy' ? 'buy-text' : 'sell-text'}>
                                        {o.side === 'buy' ? 'Buy' : 'Sell'}
                                    </td>
                                    <td>
                                        {TYPE[o.type]} <span className="muted">{ROLE[o.role]}</span>
                                    </td>
                                    <td className="num">{qty(o.qty)}</td>
                                    <td className="num">{px(o.limit ?? o.stop)}</td>
                                    <td className={`status-${o.status}`}>{o.status}</td>
                                    <td className="num">{px(o.avgFillPrice)}</td>
                                    <td className="muted">{o.reason ?? ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {tab === 'settings' && <Settings />}
            </div>
        </div>
    );
}

function Positions({ positions, onShow }: { positions: PositionState[]; onShow: (s: string) => void }) {
    if (positions.length === 0) return <p className="muted pad">No open positions.</p>;
    return (
        <table className="grid-table" data-testid="positions">
            <thead>
                <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th className="num">Quantity</th>
                    <th className="num">Average price</th>
                    <th className="num">Last</th>
                    <th className="num">Unrealised</th>
                    <th className="num">Realised</th>
                    <th className="num">Take profit</th>
                    <th className="num">Stop loss</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                {positions.map((p) => {
                    const pct = p.avgPrice > 0 ? (p.unrealizedPnl / (Math.abs(p.qty) * p.avgPrice)) * 100 : 0;
                    return (
                        <tr key={p.symbol} data-testid="position-row">
                            <td>
                                <button type="button" className="link" onClick={() => onShow(p.symbol)}>
                                    {p.symbol}
                                </button>
                            </td>
                            <td className={p.qty > 0 ? 'buy-text' : 'sell-text'}>{p.qty > 0 ? 'Long' : 'Short'}</td>
                            <td className="num">{qty(Math.abs(p.qty))}</td>
                            <td className="num">{px(p.avgPrice)}</td>
                            <td className="num">{px(p.lastPrice)}</td>
                            <td className={`num ${tone(p.unrealizedPnl)}`}>
                                {signed(p.unrealizedPnl)}{' '}
                                <span className="muted">
                                    {pct >= 0 ? '+' : '−'}
                                    {Math.abs(pct).toFixed(2)}%
                                </span>
                            </td>
                            <td className={`num ${tone(p.realizedPnl)}`}>{signed(p.realizedPnl)}</td>
                            <td className="num">
                                <PriceCell
                                    value={p.takeProfit}
                                    label={`${p.symbol} take profit`}
                                    onSave={(v) =>
                                        void setPositionBrackets(p.symbol, { takeProfit: v }).catch(() => {})
                                    }
                                />
                            </td>
                            <td className="num">
                                <PriceCell
                                    value={p.stopLoss}
                                    label={`${p.symbol} stop loss`}
                                    onSave={(v) => void setPositionBrackets(p.symbol, { stopLoss: v }).catch(() => {})}
                                />
                            </td>
                            <td className="actions">
                                <button
                                    type="button"
                                    className="link"
                                    onClick={() => void reversePosition(p.symbol, true).catch(() => {})}
                                >
                                    Reverse
                                </button>
                                <button
                                    type="button"
                                    className="link danger"
                                    onClick={() => void closePosition(p.symbol, undefined, true).catch(() => {})}
                                    data-testid="close-position"
                                >
                                    Close
                                </button>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function Orders({ orders, onShow }: { orders: OrderState[]; onShow: (s: string) => void }) {
    if (orders.length === 0) return <p className="muted pad">No working orders.</p>;
    return (
        <table className="grid-table" data-testid="orders">
            <thead>
                <tr>
                    <th>Placed (UTC)</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Type</th>
                    <th className="num">Quantity</th>
                    <th className="num">Limit</th>
                    <th className="num">Stop</th>
                    <th>Status</th>
                    <th>Time in force</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                {orders.map((o) => {
                    // A leg waiting for its entry is changed through the entry's bracket.
                    const viaParent = o.status === 'inactive' && o.parentId;
                    const leg = o.role === 'take_profit' ? 'takeProfit' : 'stopLoss';
                    const save = (field: 'limit' | 'stop') => (v: number | null) => {
                        if (v === null) return;
                        if (viaParent) void modifyOrder(o.parentId!, { bracket: { [leg]: v } }).catch(() => {});
                        else void modifyOrder(o.id, { [field]: v }).catch(() => {});
                    };
                    return (
                        <tr key={o.id} data-testid="order-row">
                            <td>{time(o.createdAt)}</td>
                            <td>
                                <button type="button" className="link" onClick={() => onShow(o.symbol)}>
                                    {o.symbol}
                                </button>
                            </td>
                            <td className={o.side === 'buy' ? 'buy-text' : 'sell-text'}>
                                {o.side === 'buy' ? 'Buy' : 'Sell'}
                            </td>
                            <td>
                                {TYPE[o.type]} <span className="muted">{ROLE[o.role]}</span>
                            </td>
                            <td className="num">
                                {o.parentId || o.role === 'take_profit' || o.role === 'stop_loss' ? (
                                    qty(o.qty)
                                ) : (
                                    <PriceCell
                                        value={o.qty}
                                        label={`${o.symbol} quantity`}
                                        onSave={(v) => v && void modifyOrder(o.id, { qty: v }).catch(() => {})}
                                    />
                                )}
                            </td>
                            <td className="num">
                                {o.limit !== undefined ? (
                                    <PriceCell
                                        value={o.limit}
                                        label={`${o.symbol} limit price`}
                                        onSave={save('limit')}
                                    />
                                ) : (
                                    '—'
                                )}
                            </td>
                            <td className="num">
                                {o.stop !== undefined && o.type !== 'trailing_stop' ? (
                                    <PriceCell value={o.stop} label={`${o.symbol} stop price`} onSave={save('stop')} />
                                ) : (
                                    px(o.stop)
                                )}
                            </td>
                            <td className={`status-${o.status}`}>
                                {o.status === 'inactive' ? 'waiting for entry' : o.status}
                            </td>
                            <td>{o.tif}</td>
                            <td className="actions">
                                <button
                                    type="button"
                                    className="link danger"
                                    onClick={() => void cancelOrder(o.id).catch(() => {})}
                                    data-testid="cancel-order"
                                >
                                    Cancel
                                </button>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function Settings() {
    const account = useTrading((s) => s.account);
    const limits = useTrading((s) => s.limits);
    const confirmOrders = useTrading((s) => s.confirmOrders);
    const setConfirm = useTrading((s) => s.setConfirmOrders);
    const quickTrade = useTrading((s) => s.quickTrade);
    const setQuickTrade = useTrading((s) => s.setQuickTrade);
    const [paper, setPaper] = useState({ initialBalance: '100000', commission: '0', slippage: '0', leverage: '1' });
    const [draft, setDraft] = useState<Record<keyof Limits, string>>({
        maxOrderValue: limits.maxOrderValue === undefined ? '' : String(limits.maxOrderValue),
        maxOrdersPerDay: limits.maxOrdersPerDay === undefined ? '' : String(limits.maxOrdersPerDay),
        maxDailyLoss: limits.maxDailyLoss === undefined ? '' : String(limits.maxDailyLoss),
    });
    const [confirmReset, setConfirmReset] = useState(false);
    return (
        <div className="acct-settings" data-testid="trading-settings">
            <section>
                <h4>Orders</h4>
                <label className="check">
                    <input type="checkbox" checked={confirmOrders} onChange={(e) => setConfirm(e.target.checked)} />
                    Ask before sending orders from the chart and the depth ladder
                </label>
                <label className="check">
                    <input type="checkbox" checked={quickTrade} onChange={(e) => setQuickTrade(e.target.checked)} />
                    Show buy and sell buttons on the chart
                </label>
            </section>
            <section>
                <h4>Limits</h4>
                <p className="muted">Checked on every order, for every account. Leave a field empty for no limit.</p>
                <div className="grid-3">
                    {(
                        [
                            ['maxOrderValue', `Largest order (${account?.currency ?? ''})`],
                            ['maxOrdersPerDay', 'Orders per day'],
                            ['maxDailyLoss', `Daily loss that stops new positions (${account?.currency ?? ''})`],
                        ] as const
                    ).map(([key, label]) => (
                        <label key={key} className="field">
                            <span className="field-label">{label}</span>
                            <input
                                type="number"
                                min={0}
                                value={draft[key]}
                                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                            />
                        </label>
                    ))}
                </div>
                <Button
                    onClick={() =>
                        void saveLimits({
                            maxOrderValue: draft.maxOrderValue === '' ? undefined : Number(draft.maxOrderValue),
                            maxOrdersPerDay: draft.maxOrdersPerDay === '' ? undefined : Number(draft.maxOrdersPerDay),
                            maxDailyLoss: draft.maxDailyLoss === '' ? undefined : Number(draft.maxDailyLoss),
                        }).catch(() => {})
                    }
                >
                    Save limits
                </Button>
            </section>
            {account?.kind === 'paper' && (
                <section>
                    <h4>Paper account</h4>
                    <p className="muted">Starting again closes every position and clears the history.</p>
                    <div className="grid-3">
                        {(
                            [
                                ['initialBalance', 'Starting balance'],
                                ['commission', 'Commission (%)'],
                                ['slippage', 'Slippage (ticks)'],
                                ['leverage', 'Leverage (×)'],
                            ] as const
                        ).map(([key, label]) => (
                            <label key={key} className="field">
                                <span className="field-label">{label}</span>
                                <input
                                    type="number"
                                    min={0}
                                    value={paper[key]}
                                    onChange={(e) => setPaper({ ...paper, [key]: e.target.value })}
                                />
                            </label>
                        ))}
                    </div>
                    {confirmReset ? (
                        <div className="row">
                            <span>Close every position and start again?</span>
                            <Button
                                variant="danger"
                                onClick={() => {
                                    setConfirmReset(false);
                                    void resetPaper({
                                        initialBalance: Number(paper.initialBalance),
                                        commission: { type: 'percent', value: Number(paper.commission) },
                                        slippageTicks: Number(paper.slippage),
                                        leverage: Number(paper.leverage),
                                    }).catch(() => {});
                                }}
                                data-testid="reset-confirm"
                            >
                                Start again
                            </Button>
                            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
                                Keep it
                            </Button>
                        </div>
                    ) : (
                        <Button variant="danger" onClick={() => setConfirmReset(true)} data-testid="reset-paper">
                            Start the paper account again
                        </Button>
                    )}
                </section>
            )}
        </div>
    );
}
