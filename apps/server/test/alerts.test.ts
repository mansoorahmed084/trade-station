import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from '@ts/alerts';
import { SyntheticAdapter } from '@ts/datafeed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type App, createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';

let dir: string;
let app: App;
let base: string;
let hook: Server;
let hookUrl: string;
const hooks: { headers: Record<string, any>; body: string }[] = [];

const config = (): Config => ({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    providers: [],
    webDir: join(dir, 'no-web'),
    notifier: {},
});
const start = async () => {
    app = await createApp(config(), { adapters: [new SyntheticAdapter({ tickMs: 20 })], log: () => {}, lingerMs: 0 });
    base = await app.listen();
};
const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
    const deadline = Date.now() + ms;
    let last = await read();
    while (!done(last) && Date.now() < deadline) {
        await wait(40);
        last = await read();
    }
    return last;
}
const log = async () => (await (await fetch(`${base}/api/alerts/log`)).json()) as any[];

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-alerts-api-'));
    hook = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => {
            body += c;
        });
        req.on('end', () => {
            hooks.push({ headers: req.headers, body });
            res.end('ok');
        });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/alert`;
    await start();
});

afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => hook.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
});

const always = { left: { type: 'price' }, op: 'greater', right: { type: 'value', value: 0 } };
const never = { left: { type: 'price' }, op: 'less', right: { type: 'value', value: 0 } };

describe('alerts API', () => {
    it('an alert fires with no browser connected, is logged, and reaches a signed webhook', async () => {
        expect(app.gateway.connections).toBe(0);
        const res = await post('/api/alerts', {
            name: 'No browser needed',
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once',
            message: '{{ticker}} traded at {{close}}',
            notify: { app: true, webhook: { url: hookUrl, secret: 'k' } },
        });
        expect(res.status).toBe(201);
        const alert = await res.json();
        expect(alert).toMatchObject({
            name: 'No browser needed',
            symbols: ['SYNTH:ALPHA'],
            active: true,
            frequency: 'once',
        });

        const entries = await until(log, (l) => l.length > 0 && l[0].deliveries.length === 2);
        expect(entries.length).toBe(1);
        expect(entries[0]).toMatchObject({ alertId: alert.id, symbol: 'SYNTH:ALPHA', late: false });
        expect(entries[0].message).toMatch(/^ALPHA traded at \d+\.\d\d$/);
        expect(entries[0].deliveries).toEqual([
            { channel: 'app', ok: true },
            { channel: 'webhook', ok: true },
        ]);

        expect(hooks.length).toBe(1);
        expect(hooks[0].headers['x-signature']).toBe(sign(hooks[0].body, 'k'));
        expect(JSON.parse(hooks[0].body)).toMatchObject({
            alert: 'No browser needed',
            ticker: 'ALPHA',
            message: entries[0].message,
        });

        const after = ((await (await fetch(`${base}/api/alerts`)).json()) as any[]).find((a) => a.id === alert.id);
        expect(after).toMatchObject({ active: false, state: { fireCount: 1, done: ['SYNTH:ALPHA'] } });
    });

    it('a connected client hears the alert the moment it fires', async () => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        const events: any[] = [];
        ws.on('message', (raw: Buffer, isBinary: boolean) => {
            if (isBinary) return;
            const msg = JSON.parse(String(raw));
            if (msg.op === 'event' && msg.topic === 'alerts') events.push(msg.data);
        });
        await new Promise((resolve) => ws.once('open', resolve));
        ws.send(JSON.stringify({ op: 'listen', topics: ['alerts'] }));
        await wait(50);
        const alert = await (
            await post('/api/alerts', {
                name: 'Live',
                symbols: ['SYNTH:BETA'],
                timeframe: '1',
                condition: always,
                frequency: 'once',
                notify: { app: true, sound: true },
            })
        ).json();
        await until(
            async () => events,
            (e) => e.some((x) => x.type === 'fired'),
        );
        const fired = events.find((e) => e.type === 'fired');
        expect(fired).toMatchObject({
            type: 'fired',
            app: true,
            event: { alertId: alert.id, alertName: 'Live', sound: true },
        });
        expect(events.some((e) => e.type === 'changed' && e.id === alert.id)).toBe(true);
        ws.close();
    });

    it('lists, edits, pauses, tests and deletes alerts', async () => {
        const created = await (
            await post('/api/alerts', {
                symbols: ['SYNTH:GAMMA'],
                timeframe: '5',
                condition: never,
                notify: { app: true, webhook: { url: hookUrl } },
            })
        ).json();
        expect(created.name).toBe('Price less than 0'); // named after its condition when no name is given
        expect(app.alerts.stats().runtimes).toBeGreaterThanOrEqual(1);

        const edited = await (
            await post(`/api/alerts/${created.id}`, { name: 'Renamed', frequency: 'once_per_bar_close' }, 'PUT')
        ).json();
        expect(edited).toMatchObject({
            id: created.id,
            name: 'Renamed',
            frequency: 'once_per_bar_close',
            timeframe: '5',
        });

        const paused = await (await post(`/api/alerts/${created.id}/active`, { active: false })).json();
        expect(paused.active).toBe(false);
        const resumed = await (await post(`/api/alerts/${created.id}/active`, { active: true })).json();
        expect(resumed.active).toBe(true);

        const before = hooks.length;
        const logged = (await log()).length;
        const test = await (await post(`/api/alerts/${created.id}/test`, {})).json();
        expect(test.message).toMatch(/^\[test\] Renamed: GAMMA at /);
        expect(test.deliveries).toEqual([
            { channel: 'app', ok: true },
            { channel: 'webhook', ok: true },
        ]);
        expect(hooks.length).toBe(before + 1);
        expect((await log()).length).toBe(logged); // a test is not a real fire
        expect(
            ((await (await fetch(`${base}/api/alerts`)).json()) as any[]).find((a) => a.id === created.id).state
                .fireCount,
        ).toBe(0);

        expect((await fetch(`${base}/api/alerts/${created.id}`, { method: 'DELETE' })).status).toBe(204);
        expect((await fetch(`${base}/api/alerts/${created.id}`, { method: 'DELETE' })).status).toBe(404);
        expect((await post('/api/alerts/nope', {}, 'PUT')).status).toBe(404);
        expect((await post('/api/alerts/nope/test', {})).status).toBe(404);
    });

    it('rejects bad input with a reason and reports which outside channels are configured', async () => {
        const bad = await post('/api/alerts', {
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: { left: { type: 'price' }, op: 'crossing' },
        });
        expect(bad.status).toBe(400);
        expect((await bad.json()).error).toMatch(/right side/);
        expect((await post('/api/alerts', { symbols: ['NOPE'], timeframe: '1', condition: always })).status).toBe(400);
        expect(await (await fetch(`${base}/api/alerts/channels`)).json()).toEqual({ telegram: false, email: false });
    });

    it('survives a restart: finished alerts stay finished, running ones keep running, the log is kept', async () => {
        const running = await (
            await post('/api/alerts', {
                name: 'Still watching',
                symbols: ['SYNTH:ALPHA'],
                timeframe: '1',
                condition: never,
            })
        ).json();
        const firedBefore = (await log()).length;
        expect(firedBefore).toBeGreaterThanOrEqual(2);
        const hooksBefore = hooks.length;

        await app.close();
        await start();

        const alerts = (await (await fetch(`${base}/api/alerts`)).json()) as any[];
        const finished = alerts.find((a) => a.name === 'No browser needed');
        expect(finished).toMatchObject({ active: false, state: { fireCount: 1 } });
        expect(alerts.find((a) => a.id === running.id)).toMatchObject({ active: true, name: 'Still watching' });
        expect(app.alerts.stats()).toMatchObject({ active: 1, runtimes: 1 });

        await wait(300); // plenty of ticks: the finished alert must not fire again
        expect((await log()).length).toBe(firedBefore);
        expect(hooks.length).toBe(hooksBefore);

        // and the restarted engine is live: a new alert fires
        await post('/api/alerts', {
            name: 'After restart',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: always,
            frequency: 'once',
        });
        const entries = await until(log, (l) => l.length > firedBefore);
        expect(entries[0].alertName).toBe('After restart');

        expect((await fetch(`${base}/api/alerts/log`, { method: 'DELETE' })).status).toBe(204);
        expect((await log()).length).toBe(0);
    });
});
