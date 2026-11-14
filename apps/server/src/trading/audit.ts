import type { Db } from '../db.ts';

/**
 * The audit log: every order request and its outcome, every risk refusal, every kill switch and
 * every change to trading settings, with who did it. Rows are only ever added.
 */

export type AuditOutcome = 'ok' | 'rejected' | 'error' | 'info';

export interface AuditEntry {
    id: number;
    time: number;
    /** `user`, `strategy:<id>`, `webhook:<id>` or `system`. */
    actor: string;
    action: string;
    account?: string;
    symbol?: string;
    outcome: AuditOutcome;
    detail?: Record<string, unknown>;
}

export class AuditLog {
    private db: Db;
    private now: () => number;
    private listeners = new Set<(e: AuditEntry) => void>();

    constructor(db: Db, now: () => number = Date.now) {
        this.db = db;
        this.now = now;
    }

    record(entry: Omit<AuditEntry, 'id' | 'time'> & { time?: number }): AuditEntry {
        const time = entry.time ?? this.now();
        const detail = entry.detail ? JSON.stringify(entry.detail).slice(0, 20_000) : null;
        const res = this.db.sql
            .prepare(
                'INSERT INTO audit (time, actor, action, account, symbol, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(time, entry.actor, entry.action, entry.account ?? null, entry.symbol ?? null, entry.outcome, detail);
        const saved: AuditEntry = { ...entry, id: Number(res.lastInsertRowid), time };
        for (const l of this.listeners) l(saved);
        return saved;
    }

    onRecord(listener: (e: AuditEntry) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Newest first. */
    list(filter: { limit?: number; actor?: string; account?: string; before?: number } = {}): AuditEntry[] {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (filter.actor) {
            // `strategy` matches every strategy; `strategy:abc` that one.
            where.push(filter.actor.includes(':') ? 'actor = ?' : "(actor = ? OR actor LIKE ? || ':%')");
            args.push(filter.actor);
            if (!filter.actor.includes(':')) args.push(filter.actor);
        }
        if (filter.account) {
            where.push('account = ?');
            args.push(filter.account);
        }
        if (filter.before) {
            where.push('id < ?');
            args.push(filter.before);
        }
        const limit = Math.min(1000, Math.max(1, Math.round(filter.limit ?? 200)));
        const rows = this.db.sql
            .prepare(
                `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`,
            )
            .all(...args) as any[];
        return rows.map((r) => ({
            id: r.id,
            time: r.time,
            actor: r.actor,
            action: r.action,
            account: r.account ?? undefined,
            symbol: r.symbol ?? undefined,
            outcome: r.outcome,
            detail: r.detail ? JSON.parse(r.detail) : undefined,
        }));
    }
}
