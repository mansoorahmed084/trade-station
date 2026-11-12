# Phase 0 findings

Measured 13 Nov 2026 on an Apple M5 Pro, Node 26, headless Chrome with the Metal GPU backend.

## Chart engine: Vela confirmed

`node tests/bench/chart-bench.ts` drives `apps/web/bench.html`: synthetic 1-minute bars, a pan across
the full history followed by a zoom sweep, one viewport change per animation frame, 180 frames per case.
Frame intervals are capped by the 60 Hz display clock (16.7 ms), so the result to read is dropped frames.

| Case | Engine | Load ms | Frame p95 ms | Frames > 17.5 ms |
|---|---|---|---|---|
| 20K bars, 1 chart | Vela 0.10.6 (WebGL2) | 49 | 16.8 | 2 (first-paint warm-up) |
| | Lightweight Charts 5.3 | 42 | 16.7 | 0 |
| 20K bars, 1 chart, 10 indicators | Vela | 82 | 16.8 | 0 |
| | Lightweight Charts | 77 | 16.8 | 0 |
| 200K bars, 1 chart, 10 indicators | Vela | 265 | 16.8 | 2 |
| | Lightweight Charts | 820 | 16.8 | 0 |
| 20K bars × 8 charts, 2–3 indicators each | Vela | 78 | 16.8 | 0 |
| | Lightweight Charts | 224 | 16.7 | 0 |

- Both engines hold 60 fps in every case, including 8 charts and 200K bars.
- Vela loads large histories about 3× faster and already ships the drawing tools, indicators,
  multi-chart workspace, replay and persistence that would otherwise be built by hand.
- **Not verified:** the 8 ms (120 fps) single-chart budget. Headless Chrome renders at 60 Hz, so this
  needs a run on a 120 Hz display.
- Lightweight Charts stays the documented fallback; the benchmark page keeps both engines.

## Pine runtime: PineTS confirmed for the server and the browser

`node spikes/pine-spike.ts` runs eight scripts over 5,000 live BTCUSDT 1h bars through a custom
data provider (the shape the server-side script host uses).

| Script | Result | Speed |
|---|---|---|
| EMA cross (v5) | pass; EMA matches reference maths to 1e-15 | 10 µs/bar |
| RSI, MACD, Bollinger, ATR, Stochastic, VWMA (v6) | pass; RSI matches to 3e-12 | 11 µs/bar |
| Supertrend + DMI | pass | 5 µs/bar |
| User-defined types, methods, arrays, boxes, lines, labels | pass | 24 µs/bar |
| `request.security` (daily and 4h) + table | pass | 93 µs/bar |
| Maps, matrices, enums, `switch`, `while` | pass | 8 µs/bar |
| Strategy with stop and target (108 trades) | pass | 8 µs/bar |
| `alert()` and `alertcondition()` (147 alerts) | pass | 3 µs/bar |

- `request.security` needs a provider (ticker and timeframe context); a bare bar array is not enough.
- A typical strategy costs about 8 µs per bar, so 1M bars takes about 8 s — over the plan's 5 s budget.
  Deep backtests of native TypeScript strategies use our own engine; Pine strategies get the PineForge
  or worker-sharding option listed in Phase 8 if this matters in practice.
- **Not verified:** your own LuxAlgo scripts (decision D4). The spike scripts were written to exercise
  the same language features; the import flow in Phase 3 reports per-script gaps.

## Decisions carried forward

| # | Decision | Outcome |
|---|---|---|
| D1 | First market | Crypto via Binance (public data, no key) |
| D2 | Chart engine | Vela core behind `ChartPort`-style adapters |
| D3 | Non-crypto data | Deferred until a second adapter is needed |
| D4 | LuxAlgo script list | Still needed from you |

## Deviations from the plan

- **npm workspaces** instead of pnpm + Turborepo: pnpm is not installed and npm 11 covers the need.
- **Node runs TypeScript directly** (type stripping), so the server has no build step.
- **No SharedArrayBuffer data worker in the browser:** Vela owns the bar cache and render loop, so the
  planned client-side columnar cache would duplicate it. The columnar `BarSeries` is used on the server
  and on the wire instead.
