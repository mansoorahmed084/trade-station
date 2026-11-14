import type { Bar, BarSeries } from '@ts/core';
import { ATR, Cross, EMA, Highest, Lowest, RSI, Supertrend } from '@ts/indicators';
import { BrokerEmulator, type BrokerOptions } from './broker.ts';
import type { TradeRecord } from './report.ts';

/**
 * Native strategies: plain TypeScript run against the broker emulator. They follow Pine's model so
 * a strategy reads the same in either language — the code runs once per closed bar, and what it
 * orders fills from the next bar on (or at this bar's close with `processOrdersOnClose`).
 */

export interface StrategyInput {
    name: string;
    title: string;
    type: 'int' | 'float' | 'bool';
    defval: number | boolean;
    min?: number;
    max?: number;
    step?: number;
}

export type QtySpec =
    | { type: 'fixed'; value: number }
    | { type: 'cash'; value: number }
    | { type: 'percent_of_equity'; value: number };

export interface StrategyApi {
    readonly bar: Bar;
    readonly index: number;
    /** Signed open position. */
    readonly position: number;
    readonly avgPrice: number;
    readonly equity: number;
    /** Open or add to a position. An opposite position is reversed, as `strategy.entry` does. */
    entry(
        id: string,
        direction: 'long' | 'short',
        opts?: { qty?: number; limit?: number; stop?: number; comment?: string },
    ): void;
    /**
     * Protective stop and/or profit target. With `from`, it belongs to that entry, as in
     * `strategy.exit(id, from_entry)`: while the entry is still waiting, the exit waits with it.
     */
    exit(id: string, opts: { from?: string; stop?: number; limit?: number; comment?: string }): void;
    /** Close the whole position at the market. */
    close(comment?: string): void;
    cancel(id: string): void;
    cancelAll(): void;
}

export interface NativeStrategy {
    id: string;
    name: string;
    description: string;
    inputs: StrategyInput[];
    /** Build the per-bar function for one run. State lives in its closure. */
    create(inputs: Record<string, number | boolean>): (api: StrategyApi) => void;
}

export interface BacktestOptions {
    broker?: Partial<BrokerOptions>;
    /** Size of each entry. Default: 10% of equity. */
    qty?: QtySpec;
    /** Quantity is rounded down to a multiple of this. */
    lotSize?: number;
    /** Maximum entries in one direction. Default 1. */
    pyramiding?: number;
    /** Fill market orders at the close of the bar that placed them instead of the next open. */
    processOrdersOnClose?: boolean;
    inputs?: Record<string, number | boolean>;
    /** Bar magnifier: the smaller bars inside a chart bar, when available. */
    intrabar?: (bar: Bar, index: number) => readonly Bar[] | undefined;
}

export interface BacktestRun {
    broker: BrokerEmulator;
    /** Closed trades, then whatever is still open marked to the last bar. */
    trades: TradeRecord[];
    inputs: Record<string, number | boolean>;
}

export function resolveInputs(
    strategy: NativeStrategy,
    given: Record<string, unknown> = {},
): Record<string, number | boolean> {
    const out: Record<string, number | boolean> = {};
    for (const input of strategy.inputs) {
        const raw = given[input.name] ?? given[input.title];
        if (input.type === 'bool')
            out[input.name] =
                raw === undefined ? (input.defval as boolean) : raw === true || raw === 'true' || raw === 1;
        else {
            let v = raw === undefined || raw === '' ? (input.defval as number) : Number(raw);
            if (!Number.isFinite(v)) v = input.defval as number;
            if (input.type === 'int') v = Math.round(v);
            if (input.min !== undefined) v = Math.max(input.min, v);
            if (input.max !== undefined) v = Math.min(input.max, v);
            out[input.name] = v;
        }
    }
    return out;
}

