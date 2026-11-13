import { seededRandom } from '@ts/core';
import { PineTS } from 'pinets';
import { describe, expect, it } from 'vitest';
import { compareExport, parseCsv, parseTime } from './compare-tv-export.ts';

const SCRIPT = '//@version=6\nindicator("G")\nplot(ta.ema(close, 20), "EMA")\nplot(ta.rsi(close, 14), "RSI")';

/** Build a CSV the way TradingView exports one, from bars and a script's own plots. */
async function makeExport(distort?: (name: string, i: number, v: number) => number) {
    const rnd = seededRandom(4);
    const bars = [];
    let p = 100;
    for (let i = 0; i < 900; i++) {
        const o = p;
        const c = o * (1 + (rnd() - 0.5) * 0.01);
        bars.push({
            openTime: 1.7e12 + i * 3_600_000,
            closeTime: 1.7e12 + (i + 1) * 3_600_000 - 1,
            open: o,
            high: Math.max(o, c) + 0.1,
            low: Math.min(o, c) - 0.1,
            close: c,
            volume: 5,
        });
        p = c;
    }
    const ctx: any = await new PineTS(bars as any).run(SCRIPT);
    const lines = ['time,open,high,low,close,EMA,RSI'];
    bars.forEach((b, i) => {
        const cell = (name: string) => {
            const v = ctx.plots[name].data[i].value;
            return typeof v === 'number' && !Number.isNaN(v) ? String(distort ? distort(name, i, v) : v) : 'NaN';
        };
        lines.push(`${b.openTime / 1000},${b.open},${b.high},${b.low},${b.close},${cell('EMA')},${cell('RSI')}`);
    });
    return lines.join('\n');
}

describe('TradingView export comparison tool', () => {
    it('reports a match when the numbers agree', async () => {
        const results = await compareExport(await makeExport(), SCRIPT, { skip: 100 });
        expect(results.map((r) => r.plot)).toEqual(['EMA', 'RSI']);
        for (const r of results) {
            expect(r.ok).toBe(true);
            expect(r.compared).toBe(800);
            expect(r.worst).toBeLessThan(1e-9);
        }
    });

    it('pinpoints a difference and names plots the script does not have', async () => {
        const csv = await makeExport((name, i, v) => (name === 'RSI' && i === 700 ? v + 0.5 : v));
        const results = await compareExport(
            csv.replace('time,open,high,low,close,EMA,RSI', 'time,open,high,low,close,EMA,RSI'),
            SCRIPT,
            { skip: 100 },
        );
        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(false);
        expect(results[1].worstAt).toContain(new Date(1.7e12 + 700 * 3_600_000).toISOString());
        const renamed = await compareExport(csv.replace(',EMA,RSI', ',EMA,Mystery'), SCRIPT);
        expect(renamed[1]).toMatchObject({ plot: 'Mystery', ok: false, compared: 0 });
    });

    it('reads both of TradingView’s time formats and quoted cells', () => {
        expect(parseTime('1700000000')).toBe(1_700_000_000_000);
        expect(parseTime('1700000000000')).toBe(1_700_000_000_000);
        expect(parseTime('2023-11-14T22:13:20Z')).toBe(1_700_000_000_000);
        expect(() => parseTime('yesterday')).toThrow();
        expect(parseCsv('a,"b,c",d\r\n1,"2,3",4\n')).toEqual({ columns: ['a', 'b,c', 'd'], rows: [['1', '2,3', '4']] });
    });
});
