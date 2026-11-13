import { describe, expect, it } from 'vitest';
import {
    averageTrueRange,
    type Bar,
    BarSeries,
    createTransform,
    formatTransform,
    parseTransform,
    seededRandom,
    type TransformSpec,
    toTransformSpec,
    transformAll,
} from '../src/index.ts';

const MIN = 60_000;
/** A source bar whose only interesting field is the close. */
const c = (i: number, close: number, volume = 1): Bar => ({
    time: i * MIN,
    open: close,
    high: close,
    low: close,
    close,
    volume,
});
const run = (spec: TransformSpec, bars: Bar[]) => {
    const t = createTransform(spec);
    const out: Bar[] = [];
    for (const b of bars) out.push(...t.push(b));
    return { out, t };
};
const oc = (bars: Bar[]) => bars.map((b) => [b.open, b.close]);

describe('Renko', () => {
    it('needs one box to continue and two to reverse', () => {
        const { out, t } = run(
            { kind: 'renko', box: 10 },
            [100, 105, 111, 135, 125, 109, 99].map((p, i) => c(i, p)),
        );
        expect(oc(out)).toEqual([
            [100, 110],
            [110, 120],
            [120, 130],
            [120, 110],
            [110, 100],
        ]);
        // bricks have no wicks
        for (const b of out) expect(b.high - b.low).toBe(10);
        // forming brick: last brick closed at 100 going down; price 99 extends it
        expect(t.preview()).toMatchObject({ open: 100, close: 99 });
    });

    it('gives every brick a strictly increasing time and keeps a forming brick’s time when it closes', () => {
        const t = createTransform({ kind: 'renko', box: 1 });
        const times: number[] = [];
        let previewTime: number | undefined;
        const rnd = seededRandom(5);
        let price = 100;
        for (let i = 0; i < 2000; i++) {
            price += (rnd() - 0.5) * 3;
            const done = t.push(c(i, price));
            if (done.length && previewTime !== undefined) expect(done[0].time).toBe(previewTime);
            for (const b of done) times.push(b.time);
            previewTime = t.preview()?.time;
        }
        expect(times.length).toBeGreaterThan(200);
        for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
        expect(previewTime).toBeGreaterThan(times[times.length - 1]);
    });

    it('assigns the gathered volume to the first brick a bar completes', () => {
        const { out } = run({ kind: 'renko', box: 10 }, [c(0, 100, 5), c(1, 104, 7), c(2, 125, 11)]);
        expect(out.map((b) => b.volume)).toEqual([23, 0]);
    });
});

describe('Line break', () => {
    it('continues on a new extreme and reverses only beyond the last three lines', () => {
        const bars: Bar[] = [
            { time: 0, open: 9, high: 10, low: 9, close: 10, volume: 1 },
            ...[11, 12, 11.5, 8.5, 8, 9, 13].map((p, i) => c(i + 1, p)),
        ];
        const { out } = run({ kind: 'linebreak', lines: 3 }, bars);
        expect(oc(out)).toEqual([
            [9, 10],
            [10, 11],
            [11, 12],
            [11, 8.5],
            [8.5, 8],
            [8.5, 13],
        ]);
    });

    it('previews a line only when the forming close would draw one', () => {
        const t = createTransform({ kind: 'linebreak', lines: 3 });
        t.push({ time: 0, open: 9, high: 10, low: 9, close: 10, volume: 1 });
        expect(t.preview(c(1, 9.5))).toBeNull();
        expect(t.preview(c(1, 10.4))).toMatchObject({ open: 10, close: 10.4 });
    });
});

describe('Kagi', () => {
    it('turns after a retrace of the reversal amount', () => {
        const { out, t } = run(
            { kind: 'kagi', reversal: 5 },
            [100, 103, 106, 110, 107, 104, 99, 105].map((p, i) => c(i, p)),
        );
        expect(oc(out)).toEqual([
            [100, 110],
            [110, 99],
        ]);
        expect(t.preview()).toMatchObject({ open: 99, close: 105 });
        expect(t.preview(c(9, 108))).toMatchObject({ open: 99, close: 108 });
    });
});

describe('Point & Figure', () => {
    it('extends a column box by box and reverses after three boxes', () => {
        const { out, t } = run(
            { kind: 'pnf', box: 1, reversal: 3 },
            [10.2, 11.5, 13.9, 12.5, 9.8, 9.0, 12.1].map((p, i) => c(i, p)),
        );
        expect(oc(out)).toEqual([
            [10, 13],
            [12, 9],
        ]);
        expect(t.preview()).toMatchObject({ open: 10, close: 12 });
    });
});

