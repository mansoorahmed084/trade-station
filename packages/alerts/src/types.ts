/**
 * The alert model. Everything here is plain data, shared by the server and the web app.
 */

export type PriceField = 'close' | 'open' | 'high' | 'low' | 'volume' | 'hl2' | 'hlc3' | 'ohlc4';

export type StudyId =
    | 'sma'
    | 'ema'
    | 'rma'
    | 'wma'
    | 'vwma'
    | 'rsi'
    | 'macd'
    | 'bb'
    | 'stdev'
    | 'atr'
    | 'stoch'
    | 'cci'
    | 'roc'
    | 'supertrend'
    | 'dmi'
    | 'donchian'
    | 'highest'
    | 'lowest'
    | 'obv'
    | 'vwap';

export interface Point {
    time: number;
    price: number;
}

/** One side of a comparison. */
export type Operand =
    /** A field of the alert's own symbol and timeframe. Default field: close. */
    | { type: 'price'; field?: PriceField }
    /** A fixed number. */
    | { type: 'value'; value: number }
    /** A built-in indicator computed natively. `output` picks one line of a multi-line study. */
    | { type: 'indicator'; study: StudyId; params?: Record<string, number>; output?: string; source?: PriceField }
    /** A line drawn on the chart: a trend line, ray or horizontal line, with the anchors it had when the alert was saved. */
    | { type: 'line'; a: Point; b: Point; extend: 'none' | 'left' | 'right' | 'both'; drawingId?: string }
    /** A plot of a Pine script, computed on the server. */
    | { type: 'plot'; scriptId?: string; source?: string; plot: string; inputs?: Record<string, unknown> };

export type Operator =
    | 'crossing'
    | 'crossing_up'
    | 'crossing_down'
    | 'greater'
    | 'less'
    | 'entering_channel'
    | 'exiting_channel'
    | 'inside_channel'
    | 'outside_channel'
    | 'moving_up'
    | 'moving_down'
    | 'moving_up_pct'
    | 'moving_down_pct';

export interface Comparison {
    left: Operand;
    op: Operator;
    /** The level or series compared against, for crossing / greater / less. */
    right?: Operand;
    /** Channel bounds, for the four channel operators. */
    upper?: Operand;
    lower?: Operand;
    /** Size of the move, for the moving operators: price units, or percent for the `_pct` forms. */
    amount?: number;
    /** Window of the move in bars. Default 1. */
    bars?: number;
}

/** Fires when a script calls `alert()`, or when one of its `alertcondition()`s is true. */
export interface ScriptAlertCondition {
    scriptAlert: { scriptId?: string; source?: string; inputs?: Record<string, unknown>; title?: string };
}

export type Condition = Comparison | ScriptAlertCondition | { all: Condition[] } | { any: Condition[] };

/**
 * `once`                the first time the condition is met, then the alert stops
 * `once_per_bar`        at most once per bar, the moment it is met
 * `once_per_bar_close`  only when a bar closes with the condition met
 * `every_time`          every time it becomes met (and again after the cooldown while it stays met)
 */
export type Frequency = 'once' | 'once_per_bar' | 'once_per_bar_close' | 'every_time';

export interface NotifyTargets {
    /** Toast in the app (and a desktop notification when the browser allows it). */
    app?: boolean;
    sound?: boolean;
    /** POST the alert as JSON to this URL. With a secret, the body is signed (HMAC-SHA256, `X-Signature`). */
    webhook?: { url: string; secret?: string };
    /** Telegram chat id. The bot token comes from the server's TS_TELEGRAM_TOKEN. */
    telegram?: { chatId: string };
    /** Discord channel webhook URL. */
    discord?: { url: string };
    /** Recipient address. The mail server comes from the server's TS_SMTP_URL. */
    email?: { to: string };
}

export interface AlertState {
    /** Open time of the last closed bar evaluated, per symbol. Lets a restart replay what it missed. */
    lastBarTime: Record<string, number>;
    /** Open time of the bar the alert last fired on, per symbol. */
    lastFiredBar: Record<string, number>;
    lastFiredAt: number | null;
    fireCount: number;
    /** Symbols on which a `once` alert has already fired. */
    done: string[];
}

export interface Alert {
    id: string;
    name: string;
    /** The symbols watched: one for an ordinary alert, many for a watchlist alert. */
    symbols: string[];
    timeframe: string;
    condition: Condition;
    frequency: Frequency;
    /** Minimum time between two fires on the same symbol. Default 0. */
    cooldownMs: number;
    /** Stop at this time. `null`: never expires. */
    expiresAt: number | null;
    /** Message template; `{{ticker}}`, `{{close}}`, `{{time}}` and friends are filled in when it fires. */
    message: string;
    notify: NotifyTargets;
    active: boolean;
    createdAt: number;
    updatedAt: number;
    state: AlertState;
}

/** What a client sends to create or change an alert. */
export type AlertInput = Partial<Omit<Alert, 'id' | 'createdAt' | 'updatedAt' | 'state'>>;

export interface Delivery {
    channel: 'app' | 'webhook' | 'telegram' | 'discord' | 'email';
    ok: boolean;
    detail?: string;
}

export interface AlertEvent {
    id: string;
    alertId: string;
    alertName: string;
    symbol: string;
    timeframe: string;
    /** When it fired. */
    time: number;
    /** Open time of the bar it fired on. */
    barTime: number;
    /** Close (last price) at the moment it fired. */
    price: number;
    message: string;
    /** True when the fire was found while replaying bars missed during downtime. */
    late: boolean;
    sound: boolean;
    deliveries: Delivery[];
}

export const emptyState = (): AlertState => ({
    lastBarTime: {},
    lastFiredBar: {},
    lastFiredAt: null,
    fireCount: 0,
    done: [],
});

export const isComparison = (c: Condition): c is Comparison => 'op' in c;
export const isScriptAlert = (c: Condition): c is ScriptAlertCondition => 'scriptAlert' in c;
