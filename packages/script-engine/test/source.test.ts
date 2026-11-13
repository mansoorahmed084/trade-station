import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BarStore, MarketDataService, SyntheticAdapter } from '@ts/datafeed';
import { BollingerBands, RSI, SMA, series } from '@ts/indicators';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScriptHost } from '../src/index.ts';
import { composeOnPlot, findPlots } from '../src/source.ts';

const BASE = `//@version=6
indicator("Base", overlay=false)   // plot(fake, "in a comment")
len = input.int(14, "Length")
r = ta.rsi(close, len)
plot(r, "RSI", color=color.purple)
plot(ta.sma(r, 3), title="Smoothed", linewidth=2)
plot(
     math.max(r, 50),
     display=display.data_window)
plotshape(r > 70, "Hot", shape.circle)
s = "plot(nope)"
`;

describe('findPlots', () => {
    it('finds every plot call with its expression and title, across lines, ignoring comments and strings', () => {
        const plots = findPlots(BASE);
        expect(plots.map((p) => [p.title, p.expr, p.hasDisplay])).toEqual([
            ['RSI', 'r', false],
            ['Smoothed', 'ta.sma(r, 3)', false],
            ['Plot 3', 'math.max(r, 50)', true],
        ]);
        for (const p of plots) expect(BASE[p.end]).toBe(')');
    });

    it('handles nested calls, tuples and a named series argument', () => {
        const plots = findPlots(
            'plot(nz(a[1], f(b, [1, 2])), "T", color=cond ? color.red : color.new(color.blue, 50))\nplot(series=x)',
        );
        expect(plots[0]).toMatchObject({ title: 'T', expr: 'nz(a[1], f(b, [1, 2]))' });
        expect(plots[1].expr).toBe('series=x');
    });
});

describe('composeOnPlot', () => {
    let dir: string;
    let data: MarketDataService;
    let host: ScriptHost;

    beforeAll(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.UTC(2025, 0, 1) + 30_000 * 60_000 + 5_000);
        dir = mkdtempSync(join(tmpdir(), 'ts-ioi-'));
        data = new MarketDataService({
            adapters: [new SyntheticAdapter({ genesis: Date.UTC(2025, 0, 1) })],
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

    const near = (got: (number | null)[], want: number[]) => {
        expect(got.length).toBe(want.length);
        let compared = 0;
        for (let i = 0; i < want.length; i++) {
            if (Number.isNaN(want[i])) expect(got[i]).toBeNull();
            else {
                compared++;
                expect(Math.abs((got[i] as number) - want[i]) / Math.max(1, Math.abs(want[i]))).toBeLessThan(1e-9);
            }
        }
        expect(compared).toBeGreaterThan(want.length * 0.8);
    };

    it('computes a study on a chosen plot, hides the base plots and retitles the script', async () => {
        const composed = composeOnPlot(BASE, 0, 'sma', 10);
        expect(composed.title).toBe('SMA 10 of Base: RSI');
        expect(composed.source).toContain('indicator("SMA 10 of Base: RSI", overlay=false)');
        expect(composed.source).toContain('plot(r, "RSI", color=color.purple, display=display.none)');
        // a plot that already sets display is left as written
        expect(composed.source).toContain('display=display.data_window)');
        expect(composed.source.match(/display=display\.none/g)?.length).toBe(2);

        const run = await host.run(composed.source, 'SYNTH:GAMMA', '15', { bars: 600, closedOnly: true });
        const bars = await data.getBars('SYNTH:GAMMA', '15', {
            from: run.times[0],
            to: run.times[run.times.length - 1],
        });
        const rsi = series(
            new RSI(14),
            bars.toBars().map((b) => b.close),
        );
        // an SMA over a series that starts undefined is undefined until it has ten defined values
        const sma = new SMA(10);
        const want = rsi.map((v) => (Number.isNaN(v) ? Number.NaN : sma.push(v)));
        near(run.plots['SMA 10'], want);
        near(run.plots.RSI, rsi);
        expect(run.title).toBe('SMA 10 of Base: RSI');
    });

    it('supports Bollinger Bands and every other study on any plot', async () => {
        const bb = composeOnPlot(BASE, 0, 'bb', 20, 2);
        const run = await host.run(bb.source, 'SYNTH:GAMMA', '15', { bars: 400, closedOnly: true });
        const bars = await data.getBars('SYNTH:GAMMA', '15', {
            from: run.times[0],
            to: run.times[run.times.length - 1],
        });
        const rsi = series(
            new RSI(14),
            bars.toBars().map((b) => b.close),
        );
        const bands = new BollingerBands(20, 2);
        const upper = rsi.map((v) => (Number.isNaN(v) ? Number.NaN : bands.push(v).upper));
        near(run.plots['BB 20 upper'], upper);
        for (const study of ['ema', 'rma', 'wma', 'rsi', 'stdev', 'roc', 'highest', 'lowest'] as const) {
            const report = await host.check(composeOnPlot(BASE, 1, study, 7).source, 'SYNTH:GAMMA', '15', 200);
            expect(report.ok, `${study}: ${JSON.stringify(report.errors)}`).toBe(true);
            expect(report.unsupported).toEqual([]);
        }
    });

    it('refuses strategies and unknown plots', () => {
        expect(() => composeOnPlot('//@version=6\nstrategy("S")\nplot(close)', 0, 'sma', 5)).toThrow(/indicator/);
        expect(() => composeOnPlot(BASE, 9, 'sma', 5)).toThrow(/not found/);
    });
});
