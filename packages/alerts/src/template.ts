import { type Bar, decimalsOf, timeframeLabel } from '@ts/core';
import { type Comparison, type Condition, isComparison, isScriptAlert, type Operand, type Operator } from './types.ts';

export interface MessageContext {
    alertName: string;
    /** `PROVIDER:TICKER`. */
    symbol: string;
    timeframe: string;
    bar: Bar;
    /** When the alert fired (epoch ms). */
    now: number;
    tickSize: number;
    /** Operand values of the first comparison at the moment it fired. */
    left?: number;
    right?: number;
    /** Script plot values by title, when the condition uses a script. */
    plots?: Record<string, number>;
}

const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');

/**
 * Fill `{{placeholders}}` in an alert message. The names follow TradingView's where one exists
 * (`{{ticker}}`, `{{exchange}}`, `{{interval}}`, `{{open}}` … `{{volume}}`, `{{time}}`, `{{timenow}}`,
 * `{{plot("Title")}}`). Unknown placeholders are left untouched so a typo stays visible.
 */
export function renderMessage(template: string, ctx: MessageContext): string {
    const colon = ctx.symbol.indexOf(':');
    const price = (v: number | undefined) =>
        v === undefined || Number.isNaN(v) ? 'n/a' : v.toFixed(decimalsOf(ctx.tickSize));
    const number = (v: number | undefined) =>
        v === undefined || Number.isNaN(v) ? 'n/a' : String(Number(v.toPrecision(10)));
    const fixed: Record<string, string> = {
        ticker: colon >= 0 ? ctx.symbol.slice(colon + 1) : ctx.symbol,
        symbol: ctx.symbol,
        exchange: colon >= 0 ? ctx.symbol.slice(0, colon) : '',
        interval: ctx.timeframe,
        interval_label: timeframeLabel(ctx.timeframe),
        open: price(ctx.bar.open),
        high: price(ctx.bar.high),
        low: price(ctx.bar.low),
        close: price(ctx.bar.close),
        price: price(ctx.bar.close),
        volume: number(ctx.bar.volume),
        time: iso(ctx.bar.time),
        timenow: iso(ctx.now),
        alert_name: ctx.alertName,
        left: number(ctx.left),
        right: number(ctx.right),
    };
    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, raw: string) => {
        const plot = /^plot\(\s*["'](.+)["']\s*\)$/.exec(raw);
        if (plot) return ctx.plots && plot[1] in ctx.plots ? number(ctx.plots[plot[1]]) : whole;
        return raw in fixed ? fixed[raw] : whole;
    });
}

const OPERATOR_TEXT: Record<Operator, string> = {
    crossing: 'crossing',
    crossing_up: 'crossing up',
    crossing_down: 'crossing down',
    greater: 'greater than',
    less: 'less than',
    entering_channel: 'entering channel',
    exiting_channel: 'exiting channel',
    inside_channel: 'inside channel',
    outside_channel: 'outside channel',
    moving_up: 'moving up',
    moving_down: 'moving down',
    moving_up_pct: 'moving up %',
    moving_down_pct: 'moving down %',
};

const PRICE_TEXT: Record<string, string> = {
    close: 'Price',
    open: 'Open',
    high: 'High',
    low: 'Low',
    volume: 'Volume',
    hl2: 'HL2',
    hlc3: 'HLC3',
    ohlc4: 'OHLC4',
};

export function describeOperand(op: Operand | undefined): string {
    if (!op) return '?';
    switch (op.type) {
        case 'price':
            return PRICE_TEXT[op.field ?? 'close'];
        case 'value':
            return String(op.value);
        case 'indicator': {
            const params = Object.values(op.params ?? {}).join(', ');
            return `${op.study.toUpperCase()}${params ? `(${params})` : ''}${op.output ? ` ${op.output}` : ''}`;
        }
        case 'line':
            return op.a.price === op.b.price ? `line at ${op.a.price}` : 'trend line';
        case 'plot':
            return `plot "${op.plot}"`;
    }
}

function describeComparison(c: Comparison): string {
    const left = describeOperand(c.left);
    const verb = OPERATOR_TEXT[c.op];
    if (c.op.includes('channel')) return `${left} ${verb} ${describeOperand(c.lower)} – ${describeOperand(c.upper)}`;
    if (c.op.startsWith('moving'))
        return `${left} ${verb.replace(' %', '')} ${c.amount ?? 0}${c.op.endsWith('_pct') ? '%' : ''} in ${c.bars ?? 1} bar${(c.bars ?? 1) === 1 ? '' : 's'}`;
    return `${left} ${verb} ${describeOperand(c.right)}`;
}

/** A one-line, human description of a condition: "Price crossing 70000", "RSI(14) greater than 70 and …". */
export function describeCondition(condition: Condition): string {
    if (isComparison(condition)) return describeComparison(condition);
    if (isScriptAlert(condition))
        return condition.scriptAlert.title
            ? `script alert "${condition.scriptAlert.title}"`
            : 'any alert() call of the script';
    const all = 'all' in condition;
    const parts = (all ? condition.all : (condition as { any: Condition[] }).any).map((c) => {
        const text = describeCondition(c);
        return isComparison(c) || isScriptAlert(c) ? text : `(${text})`;
    });
    return parts.join(all ? ' and ' : ' or ') || 'no condition';
}

/** The message used when an alert is saved without one. */
export const DEFAULT_MESSAGE = '{{alert_name}}: {{ticker}} at {{close}}';
