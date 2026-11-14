# Phase 8 findings

Measured 15 Nov 2026. Phase 8 is open-ended ("premium extras and hardening"); this round delivered
the pieces below. `node tests/e2e/phase8.ts` runs 7 checks in headless Chrome, and every browser
suite from phase 2 to phase 8 passes in one run (108 of 108 checks); `npm test` runs 323 unit and
integration tests, 5 of them for the screener and its API.

## What exists

- **Three more chart types**: Volume candles (candle width follows the bar's volume, the busiest
  visible bar at full width), HLC area (the high and low as bands around the close, green above and
  red below) and High-low (each bar as a block from its low to its high). They are registered with
  the chart engine as price styles, so they appear in its style menu, are remembered with the layout
  and grey out for symbols without volume or OHLC data. With these, every chart type in TradingView's
  standard list is available except Session volume profile, TPO and Volume footprint.
- **Volume profile** (visible range) comes from the chart engine's built-in indicator.
- **Screener** (bottom dock): scan a watchlist, the Binance USDT pairs or the synthetic market on any
  timeframe; 13 measures per symbol (last price, change over 1, 5 and 20 bars, volume and relative
  volume, RSI 14, distance from SMA 50 and SMA 200, EMA 9/21 trend, ATR %, distance from the 52-bar
  high and low); any number of filters (above, below, between); sort by any column; click a row to
  open the symbol. A **Pine Screener**: pick an indicator from the library and the last value of each
  of its plots becomes a column that can be sorted and filtered. Symbols that cannot be read are
  listed rather than failing the scan. `POST /api/screener/run`.
- **Hardening**: a failure inside a panel stays in that panel (it shows the error and "Try again"
  instead of blanking the app); every answer carries `nosniff`, `DENY` framing and `no-referrer`
  headers; a webhook address rests for a minute after ten wrong passphrases; the server shuts down
  cleanly on SIGINT and SIGTERM (saving the paper account and stopping strategies so they resume).

## Production

`npm run build` builds the app in under two seconds; `npm start` then serves it and the API from one
process on :8787. Checked: the page, its assets and deep links load; the API answers; paths outside
the built app are refused (403); every answer carries the security headers. In Chrome, the phase 2 (charts) and phase 5
(strategy tester) browser suites pass against the production server as they do in development
(24 of 24 and 19 of 19).

## Accuracy evidence

- The screener's measures are checked against hand-worked values on a known series (change, moving
  averages, RSI, relative volume, range), and a Pine column computing RSI matches the built-in RSI
  column on every symbol.
- In the browser, each new chart type paints its own layer and stops when another style is picked
  (Volume candles, High-low and HLC area each cover a few per cent of the plot's pixels; with another
  style picked, none).
- The screener sorts symbols A→Z on the first click of the Symbol column and numbers largest first.

## Not done in this round

- **TPO, Volume footprint, session and anchored volume profiles**: they need tick or footprint data
  and their own renderers.
- **Heatmaps, news, economic and earnings calendars, fundamentals, portfolios**: they need data
  sources this project does not have.
- **Electron desktop shell**: not built; the app runs in any browser or as one Node process.
- **Auto chart patterns**.
