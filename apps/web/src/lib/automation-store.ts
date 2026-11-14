import { create } from 'zustand';
import { useAlerts } from './alerts-store.ts';
import type { ServerClient } from './client.ts';
import { useTrading } from './trading-store.ts';

/** Shapes from the server's automation API (kept local: the server types pull in Node modules). */
export interface Decision {
    time: number;
    target: number;
    heldBefore: number;
    price: number;
    order?: { id: string; side: 'buy' | 'sell'; qty: number; status: string; fill: number | null; reason?: string };
    note?: string;
}

export interface Divergence {
    time: number;
    wanted: number;
    held: number;
    explained: boolean;
    reason: string;
}

export interface Runner {
    id: string;
    name: string;
    strategy: { kind: 'native'; id: string } | { kind: 'pine'; scriptId?: string; source?: string };
    symbol: string;
    timeframe: string;
    mode: 'paper' | 'shadow' | 'account';
    accountId?: string;
    bars: number;
    startWith: 'next-signal' | 'now';
    notify?: { webhook?: { url: string } };
    qty?: number;
    createdAt: number;
    accountForOrders: string | null;
    state: {
        status: 'running' | 'stopped' | 'halted' | 'error';
        error?: string;
        following: boolean;
        target: number;
        held: number;
        avgPrice: number;
        realized: number;
        fills: number;
        lastBar: number | null;
        startedAt: number | null;
        decisions: Decision[];
        divergences: Divergence[];
    };
}

export interface Webhook {
    id: string;
    name: string;
    passphrase: string;
    accountId: string;
    defaultQty: number;
    enabled: boolean;
    createdAt: number;
    lastUsedAt?: number;
    uses: number;
}

export interface RiskRules {
    maxPosition?: number | Record<string, number>;
    maxPositionValue?: number;
    maxOrderQty?: number;
    maxOrderValue?: number;
    maxDailyLoss?: number;
    maxOrdersPerMinute?: number;
    tradingHours?: { start: string; end: string } | null;
    allowList?: string[];
}

export interface Halt {
    at: number;
    reason: string;
    by: string;
}

export interface AuditEntry {
    id: number;
    time: number;
    actor: string;
    action: string;
    account?: string;
    symbol?: string;
    outcome: 'ok' | 'rejected' | 'error' | 'info';
    detail?: Record<string, unknown>;
}

interface AutomationStore {
    ready: boolean;
    runners: Record<string, Runner>;
    webhooks: Webhook[];
    rules: RiskRules;
    halt: Halt | null;
    audit: AuditEntry[];
}

export const useAutomation = create<AutomationStore>(() => ({
    ready: false,
    runners: {},
    webhooks: [],
    rules: {},
    halt: null,
    audit: [],
}));

let client: ServerClient | null = null;

