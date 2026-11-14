import type {
    AccountState,
    Execution,
    ModifyOrderRequest,
    OrderState,
    PlaceOrderRequest,
    PositionState,
} from '@ts/oms/types';
import { create } from 'zustand';
import { useAlerts } from './alerts-store.ts';
import type { ServerClient } from './client.ts';

/** Server events on the `trading` topic. */
type TradingEvent =
    | { type: 'order'; accountId: string; order: OrderState }
    | { type: 'execution'; accountId: string; execution: Execution }
    | { type: 'position'; accountId: string; position: PositionState }
    | { type: 'account'; accountId: string; account: AccountState }
    | { type: 'reset'; accountId: string };

export interface Limits {
    maxOrderValue?: number;
    maxOrdersPerDay?: number;
    maxDailyLoss?: number;
}

/** What the order ticket holds between orders. */
export interface TicketState {
    side: 'buy' | 'sell';
    type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
    /** How the size is given: units, money, or the share of equity lost if the stop loss is hit. */
    sizing: 'units' | 'value' | 'risk';
    qty: string;
    value: string;
    riskPct: string;
    limit: string;
    stop: string;
    trail: string;
    tif: 'GTC' | 'DAY' | 'IOC';
    tpOn: boolean;
    tp: string;
    slOn: boolean;
    sl: string;
}

interface ConfirmRequest {
    title: string;
    lines: string[];
    danger?: boolean;
    resolve(ok: boolean): void;
}

interface TradingStore {
    ready: boolean;
    accounts: AccountState[];
    /** The account this screen is switched to. Orders from this screen can only reach this account. */
    accountId: string;
    account: AccountState | null;
    orders: Record<string, OrderState>;
    positions: Record<string, PositionState>;
    executions: Execution[];
    limits: Limits;
    /** Ask before sending an order from the chart or the ladder. */
    confirmOrders: boolean;
    /** Show the one-click buy and sell buttons over the chart. */
    quickTrade: boolean;
    ticket: TicketState;
    confirm: ConfirmRequest | null;
    setTicket(patch: Partial<TicketState>): void;
    setConfirmOrders(on: boolean): void;
    setQuickTrade(on: boolean): void;
}

const SAVED_KEY = 'ts.trading';
const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '{}') as {
            confirmOrders?: boolean;
            quickTrade?: boolean;
            ticket?: Partial<TicketState>;
        };
    } catch {
        return {};
    }
})();

const DEFAULT_TICKET: TicketState = {
    side: 'buy',
    type: 'market',
    sizing: 'units',
    qty: '1',
    value: '1000',
    riskPct: '1',
    limit: '',
    stop: '',
    trail: '',
    tif: 'GTC',
    tpOn: false,
    tp: '',
    slOn: false,
    sl: '',
};

export const useTrading = create<TradingStore>((set, get) => {
    const persist = () => {
        try {
            const { confirmOrders, quickTrade, ticket } = get();
            // Prices belong to one moment and one symbol: only the habits are kept.
            const { limit: _l, stop: _s, tp: _t, sl: _sl, ...habits } = ticket;
            localStorage.setItem(SAVED_KEY, JSON.stringify({ confirmOrders, quickTrade, ticket: habits }));
        } catch {}
    };
    return {
        ready: false,
        accounts: [],
        accountId: 'paper',
        account: null,
        orders: {},
        positions: {},
        executions: [],
        limits: {},
        confirmOrders: saved.confirmOrders ?? true,
        quickTrade: saved.quickTrade ?? true,
        ticket: { ...DEFAULT_TICKET, ...(saved.ticket ?? {}), limit: '', stop: '', tp: '', sl: '' },
        confirm: null,
        setTicket(patch) {
            set({ ticket: { ...get().ticket, ...patch } });
            persist();
        },
        setConfirmOrders(on) {
            set({ confirmOrders: on });
            persist();
        },
        setQuickTrade(on) {
            set({ quickTrade: on });
            persist();
        },
    };
});

let client: ServerClient | null = null;

