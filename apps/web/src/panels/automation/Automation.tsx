import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { timeframeLabel } from '@ts/core';
import { useEffect, useMemo, useState } from 'react';
import {
    createRunner,
    createWebhook,
    deleteRunner,
    deleteWebhook,
    loadAudit,
    type RiskRules,
    type Runner,
    resumeTrading,
    runnerAction,
    saveRisk,
    updateWebhook,
    useAutomation,
    type VerifyResult,
    verifyRunner,
    webhookUrl,
} from '../../lib/automation-store.ts';
import type { ServerClient } from '../../lib/client.ts';
import { useTrading } from '../../lib/trading-store.ts';
import { useChartMarket } from '../../lib/use-chart-market.ts';
import { Button, Tabs } from '../../ui.tsx';

type Tab = 'strategies' | 'webhooks' | 'risk' | 'audit';

const time = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(5, 16).replace('T', ' ') : '—');
const num = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 8 });
const money = (v: number) =>
    `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

/** The automation dashboard: strategies running live, webhooks, risk rules and the audit log. */
export function Automation({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const [tab, setTab] = useState<Tab>('strategies');
    const runners = useAutomation((s) => s.runners);
    const halt = useAutomation((s) => s.halt);
    const list = Object.values(runners).sort((a, b) => b.createdAt - a.createdAt);
    const running = list.filter((r) => r.state.status === 'running').length;
    return (
        <div className="auto" data-testid="automation">
            {halt && (
                <div className="halt-banner" data-testid="halt-banner">
                    <b>Trading is halted</b> since {time(halt.at)} UTC — {halt.reason}. Strategies and webhooks cannot
                    place orders.
                    <span className="grow" />
                    <Button onClick={() => void resumeTrading().catch(() => {})} data-testid="resume">
                        Resume trading
                    </Button>
                </div>
            )}
            <Tabs
                tabs={[
                    { id: 'strategies', label: `Strategies (${running} running)` },
                    { id: 'webhooks', label: 'Webhooks' },
                    { id: 'risk', label: 'Risk rules' },
                    { id: 'audit', label: 'Audit log' },
                ]}
                value={tab}
                onChange={setTab}
            />
            <div className="auto-body">
                {tab === 'strategies' && <Strategies client={client} workspace={workspace} runners={list} />}
                {tab === 'webhooks' && <Webhooks />}
                {tab === 'risk' && <Risk />}
                {tab === 'audit' && <Audit />}
            </div>
        </div>
    );
}

function Strategies({
    client,
    workspace,
    runners,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    runners: Runner[];
}) {
    const [open, setOpen] = useState<string | null>(null);
    const [creating, setCreating] = useState(runners.length === 0);
    const selected = runners.find((r) => r.id === open) ?? null;
    return (
        <div className="auto-strategies">
            <div className="row">
                <Button
                    variant={creating ? 'ghost' : 'primary'}
                    onClick={() => setCreating(!creating)}
                    data-testid="new-runner"
                >
                    {creating ? 'Close' : 'Run a strategy live'}
                </Button>
                <span className="muted">
                    Each closed bar, a running strategy’s position is worked out and the difference traded through the
                    risk rules.
                </span>
            </div>
            {creating && <NewRunner client={client} workspace={workspace} onDone={() => setCreating(false)} />}
            {runners.length > 0 && (
                <table className="grid-table rows-click" data-testid="runners">
                    <thead>
                        <tr>
                            <th>Strategy</th>
                            <th>Market</th>
                            <th>Trades on</th>
                            <th>Status</th>
                            <th className="num">Wants</th>
                            <th className="num">Holds</th>
                            <th className="num">Realised</th>
                            <th className="num">Fills</th>
                            <th>Last bar</th>
                            <th className="num">Divergences</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {runners.map((r) => {
                            const unexplained = r.state.divergences.filter((d) => !d.explained).length;
                            return (
                                <tr
                                    key={r.id}
                                    onClick={() => setOpen(open === r.id ? null : r.id)}
                                    data-testid="runner-row"
                                    className={open === r.id ? 'on' : ''}
                                >
                                    <td>{r.name}</td>
                                    <td>
                                        {r.symbol} · {timeframeLabel(r.timeframe)}
                                    </td>
                                    <td>
                                        <span className={`mode-${r.mode}`}>
                                            {r.mode === 'shadow'
                                                ? 'shadow (nothing sent)'
                                                : (r.accountForOrders ?? '—')}
                                        </span>
                                    </td>
                                    <td>
                                        <span className={`pill pill-${r.state.status}`} title={r.state.error}>
                                            {r.state.status}
                                        </span>
                                        {r.state.status === 'running' && !r.state.following && (
                                            <span className="muted"> waiting for a signal</span>
                                        )}
                                    </td>
                                    <td className="num">{num(r.state.target)}</td>
                                    <td className="num">{num(r.state.held)}</td>
                                    <td className={`num ${tone(r.state.realized)}`}>{money(r.state.realized)}</td>
                                    <td className="num">{r.state.fills}</td>
                                    <td>{time(r.state.lastBar)}</td>
                                    <td className="num">
                                        {r.state.divergences.length - unexplained > 0 && (
                                            <span className="muted">
                                                {r.state.divergences.length - unexplained} explained{' '}
                                            </span>
                                        )}
                                        <span className={unexplained ? 'neg' : ''}>{unexplained} unexplained</span>
                                    </td>
                                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                                        {r.state.status === 'running' ? (
                                            <button
                                                type="button"
                                                className="link"
                                                onClick={() => void runnerAction(r.id, 'stop').catch(() => {})}
                                            >
                                                Stop
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                className="link"
                                                onClick={() => void runnerAction(r.id, 'start').catch(() => {})}
                                                data-testid="runner-start"
                                            >
                                                Start
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            className="link danger"
                                            onClick={() => void deleteRunner(r.id).catch(() => {})}
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {selected && <RunnerDetail runner={selected} />}
        </div>
    );
}

function NewRunner({
    client,
    workspace,
    onDone,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    onDone: () => void;
}) {
    const market = useChartMarket(workspace);
    const accounts = useTrading((s) => s.accounts);
    const [natives, setNatives] = useState<{ id: string; title: string }[]>([]);
    const [scripts, setScripts] = useState<{ id: string; name: string }[]>([]);
    const [strategy, setStrategy] = useState('native:ema-cross');
    const [symbol, setSymbol] = useState('');
    const [timeframe, setTimeframe] = useState('');
    const [mode, setMode] = useState('paper');
    const [bars, setBars] = useState(2000);
    const [startWith, setStartWith] = useState<'next-signal' | 'now'>('next-signal');
    const [notifyUrl, setNotifyUrl] = useState('');
    const [units, setUnits] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        client
            .json<{ id: string; title: string }[]>('/api/backtest/strategies')
            .then(setNatives)
            .catch(() => {});
        client
            .json<{ id: string; name: string; kind: string | null }[]>('/api/scripts')
            .then((l) => setScripts(l.filter((s) => s.kind === 'strategy')))
            .catch(() => {});
    }, [client]);
    useEffect(() => {
        if (market && !symbol) {
            setSymbol(market.symbol);
            setTimeframe(market.timeframe);
        }
    }, [market, symbol]);
    const submit = async () => {
        setBusy(true);
        const [kind, id] = [strategy.slice(0, strategy.indexOf(':')), strategy.slice(strategy.indexOf(':') + 1)];
        const account = mode.startsWith('account:') ? mode.slice(8) : undefined;
        try {
            await createRunner({
                strategy: kind === 'native' ? { kind, id } : { kind: 'pine', scriptId: id },
                symbol,
                timeframe,
                mode: account ? 'account' : mode,
                accountId: account,
                bars,
                startWith,
                qty: units.trim() ? Number(units) : undefined,
                notify: notifyUrl.trim() ? { webhook: { url: notifyUrl.trim() } } : undefined,
            });
            onDone();
        } catch {
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="new-runner" data-testid="new-runner-form">
            <label className="field">
                <span className="field-label">Strategy</span>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value)} data-testid="runner-strategy">
                    <optgroup label="Built in">
                        {natives.map((s) => (
                            <option key={s.id} value={`native:${s.id}`}>
                                {s.title}
                            </option>
                        ))}
                    </optgroup>
                    <optgroup label="Pine strategies">
                        {scripts.map((s) => (
                            <option key={s.id} value={`pine:${s.id}`}>
                                {s.name}
                            </option>
                        ))}
                    </optgroup>
                </select>
            </label>
            <label className="field">
                <span className="field-label">Symbol</span>
                <input value={symbol} onChange={(e) => setSymbol(e.target.value)} data-testid="runner-symbol" />
            </label>
            <label className="field">
                <span className="field-label">Timeframe</span>
                <input value={timeframe} onChange={(e) => setTimeframe(e.target.value)} placeholder="60" />
            </label>
            <label className="field">
                <span className="field-label">Trades on</span>
                <select value={mode} onChange={(e) => setMode(e.target.value)} data-testid="runner-mode">
                    <option value="paper">Paper account</option>
                    <option value="shadow">Shadow: record decisions, send nothing</option>
                    {accounts
                        .filter((a) => a.kind !== 'paper')
                        .map((a) => (
                            <option key={a.id} value={`account:${a.id}`}>
                                {a.name} {a.kind === 'live' ? '(LIVE)' : '(testnet)'}
                            </option>
                        ))}
                </select>
            </label>
            <label className="field">
                <span className="field-label">History per decision (bars)</span>
                <input
                    type="number"
                    min={100}
                    max={20000}
                    value={bars}
                    onChange={(e) => setBars(Number(e.target.value) || 2000)}
                />
            </label>
            <label className="field">
                <span className="field-label">Start</span>
                <select value={startWith} onChange={(e) => setStartWith(e.target.value as 'next-signal' | 'now')}>
                    <option value="next-signal">At the strategy’s next signal</option>
                    <option value="now">Take on its position now</option>
                </select>
            </label>
            <label className="field">
                <span className="field-label">Units per entry (empty: the strategy’s own sizing)</span>
                <input
                    type="number"
                    min={0}
                    value={units}
                    onChange={(e) => setUnits(e.target.value)}
                    placeholder="strategy’s own"
                    data-testid="runner-units"
                />
            </label>
            <label className="field wide">
                <span className="field-label">Announce fills to (webhook URL, optional)</span>
                <input value={notifyUrl} onChange={(e) => setNotifyUrl(e.target.value)} placeholder="https://…" />
            </label>
            <div className="row">
                <Button
                    variant="primary"
                    disabled={busy || !symbol || !timeframe}
                    onClick={submit}
                    data-testid="runner-create"
                >
                    {busy ? 'Checking…' : 'Create'}
                </Button>
                <span className="muted">It is created stopped: start it from the list.</span>
            </div>
        </div>
    );
}

function RunnerDetail({ runner }: { runner: Runner }) {
    const [check, setCheck] = useState<VerifyResult | null>(null);
    const [busy, setBusy] = useState(false);
    const decisions = useMemo(() => [...runner.state.decisions].reverse().slice(0, 200), [runner.state.decisions]);
    return (
        <div className="runner-detail" data-testid="runner-detail">
            <div className="row">
                <b>{runner.name}</b>
                {runner.state.error && <span className="error-text">{runner.state.error}</span>}
                <span className="grow" />
                <Button
                    variant="ghost"
                    disabled={busy || runner.state.decisions.length === 0}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            setCheck(await verifyRunner(runner.id));
                        } catch {
                        } finally {
                            setBusy(false);
                        }
                    }}
                    data-testid="runner-verify"
                >
                    {busy ? 'Replaying…' : 'Check against a backtest'}
                </Button>
            </div>
            {check && (
                <div className="comparison" data-testid="runner-check">
                    {check.mismatches.length === 0
                        ? `All ${check.checked} decisions want the same side as a backtest of the same bars.`
                        : `${check.mismatches.length} of ${check.checked} decisions differ from a backtest of the same bars: ${check.mismatches
                              .slice(0, 5)
                              .map((m) => `${time(m.time)} live ${m.live}, backtest ${m.replay}`)
                              .join('; ')}.`}
                    {check.sized > 0 &&
                        ` On ${check.sized} the size differs by up to ${check.maxSizeDiffPct.toFixed(2)}%: the strategy sizes by equity, which a window of recent history sees differently from one long run. Set units per entry for exact sizes.`}
                </div>
            )}
            {runner.state.divergences.length > 0 && (
                <>
                    <h4>Divergences</h4>
                    <table className="grid-table">
                        <tbody>
                            {[...runner.state.divergences]
                                .reverse()
                                .slice(0, 50)
                                .map((d) => (
                                    <tr key={`${d.time}-${d.reason}`}>
                                        <td>{time(d.time)}</td>
                                        <td>
                                            wanted {num(d.wanted)}, held {num(d.held)}
                                        </td>
                                        <td className={d.explained ? 'muted' : 'neg'}>
                                            {d.explained ? 'explained' : 'unexplained'}
                                        </td>
                                        <td>{d.reason}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </>
            )}
            <h4>Decisions</h4>
            <table className="grid-table" data-testid="decisions">
                <thead>
                    <tr>
                        <th>Bar (UTC)</th>
                        <th className="num">Wanted</th>
                        <th className="num">Held before</th>
                        <th className="num">Close</th>
                        <th>Order</th>
                        <th>Note</th>
                    </tr>
                </thead>
                <tbody>
                    {decisions.map((d) => (
                        <tr key={d.time}>
                            <td>{time(d.time)}</td>
                            <td className="num">{num(d.target)}</td>
                            <td className="num">{num(d.heldBefore)}</td>
                            <td className="num">{num(d.price)}</td>
                            <td>
                                {d.order
                                    ? `${d.order.side} ${num(d.order.qty)} · ${d.order.status}${d.order.fill ? ` at ${num(d.order.fill)}` : ''}`
                                    : ''}
                            </td>
                            <td className="muted">{d.note ?? ''}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Webhooks() {
    const hooks = useAutomation((s) => s.webhooks);
    const accounts = useTrading((s) => s.accounts);
    const [name, setName] = useState('TradingView alerts');
    const [account, setAccount] = useState('paper');
    const [qty, setQty] = useState(1);
    const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
    return (
        <div className="auto-webhooks" data-testid="webhooks">
            <p className="muted">
                Point a TradingView alert’s webhook at an address below and put the message in its body. TradingView can
                only reach this machine through a public address (a tunnel such as cloudflared or ngrok in front of port
                8787).
            </p>
            <div className="row wrap">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Webhook name" />
                <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
                    {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                            {a.name}
                        </option>
                    ))}
                </select>
                <label className="inline">
                    Default size
                    <input type="number" min={0} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
                </label>
                <Button
                    variant="primary"
                    onClick={() => void createWebhook({ name, accountId: account, defaultQty: qty }).catch(() => {})}
                    data-testid="webhook-create"
                >
                    Create webhook
                </Button>
            </div>
            {hooks.map((h) => {
                const url = webhookUrl(h.id);
                const message = JSON.stringify(
                    {
                        passphrase: h.passphrase,
                        ticker: '{{exchange}}:{{ticker}}',
                        action: '{{strategy.order.action}}',
                        contracts: '{{strategy.order.contracts}}',
                        position_size: '{{strategy.position_size}}',
                    },
                    null,
                    2,
                );
                return (
                    <div key={h.id} className="webhook" data-testid="webhook">
                        <div className="row">
                            <b>{h.name}</b>
                            <span className="muted">
                                → {h.accountId} · {h.uses} message{h.uses === 1 ? '' : 's'}
                                {h.lastUsedAt ? `, last ${time(h.lastUsedAt)}` : ''}
                            </span>
                            <span className="grow" />
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={h.enabled}
                                    onChange={(e) =>
                                        void updateWebhook(h.id, { enabled: e.target.checked }).catch(() => {})
                                    }
                                />
                                On
                            </label>
                            <button
                                type="button"
                                className="link"
                                onClick={() => void updateWebhook(h.id, { rotate: true }).catch(() => {})}
                            >
                                New passphrase
                            </button>
                            <button
                                type="button"
                                className="link danger"
                                onClick={() => void deleteWebhook(h.id).catch(() => {})}
                            >
                                Delete
                            </button>
                        </div>
                        <div className="row">
                            <code className="grow" data-testid="webhook-url">
                                {url}
                            </code>
                            <button type="button" className="link" onClick={() => copy(url)}>
                                Copy address
                            </button>
                        </div>
                        <details>
                            <summary>Alert message for a TradingView strategy</summary>
                            <pre>{message}</pre>
                            <button type="button" className="link" onClick={() => copy(message)}>
                                Copy message
                            </button>
                        </details>
                    </div>
                );
            })}
        </div>
    );
}

function Risk() {
    const rules = useAutomation((s) => s.rules);
    const field = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    const [draft, setDraft] = useState({
        maxPosition: typeof rules.maxPosition === 'number' ? String(rules.maxPosition) : '',
        maxPositionValue: field(rules.maxPositionValue),
        maxOrderQty: field(rules.maxOrderQty),
        maxOrderValue: field(rules.maxOrderValue),
        maxDailyLoss: field(rules.maxDailyLoss),
        maxOrdersPerMinute: field(rules.maxOrdersPerMinute),
        hoursStart: rules.tradingHours?.start ?? '',
        hoursEnd: rules.tradingHours?.end ?? '',
        allowList: (rules.allowList ?? []).join(', '),
    });
    const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setDraft({ ...draft, [k]: e.target.value });
    const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
    const save = () => {
        const next: RiskRules = {
            maxPosition: n(draft.maxPosition),
            maxPositionValue: n(draft.maxPositionValue),
            maxOrderQty: n(draft.maxOrderQty),
            maxOrderValue: n(draft.maxOrderValue),
            maxDailyLoss: n(draft.maxDailyLoss),
            maxOrdersPerMinute: n(draft.maxOrdersPerMinute),
            tradingHours: draft.hoursStart && draft.hoursEnd ? { start: draft.hoursStart, end: draft.hoursEnd } : null,
            allowList: draft.allowList
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean),
        };
        void saveRisk(next).catch(() => {});
    };
    const rows: [keyof typeof draft, string][] = [
        ['maxPosition', 'Largest position per symbol (units)'],
        ['maxPositionValue', 'Largest position value per symbol'],
        ['maxOrderQty', 'Largest order (units)'],
        ['maxOrderValue', 'Largest order value'],
        ['maxDailyLoss', 'Daily loss that stops new positions'],
        ['maxOrdersPerMinute', 'Orders per minute, per account'],
    ];
    return (
        <div className="auto-risk" data-testid="risk-rules">
            <p className="muted">
                These rules apply to every order a strategy or a webhook sends. Strategies cannot get around them. Leave
                a field empty for no limit.
            </p>
            <div className="grid-3">
                {rows.map(([k, label]) => (
                    <label key={k} className="field">
                        <span className="field-label">{label}</span>
                        <input type="number" min={0} value={draft[k]} onChange={set(k)} data-testid={`risk-${k}`} />
                    </label>
                ))}
                <label className="field">
                    <span className="field-label">Trading hours from (UTC, HH:MM)</span>
                    <input value={draft.hoursStart} onChange={set('hoursStart')} placeholder="any time" />
                </label>
                <label className="field">
                    <span className="field-label">until</span>
                    <input value={draft.hoursEnd} onChange={set('hoursEnd')} placeholder="any time" />
                </label>
                <label className="field">
                    <span className="field-label">Only these symbols (comma-separated)</span>
                    <input value={draft.allowList} onChange={set('allowList')} placeholder="any symbol" />
                </label>
            </div>
            <Button variant="primary" onClick={save} data-testid="risk-save">
                Save rules
            </Button>
        </div>
    );
}

function Audit() {
    const audit = useAutomation((s) => s.audit);
    const [actor, setActor] = useState('');
    useEffect(() => {
        void loadAudit({ actor: actor || undefined }).catch(() => {});
        const timer = setInterval(() => void loadAudit({ actor: actor || undefined }).catch(() => {}), 3000);
        return () => clearInterval(timer);
    }, [actor]);
    return (
        <div className="auto-audit" data-testid="audit">
            <div className="row">
                <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Who">
                    <option value="">Everyone</option>
                    <option value="user">People</option>
                    <option value="strategy">Strategies</option>
                    <option value="webhook">Webhooks</option>
                </select>
                <span className="muted">
                    Every order request and its outcome, every refusal and every change to trading settings. Entries are
                    never changed or removed.
                </span>
            </div>
            <table className="grid-table">
                <thead>
                    <tr>
                        <th>Time (UTC)</th>
                        <th>Who</th>
                        <th>Action</th>
                        <th>Account</th>
                        <th>Symbol</th>
                        <th>Outcome</th>
                        <th>Detail</th>
                    </tr>
                </thead>
                <tbody>
                    {audit.map((a) => (
                        <tr key={a.id} data-testid="audit-row">
                            <td>{new Date(a.time).toISOString().slice(5, 19).replace('T', ' ')}</td>
                            <td>{a.actor}</td>
                            <td>{a.action}</td>
                            <td>{a.account ?? ''}</td>
                            <td>{a.symbol ?? ''}</td>
                            <td className={`audit-${a.outcome}`}>{a.outcome}</td>
                            <td className="muted audit-detail" title={JSON.stringify(a.detail ?? {})}>
                                {describe(a)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function describe(a: { detail?: Record<string, unknown> }): string {
    const d = a.detail ?? {};
    const parts: string[] = [];
    if (d.side) parts.push(`${d.side} ${d.qty ?? ''} ${d.type ?? ''}`.trim());
    if (d.limit) parts.push(`limit ${d.limit}`);
    if (d.stop) parts.push(`stop ${d.stop}`);
    if (d.status) parts.push(String(d.status));
    if (d.reason) parts.push(String(d.reason));
    if (d.name) parts.push(String(d.name));
    if (d.cancelled !== undefined) parts.push(`${d.cancelled} cancelled, ${d.closed} closed`);
    return parts.join(' · ');
}
