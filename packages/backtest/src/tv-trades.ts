import type { TradeRecord } from './report.ts';

/**
 * Reading TradingView's "List of trades" export and lining it up against one of our runs. This is
 * how parity with TradingView is checked: run the same strategy over the same bars in both, export
 * the list there, and compare. No Node dependencies: the app uses it too.
 */

export interface TvTrade {
    number: number;
    side: 'long' | 'short';
    entryTime: number;
    entryPrice: number;
    exitTime?: number;
    exitPrice?: number;
    qty: number;
    /** Net profit as TradingView reports it. */
    profit?: number;
    open: boolean;
}

/** Split one CSV line, honouring quoted fields. */
function splitCsv(line: string): string[] {
    const out: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',' || ch === '\t' || ch === ';') {
            out.push(cell);
            cell = '';
        } else cell += ch;
    }
    out.push(cell);
    return out.map((c) => c.trim());
}

const number = (text: string | undefined): number | undefined => {
    if (text === undefined) return undefined;
    // TradingView writes a real minus sign and may group thousands with a narrow space.
    const cleaned = text.replace(/[−‒–]/g, '-').replace(/[\s  ]/g, '');
    if (cleaned === '') return undefined;
    const value = Number(cleaned);
    return Number.isFinite(value) ? value : undefined;
};

/** `2024-03-05 14:30` (or with seconds, or a `T`) as a UTC timestamp, shifted by the export's time zone. */
function parseTime(text: string, utcOffsetMinutes: number): number | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text.trim());
    if (!m) return undefined;
    const [, y, mo, d, h, mi, sec] = m;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec ?? 0)) - utcOffsetMinutes * 60_000;
}

/**
 * Parse a "List of trades" export. Both layouts TradingView has used are read: the columns are
 * found by name, and the entry and exit rows of a trade may come in either order.
 * `utcOffsetMinutes` is the chart's time zone when it was exported (0 for UTC).
 */
