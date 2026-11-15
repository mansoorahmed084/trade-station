import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, type Bar, BarSeries, barOpenTime } from '@ts/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarStore, MarketDataService, mergeRanges, SyntheticAdapter, subtractRanges } from '../src/index.ts';

const MIN = 60_000;
const GENESIS = Date.UTC(2025, 0, 1);
const key = { provider: 'TEST', ticker: 'AAA', timeframe: '1' };

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-datafeed-'));
});
afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

const mk = (time: number, price = 1): Bar => ({
    time,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 5,
});

describe('range maths', () => {
    it('merges touching and overlapping ranges', () => {
        expect(
            mergeRanges([
                [5, 8],
                [0, 3],
                [3, 5],
                [10, 12],
                [11, 15],
                [20, 20],
            ]),
        ).toEqual([
            [0, 8],
            [10, 15],
        ]);
    });

    it('subtracts covered ranges from a request', () => {
        const have = mergeRanges([
            [10, 20],
            [30, 40],
        ]);
        expect(subtractRanges(0, 50, have)).toEqual([
            [0, 10],
            [20, 30],
            [40, 50],
        ]);
        expect(subtractRanges(12, 18, have)).toEqual([]);
        expect(subtractRanges(15, 35, have)).toEqual([[20, 30]]);
        expect(subtractRanges(0, 5, have)).toEqual([[0, 5]]);
        expect(subtractRanges(40, 45, [])).toEqual([[40, 45]]);
    });
});

describe('BarStore', () => {
    it('persists bars across instances and year boundaries', () => {
        const a = new BarStore(dir);
        const newYear = Date.UTC(2025, 0, 1);
        const bars = [-2, -1, 0, 1, 2].map((m) => mk(newYear + m * MIN, 100 + m));
        a.write(key, bars);
        a.addCoverage(key, bars[0].time, bars[4].time + MIN);

        const b = new BarStore(dir);
        expect(b.read(key, 0, Number.MAX_SAFE_INTEGER).toBars()).toEqual(bars);
        expect(b.read(key, newYear, newYear + 2 * MIN).toBars()).toEqual(bars.slice(2, 4));
        expect(b.coverage(key)).toEqual([[bars[0].time, bars[4].time + MIN]]);
        expect(b.missing(key, bars[0].time - 2 * MIN, bars[4].time + 3 * MIN)).toEqual([
            [bars[0].time - 2 * MIN, bars[0].time],
            [bars[4].time + MIN, bars[4].time + 3 * MIN],
        ]);
    });

    it('appends, back-fills and overwrites without duplicating', () => {
        const store = new BarStore(dir);
        const t0 = Date.UTC(2025, 5, 1);
        store.write(key, [mk(t0 + 2 * MIN), mk(t0 + 3 * MIN)]);
        store.write(key, [mk(t0 + 4 * MIN)]); // pure append
        store.write(key, [mk(t0), mk(t0 + MIN)]); // back-fill
        store.write(key, [mk(t0 + 3 * MIN, 9)]); // overwrite
        const fresh = new BarStore(dir).read(key, t0, t0 + 10 * MIN);
        expect(Array.from(fresh.time.subarray(0, fresh.length))).toEqual([0, 1, 2, 3, 4].map((m) => t0 + m * MIN));
        expect(fresh.at(3).close).toBe(9);
    });

    it('extends coverage only when the new range touches an existing one', () => {
        const store = new BarStore(dir);
        store.addCoverage(key, 0, 10);
        expect(store.extendCoverage(key, 10, 11)).toBe(true);
        expect(store.extendCoverage(key, 50, 51)).toBe(false);
        expect(store.coverage(key)).toEqual([[0, 11]]);
    });
});

