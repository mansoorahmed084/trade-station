import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { BarStore, BinanceAdapter, type MarketDataAdapter, MarketDataService, SyntheticAdapter } from '@ts/datafeed';
import { ScriptHost } from '@ts/script-engine';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import { Gateway, isLocalOrigin } from './gateway.ts';
import { registerScriptRoutes, ScriptStore } from './routes/scripts.ts';

export interface App {
    server: FastifyInstance;
    data: MarketDataService;
    db: Db;
    gateway: Gateway;
    scripts: ScriptStore;
    scriptHost: ScriptHost;
    config: Config;
    listen(): Promise<string>;
    close(): Promise<void>;
}

export interface AppOverrides {
    adapters?: MarketDataAdapter[];
    dbPath?: string;
    log?: (message: string) => void;
    lingerMs?: number;
}

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
};

function buildAdapters(names: string[]): MarketDataAdapter[] {
    const out: MarketDataAdapter[] = [];
    for (const name of names) {
        if (name === 'binance') out.push(new BinanceAdapter());
        else if (name === 'synth') out.push(new SyntheticAdapter());
        else throw new Error(`Unknown market-data provider "${name}"`);
    }
    return out;
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
    const log = overrides.log ?? ((m: string) => console.log(`[server] ${m}`));
    const db = new Db(overrides.dbPath ?? join(config.dataDir, 'app.db'));
    const store = new BarStore(join(config.dataDir, 'bars'));
    const data = new MarketDataService({
        adapters: overrides.adapters ?? buildAdapters(config.providers),
        store,
        log,
        lingerMs: overrides.lingerMs ?? 5 * 60_000,
    });
    const server = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
    const gateway = new Gateway(server.server, data);

    server.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    // The server has no login: it trusts whoever can reach it. So when bound to loopback, refuse
    // requests that arrive under a foreign Host (DNS rebinding) or from a foreign page (CSRF).
    server.addHook('onRequest', async (req, reply) => {
        if (isLoopback(config.host)) {
            const host = (req.headers.host ?? '').replace(/:\d+$/, '');
            if (host && !isLoopback(host) && !host.endsWith('.localhost') && host !== '[::1]') {
                return reply.code(403).send({ error: 'forbidden host' });
            }
        }
        const origin = req.headers.origin;
        if (origin && req.method !== 'GET' && req.method !== 'HEAD' && !isLocalOrigin(origin)) {
            return reply.code(403).send({ error: 'forbidden origin' });
        }
    });

    server.setErrorHandler((err: any, _req, reply) => {
        const message = err?.message ?? 'internal error';
        const notFound = /^Unknown symbol|cannot serve timeframe|Invalid timeframe/.test(message);
        const badRequest = /formula/i.test(message);
        const status = err?.statusCode ?? (notFound ? 404 : badRequest ? 400 : 500);
        if (status >= 500) log(`error: ${message}`);
        reply.code(status).send({ error: message });
    });

    server.get('/api/health', async () => ({
        ok: true,
        now: Date.now(),
        connections: gateway.connections,
        ...data.stats(),
    }));

    server.get('/api/providers', async () => {
        const names = new Set(data.listSymbols().map((s) => s.provider));
        return [...names];
    });

    server.get('/api/symbols', async (req) => {
        const { provider, q, limit } = req.query as { provider?: string; q?: string; limit?: string };
        let list = data.listSymbols();
        if (provider) list = list.filter((s) => s.provider === provider.toUpperCase());
        if (q) {
            const needle = q.toUpperCase();
            list = list.filter(
                (s) => s.ticker.toUpperCase().includes(needle) || s.description.toUpperCase().includes(needle),
            );
            list.sort((a, b) => rank(a.ticker, needle) - rank(b.ticker, needle) || a.ticker.length - b.ticker.length);
        }
        if (limit) list = list.slice(0, Math.max(1, Number(limit)));
        return list;
    });

    server.get('/api/symbol', async (req) => data.describe(String((req.query as any).symbol ?? '')));

    /** Last price and previous close for a set of symbols — what a watchlist row shows. */
    server.get('/api/quotes', async (req) => {
        const symbols = String((req.query as any).symbols ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 200);
        return Promise.all(
            symbols.map(async (symbol) => {
                try {
                    const [bars, info] = await Promise.all([
                        data.getBars(symbol, '1D', { limit: 2 }),
                        data.describe(symbol),
                    ]);
                    const last = bars.last();
                    if (!last) return { symbol, error: 'no data' };
                    const prev = bars.length > 1 ? bars.at(bars.length - 2) : null;
                    return {
                        symbol,
                        last: last.close,
                        prevClose: prev ? prev.close : last.open,
                        open: last.open,
                        high: last.high,
                        low: last.low,
                        volume: last.volume,
                        time: last.time,
                        tickSize: info.tickSize,
                        description: info.description,
                    };
                } catch (err: any) {
                    return { symbol, error: err?.message ?? 'failed' };
                }
            }),
        );
    });

    server.get('/api/bars', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
        const series = await data.getBars(String(q.symbol ?? ''), String(q.tf ?? '1'), {
            from: num(q.from),
            to: num(q.to),
            limit: num(q.limit),
        });
        reply.header('content-type', 'application/octet-stream').header('x-bars', String(series.length));
        return reply.send(Buffer.from(series.encode()));
    });

    server.get('/api/kv/:key', async (req, reply) => {
        const value = db.kvGet((req.params as any).key);
        // `optional` callers treat "nothing saved yet" as a normal answer, not an error in the console.
        if (value === null && (req.query as any).optional !== undefined) return reply.code(204).send();
        if (value === null) return reply.code(404).send({ error: 'not found' });
        return reply.header('content-type', 'text/plain; charset=utf-8').send(value);
    });
    server.put('/api/kv/:key', async (req, reply) => {
        const body = req.body;
        db.kvSet((req.params as any).key, typeof body === 'string' ? body : JSON.stringify(body ?? null));
        return reply.code(204).send();
    });
    server.delete('/api/kv/:key', async (req, reply) => {
        db.kvDelete((req.params as any).key);
        return reply.code(204).send();
    });

    // Serve the built web app when it exists, so production is one process.
    const webDir = resolve(config.webDir);
    server.setNotFoundHandler((req, reply) => {
        const path = req.url.split('?')[0];
        if (req.method !== 'GET' || path.startsWith('/api/') || !existsSync(webDir)) {
            return reply.code(404).send({ error: 'not found' });
        }
        let file = resolve(webDir, `.${decodeURIComponent(path)}`);
        if (file !== webDir && !file.startsWith(webDir + sep)) return reply.code(403).send({ error: 'forbidden' });
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html');
        if (!existsSync(file)) return reply.code(404).send({ error: 'not found' });
        return reply.header('content-type', MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
    });

    await data.init();

    const scriptHost = new ScriptHost(data);
    const scripts = new ScriptStore(db);
    registerScriptRoutes(server, {
        scripts,
        host: scriptHost,
        // A script is checked against real bars; any symbol will do when the caller names none.
        defaultSymbol: () => {
            const all = data.listSymbols();
            return (all.find((x) => x.symbol === 'BINANCE:BTCUSDT') ?? all[0])?.symbol ?? '';
        },
    });

    return {
        server,
        data,
        db,
        gateway,
        scripts,
        scriptHost,
        config,
        async listen() {
            return server.listen({ host: config.host, port: config.port });
        },
        async close() {
            gateway.close();
            data.close();
            await server.close();
            db.close();
        },
    };
}

/** Search ranking: exact ticker, then prefix, then anything containing the query. */
function rank(ticker: string, needle: string): number {
    const t = ticker.toUpperCase();
    return t === needle ? 0 : t.startsWith(needle) ? 1 : 2;
}