export function parseTvTrades(csv: string, options: { utcOffsetMinutes?: number } = {}): TvTrade[] {
    const offset = options.utcOffsetMinutes ?? 0;
    const lines = csv
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '');
    if (lines.length < 2) return [];
    const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
    const find = (test: (h: string) => boolean) => header.findIndex(test);
    const col = {
        number: find((h) => /^trade\s*(#|number|no)/.test(h)),
        type: find((h) => h === 'type'),
        time: find((h) => h.startsWith('date')),
        price: find((h) => h.startsWith('price')),
        qty: find((h) => h.startsWith('contracts') || /^(position size \(qty\)|qty|quantity|size)/.test(h)),
        profit: find((h) => /^(profit|net p&l|net pnl|p&l)/.test(h) && !h.includes('%')),
    };
    if (col.number < 0 || col.type < 0 || col.time < 0 || col.price < 0) {
        throw new Error(
            'this is not a TradingView "List of trades" export: the Trade #, Type, Date/Time or Price column is missing',
        );
    }
    const trades = new Map<number, TvTrade>();
    for (const line of lines.slice(1)) {
        const cells = splitCsv(line);
        const id = number(cells[col.number]);
        const type = (cells[col.type] ?? '').toLowerCase();
        if (id === undefined || !/entry|exit/.test(type)) continue;
        let trade = trades.get(id);
        if (!trade) {
            trade = {
                number: id,
                side: type.includes('short') ? 'short' : 'long',
                entryTime: 0,
                entryPrice: 0,
                qty: 0,
                open: true,
            };
            trades.set(id, trade);
        }
        const time = parseTime(cells[col.time] ?? '', offset);
        const price = number(cells[col.price]);
        const qty = col.qty >= 0 ? number(cells[col.qty]) : undefined;
        if (qty !== undefined) trade.qty = Math.abs(qty);
        if (type.includes('entry')) {
            trade.side = type.includes('short') ? 'short' : 'long';
            if (time !== undefined) trade.entryTime = time;
            if (price !== undefined) trade.entryPrice = price;
        } else {
            // A position still open is exported with an exit row that has no fill behind it.
            const signal = cells.join(' ').toLowerCase();
            if (time !== undefined && price !== undefined && !/\bopen\b/.test(signal)) {
                trade.exitTime = time;
                trade.exitPrice = price;
                trade.open = false;
            }
            const profit = col.profit >= 0 ? number(cells[col.profit]) : undefined;
            if (profit !== undefined) trade.profit = profit;
        }
    }
    return [...trades.values()]
        .filter((t) => t.entryTime > 0)
        .sort((a, b) => a.entryTime - b.entryTime || a.number - b.number);
}

export interface TradeMismatch {
    number: number;
    field: 'entry price' | 'exit price' | 'exit time' | 'quantity' | 'profit';
    ours: number;
    theirs: number;
}

export interface TradeComparison {
    ours: number;
    theirs: number;
    /** Trades found in both lists: same side, entered within one bar of each other. */
    matched: number;
    /** Matched trades whose prices, exit time and quantity all agree within tolerance. */
    identical: number;
    /** In TradingView's list but not ours, and the other way round. */
    missing: TvTrade[];
    extra: TradeRecord[];
    mismatches: TradeMismatch[];
    /** Largest relative difference between a matched pair of prices. */
    maxPriceDiffPct: number;
    netProfit: { ours: number; theirs: number; diffPct: number | null };
    /** `identical ÷ max(ours, theirs)`, as a percentage. */
    agreementPct: number;
}

/**
 * Line our trades up with TradingView's. Closed trades only. Prices agree when they are within
 * `priceTolerance` of each other relatively (default 0.01%), quantities within `qtyTolerance`
 * (default 0.1%, since the two round order size differently) and profit within `profitTolerance`
 * (default 1%).
 */
export function compareTrades(
    ours: TradeRecord[],
    theirs: TvTrade[],
    options: { barMs: number; priceTolerance?: number; qtyTolerance?: number; profitTolerance?: number },
): TradeComparison {
    const priceTol = options.priceTolerance ?? 1e-4;
    const qtyTol = options.qtyTolerance ?? 1e-3;
    const profitTol = options.profitTolerance ?? 1e-2;
    const mine = ours.filter((t) => !t.open).sort((a, b) => a.entryTime - b.entryTime);
    const tv = theirs.filter((t) => !t.open);
    const used = new Set<number>();
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
    const result: TradeComparison = {
        ours: mine.length,
        theirs: tv.length,
        matched: 0,
        identical: 0,
        missing: [],
        extra: [],
        mismatches: [],
        maxPriceDiffPct: 0,
        netProfit: { ours: 0, theirs: 0, diffPct: null },
        agreementPct: 0,
    };
    let cursor = 0;
    for (const t of tv) {
        // Both lists are in entry order: look near where the last match was found.
        while (cursor < mine.length && mine[cursor].entryTime < t.entryTime - options.barMs) cursor++;
        let hit = -1;
        for (let i = cursor; i < mine.length && mine[i].entryTime <= t.entryTime + options.barMs; i++) {
            if (!used.has(i) && mine[i].side === t.side) {
                hit = i;
                break;
            }
        }
        if (hit < 0) {
            result.missing.push(t);
            continue;
        }
        used.add(hit);
        result.matched++;
        const m = mine[hit];
        const before = result.mismatches.length;
        const price = (field: TradeMismatch['field'], a: number | undefined, b: number | undefined) => {
            if (a === undefined || b === undefined) return;
            const d = rel(a, b);
            result.maxPriceDiffPct = Math.max(result.maxPriceDiffPct, d * 100);
            if (d > priceTol) result.mismatches.push({ number: t.number, field, ours: a, theirs: b });
        };
        price('entry price', m.entryPrice, t.entryPrice);
        price('exit price', m.exitPrice, t.exitPrice);
        if (m.exitTime !== undefined && t.exitTime !== undefined && Math.abs(m.exitTime - t.exitTime) > options.barMs) {
            result.mismatches.push({ number: t.number, field: 'exit time', ours: m.exitTime, theirs: t.exitTime });
        }
        if (t.qty > 0 && rel(m.qty, t.qty) > qtyTol) {
            result.mismatches.push({ number: t.number, field: 'quantity', ours: m.qty, theirs: t.qty });
        }
        if (result.mismatches.length === before) result.identical++;
        // Profit is reported but does not break a match: it follows from price, size and commission.
        if (t.profit !== undefined && Math.abs(m.pnl - t.profit) > Math.max(profitTol * Math.abs(t.profit), 0.01)) {
            result.mismatches.push({ number: t.number, field: 'profit', ours: m.pnl, theirs: t.profit });
        }
    }
    for (const [i, m] of mine.entries()) if (!used.has(i)) result.extra.push(m);
    result.netProfit.ours = mine.reduce((a, t) => a + t.pnl, 0);
    result.netProfit.theirs = tv.reduce((a, t) => a + (t.profit ?? 0), 0);
    if (result.netProfit.theirs !== 0) {
        result.netProfit.diffPct =
            ((result.netProfit.ours - result.netProfit.theirs) / Math.abs(result.netProfit.theirs)) * 100;
    }
    const most = Math.max(mine.length, tv.length);
    result.agreementPct = most ? (result.identical / most) * 100 : 100;
    return result;
}

/** Our trades in TradingView's export layout, for a spreadsheet or for comparing two of our own runs. */
export function tradesToCsv(trades: TradeRecord[]): string {
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    const rows = ['Trade #,Type,Signal,Date/Time,Price,Contracts,Profit,Run-up,Drawdown'];
    trades.forEach((t, i) => {
        const side = t.side === 'long' ? 'long' : 'short';
        rows.push(`${i + 1},Entry ${side},${t.entryId ?? ''},${stamp(t.entryTime)},${t.entryPrice},${t.qty},,,`);
        if (t.open || t.exitTime === undefined) rows.push(`${i + 1},Exit ${side},Open,,,${t.qty},${t.pnl},,`);
        else {
            rows.push(
                `${i + 1},Exit ${side},${(t.exitId ?? '').replace(/,/g, ' ')},${stamp(t.exitTime)},${t.exitPrice},${t.qty},${t.pnl},${t.maxRunup ?? ''},${t.maxDrawdown ?? ''}`,
            );
        }
    });
    return `${rows.join('\n')}\n`;
}
