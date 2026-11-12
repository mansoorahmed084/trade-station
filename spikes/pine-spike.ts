/**
 * Phase 0 spike: can PineTS run the Pine features our target scripts need, on the server, fast enough?
 * Run: node spikes/pine-spike.ts
 */
import { PineTS } from 'pinets';

interface Kline {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    closeTime: number;
}

async function fetchKlines(symbol: string, interval: string, total: number): Promise<Kline[]> {
    const out: Kline[] = [];
    let end: number | undefined;
    while (out.length < total) {
        const url = new URL('https://data-api.binance.vision/api/v3/klines');
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', interval);
        url.searchParams.set('limit', '1000');
        if (end) url.searchParams.set('endTime', String(end));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`klines ${res.status}`);
        const rows = (await res.json()) as any[][];
        if (!rows.length) break;
        const page = rows.map((r) => ({
            openTime: r[0],
            open: +r[1],
            high: +r[2],
            low: +r[3],
            close: +r[4],
            volume: +r[5],
            closeTime: r[6],
        }));
        out.unshift(...page);
        end = page[0].openTime - 1;
    }
    return out.slice(-total);
}

const scripts: Record<string, string> = {
    'EMA cross (v5)': `//@version=5
indicator("EMA Cross", overlay=true)
fast = ta.ema(close, input.int(9, "Fast"))
slow = ta.ema(close, input.int(21, "Slow"))
plot(fast, "Fast", color.blue)
plot(slow, "Slow", color.red)
plotshape(ta.crossover(fast, slow), "Up", shape.triangleup, location.belowbar, color.green)`,

    'RSI + MACD + BB (v6)': `//@version=6
indicator("Classic pack")
[m, s, h] = ta.macd(close, 12, 26, 9)
[mid, up, lo] = ta.bb(close, 20, 2.0)
plot(ta.rsi(close, 14), "RSI")
plot(m, "MACD")
plot(s, "Signal")
plot(h, "Hist", style=plot.style_histogram)
plot(up - lo, "BBWidth")
plot(ta.atr(14), "ATR")
plot(ta.stoch(close, high, low, 14), "Stoch")
plot(ta.vwma(close, 20), "VWMA")`,

    'Supertrend + DMI': `//@version=6
indicator("Supertrend", overlay=true)
[st, dir] = ta.supertrend(3.0, 10)
[dip, dim, adx] = ta.dmi(14, 14)
plot(st, "ST", color = dir < 0 ? color.green : color.red)
plot(adx, "ADX", display=display.data_window)`,

    'Structure: UDT, methods, arrays, boxes, lines, labels': `//@version=6
indicator("Structure zones", overlay=true, max_boxes_count=200, max_lines_count=200, max_labels_count=200)
len = input.int(10, "Pivot length")
type Zone
    float top
    float btm
    int   left
    bool  bull
    box   bx
method mitigated(Zone z, float c) =>
    z.bull ? c < z.btm : c > z.top
var array<Zone> zones = array.new<Zone>()
ph = ta.pivothigh(high, len, len)
pl = ta.pivotlow(low, len, len)
if not na(ph)
    z = Zone.new(ph, ph - ta.atr(14), bar_index - len, false)
    z.bx := box.new(z.left, z.top, bar_index, z.btm, bgcolor=color.new(color.red, 80), border_color=na)
    zones.push(z)
    label.new(bar_index - len, ph, "HH", style=label.style_label_down, color=color.red, textcolor=color.white)
if not na(pl)
    z = Zone.new(pl + ta.atr(14), pl, bar_index - len, true)
    z.bx := box.new(z.left, z.top, bar_index, z.btm, bgcolor=color.new(color.green, 80), border_color=na)
    zones.push(z)
    line.new(bar_index - len, pl, bar_index, pl, color=color.green, style=line.style_dashed)
if zones.size() > 0
    for i = zones.size() - 1 to 0
        z = zones.get(i)
        if z.mitigated(close)
            box.delete(z.bx)
            zones.remove(i)
        else
            box.set_right(z.bx, bar_index)
plot(zones.size(), "Active zones", display=display.data_window)`,

    'MTF dashboard: request.security + table': `//@version=6
indicator("MTF dashboard", overlay=true)
d = request.security(syminfo.tickerid, "D", ta.ema(close, 20))
h4 = request.security(syminfo.tickerid, "240", ta.rsi(close, 14))
var table t = table.new(position.top_right, 2, 2)
if barstate.islast
    table.cell(t, 0, 0, "D EMA20")
    table.cell(t, 1, 0, str.tostring(d, format.mintick))
    table.cell(t, 0, 1, "4h RSI")
    table.cell(t, 1, 1, str.tostring(h4, "#.0"))
plot(d, "Daily EMA")
plot(h4, "4h RSI", display=display.data_window)`,

    'Maps, matrices, enums, switch, while': `//@version=6
indicator("Collections")
enum Mode
    fast
    slow
mode = input.enum(Mode.fast, "Mode")
var map<string, float> stats = map.new<string, float>()
stats.put("hi", math.max(nz(stats.get("hi"), high), high))
m = matrix.new<float>(2, 2, 0.0)
m.set(0, 0, close)
m.set(1, 1, open)
len = switch mode
    Mode.fast => 5
    Mode.slow => 50
i = 0
acc = 0.0
while i < len
    acc += close[i]
    i += 1
plot(acc / len, "Manual SMA")
plot(stats.get("hi"), "All-time high")
plot(m.trace(), "Trace")`,

    'Strategy: EMA cross with stop and target': `//@version=6
strategy("EMA cross strat", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.1)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
atr = ta.atr(14)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
    strategy.exit("L-x", "L", stop=close - 2 * atr, limit=close + 3 * atr)
if ta.crossunder(fast, slow)
    strategy.close("L")
plot(strategy.equity, "Equity", display=display.data_window)`,

    'Alerts: alert() and alertcondition()': `//@version=6
indicator("Alerts")
r = ta.rsi(close, 14)
alertcondition(ta.crossunder(r, 30), "RSI oversold", "RSI crossed under 30 on {{ticker}}")
if ta.crossover(r, 70)
    alert("RSI overbought at " + str.tostring(close), alert.freq_once_per_bar_close)
plot(r)`,
};

