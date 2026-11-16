import { newId } from '@ts/core';
import { readHeader, runtimeMembers, type ScriptHost } from '@ts/script-engine';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.ts';
import { EXAMPLES } from '../examples.ts';
import { BUNDLED } from '../library/index.ts';

export interface StoredScript {
    id: string;
    name: string;
    source: string;
    kind: string | null;
    /** Attribution, recorded when a script is imported from elsewhere. */
    author: string | null;
    license: string | null;
    origin: string | null;
    builtin: boolean;
    createdAt: number;
    updatedAt: number;
}

const MAX_SOURCE = 400_000;
const MAX_RUN_BARS = 50_000;

function row(r: any): StoredScript {
    return {
        id: r.id,
        name: r.name,
        source: r.source,
        kind: r.kind,
        author: r.author,
        license: r.license,
        origin: r.origin,
        builtin: !!r.builtin,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

const text = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t ? t.slice(0, max) : null;
};

/** Ids of the bundled scripts this library has been given, so that one you delete stays deleted. */
const SEEDED_KEY = 'scripts.seeded';

/** The user's script library. Scripts live on the server so alerts and strategies can run them. */
export class ScriptStore {
    private db: Db;

    constructor(db: Db) {
        this.db = db;
        this.seed();
    }

    /**
     * Put the bundled scripts into the library. An empty library gets all of them; after that it
     * gets only the ones it has never been given, so a script bundled in a later version arrives
     * once, at the top of the list, and nothing you deleted comes back.
     */
    private seed(): void {
        const count = (this.db.sql.prepare('SELECT COUNT(*) AS n FROM scripts').get() as { n: number }).n;
        // A library from before this record was kept was seeded with the examples and nothing else.
        const examples = EXAMPLES.map((e) => e.id);
        const record = this.db.kvJson<unknown>(SEEDED_KEY, examples);
        const given = new Set<string>(count === 0 ? [] : Array.isArray(record) ? record : examples);
        const missing = BUNDLED.filter((s) => !given.has(s.id));
        if (missing.length === 0) return;
        const now = Date.now();
        const insert = this.db.sql.prepare(
            'INSERT OR IGNORE INTO scripts (id, name, source, kind, author, license, origin, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        );
        missing.forEach((s, i) => {
            insert.run(
                s.id,
                s.name,
                s.source,
                readHeader(s.source).kind,
                s.author,
                s.license,
                s.origin,
                now - i,
                now - i,
            );
            given.add(s.id);
        });
        this.db.kvSet(SEEDED_KEY, JSON.stringify([...given]));
    }

    list(): Omit<StoredScript, 'source'>[] {
        const rows = this.db.sql
            .prepare(
                'SELECT id, name, kind, author, license, origin, builtin, created_at, updated_at FROM scripts ORDER BY updated_at DESC',
            )
            .all();
        return rows.map((r: any) => {
            const { source: _source, ...rest } = row({ ...r, source: '' });
            return rest;
        });
    }

    get(id: string): StoredScript | null {
        const r = this.db.sql.prepare('SELECT * FROM scripts WHERE id = ?').get(id);
        return r ? row(r) : null;
    }

    create(input: {
        name?: unknown;
        source?: unknown;
        author?: unknown;
        license?: unknown;
        origin?: unknown;
    }): StoredScript {
        const source = typeof input.source === 'string' ? input.source : '';
        if (!source.trim()) throw Object.assign(new Error('a script needs source code'), { statusCode: 400 });
        if (source.length > MAX_SOURCE) throw Object.assign(new Error('the script is too large'), { statusCode: 413 });
        const header = readHeader(source);
        const id = newId('scr');
        const now = Date.now();
        this.db.sql
            .prepare(
                'INSERT INTO scripts (id, name, source, kind, author, license, origin, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            )
            .run(
                id,
                text(input.name, 120) ?? header.title ?? 'Untitled script',
                source,
                header.kind,
                text(input.author, 200),
                text(input.license, 200),
                text(input.origin, 500),
                now,
                now,
            );
        return this.get(id)!;
    }

    update(
        id: string,
        patch: { name?: unknown; source?: unknown; author?: unknown; license?: unknown; origin?: unknown },
    ): StoredScript | null {
        const current = this.get(id);
        if (!current) return null;
        const source = typeof patch.source === 'string' && patch.source.trim() ? patch.source : current.source;
        if (source.length > MAX_SOURCE) throw Object.assign(new Error('the script is too large'), { statusCode: 413 });
        const keep = (key: 'author' | 'license' | 'origin', max: number) =>
            patch[key] === undefined ? current[key] : text(patch[key], max);
        this.db.sql
            .prepare(
                'UPDATE scripts SET name = ?, source = ?, kind = ?, author = ?, license = ?, origin = ?, updated_at = ? WHERE id = ?',
            )
            .run(
                text(patch.name, 120) ?? current.name,
                source,
                readHeader(source).kind,
                keep('author', 200),
                keep('license', 200),
                keep('origin', 500),
                Date.now(),
                id,
            );
        return this.get(id);
    }

    delete(id: string): boolean {
        return this.db.sql.prepare('DELETE FROM scripts WHERE id = ?').run(id).changes > 0;
    }
}

export function registerScriptRoutes(
    server: FastifyInstance,
    deps: { scripts: ScriptStore; host: ScriptHost; defaultSymbol: () => string },
): void {
    const { scripts, host } = deps;

    server.get('/api/scripts', async () => scripts.list());

    /** Every built-in the Pine runtime implements, by namespace — what the editor's completion offers. */
    server.get('/api/scripts/builtins', async () => {
        const out: Record<string, string[]> = {};
        for (const [ns, names] of await runtimeMembers()) {
            out[ns] = [...names]
                .filter(
                    (n) => /^[a-z][A-Za-z0-9_]*$/.test(n) && !['context', 'param', 'any', 'constructor'].includes(n),
                )
                .sort();
        }
        return out;
    });

    server.get('/api/scripts/:id', async (req, reply) => {
        const script = scripts.get((req.params as any).id);
        return script ?? reply.code(404).send({ error: 'script not found' });
    });

    server.post('/api/scripts', async (req, reply) => reply.code(201).send(scripts.create((req.body ?? {}) as any)));

    server.put('/api/scripts/:id', async (req, reply) => {
        const script = scripts.update((req.params as any).id, (req.body ?? {}) as any);
        return script ?? reply.code(404).send({ error: 'script not found' });
    });

    server.delete('/api/scripts/:id', async (req, reply) => {
        return scripts.delete((req.params as any).id)
            ? reply.code(204).send()
            : reply.code(404).send({ error: 'script not found' });
    });

    /** Would this source run here? Returns the compatibility report; never fails on a bad script. */
    server.post('/api/scripts/check', async (req, reply) => {
        const body = (req.body ?? {}) as { source?: string; symbol?: string; timeframe?: string };
        if (typeof body.source !== 'string' || !body.source.trim())
            return reply.code(400).send({ error: 'source is required' });
        if (body.source.length > MAX_SOURCE) return reply.code(413).send({ error: 'the script is too large' });
        return host.check(body.source, body.symbol || deps.defaultSymbol(), body.timeframe || '60');
    });

    /** Compute a script's plots, alerts and strategy results on the server. */
    server.post('/api/scripts/run', async (req, reply) => {
        const body = (req.body ?? {}) as {
            source?: string;
            id?: string;
            symbol?: string;
            timeframe?: string;
            bars?: number;
            from?: number;
            to?: number;
            inputs?: Record<string, unknown>;
            closedOnly?: boolean;
        };
        const source = body.source ?? (body.id ? scripts.get(body.id)?.source : undefined);
        if (!source?.trim()) return reply.code(400).send({ error: 'source or id is required' });
        if (!body.symbol) return reply.code(400).send({ error: 'symbol is required' });
        try {
            return await host.run(source, body.symbol, body.timeframe || '60', {
                bars: Math.min(MAX_RUN_BARS, Math.max(1, Math.round(body.bars ?? 1000))),
                from: body.from,
                to: body.to,
                inputs: body.inputs,
                closedOnly: body.closedOnly,
            });
        } catch (err: any) {
            if (err?.stage)
                return reply
                    .code(422)
                    .send({ error: err.message, stage: err.stage, line: err.line, column: err.column });
            throw err;
        }
    });
}
