# Trade Station

A self-hosted trading workstation: charts, Pine-compatible indicators, alerts, backtesting,
trade-from-chart and automated trading. See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the
design and [docs/](docs) for per-phase findings.

## Run it

```bash
npm install
npm run dev        # API server on :8787, web app on :5173
```

## Check it

```bash
npm run typecheck
npm test
npm run bench                         # Node performance budgets
node tests/bench/chart-bench.ts       # chart frame timings (needs `npm run dev:web` and Chrome)
```

## Layout

| Path | What it holds |
|---|---|
| `apps/server` | API gateway, market data, script host, alerts, backtests, order management |
| `apps/web` | React UI around the Vela chart workspace |
| `packages/core` | Bars, timeframes, aggregation, price maths |
| `packages/*` | One package per subsystem (data feed, scripts, backtest, alerts, orders) |
| `tests/bench` | Performance budgets |
| `spikes` | Phase 0 experiments |

## Licences of the main dependencies

- Vela chart engine: Apache-2.0.
- PineTS and `@luxalgo/vela-pinets`: AGPL-3.0. Fine for private use; sharing or hosting this app for
  others requires publishing its source or buying a commercial licence.
