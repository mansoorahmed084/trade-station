# Phase 3 findings

Measured 13 Nov 2026. `node tests/e2e/phase3.ts` runs 16 checks in headless Chrome; `npm test` runs
150 unit and integration tests.

## Exit criteria

| Criterion | Result |
|---|---|
| Scripts render and match golden values | All 7 example scripts run on the chart. The chart's Pine engine and the server's agree exactly on 5,916 values (EMA, RSI, MACD histogram, ATR). |
| 25 indicators within the update budget | 15 native + 10 Pine indicators on a live chart: frame p95 16.8 ms, 0 dropped frames, live and while panning. The native library updates 25 indicators in 0.0005 ms per tick (budget 2 ms). |

## What exists

- **Pine editor** (Monaco, loaded on demand): syntax colouring, completion from the runtime's own
  built-ins, errors marked on their line, add to chart or update in place. A failing edit leaves the
  previous version on the chart.
- **Script library** on the server, seeded with seven original example scripts. Saving an example
  makes a copy.
- **Import flow:** paste a script, get a compatibility report, save it with author, licence and source
  URL. The attribution is shown whenever the script is open.
- **Compatibility report:** compiles and runs the script on real bars and lists every built-in it
  references that the runtime lacks, with line numbers.
- **Server-side script host** (`@ts/script-engine`): runs Pine against our own market data, including
  `request.security`, alerts and strategy results. This is what alerts and backtests build on.
- **Native indicator library** (`@ts/indicators`): 24 incremental indicators with Pine semantics.
- **Indicator on indicator:** "Study on plot" applies a moving average, RSI, Bollinger Bands and others
  to any plot of an indicator script.
- **Indicator sets:** save every indicator on a chart and re-apply them elsewhere.

## Accuracy evidence

Three independent implementations are checked against each other:

1. The **native library** matches the **Pine runtime** on every bar of a 3,000-bar series for all 24
   indicators, to within 1e-9 (the runtime rounds its output to 10 decimal places).
2. The **server** Pine engine matches the native library through the whole data path.
3. The **chart** Pine engine matches the server engine exactly.

**Not verified: agreement with TradingView itself.** That needs exports from a TradingView account.
`tests/golden/compare-tv-export.ts` does the comparison: export chart data with a script applied, then

```bash
node tests/golden/compare-tv-export.ts export.csv script.pine
```

It runs the script over the CSV's own bars, so any difference is the engine's.

## Compatibility of the Pine runtime

Of 421 commonly used Pine identifiers checked by name, the runtime implements all of them. Known gaps:

- Fundamental data requests (`request.financial`, `request.earnings`, …) return `na`; the report lists
  them as warnings.
- Pine v6 support is labelled experimental by the runtime's authors.
- Invite-only and protected scripts cannot be imported: their source is not published.

## Deviations and limits

- **LuxAlgo scripts are not bundled.** Their open-source scripts are CC BY-NC-SA and this repository is
  public; import the ones you use through the import flow, which records the attribution.
- **Indicator on indicator works on script indicators only**, by composing a new script. The chart
  engine's built-in indicators expose no plot to build on, and its source inputs offer price fields only.
- **Indicator sets restore default inputs**, not the values you had tuned.
- **Three small corrections to match the runtime** were needed in the native library: Supertrend is
  undefined until its ATR exists, DMI uses `ta.tr` (undefined on the first bar), and the rolling
  standard deviation is rebuilt once per window to stop precision drift.
