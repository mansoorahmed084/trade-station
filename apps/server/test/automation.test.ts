import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticAdapter } from '@ts/datafeed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, createApp } from '../src/app.ts';

const MIN = 60_000;
let dir: string;
let app: App;
let base: string;
/** The market clock: moved by hand, a minute at a time. */
let clock = Date.UTC(2025, 5, 1, 12, 0, 30);

const start = async () => {
    app = await createApp(
        { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'no-web'), notifier: {} },
        {
            adapters: [new SyntheticAdapter({ tickMs: 20, now: () => clock })],
            log: () => {},
            lingerMs: 0,
            workers: 2,
            now: () => clock,
        },
    );
    base = await app.listen();
};
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = text;
    }
    return { status: res.status, body: parsed };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 6000): Promise<T> {
    const deadline = Date.now() + ms;
    let last = await read();
    while (!done(last) && Date.now() < deadline) {
        await wait(30);
        last = await read();
    }
    return last;
}
const paper = async () => (await call('GET', '/api/trading/paper')).body;
const runner = async (id: string) => (await call('GET', `/api/automation/runners/${id}`)).body;
/** Move the market on by whole minutes; each new bar closes the previous one. */
const advance = async (minutes: number) => {
    for (let i = 0; i < minutes; i++) {
        clock += MIN;
        await wait(80);
    }
};

/**
 * A strategy that holds one unit in even minutes and none in odd ones: it changes its mind every
 * bar. It counts minutes from the bar's time, not \`bar_index\`: a live runner decides each bar from
 * a window of recent history, so a bar's index within that window does not move.
 */
const FLIPPER = `//@version=6
strategy("Flipper", default_qty_type=strategy.fixed, default_qty_value=1)
if math.floor(time / 60000) % 2 == 0
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
`;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-automation-'));
    await start();
    await call('PUT', '/api/trading/risk', {
        maxOrderValue: 100_000,
        maxPositionValue: 1_000_000,
        maxOrdersPerMinute: 100,
    });
}, 30_000);

afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('strategy runner', () => {
    let id: string;

    it('refuses a strategy that does not work, and creates one that does', async () => {
        const bad = await call('POST', '/api/automation/runners', {
            strategy: { kind: 'pine', source: '//@version=6\nindicator("x")\nplot(close)' },
            symbol: 'SYNTH:ALPHA',
            timeframe: '1',
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/indicator/);
        const created = await call('POST', '/api/automation/runners', {
            name: 'Flipper on ALPHA',
            strategy: { kind: 'pine', source: FLIPPER },
            symbol: 'SYNTH:ALPHA',
            timeframe: '1',
            mode: 'paper',
            bars: 300,
            startWith: 'now',
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            name: 'Flipper on ALPHA',
            mode: 'paper',
            accountForOrders: 'paper',
            state: { status: 'stopped' },
        });
        id = created.body.id;
    });

    it('follows the strategy bar by bar on the paper account, through the risk manager', async () => {
        expect((await call('POST', `/api/automation/runners/${id}/start`)).status).toBe(200);
        let r = await until(
            () => runner(id),
            (x) => x.state.decisions.length >= 1,
        );
        const first = r.state.decisions[0];
        expect(Math.abs(first.target)).toBeLessThanOrEqual(1);
        // Taken on at once ("now"): the paper position matches the strategy's.
        expect(r.state.held).toBe(first.target);
        await advance(4);
        r = await until(
            () => runner(id),
            (x) => x.state.decisions.length >= 5,
        );
        const targets = r.state.decisions.map((d: any) => d.target);
        // It changes its mind every bar, and every change was traded.
        for (let i = 1; i < targets.length; i++) expect(targets[i]).not.toBe(targets[i - 1]);
        expect(r.state.held).toBe(targets.at(-1));
        expect(r.state.divergences).toEqual([]);
        expect(r.state.fills).toBeGreaterThanOrEqual(4);
        const p = await paper();
        expect(p.positions.find((x: any) => x.symbol === 'SYNTH:ALPHA')?.qty ?? 0).toBe(targets.at(-1));
        expect(p.orders.filter((o: any) => o.source === 'strategy').length).toBeGreaterThanOrEqual(4);
        // Every order it sent is in the audit log under its name.
        const audit = (await call('GET', `/api/audit?actor=strategy:${id}`)).body;
        expect(audit.filter((a: any) => a.action === 'place' && a.outcome === 'ok').length).toBe(r.state.fills);
    }, 30_000);

    it('agrees with a backtest of the same bars', async () => {
        const v = (await call('POST', `/api/automation/runners/${id}/verify`)).body;
        expect(v.checked).toBeGreaterThanOrEqual(5);
        expect(v.mismatches).toEqual([]);
    }, 30_000);

    it('records a refused order as an explained divergence', async () => {
        await call('PUT', '/api/trading/risk', { maxOrderValue: 1 });
        await advance(1);
        const r = await until(
            () => runner(id),
            (x) => x.state.divergences.length >= 1,
        );
        const d = r.state.divergences.at(-1);
        expect(d).toMatchObject({ explained: true });
        expect(d.reason).toMatch(/limit per automated order is 1/);
        expect(r.state.decisions.at(-1).note).toMatch(/not sent/);
        await call('PUT', '/api/trading/risk', {
            maxOrderValue: 100_000,
            maxPositionValue: 1_000_000,
            maxOrdersPerMinute: 100,
        });
    }, 30_000);

    it('runs in shadow without sending anything', async () => {
        const created = await call('POST', '/api/automation/runners', {
            strategy: { kind: 'pine', source: FLIPPER },
            symbol: 'SYNTH:BETA',
            timeframe: '1',
            mode: 'shadow',
            bars: 300,
            startWith: 'now',
        });
        const sid = created.body.id;
        await call('POST', `/api/automation/runners/${sid}/start`);
        await advance(3);
        const r = await until(
            () => runner(sid),
            (x) => x.state.decisions.length >= 4,
        );
        expect(r.state.decisions.filter((d: any) => d.order).every((d: any) => d.order.status === 'shadow')).toBe(true);
        expect(r.state.held).toBe(r.state.decisions.at(-1).target);
        expect((await paper()).orders.some((o: any) => o.symbol === 'SYNTH:BETA')).toBe(false);
        await call('POST', `/api/automation/runners/${sid}/stop`);
    }, 30_000);
});

describe('kill switch', () => {
    it('halts every strategy, cancels every order, closes every position, and stays halted', async () => {
        await call('POST', '/api/trading/paper/orders', { symbol: 'SYNTH:GAMMA', side: 'buy', type: 'market', qty: 1 });
        const last = (await paper()).positions.find((p: any) => p.symbol === 'SYNTH:GAMMA').lastPrice;
        await call('POST', '/api/trading/paper/orders', {
            symbol: 'SYNTH:GAMMA',
            side: 'buy',
            type: 'limit',
            qty: 1,
            limit: Math.round(last * 0.5 * 100) / 100,
        });
        const killed = (await call('POST', '/api/trading/kill', { flatten: true, reason: 'test' })).body;
        expect(killed.halt).toMatchObject({ reason: 'test', by: 'user' });
        expect(killed.cancelled).toBeGreaterThanOrEqual(1);
        expect(killed.closed).toBeGreaterThanOrEqual(1);
        const p = await paper();
        expect(p.positions).toEqual([]);
        expect(p.orders.filter((o: any) => o.status === 'working' || o.status === 'inactive')).toEqual([]);
        const runners = (await call('GET', '/api/automation/runners')).body;
        expect(runners.every((r: any) => r.state.status !== 'running')).toBe(true);
        expect(runners.some((r: any) => r.state.status === 'halted')).toBe(true);
        // Nothing automatic gets through, and a runner cannot be started, until trading is resumed.
        const auto = await app.trading.placeAutomated(
            'paper',
            { symbol: 'SYNTH:ALPHA', side: 'buy', type: 'market', qty: 1 },
            'test',
        );
        expect(auto).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/halted \(test\)/) });
        expect((await call('POST', `/api/automation/runners/${runners[0].id}/start`)).status).toBe(409);
        // A person can still trade by hand.
        expect(
            (
                await call('POST', '/api/trading/paper/orders', {
                    symbol: 'SYNTH:ALPHA',
                    side: 'buy',
                    type: 'market',
                    qty: 1,
                })
            ).status,
        ).toBe(201);
        // The halt survives a restart.
        await app.close();
        await start();
        expect((await call('GET', '/api/trading/risk')).body.halt).toMatchObject({ reason: 'test' });
        expect(
            (await call('GET', '/api/automation/runners')).body.every((r: any) => r.state.status !== 'running'),
        ).toBe(true);
        await call('POST', '/api/trading/resume');
        expect((await call('GET', '/api/trading/risk')).body.halt).toBeNull();
        const audit = (await call('GET', '/api/audit?actor=user')).body.map((a: any) => a.action);
        expect(audit).toContain('kill switch');
        expect(audit).toContain('resume');
        expect(audit).toContain('place');
    }, 30_000);
});

