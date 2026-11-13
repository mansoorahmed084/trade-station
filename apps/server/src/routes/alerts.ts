import {
    type Alert,
    AlertEngine,
    type AlertEvent,
    type AlertInput,
    type AlertStore,
    type Delivery,
    deliver,
    emptyState,
    type NotifierConfig,
    renderMessage,
} from '@ts/alerts';
import { newId } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import type { ScriptHost } from '@ts/script-engine';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.ts';
import type { Gateway } from '../gateway.ts';
import type { ScriptStore } from './scripts.ts';

const LOG_KEEP = 10_000;

/** Alerts and their fire log in SQLite. Each alert is one JSON document. */
export class SqliteAlertStore implements AlertStore {
    private db: Db;
    private inserts = 0;

    constructor(db: Db) {
        this.db = db;
    }

    list(): Alert[] {
        const rows = this.db.sql.prepare('SELECT data FROM alerts').all() as { data: string }[];
        const out: Alert[] = [];
        for (const r of rows) {
            try {
                const alert = JSON.parse(r.data) as Alert;
                alert.state = { ...emptyState(), ...alert.state };
                out.push(alert);
            } catch {}
        }
        return out;
    }

    save(alert: Alert): void {
        this.db.sql
            .prepare(
                'INSERT INTO alerts (id, data, active, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, active = excluded.active, updated_at = excluded.updated_at',
            )
            .run(alert.id, JSON.stringify(alert), alert.active ? 1 : 0, alert.updatedAt);
    }

    remove(id: string): void {
        this.db.sql.prepare('DELETE FROM alerts WHERE id = ?').run(id);
    }

    appendLog(event: AlertEvent): void {
        this.db.sql
            .prepare('INSERT INTO alert_log (id, alert_id, time, data) VALUES (?, ?, ?, ?)')
            .run(event.id, event.alertId, event.time, JSON.stringify(event));
        // Trim now and then rather than on every insert.
        if (++this.inserts % 200 === 0) {
            this.db.sql
                .prepare('DELETE FROM alert_log WHERE id NOT IN (SELECT id FROM alert_log ORDER BY time DESC LIMIT ?)')
                .run(LOG_KEEP);
        }
    }

    updateLog(event: AlertEvent): void {
        this.db.sql.prepare('UPDATE alert_log SET data = ? WHERE id = ?').run(JSON.stringify(event), event.id);
    }

    log(limit: number, alertId?: string): AlertEvent[] {
        const rows = (
            alertId
                ? this.db.sql
                      .prepare('SELECT data FROM alert_log WHERE alert_id = ? ORDER BY time DESC LIMIT ?')
                      .all(alertId, limit)
                : this.db.sql.prepare('SELECT data FROM alert_log ORDER BY time DESC LIMIT ?').all(limit)
        ) as { data: string }[];
        return rows.map((r) => JSON.parse(r.data) as AlertEvent);
    }

    clearLog(): void {
        this.db.sql.exec('DELETE FROM alert_log');
    }
}

export interface AlertDeps {
    db: Db;
    data: MarketDataService;
    scriptHost: ScriptHost;
    scripts: ScriptStore;
    gateway: Gateway;
    notifier: NotifierConfig;
    log: (message: string) => void;
}

/** Build the alert engine on the server's own data, scripts and storage, and announce fires to connected clients. */
export function createAlerts(deps: AlertDeps): { engine: AlertEngine; store: SqliteAlertStore } {
    const store = new SqliteAlertStore(deps.db);
    const engine = new AlertEngine({
        data: deps.data,
        store,
        scripts: {
            run: (source, symbol, timeframe, opts) => deps.scriptHost.run(source, symbol, timeframe, opts),
            resolve: (id) => deps.scripts.get(id)?.source ?? null,
        },
        deliver: async (event, alert): Promise<Delivery[]> => {
            const outside = await deliver(event, alert, deps.notifier);
            return alert.notify.app === false ? outside : [{ channel: 'app', ok: true }, ...outside];
        },
        log: deps.log,
    });
    // The in-app channel: every connected client listening on `alerts` hears it at once.
    engine.events.on('fired', (event) =>
        deps.gateway.publish('alerts', { type: 'fired', event, app: engine.get(event.alertId)?.notify.app !== false }),
    );
    engine.events.on('changed', (change) => deps.gateway.publish('alerts', { type: 'changed', ...change }));
    return { engine, store };
}

export function registerAlertRoutes(
    server: FastifyInstance,
    deps: {
        engine: AlertEngine;
        store: SqliteAlertStore;
        data: MarketDataService;
        gateway: Gateway;
        notifier: NotifierConfig;
    },
): void {
    const { engine, store } = deps;

    server.get('/api/alerts', async () => engine.list());

    /** Which outside channels the server has credentials for. Never the credentials themselves. */
    server.get('/api/alerts/channels', async () => ({
        telegram: !!deps.notifier.telegramToken,
        email: !!deps.notifier.smtpUrl,
    }));

    server.get('/api/alerts/log', async (req) => {
        const q = req.query as { limit?: string; alertId?: string };
        return store.log(Math.min(1000, Math.max(1, Number(q.limit ?? 200) || 200)), q.alertId || undefined);
    });

    server.delete('/api/alerts/log', async (_req, reply) => {
        store.clearLog();
        return reply.code(204).send();
    });

    server.post('/api/alerts', async (req, reply) =>
        reply.code(201).send(await engine.create((req.body ?? {}) as AlertInput)),
    );

    server.put('/api/alerts/:id', async (req, reply) => {
        const alert = await engine.update((req.params as any).id, (req.body ?? {}) as AlertInput);
        return alert ?? reply.code(404).send({ error: 'alert not found' });
    });

    server.post('/api/alerts/:id/active', async (req, reply) => {
        const alert = await engine.setActive((req.params as any).id, !!(req.body as any)?.active);
        return alert ?? reply.code(404).send({ error: 'alert not found' });
    });

    server.delete('/api/alerts/:id', async (req, reply) => {
        return engine.remove((req.params as any).id)
            ? reply.code(204).send()
            : reply.code(404).send({ error: 'alert not found' });
    });

    /** Send a sample notification through every channel of an alert, without touching its state or the log. */
    server.post('/api/alerts/:id/test', async (req, reply) => {
        const alert = engine.get((req.params as any).id);
        if (!alert) return reply.code(404).send({ error: 'alert not found' });
        const symbol = alert.symbols[0];
        const now = Date.now();
        const bar = (await deps.data.getBars(symbol, alert.timeframe, { limit: 1 })).last() ?? {
            time: now,
            open: 0,
            high: 0,
            low: 0,
            close: 0,
            volume: 0,
        };
        const info = await deps.data.describe(symbol);
        const event: AlertEvent = {
            id: newId('test'),
            alertId: alert.id,
            alertName: alert.name,
            symbol,
            timeframe: alert.timeframe,
            time: now,
            barTime: bar.time,
            price: bar.close,
            message: `[test] ${renderMessage(alert.message.trim() || '{{alert_name}}: {{ticker}} at {{close}}', { alertName: alert.name, symbol, timeframe: alert.timeframe, bar, now, tickSize: info.tickSize })}`,
            late: false,
            sound: !!alert.notify.sound,
            deliveries: [],
        };
        event.deliveries = await deliver(event, alert, deps.notifier);
        if (alert.notify.app !== false) {
            deps.gateway.publish('alerts', { type: 'fired', event, app: true, test: true });
            event.deliveries.unshift({ channel: 'app', ok: true });
        }
        return event;
    });
}
