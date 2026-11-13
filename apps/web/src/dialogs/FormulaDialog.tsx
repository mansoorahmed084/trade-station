import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { SymbolInfo } from '@ts/core';
import { useEffect, useState } from 'react';
import { stripChartType } from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';
import { Button, Field, Modal, Tabs } from '../ui.tsx';

/** Overlay another symbol, rebased so both start at the same point on the left edge of the view. */
const compareScript = (symbol: string) => `//@version=6
indicator("Compare ${symbol.slice(symbol.indexOf(':') + 1)}", overlay=true)
sym = input.symbol("${symbol}", "Symbol")
other = request.security(sym, timeframe.period, close)
var float otherBase = na
var float ownBase = na
if time == chart.left_visible_bar_time
    otherBase := other
    ownBase := close
plot(other / otherBase * ownBase, "Compared", color=color.orange, linewidth=2)
`;

export function FormulaDialog({
    client,
    workspace,
    onClose,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    onClose: () => void;
}) {
    const chart: any = workspace.chart;
    const current = stripChartType(String(chart.market?.symbol ?? ''));
    const isFormula = /^spread:/i.test(current);
    const [tab, setTab] = useState<'compare' | 'spread'>('compare');
    const [formula, setFormula] = useState(isFormula ? current.slice(7) : `${current}/`);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SymbolInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const q = query.trim();
        if (!q) {
            setResults([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            client
                .symbols(undefined, q, 10)
                .then((rows) => !cancelled && setResults(rows))
                .catch(() => {});
        }, 120);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query, client]);

    const applyFormula = async () => {
        const text = formula.trim();
        if (!text) return;
        setBusy(true);
        setError(null);
        try {
            // Ask the server to validate the formula first: a bad one never reaches the chart.
            await client.symbolInfo(`SPREAD:${text}`);
            await chart.setMarket({ symbol: `SPREAD:${text}` });
            onClose();
        } catch (err: any) {
            setError(err?.message ?? 'invalid formula');
        } finally {
            setBusy(false);
        }
    };

    const compare = async (symbol: string) => {
        setBusy(true);
        setError(null);
        const result = await chart.runIndicator(compareScript(symbol));
        setBusy(false);
        if (result.ok) onClose();
        else setError(result.error?.message ?? 'could not add the comparison');
    };

    return (
        <Modal title="Compare or spread" onClose={onClose} width={520}>
            <Tabs
                tabs={[
                    { id: 'compare', label: 'Compare' },
                    { id: 'spread', label: 'Spread / formula' },
                ]}
                value={tab}
                onChange={(t) => {
                    setTab(t);
                    setError(null);
                }}
            />
            {tab === 'compare' ? (
                <>
                    <p className="muted" style={{ marginTop: 0 }}>
                        Adds another symbol to this chart as a line, scaled so both start together at the left edge of
                        the view.
                    </p>
                    <input
                        className="text"
                        style={{ width: '100%' }}
                        placeholder="Search a symbol to compare with…"
                        aria-label="Symbol to compare"
                        // biome-ignore lint/a11y/noAutofocus: the dialog exists to type into this box
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter' && results[0]) void compare(results[0].symbol);
                        }}
                    />
                    {results.map((s) => (
                        <div className="list-row" key={s.symbol}>
                            <b>{s.ticker}</b>
                            <span className="grow muted">{s.description}</span>
                            <span className="muted">{s.provider}</span>
                            <Button onClick={() => void compare(s.symbol)} disabled={busy}>
                                Compare
                            </Button>
                        </div>
                    ))}
                </>
            ) : (
                <>
                    <p className="muted" style={{ marginTop: 0 }}>
                        Charts a formula of up to six symbols as its own series. Use + − × ÷ and brackets, for example{' '}
                        <code>BINANCE:ETHUSDT/BINANCE:BTCUSDT</code> or{' '}
                        <code>(BINANCE:BTCUSDT+BINANCE:ETHUSDT*10)/2</code>.
                    </p>
                    <Field
                        label="Formula"
                        hint="High and low of a formula bar are approximate; open and close are exact."
                    >
                        <input
                            className="text"
                            aria-label="Formula"
                            // biome-ignore lint/a11y/noAutofocus: the dialog exists to type into this box
                            autoFocus
                            value={formula}
                            onChange={(e) => setFormula(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') void applyFormula();
                            }}
                        />
                    </Field>
                    <div className="row">
                        <Button
                            variant="primary"
                            onClick={() => void applyFormula()}
                            disabled={busy || !formula.trim()}
                        >
                            Show on chart
                        </Button>
                        {isFormula && (
                            <span className="muted">
                                The chart currently shows a formula; pick any symbol from the search to leave it.
                            </span>
                        )}
                    </div>
                </>
            )}
            {error && <div className="error">{error}</div>}
        </Modal>
    );
}
