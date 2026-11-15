# Phase 8 findings

Phase 8 is open-ended ("premium extras and hardening"). Two rounds so far: the first (14–15 Nov
2026) added three chart types, the screener and hardening; the second (15 Nov) added TPO, volume
footprints and the desktop app. Every browser suite from phase 2 to phase 8 passes in one run (109 of 109 checks; `tests/e2e/phase8.ts` has 8), and the desktop app's own check passes (6 of 6); `npm test` runs 331 unit and integration tests.

## Round 2

- **TPO (market profile)** as a chart type: one column per UTC day, a letter for every 30-minute
  period at every price band it traded (A–Z, then a–z), the point of control (the band with the
  most letters) in amber, the value area (70 % of letters, grown outwards from the point of control,
  each step taking the busier side) shaded, and the initial balance (the first hour) as a bar. Row
  size follows the zoom; on bars longer than 30 minutes it says to pick a shorter timeframe.
- **Volume footprint** as a chart type: each bar a column of price levels with the volume bought at
  the ask and sold at the bid, "sell × buy" when zoomed in and a heat column otherwise, shaded by the
  side that dominated, the busiest level outlined and the bar's delta underneath. Picking it zooms to
  about 30 bars. It runs on live Binance trades as well as the synthetic market.
- **Trade history**: adapters return every trade with its aggressor side — Binance's public aggregate
  trades (an hour per window, page by page, a few windows at once), and synthetic trades that walk
  each bar's path and add up exactly to its volume. `GET /api/footprint` builds footprints with an
  automatic row size and keeps closed bars, so later calls only read new trades; 40 one-minute bars
  of Bitcoin took about 5 s the first time.
- **Desktop app** (`npm run desktop`, Electron 45.2.1): starts the trading server on Electron's own
  Node (24.22, which has everything the server needs) on a free local port, keeps its data in the
  app's user-data folder, opens the built app in a window, opens outside links in the browser, allows
  one copy at a time, and stops the server gracefully on quit. Checked by
  launching it (`tests/e2e/desktop.ts`): the server starts behind it, the chart works in the window, a
  paper order fills, quitting stops the server, and the next start finds the position kept in its
  data folder.
- **macOS installer** (`npm run package:desktop`, electron-builder 26.18.1): the server and its
  backtest worker are bundled into plain JavaScript with Rolldown (4.3 MB, every dependency included,
  runs without `node_modules`); the built web app goes in beside it; the result is
  `Trade Station.app` (283 MB) in a 125 MB DMG with the usual drag-to-Applications window and an
  original icon. The desktop check passes 6/6 against the installed app (`DESKTOP_APP=… node
  tests/e2e/desktop.ts`): its own server starts, the chart draws, a paper order fills, no page errors,
  quitting stops the server and the position is still there on the next start. It is signed ad hoc
  because no Developer ID certificate is installed here; the build signs with one (hardened runtime) and notarizes as soon as a certificate and Apple
  ID settings are present — see the README. Only Electron's own install script may run during
  `npm install` (electron-builder's Windows helper is denied).
- **Found and fixed**: a Pine strategy's position still open at the end of a backtest was reported
  with a result of zero (the built-in engine marks it to the last close); and lint errors had been
  missed because they were checked through `tail`, which hid them — lint now runs in CI and passes.

## Round 1

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

## Not done yet

- **Session and anchored volume profiles** (the visible-range profile comes from the chart engine).
- **A distribution signature and notarization** for the installer: they need the owner's Apple
  Developer ID certificate and Apple ID. Auto-update and Intel (x64) builds are not set up.
- **Heatmaps, news, economic and earnings calendars, fundamentals, portfolios**: they need data
  sources this project does not have.
- **Auto chart patterns**.
