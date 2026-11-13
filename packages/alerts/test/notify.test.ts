import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Alert, type AlertEvent, deliver, emptyState, sign, webhookPayload } from '../src/index.ts';

interface Received {
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

let server: Server;
let base: string;
const received: Received[] = [];
/** Status codes to answer with, in order; 200 once the list runs out. */
let script: number[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            received.push({ path: req.url ?? '', headers: req.headers, body });
            res.statusCode = script.shift() ?? 200;
            res.end('ok');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
    received.length = 0;
    script = [];
});

const event: AlertEvent = {
    id: 'ev1',
    alertId: 'al1',
    alertName: 'BTC breakout',
    symbol: 'BINANCE:BTCUSDT',
    timeframe: '60',
    time: Date.UTC(2026, 10, 13, 9, 41, 7),
    barTime: Date.UTC(2026, 10, 13, 9),
    price: 69420.13,
    message: 'BTC breakout: BTCUSDT at 69420.13',
    late: false,
    sound: true,
    deliveries: [],
};

const alertWith = (notify: Alert['notify']): Alert => ({
    id: 'al1',
    name: 'BTC breakout',
    symbols: ['BINANCE:BTCUSDT'],
    timeframe: '60',
    condition: { left: { type: 'price' }, op: 'crossing', right: { type: 'value', value: 69400 } },
    frequency: 'once',
    cooldownMs: 0,
    expiresAt: null,
    message: '',
    notify,
    active: true,
    createdAt: 0,
    updatedAt: 0,
    state: emptyState(),
});

const fast = { retryDelaysMs: [5, 5] };

describe('webhook', () => {
    it('posts the alert as JSON, signed when a secret is set', async () => {
        const out = await deliver(event, alertWith({ webhook: { url: `${base}/hook`, secret: 's3cret' } }), fast);
        expect(out).toEqual([{ channel: 'webhook', ok: true, detail: undefined }]);
        expect(received.length).toBe(1);
        const [req] = received;
        expect(req.path).toBe('/hook');
        expect(req.headers['content-type']).toBe('application/json');
        expect(req.headers['x-alert-id']).toBe('ev1');
        expect(JSON.parse(req.body)).toEqual({
            id: 'ev1',
            alert: 'BTC breakout',
            alertId: 'al1',
            symbol: 'BINANCE:BTCUSDT',
            ticker: 'BTCUSDT',
            timeframe: '60',
            time: '2026-11-13T09:41:07.000Z',
            barTime: '2026-11-13T09:00:00.000Z',
            price: 69420.13,
            message: 'BTC breakout: BTCUSDT at 69420.13',
            late: false,
        });
        // the receiver can verify the signature over the exact bytes it got
        expect(req.headers['x-signature']).toBe(sign(req.body, 's3cret'));
        expect(req.headers['x-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(sign(req.body, 'other')).not.toBe(req.headers['x-signature']);
    });

    it('sends no signature without a secret', async () => {
        await deliver(event, alertWith({ webhook: { url: `${base}/plain` } }), fast);
        expect(received[0].headers['x-signature']).toBeUndefined();
        expect(JSON.parse(received[0].body)).toEqual(webhookPayload(event));
    });

    it('retries a server error and then succeeds', async () => {
        script = [500, 503];
        const out = await deliver(event, alertWith({ webhook: { url: `${base}/flaky` } }), fast);
        expect(out[0].ok).toBe(true);
        expect(received.length).toBe(3);
    });

    it('gives up after the retries and says why', async () => {
        script = [500, 500, 500];
        const out = await deliver(event, alertWith({ webhook: { url: `${base}/down` } }), fast);
        expect(out).toEqual([{ channel: 'webhook', ok: false, detail: 'HTTP 500' }]);
        expect(received.length).toBe(3);
    });

    it('does not repeat a request the receiver rejected', async () => {
        script = [401];
        const out = await deliver(event, alertWith({ webhook: { url: `${base}/denied` } }), fast);
        expect(out).toEqual([{ channel: 'webhook', ok: false, detail: 'HTTP 401' }]);
        expect(received.length).toBe(1);
    });

    it('reports an unreachable receiver instead of throwing', async () => {
        const out = await deliver(event, alertWith({ webhook: { url: 'http://127.0.0.1:1/nowhere' } }), {
            retryDelaysMs: [],
        });
        expect(out[0]).toMatchObject({ channel: 'webhook', ok: false });
        expect(out[0].detail).toBeTruthy();
    });
});

describe('other channels', () => {
    it('Discord receives the message as content', async () => {
        const out = await deliver(event, alertWith({ discord: { url: `${base}/discord` } }), fast);
        expect(out).toEqual([{ channel: 'discord', ok: true, detail: undefined }]);
        expect(JSON.parse(received[0].body)).toEqual({ content: 'BTC breakout: BTCUSDT at 69420.13' });
    });

    it('Telegram and email say what is missing when the server is not configured for them', async () => {
        const out = await deliver(
            event,
            alertWith({ telegram: { chatId: '123' }, email: { to: 'me@example.com' } }),
            fast,
        );
        expect(out).toEqual([
            { channel: 'telegram', ok: false, detail: 'TS_TELEGRAM_TOKEN is not set on the server' },
            { channel: 'email', ok: false, detail: 'TS_SMTP_URL is not set on the server' },
        ]);
        expect(received.length).toBe(0);
    });

    it('Telegram posts to the bot API with the chat id', async () => {
        const calls: { url: string; body: any }[] = [];
        const fakeFetch = (async (url: any, init: any) => {
            calls.push({ url: String(url), body: JSON.parse(init.body) });
            return new Response('{}', { status: 200 });
        }) as typeof fetch;
        const out = await deliver(event, alertWith({ telegram: { chatId: '-100123' } }), {
            ...fast,
            telegramToken: 'TOKEN',
            fetch: fakeFetch,
        });
        expect(out).toEqual([{ channel: 'telegram', ok: true, detail: undefined }]);
        expect(calls).toEqual([
            { url: 'https://api.telegram.org/botTOKEN/sendMessage', body: { chat_id: '-100123', text: event.message } },
        ]);
    });

    it('email goes through the mail transport, and a transport failure is reported', async () => {
        const sent: any[] = [];
        const ok = await deliver(event, alertWith({ email: { to: 'me@example.com' } }), {
            smtpFrom: 'alerts@example.com',
            sendMail: async (m) => void sent.push(m),
        });
        expect(ok).toEqual([{ channel: 'email', ok: true }]);
        expect(sent[0]).toMatchObject({
            to: 'me@example.com',
            from: 'alerts@example.com',
            subject: 'Alert: BTC breakout',
        });
        expect(sent[0].text).toContain(event.message);
        const failed = await deliver(event, alertWith({ email: { to: 'me@example.com' } }), {
            sendMail: async () => {
                throw new Error('connection refused');
            },
        });
        expect(failed).toEqual([{ channel: 'email', ok: false, detail: 'connection refused' }]);
    });

    it('all channels run side by side and none is sent when none is asked for', async () => {
        script = [500, 500, 500];
        const out = await deliver(
            event,
            alertWith({ webhook: { url: `${base}/a` }, discord: { url: `${base}/b` }, app: true, sound: true }),
            { retryDelaysMs: [] },
        );
        expect(out.map((d) => d.channel).sort()).toEqual(['discord', 'webhook']);
        expect(await deliver(event, alertWith({ app: true }), fast)).toEqual([]);
    });
});
