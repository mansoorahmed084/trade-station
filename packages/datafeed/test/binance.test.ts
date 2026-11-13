import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceAdapter } from '../src/index.ts';

const MIN = 60_000;
const T0 = Date.UTC(2025, 0, 1);
const TOTAL = 2500;

/** A fake venue holding 2,500 one-minute bars, answering klines the way Binance does. */
function fakeVenue(opts: { blockFirstHost?: boolean } = {}) {
    const calls: URL[] = [];
    const fetchFn = (async (input: any) => {
        const url = new URL(String(input));
        calls.push(url);
        if (opts.blockFirstHost && url.host === 'one.test') return new Response('blocked', { status: 451 });
        if (url.pathname === '/api/v3/ping') return Response.json({});
        if (url.pathname === '/api/v3/exchangeInfo') {
            return Response.json({
                symbols: [
                    {
                        symbol: 'BTCUSDT',
                        status: 'TRADING',
                        baseAsset: 'BTC',
                        quoteAsset: 'USDT',
                        filters: [
                            { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
                            { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
                            { filterType: 'NOTIONAL', minNotional: '5.00000000' },
                        ],
                    },
                    { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT', filters: [] },
                ],
            });
        }
        if (url.pathname === '/api/v3/klines') {
            const p = url.searchParams;
            const limit = Number(p.get('limit') ?? 500);
            const start = p.has('startTime') ? Number(p.get('startTime')) : undefined;
            const end = p.has('endTime') ? Number(p.get('endTime')) : T0 + (TOTAL - 1) * MIN;
            let rows: any[][] = [];
            for (let i = 0; i < TOTAL; i++) {
                const t = T0 + i * MIN;
                if (start !== undefined && t < start) continue;
                if (t > end) break;
                rows.push([t, String(100 + i), String(101 + i), String(99 + i), String(100.5 + i), '2.5', t + MIN - 1]);
            }
            // startTime given → first `limit` bars; otherwise the newest `limit` bars before endTime
            rows = start !== undefined ? rows.slice(0, limit) : rows.slice(-limit);
            return Response.json(rows);
        }
        return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchFn, calls, klineCalls: () => calls.filter((c) => c.pathname === '/api/v3/klines') };
}

class FakeSocket {
    static instances: FakeSocket[] = [];
    sent: any[] = [];
    private listeners: Record<string, ((ev: any) => void)[]> = {};
    url: string;
    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }
    addEventListener(type: string, handler: (ev: any) => void) {
        (this.listeners[type] ??= []).push(handler);
    }
    send(data: string) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.fire('close', {});
    }
    fire(type: string, ev: any) {
        for (const h of this.listeners[type] ?? []) h(ev);
    }
}

afterEach(() => {
    vi.useRealTimers();
    FakeSocket.instances = [];
});

describe('BinanceAdapter REST', () => {
    it('pages a bounded window forward and returns exactly the bars inside it', async () => {
        const venue = fakeVenue();
        const adapter = new BinanceAdapter({ fetch: venue.fetchFn, restHosts: ['https://one.test'] });
        const from = T0 + 100 * MIN;
        const to = T0 + 2399 * MIN;
        const bars = await adapter.getBars('BTCUSDT', '1', { from, to });
        expect(bars.length).toBe(2300);
        expect(bars[0].time).toBe(from);
        expect(bars[bars.length - 1].time).toBe(to);
        for (let i = 1; i < bars.length; i++) expect(bars[i].time - bars[i - 1].time).toBe(MIN);
        expect(venue.klineCalls().length).toBe(3);
        expect(bars[0]).toEqual({ time: from, open: 200, high: 201, low: 199, close: 200.5, volume: 2.5 });
        adapter.close();
    });

    it('pages newest-first for a bar count and stops at the listing date', async () => {
        const venue = fakeVenue();
        const adapter = new BinanceAdapter({ fetch: venue.fetchFn, restHosts: ['https://one.test'] });
        const recent = await adapter.getBars('BTCUSDT', '1', { limit: 1200 });
        expect(recent.length).toBe(1200);
        expect(recent[recent.length - 1].time).toBe(T0 + (TOTAL - 1) * MIN);
        expect(new Set(recent.map((b) => b.time)).size).toBe(1200);
        expect(venue.klineCalls().length).toBe(2);

        const all = await adapter.getBars('BTCUSDT', '1', { limit: 9000 });
        expect(all.length).toBe(TOTAL);
        expect(all[0].time).toBe(T0);
        expect(await adapter.firstBarTime('BTCUSDT', '1')).toBe(T0);
        await expect(adapter.getBars('BTCUSDT', '7', {})).rejects.toThrow(/no native/);
        adapter.close();
    });

    it('reads tick, lot and notional filters and skips symbols that are not trading', async () => {
        const venue = fakeVenue();
        const adapter = new BinanceAdapter({ fetch: venue.fetchFn, restHosts: ['https://one.test'] });
        const symbols = await adapter.listSymbols();
        expect(symbols).toEqual([
            {
                symbol: 'BINANCE:BTCUSDT',
                provider: 'BINANCE',
                ticker: 'BTCUSDT',
                description: 'BTC / USDT',
                type: 'crypto',
                tickSize: 0.01,
                lotSize: 0.00001,
                minQty: 0.00001,
                minNotional: 5,
                currency: 'USDT',
                baseCurrency: 'BTC',
                timezone: 'Etc/UTC',
                session: '24x7',
            },
        ]);
        adapter.close();
    });

    it('fails over to the next host when one refuses the request', async () => {
        const venue = fakeVenue({ blockFirstHost: true });
        const adapter = new BinanceAdapter({
            fetch: venue.fetchFn,
            restHosts: ['https://one.test', 'https://two.test'],
        });
        const bars = await adapter.getBars('BTCUSDT', '1', { limit: 5 });
        expect(bars.length).toBe(5);
        expect(venue.klineCalls().map((c) => c.host)).toEqual(['one.test', 'two.test']);
        // the working host is remembered
        await adapter.getBars('BTCUSDT', '1', { limit: 5 });
        expect(venue.klineCalls()[2].host).toBe('two.test');
        adapter.close();
    });
});

describe('BinanceAdapter WebSocket', () => {
    const kline = (t: number, close: number, eventTime: number) =>
        JSON.stringify({
            stream: 'btcusdt@kline_1m',
            data: { E: eventTime, k: { t, o: '1', h: '3', l: '0.5', c: String(close), v: '7' } },
        });

    it('subscribes on open, routes stream messages and unsubscribes when the last listener leaves', () => {
        const adapter = new BinanceAdapter({
            fetch: fakeVenue().fetchFn,
            WebSocket: FakeSocket as any,
            wsHosts: ['wss://a.test'],
        });
        const bars: any[] = [];
        const ticks: any[] = [];
        const stopBars = adapter.subscribeBars('BTCUSDT', '1', (bar, eventTime) => bars.push({ bar, eventTime }));
        const stopTicks = adapter.subscribeTrades('BTCUSDT', (t) => ticks.push(t));
        const sock = FakeSocket.instances[0];
        expect(sock.sent).toEqual([]); // nothing may be sent before the socket opens
        sock.fire('open', {});
        expect(sock.sent[0].method).toBe('SUBSCRIBE');
        expect(sock.sent[0].params.sort()).toEqual(['btcusdt@aggTrade', 'btcusdt@kline_1m']);

        sock.fire('message', { data: kline(T0, 2, T0 + 500) });
        sock.fire('message', {
            data: JSON.stringify({ stream: 'btcusdt@aggTrade', data: { p: '2.5', q: '0.1', T: T0 + 600, m: true } }),
        });
        sock.fire('message', { data: JSON.stringify({ stream: 'ethusdt@kline_1m', data: { k: { t: T0 } } }) });
        sock.fire('message', { data: 'garbage' });
        expect(bars).toEqual([
            { bar: { time: T0, open: 1, high: 3, low: 0.5, close: 2, volume: 7 }, eventTime: T0 + 500 },
        ]);
        expect(ticks).toEqual([{ time: T0 + 600, price: 2.5, size: 0.1, side: 'sell' }]);

        stopBars();
        expect(sock.sent[sock.sent.length - 1]).toMatchObject({ method: 'UNSUBSCRIBE', params: ['btcusdt@kline_1m'] });
        stopTicks();
        expect(sock.sent[sock.sent.length - 1]).toMatchObject({ method: 'UNSUBSCRIBE', params: ['btcusdt@aggTrade'] });
        adapter.close();
    });

    it('reconnects after a drop, resubscribes and announces the reconnect', async () => {
        vi.useFakeTimers();
        const adapter = new BinanceAdapter({
            fetch: fakeVenue().fetchFn,
            WebSocket: FakeSocket as any,
            wsHosts: ['wss://a.test'],
        });
        let reconnects = 0;
        adapter.onReconnect(() => reconnects++);
        const bars: number[] = [];
        adapter.subscribeBars('BTCUSDT', '1', (bar) => bars.push(bar.close));
        FakeSocket.instances[0].fire('open', {});
        expect(reconnects).toBe(0);

        FakeSocket.instances[0].fire('close', {});
        await vi.advanceTimersByTimeAsync(600);
        expect(FakeSocket.instances.length).toBe(2);
        const second = FakeSocket.instances[1];
        second.fire('open', {});
        expect(second.sent[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'] });
        expect(reconnects).toBe(1);
        second.fire('message', { data: kline(T0, 9, T0 + 1) });
        expect(bars).toEqual([9]);
        adapter.close();
    });

    it('drops a socket that stays open but silent', async () => {
        vi.useFakeTimers();
        const adapter = new BinanceAdapter({
            fetch: fakeVenue().fetchFn,
            WebSocket: FakeSocket as any,
            wsHosts: ['wss://a.test'],
        });
        adapter.subscribeBars('BTCUSDT', '1', () => {});
        FakeSocket.instances[0].fire('open', {});
        await vi.advanceTimersByTimeAsync(27_000);
        expect(FakeSocket.instances.length).toBe(2); // watchdog closed it and a new one was opened
        adapter.close();
    });
});
