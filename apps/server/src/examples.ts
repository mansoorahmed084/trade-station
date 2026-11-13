/**
 * Example scripts seeded into an empty library. All original to this project, so there is nothing to
 * attribute; they exist to show what the editor, alerts and strategy tester can do.
 */
export interface ExampleScript {
    id: string;
    name: string;
    source: string;
}

export const EXAMPLES: ExampleScript[] = [
    {
        id: 'example-ema-ribbon',
        name: 'EMA Ribbon',
        source: `//@version=6
indicator("EMA Ribbon", overlay=true)
base = input.int(8, "Fastest length", minval=2)
step = input.int(6, "Step between lines", minval=1)
src = input.source(close, "Source")

e1 = ta.ema(src, base)
e2 = ta.ema(src, base + step)
e3 = ta.ema(src, base + step * 2)
e4 = ta.ema(src, base + step * 3)
e5 = ta.ema(src, base + step * 4)
bull = e1 > e5
c = bull ? color.new(color.teal, 0) : color.new(color.red, 0)

p1 = plot(e1, "EMA 1", color=c)
plot(e2, "EMA 2", color=color.new(c, 30))
plot(e3, "EMA 3", color=color.new(c, 50))
plot(e4, "EMA 4", color=color.new(c, 65))
p5 = plot(e5, "EMA 5", color=color.new(c, 80))
fill(p1, p5, color=color.new(c, 88))

alertcondition(ta.crossover(e1, e5), "Ribbon turned up", "{{ticker}}: EMA ribbon turned up")
alertcondition(ta.crossunder(e1, e5), "Ribbon turned down", "{{ticker}}: EMA ribbon turned down")
`,
    },
    {
        id: 'example-rsi-bands',
        name: 'RSI with Bands and Alerts',
        source: `//@version=6
indicator("RSI with Bands and Alerts")
len = input.int(14, "RSI length", minval=1)
ob = input.int(70, "Overbought", minval=50, maxval=100)
os = input.int(30, "Oversold", minval=0, maxval=50)
smooth = input.int(9, "Signal length", minval=1)

r = ta.rsi(close, len)
sig = ta.sma(r, smooth)

hline(ob, "Overbought", color=color.new(color.red, 50))
hline(50, "Middle", color=color.new(color.gray, 70))
hline(os, "Oversold", color=color.new(color.teal, 50))
plot(r, "RSI", color=r > ob ? color.red : r < os ? color.teal : color.purple, linewidth=2)
plot(sig, "Signal", color=color.orange)
bgcolor(r > ob ? color.new(color.red, 92) : r < os ? color.new(color.teal, 92) : na)

alertcondition(ta.crossunder(r, os), "RSI entered oversold", "{{ticker}} RSI crossed below the oversold level")
alertcondition(ta.crossover(r, ob), "RSI entered overbought", "{{ticker}} RSI crossed above the overbought level")
if ta.crossover(r, sig) and r < os
    alert("RSI turning up from oversold at " + str.tostring(close, format.mintick), alert.freq_once_per_bar_close)
`,
    },
    {
        id: 'example-bollinger-squeeze',
        name: 'Bollinger Squeeze',
        source: `//@version=6
indicator("Bollinger Squeeze", overlay=true)
len = input.int(20, "Length", minval=2)
mult = input.float(2.0, "Band width", minval=0.1, step=0.1)
lookback = input.int(120, "Squeeze lookback", minval=10)

[mid, upper, lower] = ta.bb(close, len, mult)
width = (upper - lower) / mid
tight = width <= ta.lowest(width, lookback) * 1.05

pu = plot(upper, "Upper", color=color.new(color.blue, 30))
pl = plot(lower, "Lower", color=color.new(color.blue, 30))
plot(mid, "Basis", color=color.new(color.orange, 20))
fill(pu, pl, color=tight ? color.new(color.yellow, 80) : color.new(color.blue, 92))

breakUp = tight[1] and close > upper
breakDown = tight[1] and close < lower
plotshape(breakUp, "Break up", shape.triangleup, location.belowbar, color.teal, size=size.small)
plotshape(breakDown, "Break down", shape.triangledown, location.abovebar, color.red, size=size.small)
alertcondition(breakUp or breakDown, "Squeeze break", "{{ticker}} broke out of a Bollinger squeeze")
`,
    },
    {
        id: 'example-structure-zones',
        name: 'Structure Zones',
        source: `//@version=6
indicator("Structure Zones", overlay=true, max_boxes_count=200, max_lines_count=200, max_labels_count=200)
len = input.int(10, "Pivot length", minval=2)
depth = input.float(1.0, "Zone depth (ATR)", minval=0.1, step=0.1)
keep = input.int(12, "Zones to keep", minval=1, maxval=50)

type Zone
    float top
    float btm
    bool  bull
    box   bx

method broken(Zone z, float c) =>
    z.bull ? c < z.btm : c > z.top

var array<Zone> zones = array.new<Zone>()
atr = ta.atr(14)
ph = ta.pivothigh(high, len, len)
pl = ta.pivotlow(low, len, len)

if not na(ph)
    z = Zone.new(ph, ph - atr * depth, false)
    z.bx := box.new(bar_index - len, z.top, bar_index, z.btm, bgcolor=color.new(color.red, 82), border_color=color.new(color.red, 40))
    zones.push(z)
    label.new(bar_index - len, ph, "Supply", style=label.style_label_down, color=color.new(color.red, 20), textcolor=color.white, size=size.small)
if not na(pl)
    z = Zone.new(pl + atr * depth, pl, true)
    z.bx := box.new(bar_index - len, z.top, bar_index, z.btm, bgcolor=color.new(color.teal, 82), border_color=color.new(color.teal, 40))
    zones.push(z)
    label.new(bar_index - len, pl, "Demand", style=label.style_label_up, color=color.new(color.teal, 20), textcolor=color.white, size=size.small)

if zones.size() > 0
    for i = zones.size() - 1 to 0
        z = zones.get(i)
        if z.broken(close)
            box.delete(z.bx)
            zones.remove(i)
        else
            box.set_right(z.bx, bar_index)
while zones.size() > keep
    old = zones.shift()
    box.delete(old.bx)

plot(zones.size(), "Active zones", display=display.data_window)
`,
    },
    {
        id: 'example-mtf-dashboard',
        name: 'Multi-Timeframe Trend Dashboard',
        source: `//@version=6
indicator("Multi-Timeframe Trend Dashboard", overlay=true)
len = input.int(50, "EMA length", minval=2)
tf1 = input.timeframe("60", "Timeframe 1")
tf2 = input.timeframe("240", "Timeframe 2")
tf3 = input.timeframe("D", "Timeframe 3")

trend(tf) =>
    [c, e, r] = request.security(syminfo.tickerid, tf, [close, ta.ema(close, len), ta.rsi(close, 14)])
    [c > e, r]

[up1, r1] = trend(tf1)
[up2, r2] = trend(tf2)
[up3, r3] = trend(tf3)

var table t = table.new(position.top_right, 3, 4, border_width=1)
row(int y, string name, bool up, float r) =>
    table.cell(t, 0, y, name, text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(t, 1, y, up ? "Up" : "Down", text_color=color.white, bgcolor=up ? color.new(color.teal, 30) : color.new(color.red, 30))
    table.cell(t, 2, y, str.tostring(r, "#.0"), text_color=color.white, bgcolor=color.new(color.gray, 75))

if barstate.islast
    table.cell(t, 0, 0, "TF", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(t, 1, 0, "Trend", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(t, 2, 0, "RSI", text_color=color.white, bgcolor=color.new(color.gray, 40))
    row(1, tf1, up1, r1)
    row(2, tf2, up2, r2)
    row(3, tf3, up3, r3)

score = (up1 ? 1 : 0) + (up2 ? 1 : 0) + (up3 ? 1 : 0)
plot(ta.ema(close, len), "EMA", color=score == 3 ? color.teal : score == 0 ? color.red : color.gray, linewidth=2)
plot(score, "Timeframes up", display=display.data_window)
alertcondition(score == 3 and score[1] < 3, "All timeframes up", "{{ticker}}: all three timeframes are above their EMA")
`,
    },
    {
        id: 'example-ema-cross-strategy',
        name: 'EMA Cross Strategy',
        source: `//@version=6
strategy("EMA Cross Strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10, commission_type=strategy.commission.percent, commission_value=0.1)
fastLen = input.int(9, "Fast EMA", minval=1)
slowLen = input.int(21, "Slow EMA", minval=2)
atrLen = input.int(14, "ATR length", minval=1)
stopMult = input.float(2.0, "Stop (ATR)", minval=0.1, step=0.1)
targetMult = input.float(3.0, "Target (ATR)", minval=0.1, step=0.1)
allowShort = input.bool(false, "Trade short side")

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
atr = ta.atr(atrLen)
plot(fast, "Fast", color=color.teal)
plot(slow, "Slow", color=color.orange)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop=close - stopMult * atr, limit=close + targetMult * atr)
if ta.crossunder(fast, slow)
    strategy.close("Long")
    if allowShort
        strategy.entry("Short", strategy.short)
        strategy.exit("Short exit", "Short", stop=close + stopMult * atr, limit=close - targetMult * atr)
if allowShort and ta.crossover(fast, slow)
    strategy.close("Short")
`,
    },
    {
        id: 'example-supertrend-strategy',
        name: 'Supertrend Strategy',
        source: `//@version=6
strategy("Supertrend Strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=20, commission_type=strategy.commission.percent, commission_value=0.1)
factor = input.float(3.0, "Factor", minval=0.5, step=0.1)
atrLen = input.int(10, "ATR length", minval=1)

[st, dir] = ta.supertrend(factor, atrLen)
plot(st, "Supertrend", color=dir < 0 ? color.teal : color.red, linewidth=2)

turnedUp = dir < 0 and dir[1] > 0
turnedDown = dir > 0 and dir[1] < 0
if turnedUp
    strategy.entry("Long", strategy.long)
if turnedDown
    strategy.close("Long")
plotshape(turnedUp, "Buy", shape.labelup, location.belowbar, color.teal, text="Buy", textcolor=color.white, size=size.small)
plotshape(turnedDown, "Sell", shape.labeldown, location.abovebar, color.red, text="Sell", textcolor=color.white, size=size.small)
`,
    },
];