describe('Range bars', () => {
    it('closes a bar exactly one range from its other extreme and opens the next there', () => {
        const bars: Bar[] = [
            { time: 0, open: 10, high: 11, low: 9.5, close: 10.5, volume: 4 },
            { time: MIN, open: 10.5, high: 13, low: 10.4, close: 12.8, volume: 6 },
        ];
        const { out, t } = run({ kind: 'range', range: 2 }, bars);
        expect(out).toEqual([{ time: 0, open: 10, high: 11.5, low: 9.5, close: 11.5, volume: 7 }]);
        expect(t.preview()).toMatchObject({ open: 11.5, high: 13, low: 11.5, close: 12.8, volume: 3 });
    });

    it('every completed bar spans exactly the range and volume is conserved', () => {
        const rnd = seededRandom(9);
        const src = new BarSeries();
        let p = 100;
        let volume = 0;
        for (let i = 0; i < 3000; i++) {
            const o = p;
            const cl = o + (rnd() - 0.5) * 2;
            const v = rnd() * 10;
            volume += v;
            src.append(i * MIN, o, Math.max(o, cl) + rnd() * 0.5, Math.min(o, cl) - rnd() * 0.5, cl, v);
            p = cl;
        }
        const out = transformAll(src, { kind: 'range', range: 1.5 });
        expect(out.length).toBeGreaterThan(300);
        let total = 0;
        for (let i = 0; i < out.length; i++) {
            total += out.volume[i];
            if (i < out.length - 1) expect(out.high[i] - out.low[i]).toBeCloseTo(1.5, 9);
            if (i > 0) expect(out.open[i]).toBeCloseTo(out.close[i - 1], 9);
        }
        expect(total).toBeCloseTo(volume, 6);
    });
});

describe('incremental use equals a full recompute', () => {
    const specs: TransformSpec[] = [
        { kind: 'renko', box: 0.7 },
        { kind: 'linebreak', lines: 3 },
        { kind: 'kagi', reversal: 1.1 },
        { kind: 'pnf', box: 0.5, reversal: 3 },
        { kind: 'range', range: 0.9 },
    ];
    const rnd = seededRandom(21);
    const src = new BarSeries();
    let p = 50;
    for (let i = 0; i < 1500; i++) {
        const o = p;
        const cl = Math.max(1, o + (rnd() - 0.5) * 1.5);
        src.append(i * MIN, o, Math.max(o, cl) + rnd() * 0.3, Math.min(o, cl) - rnd() * 0.3, cl, 1 + rnd());
        p = cl;
    }

    for (const spec of specs) {
        it(`${spec.kind}: live stream (with forming-bar previews) matches the batch result`, () => {
            const live = createTransform(spec);
            const closed: Bar[] = [];
            for (let i = 0; i < src.length; i++) {
                const bar = src.at(i);
                // a forming source bar is previewed several times before it closes; previews must not change state
                for (const f of [0.3, 0.7, 1]) live.preview({ ...bar, close: bar.open + (bar.close - bar.open) * f });
                closed.push(...live.push(bar));
            }
            const batch = transformAll(src, spec);
            const forming = live.preview();
            const all = forming ? [...closed, forming] : closed;
            expect(all).toEqual(batch.toBars());
            expect(closed.length).toBeGreaterThan(20);
        });
    }
});

describe('suffix parsing', () => {
    it('round-trips every form', () => {
        for (const s of [
            'RENKOX50',
            'RENKOXATR14',
            'RENKOX0P5',
            'LBX3',
            'KAGIX1P5',
            'KAGIXATR14',
            'PNFX10X3',
            'PNFXATR14X3',
            'RANGEX25',
        ]) {
            const parsed = parseTransform(s);
            expect(parsed, s).not.toBeNull();
            expect(formatTransform(parsed!)).toBe(s);
        }
        expect(parseTransform('renkoxatr14')).toEqual({ kind: 'renko', atr: 14 });
        expect(parseTransform('KAGIX1P5')).toEqual({ kind: 'kagi', size: 1.5 });
        expect(parseTransform('PNFX10X3')).toEqual({ kind: 'pnf', size: 10, count: 3 });
    });

    it('rejects anything malformed', () => {
        for (const s of [
            '',
            'P',
            'RENKO',
            'RENKOX',
            'RENKOX0',
            'RENKOXABC',
            'LBX0',
            'LBX3X4',
            'PNFX10',
            'RANGEX-5',
            'FOOX1',
            'RENKOXATR0',
        ]) {
            expect(parseTransform(s), s).toBeNull();
        }
    });

    it('builds a spec from a parsed suffix and a resolved size', () => {
        expect(toTransformSpec(parseTransform('PNFXATR14X2')!, 7)).toEqual({ kind: 'pnf', box: 7, reversal: 2 });
        expect(toTransformSpec(parseTransform('LBX4')!, 0)).toEqual({ kind: 'linebreak', lines: 4 });
    });
});

describe('ATR', () => {
    it('matches a hand-computed Wilder average', () => {
        const s = BarSeries.fromBars([
            { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 0 },
            { time: 1, open: 10, high: 12, low: 10, close: 11, volume: 0 }, // TR 2
            { time: 2, open: 11, high: 11.5, low: 9, close: 9.5, volume: 0 }, // TR 2.5
            { time: 3, open: 9.5, high: 10, low: 9, close: 9.8, volume: 0 }, // TR 1
        ]);
        // seed = mean(2, 2.5) = 2.25; then (2.25 * 1 + 1) / 2 = 1.625
        expect(averageTrueRange(s, 2)).toBeCloseTo(1.625, 12);
        expect(averageTrueRange(s, 10)).toBeNaN();
    });
});
