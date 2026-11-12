# Trade Station — Implementation Plan

*Researched and written 13 Nov 2026. Working name "Trade Station" (see [Legal](#10-risks-and-legal) on why the product should not be called "TradingView").*

---

## 1. Summary

The goal is a self-hosted trading workstation with TradingView-Premium-class charts, Pine-compatible custom indicators (including LuxAlgo's open-source library), backtesting, alerts, trade-from-chart and automated trading.

Four findings from the research shape the whole plan:

1. **TradingView's own full chart cannot be used.** Its *Advanced Charts* and *Trading Platform* libraries are proprietary, licensed only to companies for public websites, and explicitly "not for personal use, hobbies, studies, or testing". The only TradingView-built chart code we may use is **Lightweight Charts** (Apache-2.0), which is a bare series renderer: no indicators, no drawings, no layouts, no scripting.
2. **Pine Script can now run outside TradingView.** **PineTS** (owned by LuxAlgo since 1 Jun 2026, AGPL-3.0 or commercial) transpiles Pine v5/v6 to JavaScript and runs in the browser and Node. This is what makes "paste in a TradingView/LuxAlgo indicator" achievable.
3. **A near-complete open-source chart workstation exists.** **Vela** (LuxAlgo, Apache-2.0, WebGL2 with canvas fallback) ships 76 drawing tools, 70+ indicators, multi-chart grids with sync, a replay API and a Pine addon. It is young (2026), so it gets a benchmark gate before we commit.
4. **Market data is the hard dependency, not code.** TradingView's speed and accuracy come largely from licensed exchange feeds. Ours will be exactly as accurate as the feed we buy or get from a broker.

**Recommended build:** TypeScript end to end (same language family TradingView uses on the front end), Vela as the chart engine behind our own adapter, PineTS as the script engine running both in a browser worker (instant on-chart feedback) and on the server (24/7 alerts and automation), our own broker emulator shared by backtesting and paper trading, and broker adapters behind one interface.

**Rough size (my estimate, one full-time developer):** usable live chart in 4–6 weeks; full scope in 6–8 months. Phases are ordered so every phase ends in something usable.

---

## 2. Assumptions and decisions needed

### Assumptions I made (tell me if any is wrong)

| # | Assumption | What changes if wrong |
|---|---|---|
| A1 | **Personal, single-user, self-hosted.** Not sold or offered to others. | Commercial use needs: PineTS commercial licence (AGPL otherwise forces open-sourcing), a licence for LuxAlgo indicators (CC BY-NC-SA is non-commercial), market-data redistribution licences, multi-tenant auth. |
| A2 | Web app first (runs at `localhost`), desktop shell later. | None structurally; the shell is a thin wrapper. |
| A3 | No social features (ideas, chat, streams, script marketplace, mobile apps). | Adds a large separate product. |

### Decisions needed from you

| # | Decision | My recommendation | Why |
|---|---|---|---|
| D1 | **First market and broker** | Crypto via Binance for development, then your real broker as adapter #2 | Free real-time data, 24/7 market for testing, Vela and PineTS both ship Binance providers. This is a development-sequencing choice, not a view on what to trade. |
| D2 | **Chart engine** | Vela core, confirmed by the Phase 0 benchmark; fallback is Lightweight Charts v5 + a drawing package | Saves most of Phase 2; fallback is the TradingView-built renderer. |
| D3 | **Market-data vendor for non-crypto** | Broker feed first; add a paid vendor (e.g. Databento, Polygon) only when history depth or tick data requires it | Cheapest path; prices and terms must be checked at purchase time. |
| D4 | **Which LuxAlgo indicators you actually use** | List them before Phase 3 | Open-source library scripts can be ported; the paid invite-only toolkits cannot (source is not published). |

---

## 3. Research: what TradingView Premium provides

Values are from TradingView's official pricing page (fetched 13 Nov 2026) unless marked. On our own hardware none of these caps apply; the "target" column is an engineering floor, not a limit.

### 3.1 Premium limits

| Capability | Premium value | Our target | Phase |
|---|---|---|---|
| Charts per tab | 8 | 8 at 60 fps (16 stretch) | 2 |
| Parallel chart connections | 50 | 50+ live subscriptions | 1 |
| Indicators per chart | 25 | 25+ | 3 |
| Indicators on indicators | 24 | Unlimited chaining | 3 |
| Historical bars loaded | 20K | 20K default, lazy-load to full history | 1 |
| Customizable chart types | 21 | 21 (list in 3.3) | 2, 8 |
| Active price alerts | 400 | 1,000+ | 4 |
| Active technical alerts | 400 | 1,000+ | 4 |
| Watchlist alerts | 2 *(inferred from partial table)* | Unlimited | 4 |
| Alert expiry | Never | Never | 4 |
| Symbols per watchlist | 1,000 | 1,000+ | 2 |
| Financials per chart | 10 | Deferred | 8 |
| Portfolios / holdings | 5 / 100 | Deferred | 8 |
| Deep Backtesting | Yes; 2M bars, 1M trades per run | Same or higher | 5 |
| Bar Magnifier | Yes (Premium and up) | Yes | 5 |

### 3.2 Premium feature inventory

| Area | Features | Phase |
|---|---|---|
| **Charts** | Multi-chart layouts with sync (symbol, interval, crosshair, time, date range); custom timeframes; second-based and tick-based intervals; custom range bars; spread charts / custom formulas (`AAPL/SPY`); compare symbols; log, percent and indexed scales; up to 8 price scales; extended-hours sessions; chart templates and saved layouts; undo/redo; chart data export | 1–2 |
| **Drawing tools** | 80–110+ tools: trend lines, channels, pitchforks, Fibonacci family, Gann, patterns (XABCD, Elliott, head-and-shoulders), shapes, text/notes, long/short position tool, measure, anchored VWAP, object tree, magnets, drawing templates, sync drawings across charts | 2 |
| **Indicators** | 100+ built-ins; indicator templates; volume profile (visible range, fixed range, session, anchored); time-price-opportunity (TPO); volume footprint; auto chart patterns; multi-timeframe | 2, 3, 8 |
| **Scripting** | Pine Script v6 editor (Monaco), inputs/styles dialogs, drawing objects (line, label, box, table, polyline), libraries, `request.security`, invite-only script access | 3 |
| **Backtesting** | Strategy Tester (overview, performance summary, trade list, properties), broker emulator, Bar Replay, Bar Magnifier, Deep Backtesting | 2, 5 |
| **Alerts** | Price, indicator, strategy, drawing and watchlist alerts; multi-condition alerts; second-based alerts; frequency options (once / once per bar / once per bar close / every time); no expiry; notifications by popup, sound, app, email, webhook | 4 |
| **Trading** | Order ticket, buy/sell from chart, drag-to-modify order and bracket lines, position line with P&L, DOM ladder, account manager, paper trading | 6 |
| **Discovery** | Watchlists with sections and colour flags; stock/crypto/forex/bond screeners; Pine Screener; heatmaps; news; economic and earnings calendar; fundamentals | 2, 8 |

### 3.3 The 21 chart types (my enumeration — verify against the app)

Bars, Candles, Hollow candles, Volume candles, Line, Line with markers, Step line, Area, HLC area, Baseline, Columns, High-low, Heikin Ashi, Renko, Line break, Kagi, Point & figure, Range, Session volume profile, TPO, Volume footprint.

### 3.4 What TradingView does *not* give you (and we will)

- **Automated order execution.** TradingView alerts only send webhooks; a third-party bridge places the orders. We build the execution engine in.
- **No caps** on alerts, indicators, layouts or history.
- **Full control of fill modelling** in backtests, plus parameter optimisation.

---

## 4. Research: how TradingView is built

TradingView does not publish its architecture. This is what is publicly verifiable, and what we do in response.

| Layer | TradingView (public evidence) | Confidence | Our choice |
|---|---|---|---|
| Front-end language | TypeScript + React (job postings; React fiber tree visible in the desktop app) | High | TypeScript + React |
| Chart rendering | HTML5 canvas (their open-source Lightweight Charts is canvas-based) | High for Lightweight Charts; main chart assumed similar | WebGL2 with canvas2d fallback (Vela) |
| Code editor | Monaco | Medium | Monaco |
| Desktop app | Electron / Chromium | Medium | Electron (Phase 8) |
| Live data transport | WebSocket streaming; their library docs recommend a streaming Datafeed API over polling | High | Binary WebSocket, snapshot + deltas |
| Script execution | Server-side: docs say Pine is "cloud-based" and runs "on our servers" | High | Browser worker for chart display **and** server for alerts/automation, same engine |
| Back end | Go and Python, Node.js; Kafka, PostgreSQL, Redis, Kubernetes, AWS; Flink/Druid for data ops (job postings) | Medium | Node.js monolith, SQLite + Parquet. Their stack is sized for millions of users; ours serves one. |
| Integration contracts | Datafeed API (`resolveSymbol`, `getBars`, `subscribeBars`…) and Broker API (`placeOrder`, `modifyOrder`, `positions`…) | High | Mirror the *shape* of both so community adapters port easily |

**Honest reading of "same tech as TV":** we match the language, rendering approach, transport pattern, editor and integration contracts. We deliberately do not copy the distributed back end, because for one user it adds latency and operational work without adding speed.

### Building blocks we can legally use

| Component | Licence | Role | Caveat |
|---|---|---|---|
| **Vela** (`@luxalgo/vela`) | Apache-2.0 | Chart engine: WebGL2, 76 drawing tools, 70+ indicators, grid layouts, sync groups, replay API, plugin SDK | Young project (~1.3k stars, no published benchmarks). Footprint/TPO, replay UI, alerts panel and trading module are in paid Vela Pro, so we build those ourselves. |
| **PineTS** + `@luxalgo/vela-pinets` | AGPL-3.0 or commercial | Runs Pine v5/v6 in browser and Node; `ta`, `math`, `array`, `matrix`, `map`, `request.security`, `strategy`, drawing objects; streaming mode | v6 support is labelled experimental. AGPL is fine for private use; see A1. |
| **Lightweight Charts v5** | Apache-2.0 (attribution required) | Fallback renderer, built by TradingView; multi-pane and primitives API | No indicators or drawings built in. |
| **KLineChart v10** | Apache-2.0 | Second fallback: canvas, built-in indicators and drawing overlays | — |
| **PineForge engine** | Engine Apache-2.0; transpiler PolyForm Noncommercial with a personal-trading exception | Optional later: Pine v6 → C++ for very fast optimisation sweeps; reports 245/246 strategies matching TradingView trade-for-trade | Self-reported; adds a C++ toolchain. |
| **LuxAlgo open-source indicators** | CC BY-NC-SA 4.0 | Portable via PineTS. LuxAlgo states trading your own account is not commercial use. | Must keep attribution; cannot be sold or bundled in a paid product. |
| **LuxAlgo paid toolkits** | Proprietary, invite-only on TradingView | **Not portable** — source is not available. | Alternatives: Vela Pro (advertises 800+ library indicators, about $1,199/developer/year), or rebuild the concepts from public descriptions. |

---

## 5. Architecture

```
┌────────────────────────── Browser / Electron ──────────────────────────┐
│  React shell: layouts · watchlists · order ticket · strategy tester    │
│  ┌───────────────┐  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │ Chart engine  │  │ Script worker(s) │  │ Data worker             │  │
│  │ (Vela, WebGL2)│◄─┤ PineTS + TS API  │◄─┤ WS decode · bar cache   │  │
│  │ via ChartPort │  │ incremental calc │  │ SharedArrayBuffer cols  │  │
│  └───────────────┘  └──────────────────┘  └───────────▲─────────────┘  │
└───────────────────────────────────────────────────────┼────────────────┘
                              binary WebSocket (snapshot + deltas) + HTTP
┌───────────────────────────────────────────────────────┼────────────────┐
│                        Server (Node.js, one process to start)          │
│  Gateway ── Market-data service ── Bar builder ── History store        │
│     │            ▲ provider adapters (Binance, broker, vendor)         │
│     ├── Script host (PineTS worker pool) ──┬── Alert engine ── Notifier│
│     │                                      └── Strategy runner         │
│     ├── Backtest service (worker pool, broker emulator)                │
│     └── OMS ── Risk manager ── BrokerPort ──► paper │ live adapters    │
│  SQLite (state, orders, audit)   Parquet + DuckDB (bars, ticks)        │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript everywhere, strict mode | One language, shared types across wire; PineTS is native to it |
| UI | React, Vite, Zustand, Radix primitives | Matches TradingView's front end; Zustand keeps high-frequency updates out of React renders |
| Chart | Vela behind our own `ChartPort` interface | Swappable if the benchmark or the project's direction disappoints |
| Editor | Monaco | Same editor TradingView uses |
| Workers | Web Workers, `SharedArrayBuffer`, `OffscreenCanvas` | Keeps the main thread free for input; needs COOP/COEP headers |
| Server | Node.js LTS, Fastify (HTTP), uWebSockets.js (WS), `worker_threads` | PineTS runs in-process; enough throughput for one user |
| App state | SQLite (WAL mode) via Drizzle | Zero-ops; schema ports to PostgreSQL if this ever goes multi-user |
| Market history | Parquet files partitioned by symbol/timeframe/year, read with DuckDB | Columnar scans make multi-million-bar backtests fast; no database server |
| Wire format | MessagePack to start; FlatBuffers only if profiling demands | Simple first, measured later |
| Hot paths | Plain TypeScript on typed arrays; Rust → WASM/N-API only where a profile proves the need | Avoids a second toolchain until justified |
| Desktop | Electron | Same shell as TradingView Desktop; consistent Chromium/WebGL |
| Tooling | pnpm workspaces, Turborepo, Vitest, Playwright, Biome | — |

### 5.2 Repository layout

```
apps/
  web/              React UI
  server/           gateway + services
  desktop/          Electron shell (Phase 8)
packages/
  core/             domain types, time/session/calendar maths, price-as-ticks
  protocol/         wire schema, encode/decode
  chart-port/       ChartPort interface + Vela adapter
  datafeed/         DatafeedPort + provider adapters + bar builder
  script-engine/    PineTS host, native TS indicator/strategy API, worker pool
  indicators/       built-in studies not covered by the chart engine
  backtest/         broker emulator, bar magnifier, reports, optimiser
  alerts/           alert engine, conditions, notifiers
  oms/              orders, positions, risk, BrokerPort + adapters, paper broker
  ui-kit/           shared components
tests/
  golden/           reference bars, indicator values, trade lists
  bench/            performance benchmarks run in CI
```

---

## 6. Speed and accuracy budgets

These are the acceptance numbers. CI benchmarks fail the build when a budget regresses by more than 10%.

### 6.1 Speed

| Metric | Budget |
|---|---|
| Pan/zoom frame time, 1 chart, 20K bars, 10 indicators | ≤ 8 ms (120 fps capable) |
| Pan/zoom, 8 charts visible | ≤ 16 ms (60 fps) |
| Tick received at server → pixel on screen (local) | ≤ 30 ms p95 |
| Symbol or timeframe switch → first paint (cached / uncached) | ≤ 100 ms / ≤ 400 ms |
| App cold start to interactive chart | ≤ 1.5 s |
| Indicator update per new tick (25 indicators) | ≤ 2 ms |
| Backtest, 1M bars, typical Pine strategy | ≤ 5 s |
| Alert evaluation delay after triggering tick | ≤ 100 ms |
| Order click → request leaves the server | ≤ 10 ms |

How we get there:

- **Columnar bars.** Time/open/high/low/close/volume in separate `Float64Array`s, shared between workers with `SharedArrayBuffer`; no per-bar objects.
- **Incremental calculation.** Indicators update in O(1) per tick; full recalculation only on history load or input change.
- **Frame conflation.** Ticks are coalesced per animation frame; rendering happens only when something is dirty.
- **Per-pixel decimation.** When zoomed out, draw min/max per pixel column rather than every bar.
- **Snapshot + delta protocol** with sequence numbers, heartbeats and resume-from-sequence on reconnect.
- **Three-level history cache:** memory → browser OPFS → server Parquet. Server pre-aggregates the common timeframes.
- **Nothing blocks the main thread:** decoding, scripts and backtests all live in workers.

### 6.2 Accuracy

| Area | Rule |
|---|---|
| Prices | Stored and compared as integer multiples of the instrument's minimum tick; converted to floats only for display and indicator maths |
| Bar building | Built from trades with per-exchange session calendars, time zones, DST, extended-hours flags and bar-alignment rules; late/out-of-sequence prints applied per feed conditions |
| Adjustments | Splits and dividends applied as a view over raw data; continuous futures with explicit roll rules |
| Indicators | Golden tests against reference values, tolerance 1e-8 relative; Pine `na` and series-history semantics preserved |
| Backtests | Trade-for-trade parity against exported Strategy Tester trade lists for a reference set of strategies |
| Orders | Idempotent client order IDs, server-side state machine, reconciliation against the broker on every reconnect |

Golden data comes from TradingView's chart-data and trade-list exports for a fixed set of symbols, used privately as a test oracle. Residual differences will usually be the data feed, not the maths, and the test report must say which.

---

## 7. Subsystem designs

### 7.1 Market data

- `DatafeedPort` mirrors TradingView's Datafeed API: `searchSymbols`, `resolveSymbol`, `getBars`, `subscribeBars`, `subscribeTicks`, `subscribeDepth`.
- **Symbol master:** exchange, type, tick size, lot size, currency, session template, time zone.
- **Bar builder:** trades → 1-second and 1-minute base bars → any timeframe, including custom, tick, range, Renko, Kagi, line-break and point-and-figure.
- **Backfill and gap repair:** on start and reconnect, detect gaps and fetch them before resuming the live stream.
- **Storage:** raw trades (optional) and base bars in Parquet; higher timeframes derived and cached.

### 7.2 Chart workstation

- `ChartPort` hides the engine: series, panes, scales, drawings, markers, order lines, events.
- Layout manager for 1–16 chart grids with sync groups; layouts, templates and drawings auto-saved to SQLite.
- Extras we add on top of the engine: replay controls, object tree, drawing alerts, long/short position tool wired to the order ticket, CSV export, screenshot.
- Keyboard-first: symbol type-ahead, timeframe hotkeys, command palette.

### 7.3 Script engine (custom and LuxAlgo indicators)

- **Two ways to write a script:** Pine v5/v6 (through PineTS) and a native TypeScript API for anything needing full speed or features Pine lacks.
- **Two places it runs:** a browser worker for on-chart display, and the server script host for alerts and automation, so they keep running when the browser is closed. Same engine, same inputs, same output.
- **Editor:** Monaco with Pine syntax, inline errors, input and style dialogs generated from `input.*` calls.
- **Output mapping:** `plot`, `plotshape`, `fill`, `bgcolor`, `line`, `label`, `box`, `table`, `polyline` → chart primitives.
- **Import flow:** paste source → compile → compatibility report listing unsupported calls → save to the script library with its licence and attribution recorded.
- **Sandboxing:** scripts get no network, file or DOM access; CPU and memory limits per script.
- **Compatibility backlog:** every unsupported Pine function found in your target scripts becomes a tracked item; fixes are contributed upstream where possible.

### 7.4 Alerts

- **Engine runs on the server, always on.** Conditions: crossing, crossing up/down, greater/less than, entering/exiting channel, inside/outside channel, moving up/down by value or percent.
- **Sources:** price, any indicator plot, `alert()` / `alertcondition()` from scripts, strategy order fills, drawings (trend line, horizontal, channel), and whole watchlists.
- **Multi-condition** alerts with AND/OR groups; **second-based** evaluation.
- **Frequency:** only once, once per bar, once per bar close, every time, plus a cooldown. No expiry unless set.
- **Message templates** with TradingView-style placeholders (`{{ticker}}`, `{{close}}`, `{{strategy.order.action}}`…).
- **Notifiers:** in-app toast and sound, desktop notification, email, Telegram, Discord, generic outbound webhook (HMAC-signed), and an internal route straight to the strategy runner.
- **Reliability:** alert state persisted; fire log with the exact tick that triggered; on restart, missed bars are replayed so alerts are not lost.

### 7.5 Backtesting

- **Broker emulator** implementing TradingView's documented rules as the default mode: orders fill on the next tick/bar, gaps fill at the open rather than the order price, intrabar path inferred from OHLC.
- **Bar Magnifier:** use lower-timeframe bars (down to ticks when available) to order intrabar fills.
- **Deep Backtesting:** runs server-side over full stored history in a worker pool, independent of what the chart has loaded; target 2M+ bars per run.
- **Realism controls:** commission, slippage, spread, margin, pyramiding, order sizing, partial fills, `calc_on_every_tick`, `process_orders_on_close`.
- **Strategy Tester UI:** equity and drawdown curves, performance summary, trade list, trades drawn on the chart, properties tab.
- **Beyond TradingView:** parameter optimisation (grid and random search across workers), walk-forward splits, Monte Carlo trade reshuffling, result comparison.
- **The same emulator powers paper trading**, so paper results and backtests agree by construction.

### 7.6 Trading from the chart

- `BrokerPort` mirrors TradingView's Broker API: place/modify/cancel, orders, positions, executions, balances, streaming updates.
- **Chart interactions:** buy/sell buttons at the price scale, right-click "trade here", draggable limit/stop/take-profit/stop-loss lines, bracket (OCO) orders, position line with live P&L, one-click close and reverse.
- **Panels:** order ticket (market, limit, stop, stop-limit, trailing; risk-based sizing), DOM ladder, account manager (positions, working orders, fills, history).
- **Safety:** confirmation toggle, per-order and per-day limits, visible paper/live indicator that cannot be confused.

### 7.7 Automated trading

```
strategy (Pine or TS) → signal → risk manager → OMS → BrokerPort → broker
                                     ▲                    │
                                     └── fills, positions ┘ (reconcile)
```

- **Strategy runner** hosts strategies on live data, one isolated worker each.
- **Promotion ladder:** backtest → paper → shadow (live data, orders logged not sent) → live at minimum size → live.
- **Risk manager (cannot be bypassed by a strategy):** max position, max order size, max daily loss, max orders per minute, trading-hours window, instrument allow-list.
- **Kill switch:** one action cancels all working orders, optionally flattens positions, and halts every strategy.
- **Reconciliation:** broker is the source of truth; any mismatch pauses the strategy and raises an alert.
- **Inbound webhook** that accepts TradingView-format alert JSON, so alerts you already run on TradingView can drive this system during the transition.
- **Audit log:** every signal, decision, order request, broker response and fill, append-only.
- **Secrets:** broker keys encrypted at rest (OS keychain), held only by the server, never sent to the browser. Server binds to `localhost` by default.

---

## 8. Roadmap

Durations are rough estimates for one full-time developer. Each phase lists what must be true before moving on.

### Phase 0 — Foundations and spikes (1–2 weeks)
- Monorepo, CI, lint, test and benchmark harness.
- **Chart spike:** Vela vs Lightweight Charts v5 against the Section 6.1 frame budgets, 20K and 200K bars, 1 and 8 charts.
- **Pine spike:** run your 15–20 must-have scripts through PineTS; record what fails.
- Confirm D1–D4.

**Exit:** chart engine chosen with benchmark numbers; Pine compatibility list written.

### Phase 1 — Data backbone and first live chart (3–4 weeks)
- Symbol master, provider adapter #1, history store, bar builder, backfill/gap repair.
- WebSocket gateway with snapshot + delta protocol and reconnect.
- One chart: live candles, standard timeframes, symbol search, crosshair, scales, lazy history loading.

**Exit:** live chart meets tick-to-pixel and symbol-switch budgets; a 24-hour soak shows no missing or duplicate bars.

### Phase 2 — Charting workstation (4–6 weeks)
- Chart types (first 17), drawing tools, built-in indicators, compare and spread symbols.
- Multi-chart layouts with sync, watchlists with sections and flags, templates, saved layouts, hotkeys, undo/redo.
- Bar replay controls, data export, custom timeframes, second-based intervals.

**Exit:** 8-chart layout holds 60 fps; a layout survives restart exactly; replay works on any symbol.

### Phase 3 — Script engine and indicators (3–4 weeks)
- Monaco editor, PineTS in a worker, inputs/styles dialogs, drawing-object rendering.
- Script library, import flow with compatibility report, indicator-on-indicator, multi-timeframe.
- Native TypeScript indicator API. Port the agreed LuxAlgo open-source indicators.

**Exit:** target scripts render and match golden values; 25 indicators on one chart stay within the update budget.

### Phase 4 — Alerts (2–3 weeks)
- Server script host, alert engine, all condition types, multi-condition, watchlist and drawing alerts.
- Notifiers, message templates, alert manager UI, fire log.

**Exit:** 1,000 active alerts evaluated within the delay budget; alerts fire with the browser closed and survive a server restart.

### Phase 5 — Backtesting (4–5 weeks)
- Broker emulator, Strategy Tester UI, Bar Magnifier, Deep Backtesting worker pool.
- Optimiser, walk-forward, parity harness.

**Exit:** reference strategies match exported trade lists trade-for-trade (or each difference is explained); 1M-bar run within budget.

### Phase 6 — Paper trading and trade-from-chart (3–4 weeks)
- OMS, paper broker on the shared emulator, order ticket, chart order lines, brackets, DOM, account manager.
- Live broker adapter #1 in the broker's sandbox, then live at minimum size.

**Exit:** every order type round-trips in sandbox; reconciliation passes a forced-disconnect test; no order can be sent to live from a paper-mode screen.

### Phase 7 — Automated trading (3–4 weeks)
- Strategy runner, risk manager, kill switch, shadow mode, inbound webhook, monitoring dashboard, audit log.

**Exit:** a strategy runs two weeks on paper and one week in shadow with zero unexplained divergences; kill switch verified against the live sandbox.

### Phase 8 — Premium extras and hardening (ongoing)
- Volume profile family, volume footprint, TPO, tick and range charts, auto chart patterns.
- Screener and Pine Screener, heatmap, news, calendars, fundamentals, portfolios.
- Electron desktop shell, additional broker and data adapters.
- Native backtest path (PineForge or Rust) if optimisation sweeps need it.

---

## 9. Testing strategy

| Layer | Method |
|---|---|
| Maths and bar building | Unit and property tests; golden files per exchange session edge case (DST, half days, gaps) |
| Indicators | Golden-value comparison per built-in and per imported script |
| Backtest | Trade-list parity harness; determinism test (same inputs → byte-identical report) |
| Protocol | Fuzzed disconnects, out-of-order and duplicate messages, replay from recorded sessions |
| Performance | Benchmarks in CI against Section 6.1; fail on regression |
| UI | Playwright flows for layouts, drawings, order ticket; screenshot diffs for rendering |
| Trading | Broker simulator with injected rejects, partial fills, latency, disconnects; mandatory sandbox run before any live release |
| Soak | Multi-day run of data, alerts and a paper strategy before each milestone |

---

## 10. Risks and legal

| Risk | Impact | Mitigation |
|---|---|---|
| **Market-data cost and licensing** | Real-time exchange data is paid, and terms usually forbid redistribution | Personal use via broker feed first; read each vendor's terms; keep data private |
| **Pine compatibility gaps** | PineTS v6 is experimental; some scripts will not run unmodified | Phase 0 spike on your real scripts; native TS API as an escape hatch; upstream fixes |
| **LuxAlgo paid toolkits are closed-source** | Cannot be ported | Use open-source library versions, evaluate Vela Pro, or rebuild concepts independently |
| **AGPL (PineTS, vela-pinets)** | Sharing or hosting the app for others triggers source-disclosure or a commercial licence | Fine under A1; revisit with a lawyer before any commercial step |
| **Vela is young and vendor-controlled** | Bugs, API churn, features moving to the paid tier | `ChartPort` abstraction, pinned versions, benchmark gate, two documented fallbacks |
| **Live-trading defects cost real money** | High | Promotion ladder, unbypassable risk manager, kill switch, reconciliation, audit log, sandbox gate |
| **Scope** | This is several products in one | Phases ship usable increments; Phase 8 items are optional |
| **Trademarks and copying** | "TradingView" and "Pine Script" are TradingView trademarks | Use a different product name and our own icons and UI assets; never obtain Advanced Charts from unofficial sources; keep required attribution for Lightweight Charts and CC-licensed scripts |

This plan is an engineering document, not legal or financial advice.

---

## 11. Sources

**TradingView (official)**
- [Pricing and plan comparison](https://www.tradingview.com/pricing/)
- [Charting libraries comparison and eligibility](https://www.tradingview.com/free-charting-libraries/)
- [Charting Library docs: product comparison](https://www.tradingview.com/charting-library-docs/latest/getting_started/product-comparison)
- [Pine Script docs: welcome ("cloud-based")](https://www.tradingview.com/pine-script-docs/welcome/)
- [Pine Script docs: strategies and broker emulator](https://www.tradingview.com/pine-script-docs/concepts/strategies/)
- [Pine Script docs: alerts](https://tradingview.com/pine-script-docs/concepts/alerts)
- [How Deep Backtesting works](https://www.tradingview.com/support/solutions/43000666265-how-deep-backtesting-works/)
- [Bar Magnifier backtesting mode](https://www.tradingview.com/support/solutions/43000669285-what-s-bar-magnifier-backtesting-mode/)
- [Lightweight Charts v5 announcement](https://www.tradingview.com/blog/en/tradingview-lightweight-charts-version-5-50837)

**Tech-stack evidence**
- [Backend developer (Go/Python) posting](https://jobs.techstars.com/companies/tradingview/jobs/45120786-backend-developer-go-python)
- [Team lead of backend development posting](https://jobs.insightpartners.com/companies/tradingview/jobs/46956589-team-lead-of-backend-development)
- [QA (DataOps) engineer posting](https://www.remocate.app/jobs/qa-dataops-engineer-tradingview)
- [tradingview-mcp wiki: architecture internals (Electron, React, Monaco)](https://github.com/tradesdontlie/tradingview-mcp/wiki/Architecture-Internals)

**Open-source building blocks**
- [Vela repository](https://github.com/LuxAlgo/Vela) · [Vela comparison page (vendor-authored)](https://velacharts.dev/compare.md)
- [PineTS repository](https://github.com/LuxAlgo/PineTS) · [PineTS architecture](https://docs.luxalgo.com/developers/pinets/architecture) · [LuxAlgo acquires PineTS](https://www.luxalgo.com/blog/luxalgo-acquires-pinets-to-bring-pine-script-r-everywhere/)
- [LuxAlgo Library licence](https://www.luxalgo.com/library/license/)
- [PineForge: Pine v6 to C++](https://dev.to/pineforge/we-transpiled-pinescript-v6-to-c-so-backtests-are-actually-reproducible-5chf)
- [PyneCore (Python Pine runtime)](https://pypi.org/project/pynesys-pynecore/)
- [KLineChart](https://github.com/liihuu/KLineChart)
- [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing/releases)

**Third-party plan comparisons (used only to cross-check limits)**
- [chartwisehub: Plus vs Premium](https://chartwisehub.com/tradingview-plus-vs-premium/)
- [quantroutine: Free vs Pro](https://quantroutine.com/tools/tradingview-free-vs-pro/)