/** Every request names the account this screen is switched to; the server refuses real-money orders that do not. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!client) throw new Error('not connected');
    return client.json<T>(path, {
        method,
        headers: {
            'x-ts-account': useTrading.getState().accountId,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const base = () => `/api/trading/${encodeURIComponent(useTrading.getState().accountId)}`;

export async function loadTrading(): Promise<void> {
    if (!client) return;
    const [accounts, state, limits] = await Promise.all([
        client.json<AccountState[]>('/api/trading/accounts'),
        call<{ account: AccountState; orders: OrderState[]; positions: PositionState[]; executions: Execution[] }>(
            'GET',
            base(),
        ),
        client.json<Limits>('/api/trading/limits'),
    ]);
    useTrading.setState({
        ready: true,
        accounts,
        account: state.account,
        orders: Object.fromEntries(state.orders.map((o) => [o.id, o])),
        positions: Object.fromEntries(state.positions.map((p) => [p.symbol, p])),
        executions: state.executions,
        limits,
    });
}

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });

function apply(event: TradingEvent): void {
    const s = useTrading.getState();
    if (event.accountId !== s.accountId) return;
    switch (event.type) {
        case 'order': {
            const before = s.orders[event.order.id];
            useTrading.setState({ orders: { ...s.orders, [event.order.id]: event.order } });
            const o = event.order;
            if (o.status === 'rejected' && before?.status !== 'rejected' && o.source !== 'api') {
                useAlerts.getState().toast({
                    kind: 'error',
                    title: 'Order rejected',
                    text: `${o.side} ${fmt(o.qty)} ${o.symbol}: ${o.reason ?? ''}`,
                });
            }
            return;
        }
        case 'execution': {
            const e = event.execution;
            useTrading.setState({ executions: [e, ...s.executions].slice(0, 500) });
            const pnl = e.realizedPnl
                ? ` · ${e.realizedPnl > 0 ? '+' : '−'}${fmt(Math.abs(Number(e.realizedPnl.toFixed(2))))}`
                : '';
            useAlerts.getState().toast(
                {
                    kind: 'info',
                    title: `${e.side === 'buy' ? 'Bought' : 'Sold'} ${fmt(e.qty)} ${e.symbol}`,
                    text: `at ${fmt(e.price)}${pnl}`,
                },
                4000,
            );
            return;
        }
        case 'position': {
            const positions = { ...s.positions };
            if (event.position.qty === 0) delete positions[event.position.symbol];
            else positions[event.position.symbol] = event.position;
            useTrading.setState({ positions });
            return;
        }
        case 'account':
            useTrading.setState({
                account: event.account,
                accounts: s.accounts.map((a) => (a.id === event.account.id ? event.account : a)),
            });
            return;
        case 'reset':
            void loadTrading();
            return;
    }
}

/** Connect the store to the server. Returns a function that disconnects it. */
export function bindTrading(c: ServerClient): () => void {
    client = c;
    void loadTrading().catch(() => {});
    const off = c.listen<TradingEvent>('trading', apply);
    // Events missed while the connection was down are recovered by reading the state again.
    let wasOpen = c.status === 'open';
    const offStatus = c.events.on('status', (status) => {
        if (status === 'open' && !wasOpen) void loadTrading().catch(() => {});
        wasOpen = status === 'open';
    });
    return () => {
        off();
        offStatus();
        client = null;
    };
}

/**
 * Switch this screen to another account. Every order from this screen then goes to that account
 * only. Not remembered: each page starts on the paper account, so trading real money is always
 * a choice made in the session.
 */
export async function switchAccount(id: string): Promise<void> {
    const target = useTrading.getState().accounts.find((a) => a.id === id);
    if (!target) return;
    if (target.kind === 'live') {
        const ok = await askToConfirm(
            'Switch to a live account?',
            [`Orders from this screen will go to ${target.name}, with real money.`],
            true,
        );
        if (!ok) return;
    }
    useTrading.setState({ accountId: id, orders: {}, positions: {}, executions: [], account: target });
    await loadTrading();
}

/** Ask the user; resolves false when they decline. */
export function askToConfirm(title: string, lines: string[], danger = false): Promise<boolean> {
    return new Promise((resolve) => {
        useTrading.setState({
            confirm: {
                title,
                lines,
                danger,
                resolve: (ok) => {
                    useTrading.setState({ confirm: null });
                    resolve(ok);
                },
            },
        });
    });
}

function failed(err: unknown, title: string): never {
    const message = String((err as Error)?.message ?? err);
    useAlerts.getState().toast({ kind: 'error', title, text: message });
    throw err;
}

/** Describe an order for a confirmation or a toast: `Buy 0.5 BTCUSDT limit 64,000`. */
export function describeOrder(
    o: Pick<PlaceOrderRequest, 'side' | 'type' | 'qty' | 'limit' | 'stop' | 'trailDistance' | 'symbol'>,
): string {
    const type = o.type.replace('_', '-');
    const price =
        o.type === 'limit'
            ? ` at ${fmt(o.limit!)}`
            : o.type === 'stop'
              ? ` at ${fmt(o.stop!)}`
              : o.type === 'stop_limit'
                ? ` stop ${fmt(o.stop!)} limit ${fmt(o.limit!)}`
                : o.type === 'trailing_stop'
                  ? ` trailing ${fmt(o.trailDistance!)}`
                  : '';
    return `${o.side === 'buy' ? 'Buy' : 'Sell'} ${fmt(o.qty)} ${o.symbol.replace(/^[A-Z]+:/, '')} ${type}${price}`;
}