describe('MarketDataService on the synthetic venue', () => {
    function setup(nowMs: number) {
        vi.useFakeTimers();
        vi.setSystemTime(nowMs);
        const adapter = new SyntheticAdapter({ genesis: GENESIS });
        const getBars = vi.spyOn(adapter, 'getBars');
        const service = new MarketDataService({ adapters: [adapter], store: new BarStore(dir) });
        return { adapter, service, getBars };
    }

    it('resolves bare and prefixed symbols', async () => {
        const { service } = setup(GENESIS + 600 * MIN);
        await service.init();
        expect(service.resolve('ALPHA').info.symbol).toBe('SYNTH:ALPHA');
        expect(service.resolve('synth:ALPHA').info.ticker).toBe('ALPHA');
        expect(() => service.resolve('NOPE')).toThrow(/Unknown symbol/);
        service.close();
    });

    it('serves history from the cache after the first fetch', async () => {
        const now = GENESIS + 5000 * MIN + 20_000;
        const { service, getBars } = setup(now);
        await service.init();
        const first = await service.getBars('SYNTH:ALPHA', '1', { limit: 500 });
        expect(first.length).toBe(500);
        expect(first.lastTime).toBe(barOpenTime(now, '1'));
        const calls = getBars.mock.calls.length;
        const again = await service.getBars('SYNTH:ALPHA', '1', { limit: 500 });
        // an immediate repeat is answered entirely from memory and disk
        expect(getBars.mock.calls.length).toBe(calls);
        expect(again.toBars()).toEqual(first.toBars());
        // once the forming bar is stale, it alone is re-fetched
        vi.setSystemTime(now + 5_000);
        const later = await service.getBars('SYNTH:ALPHA', '1', { limit: 500 });
        expect(getBars.mock.calls.length).toBe(calls + 1);
        expect(later.toBars(0, 499)).toEqual(first.toBars(0, 499));
        service.close();
    });

    it('builds non-native timeframes that match a direct aggregation', async () => {
        const now = GENESIS + 3000 * MIN + 1_000;
        const { service } = setup(now);
        await service.init();
        const from = GENESIS + 1000 * MIN;
        const base = await service.getBars('SYNTH:ALPHA', '1', { from });
        for (const tf of ['5', '45', '60', '1D']) {
            const got = await service.getBars('SYNTH:ALPHA', tf, { from });
            const want = aggregate(base.range(barOpenTime(from, tf), Number.MAX_SAFE_INTEGER), tf);
            // the first coarse bar may start before `from`; compare from the first fully covered bucket
            const start = got.lowerBound(barOpenTime(from, tf) + 1);
            expect(got.length).toBeGreaterThan(2);
            for (let i = start; i < got.length; i++) {
                const w = want.at(want.indexOf(got.time[i]));
                expect(got.at(i)).toEqual(w);
            }
        }
        service.close();
    });

    it('returns the newest `limit` bars and stops at the listing date', async () => {
        const { service } = setup(GENESIS + 50 * MIN + 5_000);
        await service.init();
        const all = await service.getBars('SYNTH:ALPHA', '1', { limit: 5000 });
        expect(all.firstTime).toBe(GENESIS);
        expect(all.length).toBe(51);
        const deep = await service.getBars('SYNTH:ALPHA', '1', { from: 0 });
        expect(deep.length).toBe(51);
        service.close();
    });

    it('live bars equal history: no missing, duplicate or different bars after a soak', async () => {
        const start = GENESIS + 1000 * MIN + 7_000;
        const { service } = setup(start);
        await service.init();
        const closed: Record<string, Bar[]> = { '1': [], '5': [] };
        const last: Record<string, Bar | null> = { '1': null, '5': null };
        const stops = ['1', '5'].map((tf) =>
            service.subscribe('SYNTH:ALPHA', tf, (bar, opened) => {
                if (opened && last[tf]) closed[tf].push(last[tf]!);
                last[tf] = { ...bar };
            }),
        );
        await vi.advanceTimersByTimeAsync(47 * MIN);
        for (const stop of stops) stop();

        for (const tf of ['1', '5']) {
            const live = closed[tf];
            expect(live.length).toBeGreaterThanOrEqual(tf === '1' ? 46 : 8);
            const history = await service.getBars('SYNTH:ALPHA', tf, {
                from: live[0].time,
                to: live[live.length - 1].time,
            });
            // drop a forming tail, if the window reaches now
            const want = history.toBars().filter((b) => b.time <= live[live.length - 1].time);
            expect(live.map((b) => b.time)).toEqual(want.map((b) => b.time));
            // the first live bar of an aggregated timeframe is seeded mid-bucket; all later ones must match exactly
            expect(live.slice(1)).toEqual(want.slice(1));
        }
        service.close();
    });

    it('persists live-closed bars so a later history request needs no fetch for them', async () => {
        const start = GENESIS + 200 * MIN + 1_000;
        const { service, getBars } = setup(start);
        await service.init();
        await service.getBars('SYNTH:ALPHA', '1', { limit: 50 });
        const stop = service.subscribe('SYNTH:ALPHA', '1', () => {});
        await vi.advanceTimersByTimeAsync(10 * MIN);
        const before = getBars.mock.calls.length;
        const bars = await service.getBars('SYNTH:ALPHA', '1', { limit: 55 });
        expect(bars.length).toBe(55);
        expect(getBars.mock.calls.length).toBe(before); // forming bar came from the live hub, history from disk
        stop();
        service.close();
    });

    it('releases upstream streams when the last listener leaves', async () => {
        const { service } = setup(GENESIS + 100 * MIN);
        await service.init();
        const a = service.subscribe('SYNTH:ALPHA', '5', () => {});
        const b = service.subscribe('SYNTH:ALPHA', '5', () => {});
        expect(service.stats().hubs).toBe(2); // the 5m hub and its 1m base
        a();
        expect(service.stats().hubs).toBe(2);
        b();
        expect(service.stats().hubs).toBe(0);
        expect(service.stats().tradeHubs).toBe(0);
        service.close();
    });
});

