/**
 * Node-side performance budgets (IMPLEMENTATION_PLAN.md §6.1). Fails the build when a budget
 * is exceeded by more than 10%. Each case reports the best of several runs.
 * Run: npm run bench
 */
import { aggregate, BarSeries, LiveAggregator, seededRandom } from '@ts/core';
import { benches as extra } from './cases.ts';

export interface BenchCase {
    name: string;
    budgetMs: number;
    /** Returns the measured milliseconds, or runs and lets the harness time it. */
    run: () => number | void | Promise<number | void>;
    runs?: number;
}

const N = 1_000_000;
const MIN = 60_000;

function synthetic(n: number): BarSeries {
    const rnd = seededRandom(11);
    const s = new BarSeries(n);
    let p = 100;
    for (let i = 0; i < n; i++) {
        const o = p;
        const c = o * (1 + (rnd() - 0.5) * 0.002);
        s.append(i * MIN, o, Math.max(o, c) * 1.0005, Math.min(o, c) * 0.9995, c, rnd() * 100);
        p = c;
    }
    return s;
}

const base = synthetic(N);

const core: BenchCase[] = [
    { name: 'BarSeries append 1M bars', budgetMs: 60, run: () => void synthetic(N) },
    { name: 'aggregate 1M 1m bars -> 1h', budgetMs: 60, run: () => void aggregate(base, '60') },
    { name: 'encode + decode 1M bars', budgetMs: 30, run: () => void BarSeries.decode(base.encode()) },
    {
        name: 'LiveAggregator 1M pushes',
        budgetMs: 120,
        run: () => {
            const agg = new LiveAggregator('15');
            for (let i = 0; i < N; i++) {
                agg.push({
                    time: base.time[i],
                    open: base.open[i],
                    high: base.high[i],
                    low: base.low[i],
                    close: base.close[i],
                    volume: base.volume[i],
                });
            }
        },
    },
];

let failed = 0;
console.log('benchmark'.padEnd(46), 'best ms'.padStart(9), 'budget'.padStart(8), ' result');
for (const b of [...core, ...extra]) {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < (b.runs ?? 5); r++) {
        const t0 = performance.now();
        const reported = await b.run();
        const ms = typeof reported === 'number' ? reported : performance.now() - t0;
        best = Math.min(best, ms);
    }
    const ok = best <= b.budgetMs * 1.1;
    if (!ok) failed++;
    console.log(
        b.name.padEnd(46),
        best.toFixed(1).padStart(9),
        String(b.budgetMs).padStart(8),
        ok ? ' ok' : ' OVER BUDGET',
    );
}
if (failed) {
    console.error(`\n${failed} benchmark(s) over budget`);
    process.exit(1);
}