/**
 * Send an order. With `ask` (orders from the chart or the ladder), the user confirms it first when
 * confirmations are on. Resolves to null when the user declined.
 */
export async function placeOrder(request: PlaceOrderRequest, ask = false): Promise<OrderState | null> {
    const s = useTrading.getState();
    if (ask && s.confirmOrders) {
        const lines = [describeOrder(request)];
        if (request.bracket?.takeProfit !== undefined) lines.push(`Take profit at ${fmt(request.bracket.takeProfit)}`);
        if (request.bracket?.stopLoss !== undefined) lines.push(`Stop loss at ${fmt(request.bracket.stopLoss)}`);
        lines.push(`Account: ${s.account?.name ?? s.accountId}`);
        if (!(await askToConfirm('Send this order?', lines))) return null;
    }
    try {
        return await call<OrderState>('POST', `${base()}/orders`, request);
    } catch (err) {
        return failed(err, 'Order not placed');
    }
}

export async function modifyOrder(id: string, changes: ModifyOrderRequest): Promise<OrderState> {
    try {
        return await call<OrderState>('PATCH', `${base()}/orders/${encodeURIComponent(id)}`, changes);
    } catch (err) {
        return failed(err, 'Order not changed');
    }
}

export async function cancelOrder(id: string): Promise<OrderState> {
    try {
        return await call<OrderState>('DELETE', `${base()}/orders/${encodeURIComponent(id)}`);
    } catch (err) {
        return failed(err, 'Order not cancelled');
    }
}

export async function cancelAll(symbol?: string): Promise<number> {
    try {
        return (await call<{ cancelled: number }>('POST', `${base()}/orders/cancel-all`, { symbol })).cancelled;
    } catch (err) {
        return failed(err, 'Orders not cancelled');
    }
}

export async function closePosition(symbol: string, qty?: number, ask = false): Promise<OrderState | null> {
    const p = useTrading.getState().positions[symbol];
    if (ask && useTrading.getState().confirmOrders && p) {
        const size = qty ?? Math.abs(p.qty);
        if (
            !(await askToConfirm('Close the position?', [
                `${p.qty > 0 ? 'Sell' : 'Buy'} ${fmt(size)} ${symbol} at the market`,
            ]))
        )
            return null;
    }
    try {
        return await call<OrderState>('POST', `${base()}/positions/close`, { symbol, qty });
    } catch (err) {
        return failed(err, 'Position not closed');
    }
}

export async function reversePosition(symbol: string, ask = false): Promise<OrderState | null> {
    const p = useTrading.getState().positions[symbol];
    if (ask && useTrading.getState().confirmOrders && p) {
        const lines = [
            `${p.qty > 0 ? 'Sell' : 'Buy'} ${fmt(Math.abs(p.qty) * 2)} ${symbol} at the market`,
            `The position becomes ${p.qty > 0 ? 'short' : 'long'} ${fmt(Math.abs(p.qty))}`,
        ];
        if (!(await askToConfirm('Reverse the position?', lines))) return null;
    }
    try {
        return await call<OrderState>('POST', `${base()}/positions/reverse`, { symbol });
    } catch (err) {
        return failed(err, 'Position not reversed');
    }
}

export async function setPositionBrackets(
    symbol: string,
    brackets: { takeProfit?: number | null; stopLoss?: number | null },
): Promise<PositionState> {
    try {
        return await call<PositionState>('PUT', `${base()}/positions/brackets`, { symbol, ...brackets });
    } catch (err) {
        return failed(err, 'Protection not changed');
    }
}

export async function resetPaper(settings: Record<string, unknown>): Promise<void> {
    if (!client) return;
    try {
        await client.post('/api/trading/paper/reset', settings);
        await loadTrading();
    } catch (err) {
        failed(err, 'Paper account not reset');
    }
}

export async function saveLimits(limits: Limits): Promise<void> {
    if (!client) return;
    try {
        const saved = await client.post<Limits>('/api/trading/limits', limits, 'PUT');
        useTrading.setState({ limits: saved });
    } catch (err) {
        failed(err, 'Limits not saved');
    }
}

/** The latest price of a symbol: from the account's position when it holds one, else from the server. */
export async function lastPrice(symbol: string): Promise<number | undefined> {
    const held = useTrading.getState().positions[symbol]?.lastPrice;
    if (held !== null && held !== undefined) return held;
    if (!client) return undefined;
    try {
        const [row] = await client.json<{ last?: number }[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`);
        return row?.last;
    } catch {
        return undefined;
    }
}

/** Working and waiting orders of one symbol (or all). */
export function openOrders(orders: Record<string, OrderState>, symbol?: string): OrderState[] {
    return Object.values(orders)
        .filter((o) => (o.status === 'working' || o.status === 'inactive') && (!symbol || o.symbol === symbol))
        .sort((a, b) => b.createdAt - a.createdAt);
}
