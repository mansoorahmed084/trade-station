import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BarStore, MarketDataService, SyntheticAdapter } from '@ts/datafeed';
import { ScriptHost, type ScriptRun } from '@ts/script-engine';
import { findAlertConditions } from '@ts/script-engine/source';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/db.ts';
import { EXAMPLES } from '../src/examples.ts';
import { BUNDLED, INDICATORS } from '../src/library/index.ts';
import { ScriptStore } from '../src/routes/scripts.ts';

const ids = (store: ScriptStore) => store.list().map((s) => s.id);
const INDICATOR_IDS = INDICATORS.map((s) => s.id);

describe('seeding the script library', () => {
    it('gives an empty library every bundled script, examples first', () => {
        const store = new ScriptStore(new Db(':memory:'));
        expect(ids(store)).toEqual(BUNDLED.map((s) => s.id));
        expect(store.list().every((s) => s.builtin)).toBe(true);
        expect(store.get(INDICATOR_IDS[0])).toMatchObject({ kind: 'indicator', author: 'StockCryptoScreener' });
    });

    it('adds newly bundled scripts once to a library that predates them, and nothing you deleted', () => {
        // A library as earlier versions left it: the examples (one since deleted), your own script, no record.
        const db = new Db(':memory:');
        const insert = db.sql.prepare(
            'INSERT INTO scripts (id, name, source, kind, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        );
        for (const e of EXAMPLES.slice(1)) insert.run(e.id, e.name, e.source, 'indicator', 1, 1, 1);
        insert.run('scr-mine', 'Mine', '//@version=6\nindicator("Mine")\nplot(close)', 'indicator', 0, 2, 2);

        const store = new ScriptStore(db);
        // The new indicators arrive at the top of the list; the deleted example does not come back.
        expect(ids(store).slice(0, 2)).toEqual(INDICATOR_IDS);
        expect(ids(store)).toHaveLength(EXAMPLES.length + 2);
        expect(store.get(EXAMPLES[0].id)).toBeNull();
        expect(store.get('scr-mine')?.builtin).toBe(false);

        // Delete one of them: the next start leaves it deleted, and changes nothing else.
        expect(store.delete(INDICATOR_IDS[1])).toBe(true);
        const before = ids(store);
        expect(ids(new ScriptStore(db))).toEqual(before);
    });

    it('seeds everything again once the library has been emptied', () => {
        const db = new Db(':memory:');
        const store = new ScriptStore(db);
        for (const id of ids(store)) store.delete(id);
        expect(ids(new ScriptStore(db))).toEqual(BUNDLED.map((s) => s.id));
    });
});

describe('the bundled indicators', () => {
    const MIN = 60_000;
    const GENESIS = Date.UTC(2025, 0, 1);
    let dir: string;
    let data: MarketDataService;
    let host: ScriptHost;

    beforeAll(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(GENESIS + 40_000 * MIN + 17_000);
        dir = mkdtempSync(join(tmpdir(), 'ts-library-'));
        data = new MarketDataService({
            adapters: [new SyntheticAdapter({ genesis: GENESIS })],
            store: new BarStore(dir),
        });
        await data.init();
        host = new ScriptHost(data);
    });

    afterAll(() => {
        data.close();
        vi.useRealTimers();
        rmSync(dir, { recursive: true, force: true });
    });

    const source = (id: string) => INDICATORS.find((s) => s.id === id)!.source;
    const values = (run: ScriptRun, plot: string) => run.plots[plot].filter((v): v is number => v !== null);
    const within = (run: ScriptRun, plot: string, lo: number, hi: number) => {
        const v = values(run, plot);
        expect(v.length, plot).toBeGreaterThan(run.times.length / 2);
        expect(Math.min(...v), plot).toBeGreaterThanOrEqual(lo);
        expect(Math.max(...v), plot).toBeLessThanOrEqual(hi);
    };

    it('Technical Sentiment Composite reads 0-100 and is the average of its two groups', async () => {
        const run = await host.run(source('indicator-technical-sentiment-composite'), 'SYNTH:ALPHA', '15', {
            bars: 1200,
        });
        expect(run.warnings).toEqual([]);
        for (const plot of ['Sentiment', 'Momentum average', 'Trend average']) within(run, plot, 0, 100);
        // Five momentum tools and, on intraday bars with volume, six trend tools.
        for (let i = 0; i < run.times.length; i++) {
            const s = run.plots.Sentiment[i];
            if (s === null) continue;
            const expected = (5 * run.plots['Momentum average'][i]! + 6 * run.plots['Trend average'][i]!) / 11;
            expect(Math.abs(s - expected), `bar ${i}`).toBeLessThan(1e-9);
        }
        // It moves: a reading that sat in one band would mean a broken scale.
        expect(Math.min(...values(run, 'Sentiment'))).toBeLessThan(40);
        expect(Math.max(...values(run, 'Sentiment'))).toBeGreaterThan(60);
        // Daily bars drop the session VWAP, leaving five trend tools.
        const daily = await host.run(source('indicator-technical-sentiment-composite'), 'SYNTH:ALPHA', '1D', {
            bars: 600,
        });
        const last = daily.times.length - 1;
        expect(daily.plots.Sentiment[last]).toBeCloseTo(
            (daily.plots['Momentum average'][last]! + daily.plots['Trend average'][last]!) / 2,
            9,
        );
        expect(findAlertConditions(source('indicator-technical-sentiment-composite'))).toHaveLength(6);
    });

    it('Wave & Flow Matrix keeps its wave, signal, flow and meter on scale and marks its turns', async () => {
        const run = await host.run(source('indicator-wave-flow-matrix'), 'SYNTH:ALPHA', '15', { bars: 1200 });
        expect(run.warnings).toEqual([]);
        for (const plot of ['Wave', 'Signal', 'Money flow', 'Confluence meter']) within(run, plot, 0, 100);
        // The learned thresholds sit either side of the midline.
        expect(Math.min(...values(run, 'Money flow upper threshold'))).toBeGreaterThanOrEqual(50);
        expect(Math.max(...values(run, 'Money flow lower threshold'))).toBeLessThanOrEqual(50);
        // A turn up is the bar the wave crosses above its signal; every marked one must be exactly that.
        const marked = ['Turn up', 'Strong turn up'].flatMap((plot) =>
            run.plots[plot].flatMap((v, i) => (v === null ? [] : [i])),
        );
        expect(marked.length).toBeGreaterThan(10);
        for (const i of marked) {
            expect(run.plots.Wave[i]!, `bar ${i}`).toBeGreaterThan(run.plots.Signal[i]!);
            expect(run.plots.Wave[i - 1]!, `bar ${i - 1}`).toBeLessThanOrEqual(run.plots.Signal[i - 1]!);
        }
        expect(run.alerts.some((a) => a.title === 'Turn up')).toBe(true);
        expect(findAlertConditions(source('indicator-wave-flow-matrix'))).toHaveLength(14);

        // The other signal line: a stop that trails the wave.
        const trailing = await host.run(source('indicator-wave-flow-matrix'), 'SYNTH:ALPHA', '15', {
            bars: 1200,
            inputs: { 'Signal line': 'Trailing stop' },
        });
        within(trailing, 'Signal', 0, 100);
        expect(trailing.plots.Signal).not.toEqual(run.plots.Signal);
    });
});