const headers = (body?: unknown): Record<string, string> => ({
    'x-ts-account': useTrading.getState().accountId,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
});

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!client) throw new Error('not connected');
    return client.json<T>(path, {
        method,
        headers: headers(body),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function failed(err: unknown, title: string): never {
    useAlerts.getState().toast({ kind: 'error', title, text: String((err as Error)?.message ?? err) });
    throw err;
}

export async function loadAutomation(): Promise<void> {
    const [runners, webhooks, risk] = await Promise.all([
        call<Runner[]>('GET', '/api/automation/runners'),
        call<Webhook[]>('GET', '/api/automation/webhooks'),
        call<{ rules: RiskRules; halt: Halt | null }>('GET', '/api/trading/risk'),
    ]);
    useAutomation.setState({
        ready: true,
        runners: Object.fromEntries(runners.map((r) => [r.id, r])),
        webhooks,
        rules: risk.rules,
        halt: risk.halt,
    });
}

export async function loadAudit(filter: { actor?: string } = {}): Promise<void> {
    const q = new URLSearchParams({ limit: '300' });
    if (filter.actor) q.set('actor', filter.actor);
    useAutomation.setState({ audit: await call<AuditEntry[]>('GET', `/api/audit?${q}`) });
}

/** Connect to the server: the halt state is wanted everywhere, so this runs at start-up. */
export function bindAutomation(c: ServerClient): () => void {
    client = c;
    void loadAutomation().catch(() => {});
    const offs = [
        c.listen<any>('automation', (event) => {
            if (event?.type === 'runner') {
                useAutomation.setState((s) => ({ runners: { ...s.runners, [event.runner.id]: event.runner } }));
            } else if (event?.type === 'strategy-fill') {
                useAlerts
                    .getState()
                    .toast(
                        { kind: 'info', title: event.name, text: event.message.replace(`${event.name}: `, '') },
                        5000,
                    );
            }
        }),
        c.listen<any>('trading', (event) => {
            if (event?.type !== 'halt') return;
            useAutomation.setState({ halt: event.halt });
            if (event.halt)
                useAlerts.getState().toast({ kind: 'error', title: 'Trading halted', text: event.halt.reason }, 10_000);
            void loadAutomation().catch(() => {});
        }),
        c.events.on('status', (status) => {
            if (status === 'open') void loadAutomation().catch(() => {});
        }),
    ];
    return () => {
        for (const off of offs) off();
        client = null;
    };
}

export async function createRunner(input: Record<string, unknown>): Promise<Runner> {
    try {
        const r = await call<Runner>('POST', '/api/automation/runners', input);
        useAutomation.setState((s) => ({ runners: { ...s.runners, [r.id]: r } }));
        return r;
    } catch (err) {
        return failed(err, 'Strategy not created');
    }
}

export async function runnerAction(id: string, action: 'start' | 'stop'): Promise<void> {
    try {
        const r = await call<Runner>('POST', `/api/automation/runners/${id}/${action}`);
        useAutomation.setState((s) => ({ runners: { ...s.runners, [r.id]: r } }));
    } catch (err) {
        failed(err, action === 'start' ? 'Strategy not started' : 'Strategy not stopped');
    }
}

export async function deleteRunner(id: string): Promise<void> {
    try {
        await call('DELETE', `/api/automation/runners/${id}`);
        useAutomation.setState((s) => {
            const runners = { ...s.runners };
            delete runners[id];
            return { runners };
        });
    } catch (err) {
        failed(err, 'Strategy not deleted');
    }
}

export interface VerifyResult {
    checked: number;
    mismatches: { time: number; live: number; replay: number }[];
    sized: number;
    maxSizeDiffPct: number;
}

export async function verifyRunner(id: string): Promise<VerifyResult> {
    try {
        return await call('POST', `/api/automation/runners/${id}/verify`);
    } catch (err) {
        return failed(err, 'Could not check the strategy');
    }
}

export async function saveRisk(rules: RiskRules): Promise<void> {
    try {
        const saved = await call<{ rules: RiskRules; halt: Halt | null }>('PUT', '/api/trading/risk', rules);
        useAutomation.setState({ rules: saved.rules, halt: saved.halt });
    } catch (err) {
        failed(err, 'Risk rules not saved');
    }
}

export async function killSwitch(
    flatten: boolean,
    reason: string,
): Promise<{ cancelled: number; closed: number; errors: string[] }> {
    try {
        const r = await call<{ halt: Halt; cancelled: number; closed: number; errors: string[] }>(
            'POST',
            '/api/trading/kill',
            { flatten, reason },
        );
        useAutomation.setState({ halt: r.halt });
        return r;
    } catch (err) {
        return failed(err, 'Kill switch failed');
    }
}

export async function resumeTrading(): Promise<void> {
    try {
        await call('POST', '/api/trading/resume');
        useAutomation.setState({ halt: null });
    } catch (err) {
        failed(err, 'Trading not resumed');
    }
}

export async function createWebhook(input: { name: string; accountId: string; defaultQty: number }): Promise<void> {
    try {
        const hook = await call<Webhook>('POST', '/api/automation/webhooks', input);
        useAutomation.setState((s) => ({ webhooks: [...s.webhooks, hook] }));
    } catch (err) {
        failed(err, 'Webhook not created');
    }
}

export async function updateWebhook(id: string, patch: Record<string, unknown>): Promise<void> {
    try {
        const hook = await call<Webhook>('PATCH', `/api/automation/webhooks/${id}`, patch);
        useAutomation.setState((s) => ({ webhooks: s.webhooks.map((h) => (h.id === id ? hook : h)) }));
    } catch (err) {
        failed(err, 'Webhook not changed');
    }
}

export async function deleteWebhook(id: string): Promise<void> {
    try {
        await call('DELETE', `/api/automation/webhooks/${id}`);
        useAutomation.setState((s) => ({ webhooks: s.webhooks.filter((h) => h.id !== id) }));
    } catch (err) {
        failed(err, 'Webhook not deleted');
    }
}

/** Where outside programs send orders: the API server's address, not the page's. */
export function webhookUrl(id: string): string {
    const api = client?.base || location.origin.replace(/:5173$/, ':8787');
    return `${api}/api/webhook/${id}`;
}