export function runBacktest(strategy: NativeStrategy, bars: BarSeries, options: BacktestOptions = {}): BacktestRun {
    const broker = new BrokerEmulator(options.broker);
    const inputs = resolveInputs(strategy, options.inputs);
    const onBar = strategy.create(inputs);
    const qtySpec = options.qty ?? { type: 'percent_of_equity', value: 10 };
    const pyramiding = Math.max(1, options.pyramiding ?? 1);
    const lot = options.lotSize ?? 0;
    /** Brackets asked for while their entry was still waiting. */
    const armed = new Map<string, { from?: string; stop?: number; limit?: number; comment?: string }>();

    // Sizing by money leaves room for the commission, as TradingView does: the cost of the position
    // including its entry commission equals the amount asked for.
    const commission = broker.options.commission;
    const feeRate = commission.type === 'percent' ? commission.value / 100 : 0;
    const size = (price: number): number => {
        const perUnit = price * (1 + feeRate);
        let qty =
            qtySpec.type === 'fixed'
                ? qtySpec.value
                : qtySpec.type === 'cash'
                  ? qtySpec.value / perUnit
                  : (broker.equity(price) * qtySpec.value) / 100 / perUnit;
        if (lot > 0) qty = Math.floor(qty / lot + 1e-9) * lot;
        return qty;
    };

    const bracket = (id: string, opts: { stop?: number; limit?: number; comment?: string }) => {
        const position = broker.position;
        const side = position > 0 ? 'sell' : 'buy';
        const qty = Math.abs(position);
        const group = `exit:${id}`;
        broker.cancel(`${id}:stop`);
        broker.cancel(`${id}:limit`);
        if (opts.stop !== undefined)
            broker.submit({
                id: `${id}:stop`,
                side,
                qty,
                type: 'stop',
                stop: opts.stop,
                reduceOnly: true,
                ocaGroup: group,
                comment: opts.comment,
            });
        if (opts.limit !== undefined)
            broker.submit({
                id: `${id}:limit`,
                side,
                qty,
                type: 'limit',
                limit: opts.limit,
                reduceOnly: true,
                ocaGroup: group,
                comment: opts.comment,
            });
    };

    let side = 0;
    broker.onFill = (_fill, order) => {
        const now = Math.sign(broker.position);
        if (now !== side) {
            // The position closed or flipped: its protective orders have nothing left to protect.
            for (const o of broker.pending()) if (o.reduceOnly) broker.cancel(o.id);
        }
        side = now;
        if (now === 0 || order.reduceOnly) return;
        // An entry filled: place the exits that were waiting for it.
        for (const [id, opts] of [...armed]) {
            if (opts.from && opts.from !== order.id) continue;
            armed.delete(id);
            bracket(id, opts);
        }
    };

    const api: StrategyApi & { bar: Bar; index: number } = {
        bar: undefined as unknown as Bar,
        index: -1,
        get position() {
            return broker.position;
        },
        get avgPrice() {
            return broker.avgPrice;
        },
        get equity() {
            return broker.equity();
        },
        entry(id, direction, opts = {}) {
            const sign = direction === 'long' ? 1 : -1;
            const position = broker.position;
            if (Math.sign(position) === sign && broker.openEntries >= pyramiding) return;
            const price = opts.limit ?? opts.stop ?? api.bar.close;
            let qty = opts.qty ?? size(price);
            if (!(qty > 0)) return;
            // An opposite position is closed by the same order: reverse in one fill.
            if (Math.sign(position) === -sign) qty += Math.abs(position);
            const type =
                opts.limit !== undefined && opts.stop !== undefined
                    ? 'stop_limit'
                    : opts.limit !== undefined
                      ? 'limit'
                      : opts.stop !== undefined
                        ? 'stop'
                        : 'market';
            broker.submit({
                id,
                side: sign === 1 ? 'buy' : 'sell',
                qty,
                type,
                limit: opts.limit,
                stop: opts.stop,
                comment: opts.comment,
            });
        },
        exit(id, opts) {
            const waiting = opts.from !== undefined && broker.orders.get(opts.from)?.status === 'pending';
            if (waiting || broker.position === 0) armed.set(id, opts);
            else bracket(id, opts);
        },
        close(comment) {
            const position = broker.position;
            armed.clear();
            if (position === 0) return;
            broker.submit({
                id: 'close',
                side: position > 0 ? 'sell' : 'buy',
                qty: Math.abs(position),
                type: 'market',
                reduceOnly: true,
                comment,
            });
        },
        cancel(id) {
            broker.cancel(id);
            broker.cancel(`${id}:stop`);
            broker.cancel(`${id}:limit`);
            armed.delete(id);
        },
        cancelAll() {
            broker.cancelAll();
            armed.clear();
        },
    };

    const n = bars.length;
    for (let i = 0; i < n; i++) {
        const bar: Bar = {
            time: bars.time[i],
            open: bars.open[i],
            high: bars.high[i],
            low: bars.low[i],
            close: bars.close[i],
            volume: bars.volume[i],
        };
        broker.processBar(bar, options.intrabar?.(bar, i));
        api.bar = bar;
        api.index = i;
        onBar(api);
        if (options.processOrdersOnClose) broker.processClose(bar.time);
    }

    const trades: TradeRecord[] = broker.trades.map((t) => ({
        side: t.side,
        qty: t.qty,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        entryId: t.entryId,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        exitId: t.exitId,
        pnl: t.pnl,
        commission: t.commission,
        maxRunup: t.maxRunup,
        maxDrawdown: t.maxDrawdown,
        open: false,
    }));
    if (broker.position !== 0 && n > 0) {
        const last = bars.close[n - 1];
        const side = broker.position > 0 ? 'long' : 'short';
        trades.push({
            side,
            qty: Math.abs(broker.position),
            entryTime: bars.time[n - 1],
            entryPrice: broker.avgPrice,
            pnl: broker.unrealized(last),
            commission: 0,
            open: true,
        });
    }
    return { broker, trades, inputs };
}

