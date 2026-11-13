import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Ordered schema migrations. Append only — never edit one that has shipped. */
const MIGRATIONS: string[] = [
    `CREATE TABLE kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
];

export function registerMigration(sql: string): void {
    MIGRATIONS.push(sql);
}

/** Application state: layouts, watchlists, alerts, scripts, orders, audit log. One SQLite file, WAL mode. */
export class Db {
    readonly sql: DatabaseSync;

    constructor(path: string) {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        this.sql = new DatabaseSync(path);
        this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
        this.migrate();
    }

    private migrate(): void {
        this.sql.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
        const row = this.sql.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
        const current = row.v ?? 0;
        for (let i = current; i < MIGRATIONS.length; i++) {
            this.sql.exec('BEGIN');
            try {
                this.sql.exec(MIGRATIONS[i]);
                this.sql.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
                this.sql.exec('COMMIT');
            } catch (err) {
                this.sql.exec('ROLLBACK');
                throw err;
            }
        }
    }

    kvGet(key: string): string | null {
        const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    kvSet(key: string, value: string): void {
        this.sql
            .prepare(
                'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            )
            .run(key, value, Date.now());
    }

    kvDelete(key: string): void {
        this.sql.prepare('DELETE FROM kv WHERE key = ?').run(key);
    }

    /** Read and JSON-parse a value, falling back when it is missing or corrupt. */
    kvJson<T>(key: string, fallback: T): T {
        const raw = this.kvGet(key);
        if (raw === null) return fallback;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return fallback;
        }
    }

    close(): void {
        this.sql.close();
    }
}
