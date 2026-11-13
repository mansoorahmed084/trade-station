# Phase 4 findings

Measured 14 Nov 2026. `node tests/e2e/phase4.ts` runs 17 checks in headless Chrome; `npm test` runs
200 unit and integration tests, 49 of them for alerts.

## Exit criteria

| Criterion | Result |
|---|---|
| 1,000 active alerts evaluated within the delay budget | 0.04 ms per tick for 1,000 alerts (budget 100 ms); evaluation happens inside the tick handler, so there is no queue to wait in |
| Alerts fire with the browser closed | Fires, is logged and reaches a signed webhook with no client connected |
| Alerts survive a server restart | State is kept, finished alerts stay finished, and bars that closed during the outage are replayed and reported as missed |

## What exists

- **Conditions:** crossing, crossing up/down, greater/less than, entering/exiting/inside/outside a
  channel, moving up/down by an amount or a percentage within N bars; any mix joined by AND or OR.
- **What a condition can read:** price fields, fixed values, 20 native indicators, plots of Pine
  scripts, lines drawn on the chart, and a script's own `alert()` / `alertcondition()` calls.
- **Triggers:** only once, once per bar, once per bar close, every time; quiet time; expiry.
- **Watchlist alerts:** one alert over every symbol of a list, fired per symbol.
- **Messages** with TradingView-style placeholders (`{{ticker}}`, `{{close}}`, `{{time}}`, `{{plot("…")}}`).
- **Notifications:** in-app toast, sound, desktop notification, webhook (HMAC-signed, retried),
  Discord, Telegram and email.
- **In the app:** alerts panel with status and log, create/edit dialog with a condition builder,
  "Add alert at this price" on the chart's right-click menu, alert levels drawn on charts of that
  symbol, and alerts that follow a drawing when it is moved.
- **On the server:** the engine runs every alert against the same data service the charts use. Fires
  are stored in SQLite with the delivery result of each channel.

## Accuracy evidence

- An RSI alert run live for four simulated hours fired on exactly the bars where the closed-bar RSI
  crossed, compared against history afterwards.
- The same condition expressed four ways (native indicator, Pine plot, `alertcondition`, `alert()`)
  fired on identical bars.
- A level crossed mid-bar fires on the tick that crossed it, not at the bar's close.
- Crossing follows Pine's rule: a bar that closed exactly on the level counts as the starting side.

## Limits and deviations

- **Telegram and email need server configuration** (`TS_TELEGRAM_TOKEN`, `TS_SMTP_URL`, `TS_SMTP_FROM`).
  They are read from the environment and never stored or returned by the API. **Neither was sent for
  real**: Telegram is tested against a stand-in for its API and email against a stand-in transport.
- **Missed alerts are reported at bar granularity.** After downtime the engine replays closed bars, so a
  level touched and left within one bar during the outage is not seen. At most five missed fires are
  announced per alert and symbol.
- **"Every time" re-arms once per bar** for conditions that stay true, and repeats within a bar only
  when a quiet time is set. TradingView limits this trigger to once a minute.
- **Script-backed alerts are evaluated at bar close, and at most every two seconds in between**, since
  each evaluation runs the script on the server.
- **Alert levels are drawn but cannot be dragged yet.** Dragging arrives with order lines in Phase 6.
- **Drawing lines on the chart uses the chart engine's inner renderer** to feed its layer, because the
  public surface has no call for it. A fallback keeps the lines drawing if that changes.
- **Strategy order-fill alerts** are part of Phase 7, where strategies run live.
