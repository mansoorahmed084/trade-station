# Phase 6 findings

Measured 14 Nov 2026. `node tests/e2e/phase6.ts` runs 16 checks in headless Chrome, and the suites
of phases 2–5 still pass (24, 16, 17 and 19 checks: 92 of 92 in all); `npm test` runs
303 unit and integration tests, 40 of them for trading (17 paper broker, 10 Binance adapter, 11
trading API, one for the Binance order book and one for the emulator's saved state).

## Exit criteria

| Criterion | Result |
|---|---|
| Every order type round-trips in sandbox | Against a stand-in for the Binance Spot API (signed REST and the WebSocket user data stream): market, limit, stop, trailing stop, change (cancel-replace), cancel, OCO exits and position protection all round-trip, and fills come back over the stream. **Not yet run against the real Binance testnet**: that needs testnet API keys in `TS_BINANCE_TESTNET_KEY` / `TS_BINANCE_TESTNET_SECRET`, which only the account owner can create |
| Reconciliation passes a forced-disconnect test | The stream is cut; an order fills and another is placed on the exchange's own site while the adapter is away; it reconnects by itself, reads orders, balances and fills back, and reports `working → filled`, one missed fill and one adopted order. An entry that filled while disconnected gets its stop placed at reconciliation |
| No order can be sent to live from a paper-mode screen | Every order request names the account its screen is switched to (`x-ts-account`); the server refuses any order for a non-paper account that does not name it (tested for place, cancel-all and close), and a refused order never reaches the exchange. In the browser run all 12 order requests from the paper screen named `paper`. Pages always open on paper; switching to a live account asks first |

## What exists

- **Order model** after TradingView's Broker API: orders, positions, executions and an account
  summary with streaming updates, behind one `BrokerPort` that paper and exchange accounts share.
- **Paper broker** on the backtest emulator, fed with live trade prices, so paper fills follow the
  same rules as backtests: market, limit, stop, stop-limit and trailing-stop orders; brackets whose
  exits wait for their entry; protection for a whole position that follows its size; close and
  reverse; GTC, DAY and IOC; commission, slippage and leverage settings; rejections with reasons.
  The account survives restarts and its price feeds restart with it.
- **Order manager on the server**: per-order value, orders-per-day and daily-loss limits on every
  order; chart-type symbols trade their underlying, formulas are refused; positions and account
  updates throttled to four a second, orders and fills sent at once.
- **Binance Spot adapter**, testnet by default. Signed REST orders, the WebSocket API user data
  stream, reconciliation after every connection, OCO exits, spot rules (no shorts, no day orders,
  sell only what is held). Live trading needs `live: true` in code and `TS_ENABLE_LIVE=1` on the
  server; keys are read from the environment and never returned by the API.
- **Order-book depth** for the ladder: Binance's public book, a generated book for the synthetic
  venue, `GET /api/depth`, cached for 400 ms.
- **In the app**: order ticket (sizing by units, value or % of equity at risk, take profit and stop
  loss, time in force, risk and reward); account manager (figures, positions with editable
  protection, working orders with editable prices and size, fills, history, limits, paper
  settings, account switch); chart lines for positions, orders and exits that can be dragged to a
  new price or closed with ×; one-click buy and sell buttons; "Buy here" / "Sell here" on the
  chart's right-click menu; a depth ladder where a click places a limit or stop and our orders sit
  at their rows; confirmations for orders from the chart and the ladder; fill and rejection toasts;
  a PAPER / SANDBOX / LIVE badge on every trading screen and in the status bar.

## Speed

| Measured | Result |
|---|---|
| Paper market order, request → filled response (200 orders) | p50 0.68 ms, p95 0.94 ms |
| Paper market order, request → fill event on the socket | p50 0.37 ms, p95 0.55 ms |

## Found and fixed on the way

- **Replacing an order on the exchange raced its own reports.** The stream can report the old
  version cancelled and the new version open before the replace request answers, which made the
  order look cancelled and its replacement look like a stranger's. The replacement's id is now
  registered before the request goes out, and reports about a superseded version are ignored.
- **Dragging an order line sometimes did nothing in the test**: the line sat at the bottom edge of
  the price pane, so the drag was clamped back to where it started, and the target line was above
  the visible range. The test now uses prices near the market; the hit test also ignores layer
  canvases that are not on screen.

## Limits and deviations

- **The exchange adapter has only been run against the stand-in.** The stand-in follows Binance's
  documented protocol and checks every signature, but it is not the exchange; differences in field
  formats or edge cases will only show on the testnet.
- **OTOCO is not used.** Binance's documentation for one-request entry-plus-bracket orders could not
  be read here, so a bracket's exits are placed by the adapter when the entry fills. If the server
  is down at that moment they are placed at the next reconciliation, not instantly.
- **Paper fills are complete and immediate**: no partial fills, no queue position, no spread (only
  last trade prices, plus slippage in ticks). A stop fills at its price when the market trades
  through it.
- **The paper account has no margin calls**: leverage limits buying power, but positions are never
  liquidated.
- **Drag and close on chart lines use the chart engine's inner renderer** to reach their layer,
  like alert levels and trade markers.
