# Phase 1 findings

Measured 13 Nov 2026 on an Apple M5 Pro against live Binance spot data.

## What exists

- **Market-data service** (`packages/datafeed`): venue adapters behind one interface, a disk cache of
  closed bars with coverage tracking, gap repair after reconnects, and live streams fanned out from
  one upstream subscription per series. Timeframes a venue lacks (45m, 7m, 2D, …) are aggregated from
  the coarsest native one, both for history and live.
- **Adapters:** Binance spot (public REST + one multiplexed WebSocket, no API key) and a deterministic
  synthetic venue used by the tests and for offline work.
- **Server** (`apps/server`): HTTP for symbols, binary bar history and saved state; a WebSocket
  gateway with 64-byte binary bar frames conflated to one per 16 ms; SQLite for app state.
- **Web app** (`apps/web`): the Vela workspace fed only by our server, with progressive history
  loading (newest 500 bars first), workspace state saved on the server, and a status bar that shows
  connection state and measured live latency.

## Speed against the plan's budgets

`node tests/bench/live-bench.ts` in headless Chrome, uncached symbol chosen per run:

| Metric | Measured | Budget |
|---|---|---|
| App cold start to interactive chart | 181 ms | 1,500 ms |
| Symbol switch, first visit (history fetched from Binance) | 166–182 ms | 400 ms |
| Symbol switch, revisited | 14–16 ms | 100 ms |
| Timeframe switch, first visit | about 160 ms settled; about 400 ms when fired during a background download | 400 ms |
| Live update: server send → page | 2–4 ms p95 | 30 ms |
| Live update: server send → painted frame | 17–19 ms p95 | 30 ms |

Three changes were needed to get there:

1. **Progressive loading.** The chart used to wait for all 5,000 bars before its first paint.
2. **A persistent connection pool to Binance.** A request on an open connection takes about 140 ms;
   a new TLS handshake adds about 450 ms, and Node closes idle connections after 4 s by default.
3. **Forming bar from memory.** Each history request used to ask the venue for the forming bar; it
   now comes from the live stream (kept alive for 5 minutes after the last viewer leaves).

**Not measured:** latency from the exchange's own timestamp to the screen. The numbers above start
when our server sends the update; Binance's kline stream itself batches updates, which the server
shortens by patching the forming bar from the trade stream.

## Accuracy

- 46 automated tests, including a simulated 47-minute live run on the synthetic venue in which every
  bar closed by the live stream is compared with history, for a native and an aggregated timeframe.
- That test caught a real bug: an aggregated bar at the end of a requested window was built from only
  part of its base bars.
- Live soak against Binance: see the result below.

## Soak result

`node tests/soak/live-soak.ts 15` subscribed to four live series through the server for 15 minutes,
then fetched the same period straight from Binance and compared every bar that had closed.

| Series | Bars closed | Missing | Duplicate | Different |
|---|---|---|---|---|
| BTCUSDT 1m | 15 | 0 | 0 | 0 |
| ETHUSDT 1m | 15 | 0 | 0 | 0 |
| BTCUSDT 5m | 3 | 0 | 0 | 0 |
| BTCUSDT 3m | 5 | 0 | 0 | 0 |

10,141 frames were received, none out of order. Open, high, low and close matched exactly and volume
to within 1e-6. Two earlier attempts were discarded because I restarted the server underneath them.

## Deviations from the plan

- **Bar store is fixed-width binary files per year, not Parquet + DuckDB.** Appends are one write,
  reads are a typed-array view, and there is no native dependency. The store sits behind `BarStore`,
  so a Parquet backend can replace it if interoperability with other tools is wanted.
- **`ws` + Fastify instead of uWebSockets.js**, and **`node:sqlite` instead of Drizzle**: fewer
  native and build-time dependencies; throughput is far above what one user needs.
- **Bar frames are a fixed binary layout, control messages are JSON** (the plan said MessagePack).
- **Trades patch the forming bar's price only.** Volume and the final OHLC always come from the
  venue's own bar, so a closed bar is exactly the venue's bar.
- **The 24-hour soak in the plan's exit criteria was run for 15 minutes.** `tests/soak/live-soak.ts`
  takes the duration as an argument; run it overnight before trusting the feed with money.
