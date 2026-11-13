import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barOpenTime } from '@ts/core';
import { BarStore, MarketDataService, SyntheticAdapter } from '@ts/datafeed';
import { RSI, series } from '@ts/indicators';
import { ScriptHost } from '@ts/script-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type Alert,
    AlertEngine,
    type AlertEvent,
    type AlertInput,
    type AlertStore,
    checkCondition,
} from '../src/index.ts';

/** The real clock, captured before any test installs the fake one (which also fakes performance.now and hrtime). */
const realNow = performance.now.bind(performance);

const MIN = 60_000;
const GENESIS = Date.UTC(2025, 0, 1);
const START = GENESIS + 20_000 * MIN + 13_000;

class MemoryStore implements AlertStore {
    alerts = new Map<string, Alert>();
    log: AlertEvent[] = [];
    list() {
        // what a database would hand back: detached copies
        return [...this.alerts.values()].map((a) => structuredClone(a));
    }
    save(alert: Alert) {
        this.alerts.set(alert.id, structuredClone(alert));
    }
    remove(id: string) {
        this.alerts.delete(id);
    }
    appendLog(event: AlertEvent) {
        this.log.push(structuredClone(event));
    }
    updateLog(event: AlertEvent) {
        const i = this.log.findIndex((e) => e.id === event.id);
        if (i >= 0) this.log[i] = structuredClone(event);
    }
}

let dir: string;
let data: MarketDataService;
let store: MemoryStore;
let engine: AlertEngine;
const engines: AlertEngine[] = [];

function makeEngine(s = store): AlertEngine {
    const host = new ScriptHost(data);
    const e = new AlertEngine({
        data,
        store: s,
        scripts: { run: (src, sym, tf, o) => host.run(src, sym, tf, o), resolve: () => null },
    });
    engines.push(e);
    return e;
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    dir = mkdtempSync(join(tmpdir(), 'ts-alerts-'));
    data = new MarketDataService({ adapters: [new SyntheticAdapter({ genesis: GENESIS })], store: new BarStore(dir) });
    await data.init();
    store = new MemoryStore();
    engine = makeEngine();
    await engine.start();
});

