# Trade Station

A self-hosted trading workstation: charts, Pine-compatible indicators, alerts, backtesting,
paper and exchange trading from the chart, automated strategies and a screener. See
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the design and [docs/](docs) for what each
phase delivered, how it was measured and what it does not do yet.

## Run it

```bash
npm install
npm run dev        # API server on :8787, web app on :5173
```

Or as one process with the built app: `npm run build`, then `npm start` and open :8787.

Or as a desktop app: `npm run desktop` (builds the app, then opens it in its own window with the
server running behind it; its data lives in the app's user-data folder).

### macOS installer

```bash
npm run package:desktop      # → apps/desktop/dist/Trade Station-<version>-arm64.dmg
```

The DMG holds a self-contained `Trade Station.app` (the server is bundled inside; no Node or project
folder needed). Its data lives in `~/Library/Application Support/Trade Station/data`.

Signing: without a certificate the app is signed ad hoc — it runs on the Mac that built it, and other
Macs warn before opening it (right-click → Open to allow it). To sign it for distribution, install
your **Developer ID Application** certificate in the keychain (or set `CSC_LINK` and
`CSC_KEY_PASSWORD`, or `CSC_NAME`), and to notarize it also set `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. The build script picks these up by itself and
then signs with the hardened runtime and notarizes.

### Settings (environment variables)

| Variable | What it does |
|---|---|
| `TS_PORT`, `TS_HOST`, `TS_DATA_DIR` | Where the server listens and keeps its data (default `127.0.0.1:8787`, `./data`) |
| `TS_PROVIDERS` | Market data: `binance,synth` by default |
| `TS_TELEGRAM_TOKEN`, `TS_SMTP_URL`, `TS_SMTP_FROM` | Alert channels |
| `TS_BINANCE_TESTNET_KEY`, `TS_BINANCE_TESTNET_SECRET` | A Binance **testnet** account to trade (no real money) |
| `TS_BINANCE_LIVE_KEY`, `TS_BINANCE_LIVE_SECRET`, `TS_ENABLE_LIVE=1` | The live Binance exchange — real money; all three are needed |

Keys are read from the environment only; the server never stores them or sends them to the app.

## What is in it

- **Charts**: 8 synchronised charts per layout, drawings, replay, 20+ chart types including Renko,
  Kagi, Point & figure, Line break, Range, Volume candles, HLC area, High-low, TPO (market profile)
  and Volume footprint; spreads and formulas.
- **Indicators**: the chart engine's built-ins, a Pine editor and script library (PineTS runtime),
  native TypeScript indicators. The library ships with two composite indicators, Technical
  Sentiment Composite and Wave & Flow Matrix (own implementations, not LuxAlgo code), usable on
  charts, in alerts and as screener columns.
- **Alerts** that run on the server with the browser closed: price, indicator, drawing and script
  conditions; app, webhook, Discord, Telegram and email.
- **Strategy tester**: built-in and Pine strategies, TradingView's fill rules, bar magnifier, deep
  history on worker threads, parameter search, walk-forward, Monte Carlo, and a comparison with
  TradingView's exported trade lists.
- **Trading**: a paper account on the backtest engine, order ticket, chart order lines you drag,
  one-click and right-click trading, depth ladder, account manager; a Binance spot adapter (testnet
  by default) with reconciliation.
- **Automation**: strategies running live (paper, shadow or an exchange account), an unbypassable
  risk manager, a kill switch, an audit log and inbound webhooks in TradingView's alert format.
- **Screener** over watchlists or whole venues, with Pine-script columns.

## Check it

```bash
npm run typecheck
npm test                                   # unit and integration tests
npm run bench                              # performance budgets
node tests/e2e/phase8.ts                   # browser checks (phase2 … phase8), need `npm run dev` and Chrome
node tests/soak/automation-soak.ts 14      # two simulated weeks of live strategies
node tests/golden/compare-tv-trades.ts     # compare a backtest with a TradingView trade-list export
```

## Layout

| Path | What it holds |
|---|---|
| `apps/server` | API, market data service, script host, alerts, backtest workers, trading, automation, screener |
| `apps/web` | React app around the Vela chart workspace |
| `apps/desktop` | Electron shell: runs the server and opens the app in a window |
| `packages/core` | Bars, timeframes, aggregation, chart-type transforms, price maths |
| `packages/datafeed` | Venue adapters (Binance, synthetic), bar store, live hubs |
| `packages/indicators` | Native indicators |
| `packages/script-engine` | Pine script host and compatibility checks |
| `packages/alerts` | Alert engine, conditions, notifiers |
| `packages/backtest` | Broker emulator, native strategies, reports, optimiser, TradingView trade lists |
| `packages/oms` | Order model, paper broker, Binance spot adapter, risk manager |
| `tests` | Benchmarks, browser checks, soaks, golden comparisons |

## Licences of the main dependencies

- Vela chart engine: Apache-2.0.
- PineTS and `@luxalgo/vela-pinets`: AGPL-3.0. Fine for private use; sharing or hosting this app for
  others requires publishing its source or buying a commercial licence.