describe('inbound webhook', () => {
    let hook: any;

    it('takes TradingView-style messages and trades the account it was set up for', async () => {
        hook = (await call('POST', '/api/automation/webhooks', { name: 'TV alerts', defaultQty: 2 })).body;
        expect(hook.passphrase.length).toBeGreaterThanOrEqual(20);
        const send = (msg: unknown, headers: Record<string, string> = {}) =>
            call('POST', `/api/webhook/${hook.id}`, typeof msg === 'string' ? msg : JSON.stringify(msg), {
                'content-type': 'text/plain',
                ...headers,
            });
        // A bare buy uses the webhook's own size; the exchange prefix may come separately.
        let r = await send({ passphrase: hook.passphrase, ticker: 'BETA', exchange: 'SYNTH', action: 'buy' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.order).toMatchObject({
            symbol: 'SYNTH:BETA',
            side: 'buy',
            qty: 2,
            status: 'filled',
            source: 'webhook',
        });
        // A strategy alert reporting its position after the order: trade to it.
        r = await send({
            passphrase: hook.passphrase,
            ticker: 'SYNTH:BETA',
            strategy: { order: { action: 'sell', contracts: 1 }, position_size: -1 },
        });
        expect(r.body.order).toMatchObject({ side: 'sell', qty: 3 });
        expect((await paper()).positions.find((p: any) => p.symbol === 'SYNTH:BETA').qty).toBe(-1);
        r = await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'close' });
        expect(r.body.order).toMatchObject({ side: 'buy', qty: 1, reduceOnly: true });
        // It arrives under any host name: the address and passphrase are its protection.
        r = await send(
            { passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy', qty: 0.5 },
            { host: 'abc.trycloudflare.com' },
        );
        expect(r.status).toBe(200);
    });

    it('refuses what it should, and says why', async () => {
        const send = (msg: unknown, id = hook.id) =>
            call('POST', `/api/webhook/${id}`, typeof msg === 'string' ? msg : JSON.stringify(msg), {
                'content-type': 'text/plain',
            });
        expect((await send({ passphrase: 'wrong', ticker: 'SYNTH:BETA', action: 'buy' })).status).toBe(401);
        expect(
            (await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy' }, 'whnope')).status,
        ).toBe(401);
        expect((await send('buy BETA now')).status).toBe(400);
        expect((await send({ passphrase: hook.passphrase, ticker: 'SYNTH:NOPE', action: 'buy' })).status).toBe(404);
        expect((await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'hodl' })).body.error).toMatch(
            /not buy, sell or close/,
        );
        await call('PUT', '/api/trading/risk', { allowList: ['SYNTH:ALPHA'] });
        const refused = await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy' });
        expect(refused.status).toBe(422);
        expect(refused.body.error).toMatch(/not on the list/);
        await call('PUT', '/api/trading/risk', { maxOrderValue: 100_000 });
        await call('PATCH', `/api/automation/webhooks/${hook.id}`, { enabled: false });
        expect((await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy' })).status).toBe(409);
        const rotated = (await call('PATCH', `/api/automation/webhooks/${hook.id}`, { enabled: true, rotate: true }))
            .body;
        expect((await send({ passphrase: hook.passphrase, ticker: 'SYNTH:BETA', action: 'buy' })).status).toBe(401);
        expect((await send({ passphrase: rotated.passphrase, ticker: 'SYNTH:BETA', action: 'buy' })).status).toBe(200);
        const log = (await call('GET', `/api/audit?actor=webhook:${hook.id}`)).body;
        expect(log.some((a: any) => a.outcome === 'rejected' && a.detail.reason === 'wrong passphrase')).toBe(true);
        expect(JSON.stringify(log)).not.toContain(rotated.passphrase);
    });
});
