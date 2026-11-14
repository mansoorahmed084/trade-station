/**
 * Accelerated soak of the strategy runner (Phase 7 exit criterion, in simulated time).
 * The market clock is moved a minute at a time through two weeks of one-minute bars. Two runners
 * trade the paper account the whole time (one sizing by equity, one with fixed units); a third runs
 * in shadow for the first week. Every bar is decided on exactly as live. At the end of each
 * simulated day, that day's decisions are replayed as one continuous backtest and compared.
 * Run: node tests/soak/automation-soak.ts [days=14]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyntheticAdapter } from '@ts/datafeed';
import { createApp } from '../../apps/server/src/app.ts';

const MIN = 60_000;
const DAY = 24 * 60;
const days = Number(process.argv[2] ?? 14);
let clock = Date.UTC(2025, 2, 1, 0, 0, 30);
const dir = mkdtempSync(join(tmpdir(), 'ts-soak-auto-'));
const app = await createApp(
    { host: '127.0.0.1', port: 0, dataDir: dir, providers: [], webDir: join(dir, 'x'), notifier: {} },
    {
        adapters: [new SyntheticAdapter({ tickMs: 60_000, now: () => clock })],
        log: () => {},
        lingerMs: 0,
        workers: 4,
        now: () => clock,
    },
);
const started = performance.now();
try {
    const equity = await app.automation.create({
        name: 'EMA cross · ALPHA 1m · paper, sized by equity',
        strategy: { kind: 'native', id: 'ema-cross' },
        symbol: 'SYNTH:ALPHA',
        timeframe: '1',
        mode: 'paper',
        bars: 500,
        startWith: 'now',
    });
    const fixed = await app.automation.create({
        name: 'Supertrend · GAMMA 1m · paper, 2 units per entry',
        strategy: { kind: 'native', id: 'supertrend' },
        symbol: 'SYNTH:GAMMA',
        timeframe: '1',
        mode: 'paper',
        bars: 500,
        startWith: 'now',
        qty: 2,
    });
    const shadow = await app.automation.create({
        name: 'EMA cross (Pine) · BETA 1m · shadow, first week',
        strategy: { kind: 'pine', scriptId: 'example-ema-cross-strategy' },
        symbol: 'SYNTH:BETA',
        timeframe: '1',
        mode: 'shadow',
        bars: 500,
        startWith: 'now',
    });
    const ids = [equity.id, fixed.id, shadow.id];
    for (const id of ids) await app.automation.startRunner(id);
    const totals = new Map(
        ids.map((id) => [
            id,
            {
                checked: 0,
                mismatches: [] as { time: number; live: number; replay: number }[],
                sized: 0,
                maxSizeDiffPct: 0,
            },
        ]),
    );
    const running = (id: string) => app.automation.get(id).state.status === 'running';

    for (let m = 1; m <= days * DAY; m++) {
        clock += MIN;
        for (const id of ids) if (running(id)) await app.automation.decideNow(id);
        if (m % DAY === 0) {
            // Replay the day just finished as one backtest (runners keep their last 2,000 decisions).
            // From the first bar of the day (bars open on the minute; the clock is 30 s into one).
            const dayStart = Math.floor((clock - DAY * MIN) / MIN) * MIN;
            for (const id of ids) {
                if (app.automation.get(id).state.decisions.every((d) => d.time < dayStart)) continue;
                const check = await app.automation.verify(id, dayStart);
                const t = totals.get(id)!;
                t.checked += check.checked;
                t.mismatches.push(...check.mismatches);
                t.sized += check.sized;
                t.maxSizeDiffPct = Math.max(t.maxSizeDiffPct, check.maxSizeDiffPct);
            }
            if (m === 7 * DAY) app.automation.stopRunner(shadow.id);
            console.log(`day ${m / DAY}: ${((performance.now() - started) / 1000).toFixed(0)} s`);
        }
    }

    for (const id of ids) {
        const r = app.automation.get(id);
        const s = r.state;
        const unexplained = s.divergences.filter((d) => !d.explained);
        const t = totals.get(id)!;
        console.log(`\n${r.name}`);
        console.log(
            `  bars decided ${t.checked.toLocaleString('en-US')}, orders filled ${s.fills}, final status ${s.status}${s.error ? ` (${s.error})` : ''}`,
        );
        console.log(
            `  divergences: ${s.divergences.length - unexplained.length} explained, ${unexplained.length} unexplained`,
        );
        for (const d of unexplained.slice(0, 5))
            console.log(`    ${new Date(d.time).toISOString()} wanted ${d.wanted} held ${d.held}: ${d.reason}`);
        console.log(
            `  against one continuous backtest: ${t.checked - t.mismatches.length} of ${t.checked} decisions want the same side; ${t.sized} differ only in size (at most ${t.maxSizeDiffPct.toFixed(3)}%)`,
        );
        for (const x of t.mismatches.slice(0, 5))
            console.log(`    ${new Date(x.time).toISOString()} live ${x.live} backtest ${x.replay}`);
    }
    const account = app.trading.paper.account();
    console.log(`\npaper account: equity ${account.equity.toFixed(2)}, realised ${account.realizedPnl.toFixed(2)}`);
    console.log(
        `simulated ${days} days (${(days * DAY).toLocaleString('en-US')} one-minute bars) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
} finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
}