function ema(values: number[], len: number): number[] {
    const k = 2 / (len + 1);
    const out: number[] = [];
    let prev = Number.NaN;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        if (i < len - 1) {
            sum += values[i];
            out.push(Number.NaN);
        } else if (i === len - 1) {
            sum += values[i];
            prev = sum / len;
            out.push(prev);
        } else {
            prev = values[i] * k + prev * (1 - k);
            out.push(prev);
        }
    }
    return out;
}

function rsi(values: number[], len: number): number[] {
    const out: number[] = [Number.NaN];
    let avgG = 0;
    let avgL = 0;
    for (let i = 1; i < values.length; i++) {
        const ch = values[i] - values[i - 1];
        const g = Math.max(ch, 0);
        const l = Math.max(-ch, 0);
        if (i <= len) {
            avgG += g / len;
            avgL += l / len;
            out.push(i === len ? 100 - 100 / (1 + avgG / avgL) : Number.NaN);
        } else {
            avgG = (avgG * (len - 1) + g) / len;
            avgL = (avgL * (len - 1) + l) / len;
            out.push(100 - 100 / (1 + avgG / avgL));
        }
    }
    return out;
}

function maxRelDiff(a: number[], b: number[], skip: number): number {
    let worst = 0;
    for (let i = skip; i < a.length; i++) {
        if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
        worst = Math.max(worst, Math.abs(a[i] - b[i]) / Math.max(1e-12, Math.abs(b[i])));
    }
    return worst;
}

const BARS = Number(process.argv[2] ?? 5000);
const klines = await fetchKlines('BTCUSDT', '1h', BARS);
console.log(`Loaded ${klines.length} 1h bars of BTCUSDT\n`);
const closes = klines.map((k) => k.close);

const TF_TO_BINANCE: Record<string, string> = { '60': '1h', '240': '4h', D: '1d', '1D': '1d', W: '1w', '1W': '1w' };
const seen: string[] = [];
const cache = new Map<string, Kline[]>();
/** A PineTS provider backed by our own fetch — the shape the server-side script host will use. */
const provider = {
    async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number) {
        seen.push(`${tickerId}@${timeframe} limit=${limit} s=${sDate} e=${eDate}`);
        if (timeframe === '60') return klines;
        const interval = TF_TO_BINANCE[timeframe];
        if (!interval) throw new Error(`spike provider: unmapped timeframe ${timeframe}`);
        if (!cache.has(interval)) cache.set(interval, await fetchKlines('BTCUSDT', interval, 1000));
        return cache.get(interval)!;
    },
    async getSymbolInfo(tickerId: string) {
        return {
            ticker: 'BTCUSDT',
            tickerid: 'BINANCE:BTCUSDT',
            prefix: 'BINANCE',
            description: 'Bitcoin / TetherUS',
            type: 'crypto',
            currency: 'USDT',
            basecurrency: 'BTC',
            timezone: 'Etc/UTC',
            session: '24x7',
            mintick: 0.01,
            minmove: 1,
            pricescale: 100,
            pointvalue: 1,
            mincontract: 0.00001,
            volumetype: 'base',
            root: 'BTC',
            main_tickerid: tickerId,
        } as any;
    },
    configure() {},
};

const rows: string[] = [];
for (const [name, source] of Object.entries(scripts)) {
    const t0 = performance.now();
    try {
        const pine = new PineTS(provider as any, 'BTCUSDT', '60', klines.length);
        pine.setAlertMode('all');
        const ctx: any = await pine.run(source);
        const ms = performance.now() - t0;
        const plotNames = Object.keys(ctx.plots ?? {});
        let note = `${plotNames.length} plots`;
        if (ctx.strategy) {
            const s = ctx.strategy;
            note += `, ${s.closedtrades.length} closed trades, net ${s.netprofit.toFixed(2)}`;
        }
        if (ctx.alerts?.length) note += `, ${ctx.alerts.length} alerts`;
        if (ctx.warnings?.length) note += `, ${ctx.warnings.length} warnings`;

        if (name.startsWith('EMA cross')) {
            const got = ctx.plots.Fast.data.map((d: any) => d.value);
            note += `, EMA9 max rel diff vs reference ${maxRelDiff(got, ema(closes, 9), 200).toExponential(1)}`;
        }
        if (name.startsWith('RSI')) {
            const got = ctx.plots.RSI.data.map((d: any) => d.value);
            note += `, RSI max rel diff vs reference ${maxRelDiff(got, rsi(closes, 14), 300).toExponential(1)}`;
        }
        rows.push(
            `OK    ${ms.toFixed(0).padStart(6)} ms  ${((ms / klines.length) * 1000).toFixed(1).padStart(7)} µs/bar  ${name} — ${note}`,
        );
    } catch (err: any) {
        const ms = performance.now() - t0;
        rows.push(
            `FAIL  ${ms.toFixed(0).padStart(6)} ms                  ${name} — ${String(err?.message ?? err).split('\n')[0]}`,
        );
    }
}
console.log(rows.join('\n'));
console.log('\nprovider calls:', [...new Set(seen)].join(' | '));