afterEach(() => {
    for (const e of engines.splice(0)) e.stop();
    data.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

const price = { type: 'price' } as const;
const level = (value: number) => ({ type: 'value', value }) as const;
const always: AlertInput['condition'] = { left: price, op: 'greater', right: level(0) };
const run = (minutes: number) => vi.advanceTimersByTimeAsync(minutes * MIN);

/** Bar times at which RSI(14) crossed up through 50 at the close, among bars opening in [from, to]. */
async function expectedRsiCrosses(symbol: string, from: number, to: number): Promise<number[]> {
    const bars = (await data.getBars(symbol, '1', { from: from - 2000 * MIN, to }))
        .toBars()
        .filter((b) => b.time <= to);
    const rsi = series(
        new RSI(14),
        bars.map((b) => b.close),
    );
    const out: number[] = [];
    for (let i = 1; i < bars.length; i++)
        if (bars[i].time >= from && rsi[i - 1] <= 50 && rsi[i] > 50) out.push(bars[i].time);
    return out;
}

const rsiCross: AlertInput['condition'] = {
    left: { type: 'indicator', study: 'rsi', params: { length: 14 } },
    op: 'crossing_up',
    right: level(50),
};

describe('firing rules', () => {
    it('once: fires on the first tick that meets the condition, then stops', async () => {
        const alert = await engine.create({
            name: 'Any price',
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once',
            message: '{{ticker}} is at {{close}} ({{interval_label}})',
        });
        await run(3);
        expect(store.log.length).toBe(1);
        const [event] = store.log;
        expect(event).toMatchObject({
            alertId: alert.id,
            alertName: 'Any price',
            symbol: 'SYNTH:ALPHA',
            timeframe: '1',
            late: false,
        });
        expect(event.message).toMatch(/^ALPHA is at \d+\.\d\d \(1m\)$/);
        expect(event.barTime).toBe(barOpenTime(START, '1'));
        expect(event.time - START).toBeLessThanOrEqual(500); // within two stream ticks of starting
        expect(engine.get(alert.id)).toMatchObject({ active: false, state: { fireCount: 1, done: ['SYNTH:ALPHA'] } });
        expect(engine.stats().runtimes).toBe(0);
    });

    it('once per bar: at most one fire per bar, at the first tick of each', async () => {
        await engine.create({ symbols: ['SYNTH:ALPHA'], timeframe: '1', condition: always, frequency: 'once_per_bar' });
        await run(5);
        const bars = store.log.map((e) => e.barTime);
        expect(bars.length).toBe(6); // the bar in progress plus five more
        expect(new Set(bars).size).toBe(6);
        for (const e of store.log.slice(1)) expect(e.time - e.barTime).toBeLessThanOrEqual(500);
    });

    it('once per bar close: fires only when a bar closes, with that bar’s final values', async () => {
        await engine.create({
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once_per_bar_close',
            message: '{{close}}',
        });
        await run(5);
        expect(store.log.length).toBe(5);
        const history = await data.getBars('SYNTH:ALPHA', '1', {
            from: store.log[0].barTime,
            to: store.log[4].barTime,
        });
        store.log.forEach((e, i) => {
            expect(e.barTime).toBe(history.time[i]);
            expect(e.price).toBe(history.close[i]);
            expect(e.message).toBe(history.close[i].toFixed(2));
            expect(e.time).toBeGreaterThanOrEqual(e.barTime + MIN); // announced after the close, not before
        });
    });

    it('every time: re-arms each bar, and repeats within a bar only after the cooldown', async () => {
        await engine.create({ symbols: ['SYNTH:ALPHA'], timeframe: '1', condition: always, frequency: 'every_time' });
        await engine.create({
            symbols: ['SYNTH:BETA'],
            timeframe: '1',
            condition: always,
            frequency: 'every_time',
            cooldownMs: 20_000,
        });
        await run(3);
        const alpha = store.log.filter((e) => e.symbol === 'SYNTH:ALPHA');
        const beta = store.log.filter((e) => e.symbol === 'SYNTH:BETA');
        expect(alpha.length).toBe(4); // one per bar
        expect(beta.length).toBeGreaterThanOrEqual(9); // roughly every 20 s over 3 min
        expect(beta.length).toBeLessThanOrEqual(11);
        for (let i = 1; i < beta.length; i++) expect(beta[i].time - beta[i - 1].time).toBeGreaterThanOrEqual(20_000);
    });

    it('catches a level crossed in the middle of a bar, at the tick it happens', async () => {
        // The synthetic venue is deterministic: read the next bar from a copy of it running in the future.
        const future = new SyntheticAdapter({ genesis: GENESIS, now: () => START + 10 * MIN });
        const next = (
            await future.getBars('GAMMA', '1', {
                from: barOpenTime(START, '1') + MIN,
                to: barOpenTime(START, '1') + MIN,
            })
        )[0];
        const target = Math.round(((next.high + next.low) / 2) * 10) / 10;
        expect(next.high - next.low).toBeGreaterThan(0.3);
        await engine.create({
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: { left: price, op: 'crossing', right: level(target) },
            frequency: 'once',
        });
        await run(2.2);
        expect(store.log.length).toBe(1);
        const [event] = store.log;
        expect(event.barTime).toBeLessThanOrEqual(next.time);
        // fired on the tick that crossed, so the price is right next to the level, not the bar's close
        expect(Math.abs(event.price - target)).toBeLessThanOrEqual((next.high - next.low) / 2);
        expect(event.time).toBeLessThan(next.time + MIN);
    });
});

describe('indicator alerts agree with history', () => {
    it('RSI crossing 50 fires on exactly the bars where the closed-bar RSI crossed', async () => {
        await engine.create({
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: rsiCross,
            frequency: 'once_per_bar_close',
        });
        const first = barOpenTime(START, '1');
        await run(240);
        const lastClosed = barOpenTime(Date.now(), '1') - MIN;
        const expected = await expectedRsiCrosses('SYNTH:GAMMA', first, lastClosed);
        expect(expected.length).toBeGreaterThan(5);
        expect(store.log.map((e) => e.barTime)).toEqual(expected);
        expect(store.log.every((e) => !e.late)).toBe(true);
    });

    it('a Pine plot and a Pine alertcondition fire on the same bars as the native indicator', async () => {
        const source =
            '//@version=6\nindicator("R")\nr = ta.rsi(close, 14)\nplot(r, "RSI")\nalertcondition(ta.crossover(r, 50), "Up", "RSI up")\nif ta.crossover(r, 50)\n    alert("script says " + str.tostring(close))';
        await engine.create({
            name: 'native',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: rsiCross,
            frequency: 'once_per_bar_close',
        });
        await engine.create({
            name: 'plot',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: { left: { type: 'plot', source, plot: 'RSI' }, op: 'crossing_up', right: level(50) },
            frequency: 'once_per_bar_close',
        });
        await engine.create({
            name: 'condition',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: { scriptAlert: { source, title: 'Up' } },
            frequency: 'once_per_bar_close',
        });
        await engine.create({
            name: 'call',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: { scriptAlert: { source } },
            frequency: 'once_per_bar_close',
        });
        await run(90);
        const bars = (name: string) => store.log.filter((e) => e.alertName === name).map((e) => e.barTime);
        expect(bars('native').length).toBeGreaterThan(2);
        expect(bars('plot')).toEqual(bars('native'));
        expect(bars('condition')).toEqual(bars('native'));
        expect(bars('call')).toEqual(bars('native'));
        // an alert() call supplies its own message when the alert has none
        expect(store.log.find((e) => e.alertName === 'call')!.message).toMatch(/^script says \d/);
    });
});

describe('surviving a restart', () => {
    it('keeps state, does not re-fire, and reports what happened while it was down as late', async () => {
        const created = await engine.create({
            name: 'RSI',
            symbols: ['SYNTH:GAMMA'],
            timeframe: '1',
            condition: rsiCross,
            frequency: 'once_per_bar_close',
        });
        await engine.create({
            name: 'Once',
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once',
        });
        const first = barOpenTime(START, '1');
        await run(60);
        const beforeStop = store.log.filter((e) => e.alertName === 'RSI').map((e) => e.barTime);
        const lastSeen = barOpenTime(Date.now(), '1') - MIN;
        engine.stop();
        expect(store.alerts.get(created.id)!.state.lastBarTime['SYNTH:GAMMA']).toBe(lastSeen);

        await run(45); // nothing is running
        expect(store.log.filter((e) => e.alertName === 'RSI').length).toBe(beforeStop.length);

        const second = makeEngine();
        await second.start();
        const downUntil = barOpenTime(Date.now(), '1') - MIN;
        const missed = await expectedRsiCrosses('SYNTH:GAMMA', lastSeen + MIN, downUntil);
        expect(missed.length).toBeGreaterThan(0);
        const late = store.log.filter((e) => e.alertName === 'RSI' && e.late);
        expect(late.map((e) => e.barTime)).toEqual(missed.slice(0, 5)); // late reports are capped at five
        expect(store.log.filter((e) => e.alertName === 'Once').length).toBe(1); // the finished alert stays finished
        expect(second.get(created.id)!.state.fireCount).toBe(beforeStop.length + late.length);

        await run(60);
        const all = store.log.filter((e) => e.alertName === 'RSI' && !e.late).map((e) => e.barTime);
        const liveExpected = [
            ...(await expectedRsiCrosses('SYNTH:GAMMA', first, lastSeen)),
            ...(await expectedRsiCrosses('SYNTH:GAMMA', downUntil + MIN, barOpenTime(Date.now(), '1') - MIN)),
        ];
        expect(all).toEqual(liveExpected);
    });
});

describe('managing alerts', () => {
    it('a watchlist alert fires once per symbol', async () => {
        const alert = await engine.create({
            name: 'Basket',
            symbols: ['SYNTH:ALPHA', 'BETA', 'synth:gamma'],
            timeframe: '5',
            condition: always,
            frequency: 'once',
        });
        expect(alert.symbols).toEqual(['SYNTH:ALPHA', 'SYNTH:BETA', 'SYNTH:GAMMA']);
        await run(1);
        expect(store.log.map((e) => e.symbol).sort()).toEqual(['SYNTH:ALPHA', 'SYNTH:BETA', 'SYNTH:GAMMA']);
        expect(engine.get(alert.id)!.active).toBe(false);
    });

    it('pause stops it, resume starts it again without replaying the pause', async () => {
        const alert = await engine.create({
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once_per_bar_close',
        });
        await run(3);
        expect(store.log.length).toBe(3);
        await engine.setActive(alert.id, false);
        await run(10);
        expect(store.log.length).toBe(3);
        await engine.setActive(alert.id, true);
        await run(2);
        expect(store.log.length).toBe(5);
        expect(store.log.every((e) => !e.late)).toBe(true);
    });

    it('an edit takes effect immediately and a deleted alert never fires again', async () => {
        const alert = await engine.create({
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: { left: price, op: 'less', right: level(0) },
            frequency: 'once_per_bar',
        });
        await run(2);
        expect(store.log.length).toBe(0);
        const updated = await engine.update(alert.id, { condition: always, name: 'Now true' });
        expect(updated).toMatchObject({ id: alert.id, name: 'Now true', createdAt: alert.createdAt });
        await run(1);
        expect(store.log.length).toBeGreaterThanOrEqual(1);
        expect(engine.remove(alert.id)).toBe(true);
        const count = store.log.length;
        await run(3);
        expect(store.log.length).toBe(count);
        expect(store.alerts.size).toBe(0);
        expect(engine.remove('nope')).toBe(false);
        expect(await engine.update('nope', {})).toBeNull();
    });

    it('an alert stops at its expiry', async () => {
        const alert = await engine.create({
            symbols: ['SYNTH:ALPHA'],
            timeframe: '1',
            condition: always,
            frequency: 'once_per_bar_close',
            expiresAt: START + 2.5 * MIN,
        });
        await run(6);
        expect(store.log.length).toBe(2);
        expect(engine.get(alert.id)!.active).toBe(false);
    });

    it('rejects malformed alerts with a reason', async () => {
        const base = { symbols: ['SYNTH:ALPHA'], timeframe: '1', condition: always };
        await expect(engine.create({ ...base, symbols: [] })).rejects.toThrow(/at least one symbol/);
        await expect(engine.create({ ...base, symbols: ['NOPE'] })).rejects.toThrow(/Unknown symbol/);
        await expect(engine.create({ ...base, timeframe: 'zz' })).rejects.toThrow(/timeframe/);
        await expect(engine.create({ ...base, frequency: 'sometimes' as any })).rejects.toThrow(/frequency/);
        await expect(engine.create({ ...base, notify: { webhook: { url: 'ftp://x' } } })).rejects.toThrow(
            /webhook URL/,
        );
        await expect(engine.create({ ...base, notify: { email: { to: 'not-an-address' } } })).rejects.toThrow(/email/);
        expect(() => checkCondition({ left: price, op: 'sideways', right: level(1) })).toThrow(/operator/);
        expect(() => checkCondition({ left: price, op: 'crossing' })).toThrow(/right side/);
        expect(() => checkCondition({ left: price, op: 'moving_up' })).toThrow(/positive amount/);
        expect(() => checkCondition({ left: price, op: 'entering_channel', upper: level(2) })).toThrow(/lower bound/);
        expect(() => checkCondition({ all: [] })).toThrow(/at least one/);
        expect(() => checkCondition({ scriptAlert: {} })).toThrow(/script/);
        expect(store.alerts.size).toBe(0);
    });
});

describe('scale', () => {
    it('1,000 active alerts are evaluated on every tick well inside the delay budget', async () => {
        const last = (await data.getBars('SYNTH:ALPHA', '1', { limit: 1 })).last()!.close;
        for (let i = 0; i < 1000; i++) {
            const far = last * (i % 2 === 0 ? 3 + i / 100 : 0.01);
            const condition: AlertInput['condition'] =
                i % 5 === 0
                    ? {
                          left: { type: 'indicator', study: 'rsi', params: { length: 14 } },
                          op: 'greater',
                          right: level(101),
                      }
                    : { left: price, op: i % 2 === 0 ? 'crossing_up' : 'crossing_down', right: level(far) };
            await engine.create({ symbols: ['SYNTH:ALPHA'], timeframe: '1', condition, frequency: 'once_per_bar' });
        }
        expect(engine.stats()).toMatchObject({ alerts: 1000, active: 1000, runtimes: 1000 });
        const before = engine.evaluations;
        const t0 = realNow();
        await run(1);
        const wall = realNow() - t0;
        const ticks = 240; // one minute at four ticks a second
        const evaluations = engine.evaluations - before;
        expect(evaluations).toBeGreaterThanOrEqual(1000 * (ticks - 2));
        // 100 ms is the budget for one tick across all alerts; the whole minute of 240 ticks must fit many times over
        expect(wall / ticks).toBeLessThan(20);
        expect(store.log.length).toBe(0);
        console.log(
            `1,000 alerts: ${(wall / ticks).toFixed(3)} ms per tick, ${((wall / evaluations) * 1e6).toFixed(0)} ns per evaluation`,
        );
    });
});
