# Phase 7 findings

Measured 14–15 Nov 2026. `node tests/e2e/phase7.ts` runs 9 checks in headless Chrome, and every
browser suite from phase 2 to phase 8 passes in one run (108 of 108 checks);
`npm test` runs 323 unit and integration tests, 15 of them for automation (5 risk rules, and 10 for
runners, the kill switch and webhooks through the API); `node tests/soak/automation-soak.ts` runs
strategies through two simulated weeks of one-minute bars.

## Exit criteria

| Criterion | Result |
|---|---|
| A strategy runs two weeks on paper and one week in shadow with zero unexplained divergences | In simulated time (`tests/soak/automation-soak.ts`, 85 s): two runners traded the paper account for two weeks of one-minute bars (20,160 bars each) and a Pine runner ran a week in shadow (10,080 bars). **Zero divergences of any kind** — every bar, each runner held exactly what its strategy wanted — and every one of the 50,400 decisions wanted the same side as one continuous backtest of the same bars. Two weeks were not lived through in real time |
| Kill switch verified against the live sandbox | Against the stand-in Binance exchange (the same one Phase 6 used): with a market buy, a resting limit and an OCO pair working, the kill switch cancels everything on the exchange in one call per symbol, re-reads balances and sells the holding at the market; nothing is left working and the position is flat. **Not yet run against the real testnet**, which needs the owner's API keys |

## What exists

- **Risk manager** for everything automatic: largest position per symbol (units or value), largest
  order (units or value), daily loss after which only reducing orders pass, orders per minute per
  account, trading hours (UTC, may wrap past midnight) and a symbol allow-list. Strategies and
  webhooks never hold an account: the only way their orders reach one is
  `TradingService.placeAutomated`, which applies these rules and the per-order limits first.
- **Kill switch** (status bar, always visible): halts every strategy, refuses webhooks, cancels every
  working order on every account and can close every position. The halt survives a restart; only
  "Resume" lifts it. People can still trade by hand while halted.
- **Audit log**: every order request and its outcome from people, strategies and webhooks, every
  risk refusal, the kill switch, resume, and every change to limits, risk rules, runners and
  webhooks. Append-only, in SQLite; `GET /api/audit`, and an Audit tab in the app.
- **Strategy runner**: on every closed bar it works out the position a built-in or Pine strategy
  wants (in a worker thread, over recent history) and trades the difference at the market. Paper,
  shadow (decisions recorded, nothing sent) or an exchange account; start at the next signal or take
  the position on at once; optional fixed units per entry; fills announced in the app and on the
  runner's own alert channels; running runners restart with the server unless trading is halted.
  Each decision is kept, and any time the position held is not the position wanted is recorded as a
  divergence, explained (a refused order, a halt) or not. "Check against a backtest" replays the
  period as one continuous backtest and lists every bar where they disagree.
- **Inbound webhook** in TradingView's alert format: `ticker` (+ `exchange`), `action`,
  `contracts`, `position_size`, the nested `strategy.order.*` fields, limit and stop orders, and
  close. Each webhook has its own address and passphrase and trades one account; it is reachable
  under any host name (through a tunnel), compares passphrases in constant time and answers an
  unknown address and a wrong passphrase alike.
- **Automation dashboard** (bottom dock): runners with what they want and hold, fills, realised
  result and divergences; a decision log; webhooks with their address and a ready-made TradingView
  message; risk rules; the audit log; a halt banner with Resume.

## Accuracy evidence

- **Two simulated weeks** (`node tests/soak/automation-soak.ts`): the market clock moves a minute at
  a time and every runner decides on every bar exactly as it does live. At the end of each day, that
  day's decisions are replayed as one continuous backtest.

  | Runner | Bars | Orders filled | Divergences | Same side as the backtest | Size differences |
  |---|---|---|---|---|---|
  | EMA cross (built-in), paper, sized by equity | 20,160 | 1,484 | 0 | 20,160 of 20,160 | 4,969 bars, at most 0.30 % |
  | Supertrend (built-in), paper, 2 units per entry | 20,160 | 477 | 0 | 20,160 of 20,160 | none |
  | EMA cross (Pine), shadow, first week | 10,080 | 803 | 0 | 10,080 of 10,080 | 2,790 bars, at most 0.81 % |

  The size differences come only from sizing by equity (see below); with fixed units they vanish.
- **Following bar by bar** (`apps/server/test/automation.test.ts`): a strategy that changes its mind
  every minute is followed for five minutes on the paper account, every change traded, its position
  equal to the strategy's, every order in the audit log, and its decisions identical to a backtest.
- **A refused order** shows as an explained divergence with the risk rule that refused it.

## Found and fixed on the way

- **Paper fills at a stale price.** The paper account kept the last trade it had seen; with no
  trades arriving (a quiet market, or simulated time) every order filled at that old price. Before
  an order, a price older than 15 seconds by the market clock is now refreshed from the latest
  stream price or one-minute close.
- **The kill switch could not close an exchange position.** Cancelling exit orders unlocks coins,
  but the exchange's balance update had not arrived yet, so the close computed nothing to sell.
  Closing now re-reads balances first, and the kill switch cancels with one exchange call per symbol
  instead of order by order (which had briefly re-placed the other leg of an OCO pair).
- **Price feeds for symbols without market data** threw; an exchange account can hold coins no
  chart shows. The account now values them on its own.
- **Toasts piled up** over the panels during busy moments; at most three show at once.
- **The browser suite left strategies running.** Its clean-up sent requests with a JSON content type
  and no body, which the server refuses, so runners, webhooks and scripts from earlier runs stayed
  behind — and a leftover strategy kept trading the paper account under later suites. Fixed in the
  suite; the server state was cleaned.
- **The soak found two more.** Paper orders filled at a price two simulated weeks old: the stale-price
  check trusted the data service's last price, which was itself stale. Stream prices now carry the
  time they were seen and count only while recent. And the built-in backtester recorded a position
  still open at the end as entered on the last bar, so the Strategy Tester showed the wrong entry
  time and a replay missed it; it is now dated from its first fill.

## Limits and deviations

- **Decisions are made at bar close from a window of recent history** (2,000 bars by default).
  Market orders follow at the close; stops and targets inside a strategy are followed at the next
  close rather than at their own price. A strategy whose logic depends on its own bar count
  (`bar_index`) or on state older than the window can decide differently live than in one long
  backtest — "Check against a backtest" exists to catch exactly that.
- **Sizing by percent of equity differs slightly** between a window of recent history and one long
  run, because the equity each sees differs. Side and timing are unaffected; set units per entry for
  exact sizes.
- **The two weeks were simulated**, minute by minute, not lived through; network, venue outages and
  a real exchange's behaviour are not part of it.
- **Runners keep their last 2,000 decisions** to keep their saved state small.