describe('trades and footprints', () => {
    it('makes up each synthetic bar from trades that add up to its volume, inside its range', async () => {
        const adapter = new SyntheticAdapter({ genesis: GENESIS, now: () => GENESIS + 600 * MIN });
        const { trades } = await adapter.getTrades('ALPHA', GENESIS + 100 * MIN, GENESIS + 103 * MIN, 1e6);
        const bars = await adapter.getBars('ALPHA', '1', { from: GENESIS + 100 * MIN, to: GENESIS + 102 * MIN });
        expect(bars).toHaveLength(3);
        for (const bar of bars) {
            const own = trades.filter((t) => t.time >= bar.time && t.time < bar.time + MIN);
            expect(own.length).toBeGreaterThanOrEqual(20);
            expect(own.reduce((a, t) => a + t.size, 0)).toBeCloseTo(bar.volume, 6);
            expect(own.every((t) => t.price >= bar.low - 1e-9 && t.price <= bar.high + 1e-9)).toBe(true);
            expect(own[0].price).toBeCloseTo(bar.open, 6);
            expect(own.at(-1)!.price).toBeCloseTo(bar.close, 6);
        }
        // The same bars give the same trades.
        const again = await adapter.getTrades('ALPHA', GENESIS + 100 * MIN, GENESIS + 103 * MIN, 1e6);
        expect(again.trades).toEqual(trades);
        expect((await adapter.getTrades('ALPHA', GENESIS, GENESIS + 600 * MIN, 50)).truncated).toBe(true);
    });

    it('builds footprints whose volume matches the bars, and fetches only what is new', async () => {
        let now = GENESIS + 2000 * MIN + 30_000;
        const adapter = new SyntheticAdapter({ genesis: GENESIS, now: () => now });
        const service = new MarketDataService({ adapters: [adapter], store: new BarStore(dir), now: () => now });
        await service.init();
        const spy = vi.spyOn(adapter, 'getTrades');
        const fp = await service.footprint('SYNTH:ALPHA', '5', { bars: 12 });
        const bars = await service.getBars('SYNTH:ALPHA', '5', { limit: 12 });
        expect(fp.bars.map((b) => b.time)).toEqual(Array.from(bars.time.subarray(0, 12)));
        for (let i = 0; i < 11; i++) {
            const b = fp.bars[i];
            expect(b.buy + b.sell).toBeCloseTo(bars.volume[i], 4);
            expect(b.delta).toBeCloseTo(b.buy - b.sell, 9);
            expect(b.levels[0].price).toBeGreaterThanOrEqual(Math.floor(bars.low[i] / fp.rowSize) * fp.rowSize - 1e-9);
        }
        expect(fp.rowSize).toBeGreaterThan(0);
        expect(spy).toHaveBeenCalledTimes(1);
        // A minute later only the bar still forming is read again.
        now += MIN;
        await service.footprint('SYNTH:ALPHA', '5', { bars: 12, rowSize: fp.rowSize });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[1][1]).toBe(bars.time[11]);
        service.close();
    });
});

