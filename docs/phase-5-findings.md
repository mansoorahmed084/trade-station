# Phase 5 findings

Measured 14 Nov 2026. `node tests/e2e/phase5.ts` runs 19 checks in headless Chrome (the suites of
phases 2–4 still pass: 24, 16 and 17 checks); `npm test` runs 263 unit and integration tests, 61 of
them for backtesting; `npm run bench` holds four backtest budgets.

## Exit criteria

| Criterion | Result |
|---|---|
| Reference strategies match exported trade lists trade for trade | Against the Pine runtime's own broker: every trade identical on three reference runs (entry and exit bar, entry and exit price, size), and 95 of 95 identical on six months of real BTCUSDT hourly bars, compared through the TradingView trade-list tool. **Not yet run against lists exported from TradingView itself** — see below |
| A 1M-bar run within budget | 104 ms for a native strategy plus its full report over 1,000,000 bars (budget 5 s). A Pine strategy takes about 3 µs a bar, so 1M bars is about 3 s, also inside the budget |

## What exists

- **Broker emulator** with TradingView's fill rules: market orders fill at the next bar's open (or at
  this bar's close with "process orders on close"); a bar that gaps through a resting order fills it
  at the open; inside a bar, price walks open → nearer extreme → farther extreme → close, and every
  order in reach on the way fills in that order. Limit, stop and stop-limit orders, OCA groups,
  reduce-only exits, FIFO closing, pyramiding, commission (percent, per order, per unit) and slippage
  in ticks. Order prices are moved onto the tick grid away from the market, as TradingView does.
- **Bar magnifier**: a native strategy can read the smaller bars inside each chart bar (10-minute bars
  for an hourly chart, following TradingView's table) to decide which of two orders filled first.
- **Two kinds of strategy**: Pine strategies (from the library, or straight from the editor without
  saving) and built-in TypeScript strategies (EMA cross with ATR stop and target, Donchian breakout,
  RSI mean reversion, Supertrend). Both report through the same code, so they are measured the same way.
- **Report**: net profit, drawdown, profit factor, win rate, average and largest trades, by side;
  Sharpe, Sortino, CAGR, time in market, commission paid, buy-and-hold return, monthly returns, the
  equity curve and its drawdown, and every trade with its run-up and drawdown.
- **Parameter search**: every combination of up to 5,000 (1,000 for Pine) or a random sample of a
  larger grid, ranked by net profit, return ÷ drawdown, profit factor, Sharpe, smallest drawdown or
  win rate. Progress is pushed to the app as it runs; a search can be cancelled.
- **Walk-forward**: parameters are chosen on one window and measured on the window after it, fold by
  fold. The out-of-sample folds are joined into one equity curve, with a walk-forward efficiency
  (annualised out-of-sample return ÷ annualised in-sample return).
- **Monte Carlo**: the closed trades replayed in thousands of random orders, giving the spread of
  drawdowns and final equity and the chance of ruin.
- **Deep backtesting**: runs execute in worker threads (one fewer than the cores, at most eight). A
  worker asks the main thread for bars and keeps them while the runs of one search keep arriving, so a
  search loads its history once. A run covers up to 3M bars (native) or 1M (Pine).
- **Strategy tester in the app** (bottom dock, or the toolbar's chart icon): follows the active chart;
  last N bars, a date range or the entire history; re-runs on every change for windows up to 20,000
  bars; settings for inputs and properties, where an empty field keeps what a Pine script declares;
  overview with the equity curve against buy-and-hold and the drawdown strip; performance table;
  list of trades that moves the chart to a trade when clicked, exports CSV and compares with a
  TradingView export; optimiser with "Use" to apply a row; walk-forward; Monte Carlo. Entries and
  exits are marked on the chart.
- **Server**: `GET /api/backtest/strategies`, `POST /api/backtest/describe`, `/run`, `/optimize`,
  `/walk-forward`, `GET|DELETE /api/backtest/jobs/:id`, and progress on the `backtest` topic.

## Accuracy evidence

- **Native broker vs the Pine runtime's broker**, three runs of 4,000 bars (long only on two markets,
  and long/short with reversals): every trade has the same entry and exit bar, the same entry and exit
  price to 1e-9, a size within 0.02 % and net profit within 0.1 %. Exits by stop, by target and by the
  opposite signal all occur in each run.
- **The same through the server**: the built-in EMA-cross strategy and the example Pine script written
  the same way give identical trade lists and net profit (11.6825 vs 11.6825 over 108 trades in the
  end-to-end run).
- **Real market data**: the Pine version run over BTCUSDT 1h, 1 Jan – 1 Jul 2025 (4,345 bars), was
  written out in TradingView's "List of trades" layout and compared with a native run by
  `tests/golden/compare-tv-trades.ts`: 95 of 95 trades identical, net −199.58 in both.
- **Determinism**: the same request returns a byte-identical report, for both engines.
- **Found and fixed on the way**: stop and target prices were left off the tick grid. Measured on the
  Pine runtime with a 0.01 tick, a buy limit or sell stop at 97.127 fills at 97.12 and a sell limit or
  buy stop at 103.121 at 103.13. The emulator now does the same, which took exit prices from within
  half a tick to exact. Order sizes are also written without floating-point noise (0.00954, not
  0.009540000000000002).
- **A deep load froze the server for three seconds.** Loading 500,000 one-minute bars for a symbol
  whose recent end was already stored rewrote that year's 22 MB segment once per 1,000-bar window,
  about 380 times, on the main thread: every other request waited 3 s. The download now gathers its
  windows and writes them in batches of 200,000 bars, and merging a block into a gap of a series uses
  block copies. The same load now takes 328 ms and the server answers within 13 ms throughout. This
  also speeds up deep chart history on the live venue, where the same rewrite happened between
  network round trips.

### Checking against TradingView itself

No TradingView account was available here, so the parity above is with the Pine runtime, which
implements TradingView's documented rules. To check a strategy against TradingView: in its Strategy
Tester use "Export data" → "List of trades", then either

- in the app, open List of trades → "Compare with a TradingView export…", or
- `node tests/golden/compare-tv-trades.ts <trades.csv> --symbol BINANCE:BTCUSDT --tf 60 --pine strategy.pine --from <first bar of the TradingView backtest>`.

Both name every trade that is missing, extra or different, and the tool exits non-zero below 99 %
agreement. With sizing by percent of equity, `--from` must be the first bar TradingView tested,
because every later size depends on the equity it started from.

## Speed

| Measured | Result |
|---|---|
| Native strategy + report, 1M bars, one thread | 104 ms |
| Bar magnifier: 100K ten-minute bars read through 1M one-minute bars | 80 ms |
| 200 parameter sets × 20K bars, one thread | 364 ms |
| Pine strategy, 20K bars | 66 ms |
| Through the server, 499K one-minute bars, native, bars already stored | 54 ms total |
| Through the server, Pine EMA cross on 90K five-minute bars | 650 ms |
| Through the server, first load of 500K one-minute bars around 300K already stored | 328 ms, health checks answered within 13 ms meanwhile |
| Parameter search of 117 runs on 5,000 bars (end to end, three workers busy) | 128–155 ms |

## Limits and deviations

- **The Pine runtime has no bar magnifier.** It fills from the chart bar alone. The magnifier applies
  to built-in strategies, and the tester says so when it is switched on for a Pine one.
- **Pine runs about 30× slower than native** (≈3 µs a bar against ≈0.1 µs), so parameter searches over
  Pine strategies are capped at 1,000 runs.
- **Sharpe and Sortino** are annualised from daily returns with no risk-free rate. TradingView computes
  its ratios differently (from monthly returns, net of a risk-free rate), so compare those two
  figures only between runs here. Drawdown is measured on bar-close equity.
- **No margin model**: positions are not liquidated and margin calls are not simulated.
- **Monte Carlo reshuffles the trades that happened**; it does not draw new ones, so it says nothing
  about trades the strategy might have taken.
- **Trade markers use the chart engine's inner renderer** to reach their layer, as the alert levels
  do; a fallback keeps them drawing if that changes.
