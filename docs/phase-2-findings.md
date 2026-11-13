# Phase 2 findings

Measured 13 Nov 2026 with `node tests/e2e/phase2.ts` (24 checks in headless Chrome against live data).

## Exit criteria

| Criterion | Result |
|---|---|
| 8-chart layout holds 60 fps | 8 live charts with 17 indicators, every chart panning: frame p95 16.7 ms, 0 frames over 25 ms |
| A layout survives a restart exactly | 8 charts restored with symbols, timeframes, styles, sync links, indicators, drawings and the active chart |
| Replay works on any symbol | Start, step, play, pause, stop on one chart and across the grid |

## What exists

- **Chart types.** The chart engine's ten (candles, hollow candles, bars, line, line with markers, step
  line, area, baseline, columns, Heikin Ashi) plus Renko, Line break, Kagi, Point & figure and Range,
  which the server computes as their own bar series (`BINANCE:BTCUSDT.RENKOXATR14`). Sizes come from
  ATR or a fixed amount.
- **Spreads and formulas** of up to six symbols (`SPREAD:BINANCE:ETHUSDT/BINANCE:BTCUSDT`).
- **Watchlists** with sections, colour flags, live quotes and drag reordering, stored on the server.
- **Replay bar**, **saved layouts**, **chart templates**, **compare overlay**, **CSV export**.
- **Timeframes:** seconds (from Binance's 1-second bars) and any custom minute, hour or day count.

## Limits

- **Chart-type series start where their source window starts.** A Renko series is built from the
  newest 20,000 source bars, so its first brick can differ after a server restart. TradingView behaves
  the same way relative to its loaded history.
- **First view of a chart type costs 1–2 s** while those source bars load; later views are instant.
- **Spread high and low are approximate** (the envelope of the formula at each corner); open and close
  are exact.
- **Three chart types deferred to Phase 8:** Volume candles, HLC area and High-low need custom drawing.
