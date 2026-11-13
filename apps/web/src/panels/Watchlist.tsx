import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { decimalsOf, newId, type SymbolInfo } from '@ts/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stripChartType } from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';

type Item = { kind: 'symbol'; symbol: string; flag?: string } | { kind: 'section'; title: string };
interface List {
    id: string;
    name: string;
    items: Item[];
}
interface Doc {
    active: string;
    lists: List[];
}

interface Quote {
    last: number;
    prevClose: number;
    tickSize: number;
    description: string;
    error?: string;
}

const FLAGS = ['', '#ef5350', '#ff9800', '#e3b341', '#26a69a', '#29b6f6', '#4c8dff', '#ab47bc'];
const KV_KEY = 'watchlists';

const DEFAULT_DOC = (providers: string[]): Doc => {
    const items: Item[] = [];
    if (providers.includes('BINANCE')) {
        items.push({ kind: 'section', title: 'Crypto' });
        for (const t of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'])
            items.push({ kind: 'symbol', symbol: `BINANCE:${t}` });
    }
    if (providers.includes('SYNTH')) {
        items.push({ kind: 'section', title: 'Synthetic' });
        for (const t of ['ALPHA', 'BETA', 'GAMMA']) items.push({ kind: 'symbol', symbol: `SYNTH:${t}` });
    }
    return { active: 'default', lists: [{ id: 'default', name: 'Watchlist', items }] };
};

function sanitize(raw: unknown): Doc | null {
    const doc = raw as Doc;
    if (!doc || !Array.isArray(doc.lists) || doc.lists.length === 0) return null;
    const lists = doc.lists
        .filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string' && Array.isArray(l.items))
        .map((l) => ({
            id: l.id,
            name: l.name,
            items: l.items.filter(
                (it) =>
                    (it?.kind === 'symbol' && typeof it.symbol === 'string') ||
                    (it?.kind === 'section' && typeof it.title === 'string'),
            ),
        }));
    if (!lists.length) return null;
    return { active: lists.some((l) => l.id === doc.active) ? doc.active : lists[0].id, lists };
}

export function Watchlist({
    client,
    workspace,
    providers,
}: {
    client: ServerClient;
    workspace: VelaWorkspace | null;
    providers: string[];
}) {
    const [doc, setDoc] = useState<Doc | null>(null);
    const [, setTick] = useState(0);
    const [activeSymbol, setActiveSymbol] = useState('');
    const [query, setQuery] = useState('');
    const [suggest, setSuggest] = useState<SymbolInfo[]>([]);
    const [hi, setHi] = useState(0);
    const [dragOver, setDragOver] = useState<number | null>(null);
    const quotes = useRef(new Map<string, Quote>());
    const dirty = useRef(false);
    const dragFrom = useRef<number | null>(null);

    // Load once; save (debounced) on every change.
    useEffect(() => {
        let cancelled = false;
        client.kvGet(KV_KEY).then((raw) => {
            if (cancelled) return;
            let loaded: Doc | null = null;
            try {
                loaded = raw ? sanitize(JSON.parse(raw)) : null;
            } catch {}
            if (loaded) setDoc(loaded);
            else {
                // First run: store the starter list at once, so other features (watchlist alerts) can read it.
                const starter = DEFAULT_DOC(providers);
                client.kvSet(KV_KEY, JSON.stringify(starter));
                setDoc(starter);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [client, providers]);

    const loaded = useRef(false);
    useEffect(() => {
        if (!doc) return;
        if (!loaded.current) {
            loaded.current = true;
            return;
        }
        const timer = setTimeout(() => client.kvSet(KV_KEY, JSON.stringify(doc)), 400);
        return () => clearTimeout(timer);
    }, [doc, client]);

    const list = doc?.lists.find((l) => l.id === doc.active) ?? null;
    const symbols = useMemo(
        () => (list ? list.items.flatMap((it) => (it.kind === 'symbol' ? [it.symbol] : [])) : []),
        [list],
    );
    const symbolsKey = symbols.join(',');

    // Quotes: one snapshot per symbol, then the live daily bar keeps the last price current.
    useEffect(() => {
        if (!symbolsKey) return;
        const wanted = symbolsKey.split(',');
        let cancelled = false;
        const missing = wanted.filter((s) => !quotes.current.has(s));
        if (missing.length) {
            client
                .json<any[]>(`/api/quotes?symbols=${encodeURIComponent(missing.join(','))}`)
                .then((rows) => {
                    if (cancelled) return;
                    for (const r of rows) {
                        quotes.current.set(
                            r.symbol,
                            r.error
                                ? {
                                      last: Number.NaN,
                                      prevClose: Number.NaN,
                                      tickSize: 0.01,
                                      description: '',
                                      error: r.error,
                                  }
                                : r,
                        );
                    }
                    dirty.current = true;
                })
                .catch(() => {});
        }
        const stops = wanted.map((symbol) =>
            client.subscribe(symbol, '1D', (bar) => {
                const q = quotes.current.get(symbol);
                if (!q || q.last === bar.close) return;
                q.last = bar.close;
                dirty.current = true;
            }),
        );
        return () => {
            cancelled = true;
            for (const stop of stops) stop();
        };
    }, [symbolsKey, client]);

    // Repaint at most four times a second, however fast prices move.
    useEffect(() => {
        const timer = setInterval(() => {
            if (!dirty.current) return;
            dirty.current = false;
            setTick((n) => n + 1);
        }, 250);
        return () => clearInterval(timer);
    }, []);

    // Highlight the symbol on the active chart.
    useEffect(() => {
        if (!workspace) return;
        const read = () =>
            setActiveSymbol(stripChartType(String((workspace.chart as any)?.market?.symbol ?? '')).toUpperCase());
        read();
        const offs = [workspace.on('cell:active', read), workspace.on('state:changed', read)];
        const timer = setInterval(read, 1000);
        return () => {
            for (const off of offs) (off as () => void)();
            clearInterval(timer);
        };
    }, [workspace]);

    // Symbol suggestions for the add box.
    useEffect(() => {
        const q = query.trim();
        if (q.length < 1) {
            setSuggest([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(() => {
            client
                .symbols(undefined, q, 12)
                .then((rows) => {
                    if (!cancelled) {
                        setSuggest(rows);
                        setHi(0);
                    }
                })
                .catch(() => {});
        }, 120);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query, client]);

    const update = useCallback((fn: (l: List) => List) => {
        setDoc((d) => (d ? { ...d, lists: d.lists.map((l) => (l.id === d.active ? fn(l) : l)) } : d));
    }, []);

    const addSymbol = (symbol: string) => {
        update((l) =>
            l.items.some((it) => it.kind === 'symbol' && it.symbol === symbol)
                ? l
                : { ...l, items: [...l.items, { kind: 'symbol', symbol }] },
        );
        setQuery('');
        setSuggest([]);
    };

    const open = (symbol: string) => {
        const chart: any = workspace?.chart;
        if (!chart) return;
        setActiveSymbol(symbol.toUpperCase());
        void chart.setMarket({ symbol });
    };

    const move = (from: number, to: number) => {
        if (from === to) return;
        update((l) => {
            const items = [...l.items];
            const [it] = items.splice(from, 1);
            items.splice(from < to ? to - 1 : to, 0, it);
            return { ...l, items };
        });
    };

    if (!doc || !list) return <div className="dock-content" />;

    return (
        <div className="dock-content" data-testid="watchlist">
            <div className="panel-head">
                <select
                    className="text grow"
                    aria-label="Watchlist"
                    value={doc.active}
                    onChange={(e) => setDoc({ ...doc, active: e.target.value })}
                >
                    {doc.lists.map((l) => (
                        <option key={l.id} value={l.id}>
                            {l.name}
                        </option>
                    ))}
                </select>
                <button
                    type="button"
                    className="icon-btn"
                    title="New list"
                    onClick={() => {
                        const name = prompt('Name of the new watchlist');
                        if (!name?.trim()) return;
                        const id = newId('wl');
                        setDoc({ active: id, lists: [...doc.lists, { id, name: name.trim(), items: [] }] });
                    }}
                >
                    +
                </button>
                <button
                    type="button"
                    className="icon-btn"
                    title="Rename list"
                    onClick={() => {
                        const name = prompt('Rename watchlist', list.name);
                        if (name?.trim()) update((l) => ({ ...l, name: name.trim() }));
                    }}
                >
                    ✎
                </button>
                <button
                    type="button"
                    className="icon-btn"
                    title="Delete list"
                    disabled={doc.lists.length < 2}
                    onClick={() => {
                        if (doc.lists.length < 2 || !confirm(`Delete the watchlist "${list.name}"?`)) return;
                        const lists = doc.lists.filter((l) => l.id !== doc.active);
                        setDoc({ active: lists[0].id, lists });
                    }}
                >
                    🗑
                </button>
            </div>
            <div className="wl-add">
                <input
                    className="text"
                    placeholder="Add symbol…"
                    aria-label="Add symbol"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'ArrowDown') setHi((h) => Math.min(suggest.length - 1, h + 1));
                        else if (e.key === 'ArrowUp') setHi((h) => Math.max(0, h - 1));
                        else if (e.key === 'Enter' && suggest[hi]) addSymbol(suggest[hi].symbol);
                        else if (e.key === 'Escape') {
                            setQuery('');
                            setSuggest([]);
                        }
                    }}
                />
                {suggest.length > 0 && (
                    <div className="wl-suggest">
                        {suggest.map((s, i) => (
                            <button
                                key={s.symbol}
                                type="button"
                                className={i === hi ? 'hi' : ''}
                                onClick={() => addSymbol(s.symbol)}
                            >
                                <b>{s.ticker}</b>
                                <span className="muted">{s.description}</span>
                                <span className="venue">{s.provider}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="panel-body">
                {list.items.length === 0 && <div className="empty">This list is empty. Add a symbol above.</div>}
                {list.items.map((it, i) => {
                    const drag = {
                        draggable: true,
                        onDragStart: () => {
                            dragFrom.current = i;
                        },
                        onDragOver: (e: React.DragEvent) => {
                            e.preventDefault();
                            setDragOver(i);
                        },
                        onDragLeave: () => setDragOver((d) => (d === i ? null : d)),
                        onDrop: () => {
                            if (dragFrom.current !== null) move(dragFrom.current, i);
                            dragFrom.current = null;
                            setDragOver(null);
                        },
                    };
                    const remove = (
                        <button
                            type="button"
                            className="icon-btn wl-remove"
                            title="Remove"
                            onClick={(e) => {
                                e.stopPropagation();
                                update((l) => ({ ...l, items: l.items.filter((_, k) => k !== i) }));
                            }}
                        >
                            ×
                        </button>
                    );
                    if (it.kind === 'section') {
                        return (
                            <div
                                key={`section:${it.title}:${list.items.slice(0, i).filter((x) => x.kind === 'section' && x.title === it.title).length}`}
                                className={`wl-section ${dragOver === i ? 'drag-over' : ''}`}
                                {...drag}
                            >
                                <span>{it.title}</span>
                                {remove}
                            </div>
                        );
                    }
                    const q = quotes.current.get(it.symbol);
                    const ticker = it.symbol.slice(it.symbol.indexOf(':') + 1);
                    const chg = q && Number.isFinite(q.last) ? q.last - q.prevClose : Number.NaN;
                    const pct = q && q.prevClose ? (chg / q.prevClose) * 100 : Number.NaN;
                    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : 'muted';
                    return (
                        <div
                            key={it.symbol}
                            className={`wl-row ${it.symbol.toUpperCase() === activeSymbol ? 'active' : ''} ${dragOver === i ? 'drag-over' : ''}`}
                            onClick={() => open(it.symbol)}
                            title={q?.error ?? q?.description ?? it.symbol}
                            {...drag}
                        >
                            <button
                                type="button"
                                className="wl-flag"
                                title="Flag"
                                style={{ background: it.flag || 'transparent' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const next = FLAGS[(FLAGS.indexOf(it.flag ?? '') + 1) % FLAGS.length];
                                    update((l) => ({
                                        ...l,
                                        items: l.items.map((x, k) =>
                                            k === i && x.kind === 'symbol' ? { ...x, flag: next || undefined } : x,
                                        ),
                                    }));
                                }}
                            />
                            <div>
                                <div className="wl-ticker">{ticker}</div>
                            </div>
                            <div className="wl-last">
                                {q && Number.isFinite(q.last)
                                    ? q.last.toFixed(decimalsOf(q.tickSize))
                                    : q?.error
                                      ? '—'
                                      : '…'}
                            </div>
                            <div className={`wl-chg ${cls}`}>
                                {Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : ''}
                            </div>
                            {remove}
                        </div>
                    );
                })}
                <div style={{ padding: 8 }}>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                            const title = prompt('Section title');
                            if (title?.trim())
                                update((l) => ({
                                    ...l,
                                    items: [...l.items, { kind: 'section', title: title.trim() }],
                                }));
                        }}
                    >
                        + Add section
                    </button>
                </div>
            </div>
        </div>
    );
}
