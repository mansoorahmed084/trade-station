import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barOpenTime } from '@ts/core';
import { BarStore, MarketDataService, SyntheticAdapter } from '@ts/datafeed';
import { EMA, RSI, series } from '@ts/indicators';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findUnsupported, readHeader, ScriptHost, stripCommentsAndStrings } from '../src/index.ts';

const MIN = 60_000;
const GENESIS = Date.UTC(2025, 0, 1);
const NOW = GENESIS + 40_000 * MIN + 17_000;

let dir: string;
let data: MarketDataService;
let host: ScriptHost;

beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    dir = mkdtempSync(join(tmpdir(), 'ts-script-'));
    data = new MarketDataService({ adapters: [new SyntheticAdapter({ genesis: GENESIS })], store: new BarStore(dir) });
    await data.init();
    host = new ScriptHost(data);
});

afterAll(() => {
    data.close();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

const EMA_SCRIPT = `//@version=6
indicator("EMA test", overlay=true)
len = input.int(20, "Length", minval=1)
plot(ta.ema(close, len), "EMA")
plot(ta.rsi(close, 14), "RSI")`;

const close = (a: number | null, b: number, name: string, i: number) => {
    if (Number.isNaN(b)) expect(a, `${name}[${i}]`).toBeNull();
    else expect(Math.abs((a as number) - b) / Math.max(1, Math.abs(b)), `${name}[${i}]`).toBeLessThan(1e-9);
};

describe('ScriptHost.run', () => {
    it('computes plots over the same bars the data service serves, matching the native indicators', async () => {
        const run = await host.run(EMA_SCRIPT, 'SYNTH:ALPHA', '5', { bars: 800 });
        const bars = await data.getBars('SYNTH:ALPHA', '5', { limit: 800 });
        expect(run.title).toBe('EMA test');
        expect(run.kind).toBe('indicator');
        expect(run.times).toEqual(Array.from(bars.time.subarray(0, bars.length)));
        expect(run.times.length).toBe(800);
        const closes = bars.toBars().map((b) => b.close);
        const ema = series(new EMA(20), closes);
        const rsi = series(new RSI(14), closes);
        for (let i = 0; i < 800; i++) {
            close(run.plots.EMA[i], ema[i], 'EMA', i);
            close(run.plots.RSI[i], rsi[i], 'RSI', i);
        }
        expect(run.ms).toBeGreaterThan(0);
    });

    it('describes inputs and applies overrides', async () => {
        const run = await host.run(EMA_SCRIPT, 'SYNTH:ALPHA', '5', { bars: 300, inputs: { Length: 5 } });
        expect(run.inputs).toEqual([expect.objectContaining({ title: 'Length', type: 'int', defval: 20, min: 1 })]);
        const bars = await data.getBars('SYNTH:ALPHA', '5', { limit: 300 });
        const ema5 = series(
            new EMA(5),
            bars.toBars().map((b) => b.close),
        );
        for (let i = 0; i < 300; i++) close(run.plots.EMA[i], ema5[i], 'EMA5', i);
    });

    it('can leave out the forming bar, or take an explicit window', async () => {
        const boundary = barOpenTime(NOW, '5');
        const live = await host.run(EMA_SCRIPT, 'SYNTH:ALPHA', '5', { bars: 50 });
        expect(live.times[live.times.length - 1]).toBe(boundary);
        const closed = await host.run(EMA_SCRIPT, 'SYNTH:ALPHA', '5', { bars: 50, closedOnly: true });
        expect(closed.times[closed.times.length - 1]).toBe(boundary - 5 * MIN);
        const from = boundary - 100 * 5 * MIN;
        const windowed = await host.run(EMA_SCRIPT, 'SYNTH:ALPHA', '5', { from, to: from + 40 * 5 * MIN });
        expect(windowed.times[0]).toBe(from);
        expect(windowed.times.length).toBe(41);
    });

    it('resolves request.security through the data service, across timeframes and symbols', async () => {
        const run = await host.run(
            `//@version=6
indicator("MTF")
htf = request.security(syminfo.tickerid, "60", close)
other = request.security("SYNTH:GAMMA", timeframe.period, close)
plot(htf, "H1 close")
plot(other, "Gamma")
plot(syminfo.mintick, "tick")`,
            'SYNTH:ALPHA',
            '5',
            { bars: 400, closedOnly: true },
        );
        const gamma = await data.getBars('SYNTH:GAMMA', '5', {
            from: run.times[0],
            to: run.times[run.times.length - 1],
        });
        const last = run.times.length - 1;
        expect(run.plots.Gamma[last]).toBe(gamma.close[gamma.length - 1]);
        expect(run.plots.Gamma[200]).toBe(gamma.close[200]);
        expect(run.plots.tick[last]).toBe(0.01);
        // the hourly close seen from a 5-minute bar is the close of an hour that had already finished
        const hourly = await data.getBars('SYNTH:ALPHA', '60', { limit: 60 });
        const htf = run.plots['H1 close'][last] as number;
        expect(Array.from(hourly.close.subarray(0, hourly.length))).toContain(htf);
    });

    it('returns strategy results with a consistent trade ledger', async () => {
        const run = await host.run(
            `//@version=6
strategy("Cross", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)
fast = ta.ema(close, 8)
slow = ta.ema(close, 21)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")`,
            'SYNTH:GAMMA',
            '15',
            { bars: 3000, closedOnly: true },
        );
        const s = run.strategy!;
        expect(run.kind).toBe('strategy');
        expect(s.initialCapital).toBe(10000);
        const closed = s.trades.filter((t) => !t.open);
        expect(closed.length).toBeGreaterThan(10);
        expect(s.wins + s.losses + s.even).toBe(closed.length);
        const sum = closed.reduce((a, t) => a + (t.profit ?? 0), 0);
        expect(sum).toBeCloseTo(s.netProfit, 6);
        expect(s.equity).toBeCloseTo(s.initialCapital + s.netProfit + s.openProfit, 6);
        for (const t of closed) {
            expect(t.exitTime!).toBeGreaterThan(t.entryTime);
            expect(t.profit!).toBeCloseTo((t.exitPrice! - t.entryPrice) * t.size - (t.commission ?? 0), 6);
            expect(run.times).toContain(t.entryTime);
        }
    });

    it('collects alerts with the bar they fired on', async () => {
        const run = await host.run(
            `//@version=6
indicator("Alerts")
r = ta.rsi(close, 14)
if ta.crossover(r, 60)
    alert("RSI up " + str.tostring(close), alert.freq_once_per_bar_close)
plot(r)`,
            'SYNTH:ALPHA',
            '5',
            { bars: 1500, closedOnly: true, alertMode: 'all' },
        );
        expect(run.alerts.length).toBeGreaterThan(5);
        for (const a of run.alerts) {
            expect(a.message).toMatch(/^RSI up \d/);
            expect(run.times).toContain(a.time);
        }
    });

    it('reports a failure with its stage and position', async () => {
        await expect(host.run('//@version=6\nindicator("x")\nplot(close', 'SYNTH:ALPHA', '5')).rejects.toMatchObject({
            stage: 'compile',
            line: 3,
        });
        await expect(
            host.run('//@version=6\nindicator("x")\nplot(ta.nope(close))', 'SYNTH:ALPHA', '5'),
        ).rejects.toMatchObject({ stage: 'runtime' });
        await expect(host.run(EMA_SCRIPT, 'SYNTH:NOPE', '5')).rejects.toThrow();
    });
});

describe('compatibility report', () => {
    it('passes a script the runtime fully supports', async () => {
        const report = await host.check(EMA_SCRIPT, 'SYNTH:ALPHA');
        expect(report).toMatchObject({
            ok: true,
            version: 6,
            kind: 'indicator',
            title: 'EMA test',
            errors: [],
            unsupported: [],
            inputs: 1,
            plots: 2,
            bars: 500,
        });
    });

    it('names built-ins the runtime lacks, with their position, and does not run past them', async () => {
        const report = await host.check(
            `//@version=5
indicator("Needs more")
a = ta.nope(close, 3)       // not a real function
b = ta.sma(close, 5)
c = math.fancy(a)
plot(a + b + c)`,
            'SYNTH:ALPHA',
        );
        expect(report.ok).toBe(false);
        expect(report.version).toBe(5);
        expect(report.unsupported).toEqual([
            { name: 'ta.nope', line: 3, column: 5 },
            { name: 'math.fancy', line: 5, column: 5 },
        ]);
        expect(report.errors[0].stage).toBe('runtime');
    });

    it('locates a syntax error', async () => {
        const report = await host.check('//@version=6\nindicator("Broken")\nx = (1 +\nplot(x)', 'SYNTH:ALPHA');
        expect(report.ok).toBe(false);
        expect(report.errors[0].stage).toBe('compile');
        expect(report.errors[0].line).toBeGreaterThanOrEqual(3);
    });

    it('lists data the runtime answers with na as a warning, not a failure', async () => {
        const report = await host.check(
            '//@version=6\nindicator("Fin")\nplot(request.financial(syminfo.tickerid, "EPS", "FQ"))',
            'SYNTH:ALPHA',
        );
        expect(report.ok).toBe(true);
        expect(report.warnings).toEqual([expect.objectContaining({ method: 'request.financial' })]);
    });

    it('explains that a library cannot be added to a chart', async () => {
        const report = await host.check('//@version=6\nlibrary("Lib")\nexport f(float x) => x * 2', 'SYNTH:ALPHA');
        expect(report.ok).toBe(false);
        expect(report.kind).toBe('library');
        expect(report.errors[0].message).toMatch(/library/i);
    });
});

describe('static scan', () => {
    it('ignores comments, strings, user objects and members that exist', async () => {
        const found = await findUnsupported(`//@version=6
indicator("x")   // ta.fake(1) in a comment
s = "ta.alsofake(2) in a string" + 'math.nah'
type Zone
    float top
z = Zone.new(1.0)
v = z.top + ta.sma(close, 3) + math.max(1, 2) + myobj.whatever
l = line.new(bar_index, 1, bar_index, 2, style=line.style_dashed)
plot(strategy.position_size + color.r(color.red) + str.length(syminfo.ticker))`);
        expect(found).toEqual([]);
    });

    it('reports each missing name once, at its first use', async () => {
        const found = await findUnsupported('a = ta.zzz(1)\nb = ta.zzz(2) + array.qqq()\n');
        expect(found).toEqual([
            { name: 'ta.zzz', line: 1, column: 5 },
            { name: 'array.qqq', line: 2, column: 17 },
        ]);
    });

    it('keeps positions when blanking comments and strings', () => {
        const src = "a = \"x // y\" // tail\nb = 'q\\'r' + 1";
        const out = stripCommentsAndStrings(src);
        expect(out.length).toBe(src.length);
        expect(out.split('\n')[0].trim()).toBe('a =');
        expect(out.split('\n')[1]).toMatch(/^b = +\+ 1$/);
    });

    it('reads the version, kind and title from the declaration', () => {
        expect(readHeader('//@version=5\nstrategy(title = "My strat", overlay=true)')).toEqual({
            version: 5,
            kind: 'strategy',
            title: 'My strat',
        });
        expect(readHeader("// @version=4\nstudy('Old one')")).toEqual({
            version: 4,
            kind: 'indicator',
            title: 'Old one',
        });
        expect(readHeader('plot(close)')).toEqual({ version: null, kind: null, title: null });
    });
});
