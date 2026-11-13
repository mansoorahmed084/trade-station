import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BarSeries } from '@ts/core';
import { SyntheticAdapter } from '@ts/datafeed';
import { type BarFrame, decodeBarFrame } from '@ts/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type App, createApp } from '../src/app.ts';

let app: App;
let base: string;
let dir: string;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-server-'));
    app = await createApp(
        { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'no-web') },
        { adapters: [new SyntheticAdapter({ tickMs: 20 })], log: () => {}, lingerMs: 0 },
    );
    base = await app.listen();
});

afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
});

/** Open a socket that records everything from the first frame on (the greeting arrives with the handshake). */
function open(headers: Record<string, string> = {}): Promise<WebSocket & { greeting: any[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers }) as WebSocket & { greeting: any[] };
        ws.greeting = [];
        ws.on('message', (raw: Buffer, isBinary: boolean) => {
            if (!isBinary) ws.greeting.push(JSON.parse(String(raw)));
        });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

describe('HTTP API', () => {
    it('reports health, providers and symbols', async () => {
        const health = await (await fetch(`${base}/api/health`)).json();
        expect(health.ok).toBe(true);
        expect(health.symbols).toBe(3);
        expect(await (await fetch(`${base}/api/providers`)).json()).toEqual(['SYNTH']);
        const symbols = await (await fetch(`${base}/api/symbols?provider=synth`)).json();
        expect(symbols.map((s: any) => s.symbol).sort()).toEqual(['SYNTH:ALPHA', 'SYNTH:BETA', 'SYNTH:GAMMA']);
        const found = await (await fetch(`${base}/api/symbols?q=gam`)).json();
        expect(found.map((s: any) => s.ticker)).toEqual(['GAMMA']);
        const info = await (await fetch(`${base}/api/symbol?symbol=ALPHA`)).json();
        expect(info.tickSize).toBe(0.01);
    });

    it('serves bars as a binary column payload', async () => {
        const res = await fetch(`${base}/api/bars?symbol=SYNTH:ALPHA&tf=5&limit=100`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        const series = BarSeries.decode(await res.arrayBuffer());
        expect(series.length).toBe(100);
        expect(res.headers.get('x-bars')).toBe('100');
        for (let i = 1; i < series.length; i++) expect(series.time[i] - series.time[i - 1]).toBe(5 * 60_000);
        for (let i = 0; i < series.length; i++) {
            expect(series.high[i]).toBeGreaterThanOrEqual(Math.max(series.open[i], series.close[i]));
            expect(series.low[i]).toBeLessThanOrEqual(Math.min(series.open[i], series.close[i]));
        }
    });

    it('answers 404 for unknown symbols and timeframes it cannot build', async () => {
        expect((await fetch(`${base}/api/bars?symbol=NOPE&tf=1`)).status).toBe(404);
        expect((await fetch(`${base}/api/bars?symbol=SYNTH:ALPHA&tf=15S`)).status).toBe(404);
        expect((await fetch(`${base}/api/bars?symbol=SYNTH:ALPHA&tf=zzz`)).status).toBe(404);
        expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    });

    it('stores and returns workspace state', async () => {
        expect((await fetch(`${base}/api/kv/layout`)).status).toBe(404);
        const put = await fetch(`${base}/api/kv/layout`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain' },
            body: '{"a":1}',
        });
        expect(put.status).toBe(204);
        expect(await (await fetch(`${base}/api/kv/layout`)).text()).toBe('{"a":1}');
        await fetch(`${base}/api/kv/layout`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{"b":2}',
        });
        expect(await (await fetch(`${base}/api/kv/layout`)).text()).toBe('{"b":2}');
        expect((await fetch(`${base}/api/kv/layout`, { method: 'DELETE' })).status).toBe(204);
        expect((await fetch(`${base}/api/kv/layout`)).status).toBe(404);
    });

    it('refuses writes from foreign pages and requests under a foreign host name', async () => {
        const csrf = await fetch(`${base}/api/kv/x`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
            body: '1',
        });
        expect(csrf.status).toBe(403);
        const local = await fetch(`${base}/api/kv/x`, {
            method: 'PUT',
            headers: { 'content-type': 'text/plain', origin: 'http://localhost:5173' },
            body: '1',
        });
        expect(local.status).toBe(204);
        const rebind = await app.server.inject({
            method: 'GET',
            url: '/api/health',
            headers: { host: 'evil.example' },
        });
        expect(rebind.statusCode).toBe(403);
    });
});