// ── Built-in strategies ─────────────────────────────────────────────────────

const num = (v: number | boolean) => Number(v);

export const STRATEGIES: NativeStrategy[] = [
    {
        id: 'ema-cross',
        name: 'EMA cross with ATR stop and target',
        description:
            'Buys when the fast EMA crosses above the slow one, with a stop and a target sized by ATR; closes on the opposite cross.',
        inputs: [
            { name: 'fast', title: 'Fast EMA', type: 'int', defval: 9, min: 1 },
            { name: 'slow', title: 'Slow EMA', type: 'int', defval: 21, min: 2 },
            { name: 'atrLength', title: 'ATR length', type: 'int', defval: 14, min: 1 },
            { name: 'stop', title: 'Stop (ATR)', type: 'float', defval: 2, min: 0.1, step: 0.1 },
            { name: 'target', title: 'Target (ATR)', type: 'float', defval: 3, min: 0.1, step: 0.1 },
            { name: 'short', title: 'Trade short side', type: 'bool', defval: false },
        ],
        create(inputs) {
            const fast = new EMA(num(inputs.fast));
            const slow = new EMA(num(inputs.slow));
            const atr = new ATR(num(inputs.atrLength));
            const cross = new Cross();
            return (s) => {
                const f = fast.push(s.bar.close);
                const sl = slow.push(s.bar.close);
                const a = atr.push(s.bar);
                const x = cross.push(f, sl);
                if (x.over) {
                    s.entry('Long', 'long');
                    s.exit('Long exit', {
                        from: 'Long',
                        stop: s.bar.close - num(inputs.stop) * a,
                        limit: s.bar.close + num(inputs.target) * a,
                    });
                }
                if (x.under) {
                    if (inputs.short) {
                        s.entry('Short', 'short');
                        s.exit('Short exit', {
                            from: 'Short',
                            stop: s.bar.close + num(inputs.stop) * a,
                            limit: s.bar.close - num(inputs.target) * a,
                        });
                    } else s.close('cross down');
                }
            };
        },
    },
    {
        id: 'donchian-breakout',
        name: 'Donchian breakout',
        description:
            'Buys a break of the highest high of the entry window with a stop order; exits at the lowest low of the exit window.',
        inputs: [
            { name: 'entry', title: 'Entry window', type: 'int', defval: 20, min: 2 },
            { name: 'exit', title: 'Exit window', type: 'int', defval: 10, min: 2 },
        ],
        create(inputs) {
            const high = new Highest(num(inputs.entry));
            const low = new Lowest(num(inputs.exit));
            return (s) => {
                const top = high.push(s.bar.high);
                const floor = low.push(s.bar.low);
                if (Number.isNaN(top) || Number.isNaN(floor)) return;
                if (s.position === 0) s.entry('Breakout', 'long', { stop: top });
                else s.exit('Trail', { stop: floor });
            };
        },
    },
    {
        id: 'rsi-reversion',
        name: 'RSI mean reversion',
        description: 'Buys when RSI falls below the oversold level and sells when it rises above the exit level.',
        inputs: [
            { name: 'length', title: 'RSI length', type: 'int', defval: 14, min: 2 },
            { name: 'oversold', title: 'Buy below', type: 'float', defval: 30, min: 1, max: 99 },
            { name: 'exit', title: 'Sell above', type: 'float', defval: 55, min: 1, max: 99 },
        ],
        create(inputs) {
            const rsi = new RSI(num(inputs.length));
            return (s) => {
                const r = rsi.push(s.bar.close);
                if (Number.isNaN(r)) return;
                if (s.position === 0 && r < num(inputs.oversold)) s.entry('Dip', 'long');
                else if (s.position > 0 && r > num(inputs.exit)) s.close('recovered');
            };
        },
    },
    {
        id: 'supertrend',
        name: 'Supertrend follower',
        description: 'Long while price is above the Supertrend line, flat otherwise.',
        inputs: [
            { name: 'factor', title: 'Factor', type: 'float', defval: 3, min: 0.5, step: 0.1 },
            { name: 'period', title: 'ATR length', type: 'int', defval: 10, min: 1 },
        ],
        create(inputs) {
            const st = new Supertrend(num(inputs.factor), num(inputs.period));
            let prev = Number.NaN;
            return (s) => {
                const { direction } = st.push(s.bar);
                if (direction < 0 && prev > 0) s.entry('Long', 'long');
                if (direction > 0 && prev < 0) s.close('trend turned');
                prev = direction;
            };
        },
    },
];

export const strategyById = (id: string): NativeStrategy | undefined => STRATEGIES.find((s) => s.id === id);