describe('deep downloads', () => {
    it('fill older history around stored bars in a few large writes, storing exactly what a fresh load does', async () => {
        vi.useFakeTimers();
        const now = GENESIS + 400_000 * MIN + 30_000;
        vi.setSystemTime(now);
        const store = new BarStore(join(dir, 'a'));
        const service = new MarketDataService({ adapters: [new SyntheticAdapter({ genesis: GENESIS })], store });
        await service.init();
        // A chart already stored the recent end; a deep backtest then asks for far more.
        await service.getBars('SYNTH:ALPHA', '1', { limit: 5000 });
        const writes = vi.spyOn(store, 'write');
        const deep = await service.getBars('SYNTH:ALPHA', '1', { limit: 350_000 });
        expect(deep.length).toBe(350_000);
        // 345 windows of 1,000 bars were fetched; they reach the disk in two writes, not 345.
        expect(writes.mock.calls.length).toBeLessThanOrEqual(3);
        service.close();

        const freshStore = new BarStore(join(dir, 'b'));
        const fresh = new MarketDataService({
            adapters: [new SyntheticAdapter({ genesis: GENESIS })],
            store: freshStore,
        });
        await fresh.init();
        const reference = await fresh.getBars('SYNTH:ALPHA', '1', { limit: 350_000 });
        fresh.close();
        expect(deep.toBars()).toEqual(reference.toBars());
        // And what is on disk reads back the same, gap-free.
        const key = { provider: 'SYNTH', ticker: 'ALPHA', timeframe: '1' };
        const stored = new BarStore(join(dir, 'a')).read(key, deep.time[0], deep.time[deep.length - 2] + 1);
        expect(stored.length).toBe(deep.length - 1); // the last one is still forming and never stored
        expect(new BarStore(join(dir, 'a')).missing(key, deep.time[0], deep.time[deep.length - 1])).toEqual([]);
    });
});

describe('gap repair after an upstream reconnect', () => {
    it('replays missed bars in order', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(GENESIS + 100 * MIN + 1_000);
        const adapter = new SyntheticAdapter({ genesis: GENESIS });
        let fire: () => void = () => {};
        (adapter as any).onReconnect = (handler: () => void) => {
            fire = handler;
            return () => {};
        };
        const service = new MarketDataService({ adapters: [adapter], store: new BarStore(dir) });
        await service.init();
        const seen: number[] = [];
        // Freeze the upstream stream after the first bar by swapping in a stream that never ticks again.
        const real = adapter.subscribeBars.bind(adapter);
        let stopUpstream: () => void = () => {};
        vi.spyOn(adapter, 'subscribeBars').mockImplementation((ticker, tf, onBar) => {
            let delivered = false;
            stopUpstream = real(ticker, tf, (bar, t) => {
                if (delivered) return;
                delivered = true;
                onBar(bar, t);
            });
            return stopUpstream;
        });
        const stop = service.subscribe('SYNTH:ALPHA', '1', (bar, opened) => {
            if (opened) seen.push(bar.time);
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(seen.length).toBe(1);
        await vi.advanceTimersByTimeAsync(5 * MIN); // upstream is silent: five bars are missed
        expect(seen.length).toBe(1);
        fire();
        await vi.advanceTimersByTimeAsync(10);
        const expected = [0, 1, 2, 3, 4, 5].map((m) => GENESIS + (100 + m) * MIN);
        expect(seen).toEqual(expected);
        stop();
        service.close();
    });
});

describe('BarSeries wire round trip through the service', () => {
    it('encodes what getBars returns', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(GENESIS + 300 * MIN);
        const service = new MarketDataService({
            adapters: [new SyntheticAdapter({ genesis: GENESIS })],
            store: new BarStore(dir),
        });
        await service.init();
        const series = await service.getBars('SYNTH:GAMMA', '15', { limit: 10 });
        expect(BarSeries.decode(series.encode()).toBars()).toEqual(series.toBars());
        service.close();
    });
});