describe('WebSocket gateway', () => {
    it('streams conflated binary bar frames for a subscription and stops on unsubscribe', async () => {
        const ws = await open();
        const frames: BarFrame[] = [];
        const control: any[] = [];
        ws.on('message', (raw: Buffer, isBinary: boolean) => {
            if (isBinary)
                frames.push(
                    decodeBarFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
                );
            else control.push(JSON.parse(String(raw)));
        });
        ws.send(JSON.stringify({ op: 'sub', id: 7, symbol: 'SYNTH:ALPHA', tf: '1' }));
        ws.send(JSON.stringify({ op: 'ping', t: 123 }));
        await new Promise((r) => setTimeout(r, 400));
        expect(ws.greeting.find((m) => m.op === 'hello')?.version).toBe(1);
        expect(control.find((m) => m.op === 'subscribed')?.id).toBe(7);
        expect(control.find((m) => m.op === 'pong')?.t).toBe(123);
        expect(frames.length).toBeGreaterThan(3);
        // 20 ms upstream ticks through a 16 ms flush: never more frames than flush ticks
        expect(frames.length).toBeLessThanOrEqual(30);
        for (const f of frames) {
            expect(f.subId).toBe(7);
            expect(f.bar.time % 60_000).toBe(0);
            expect(Math.abs(Date.now() - f.sentAt)).toBeLessThan(2_000);
        }
        expect(frames[0].opened).toBe(true);

        ws.send(JSON.stringify({ op: 'unsub', id: 7 }));
        await new Promise((r) => setTimeout(r, 80));
        const count = frames.length;
        await new Promise((r) => setTimeout(r, 150));
        expect(frames.length).toBe(count);
        expect(app.data.stats().hubs).toBe(0);
        ws.close();
    });

    it('reports a bad subscription instead of dropping the socket', async () => {
        const ws = await open();
        const errors: any[] = [];
        ws.on('message', (raw: Buffer, isBinary: boolean) => {
            if (isBinary) return;
            const msg = JSON.parse(String(raw));
            if (msg.op === 'error') errors.push(msg);
        });
        ws.send(JSON.stringify({ op: 'sub', id: 1, symbol: 'NOPE', tf: '1' }));
        ws.send('not json');
        ws.send(JSON.stringify({ op: 'sub', id: 2, symbol: 'SYNTH:ALPHA', tf: 'zzz' }));
        await new Promise((r) => setTimeout(r, 100));
        expect(errors.map((e) => e.id)).toEqual([1, undefined, 2]);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    it('pushes application events only to clients listening on the topic', async () => {
        const a = await open();
        const b = await open();
        const got: Record<string, any[]> = { a: [], b: [] };
        const collect = (name: string) => (raw: Buffer, isBinary: boolean) => {
            if (isBinary) return;
            const msg = JSON.parse(String(raw));
            if (msg.op === 'event') got[name].push(msg);
        };
        a.on('message', collect('a'));
        b.on('message', collect('b'));
        a.send(JSON.stringify({ op: 'listen', topics: ['alerts'] }));
        await new Promise((r) => setTimeout(r, 50));
        app.gateway.publish('alerts', { id: 1 });
        app.gateway.publish('orders', { id: 2 });
        await new Promise((r) => setTimeout(r, 50));
        expect(got.a).toEqual([{ op: 'event', topic: 'alerts', data: { id: 1 } }]);
        expect(got.b).toEqual([]);
        a.close();
        b.close();
    });

    it('refuses sockets opened by a page from another site', async () => {
        await expect(open({ origin: 'https://evil.example' })).rejects.toBeDefined();
        const ok = await open({ origin: 'http://localhost:5173' });
        expect(ok.readyState).toBe(WebSocket.OPEN);
        ok.close();
    });
});
