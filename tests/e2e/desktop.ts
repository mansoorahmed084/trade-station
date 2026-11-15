/**
 * Desktop app check: launches the Electron shell (apps/desktop) as a person would, with its own
 * data folder, and checks the trading server starts behind it, the app loads and works, the server
 * stops when the app quits, and the data is still there on the next start.
 * Needs `npm run build` first. Run: node tests/e2e/desktop.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron, type Page } from 'playwright-core';

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const executablePath = createRequire(import.meta.url)('electron') as string;
const dataDir = mkdtempSync(join(tmpdir(), 'ts-desktop-'));

async function launch(): Promise<{ app: ElectronApplication; win: Page; base: string; errors: string[] }> {
    const app = await electron.launch({
        executablePath,
        args: ['apps/desktop'],
        env: { ...process.env, TS_DATA_DIR: dataDir, TS_PROVIDERS: 'synth' },
        timeout: 60_000,
    });
    const win = await app.firstWindow({ timeout: 60_000 });
    const errors: string[] = [];
    win.on('pageerror', (e) => errors.push(e.message));
    await win.waitForFunction(
        () => (window as any).__ts?.workspace && (window as any).__ts?.trading?.getState().ready,
        null,
        { timeout: 60_000 },
    );
    const base = new URL(win.url()).origin;
    return { app, win, base, errors };
}

let base = '';
try {
    const first = await launch();
    base = first.base;
    const title = await first.win.title();
    const health = await (await fetch(`${base}/api/health`)).json();
    check(
        'the desktop app starts its own trading server on a local port and opens the app',
        /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && health.ok === true && /Trade Station/.test(title),
        `${base}; title "${title}"`,
    );

    const shown = await first.win.evaluate(async () => {
        const t = (window as any).__ts;
        await t.workspace.chart.ready();
        await t.workspace.chart.setMarket({ symbol: 'SYNTH:ALPHA', timeframe: '15' });
        await new Promise((r) => setTimeout(r, 1500));
        return { symbol: t.workspace.chart.market.symbol, canvases: document.querySelectorAll('canvas').length };
    });
    await first.win.screenshot({ path: 'tests/e2e/desktop.png' });
    check(
        'the chart works inside the desktop window',
        /SYNTH:ALPHA/.test(shown.symbol) && shown.canvases > 3,
        `${shown.symbol}, ${shown.canvases} canvases`,
    );

    const order = await (
        await fetch(`${base}/api/trading/paper/orders`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-ts-account': 'paper' },
            body: JSON.stringify({ symbol: 'SYNTH:ALPHA', side: 'buy', type: 'market', qty: 1 }),
        })
    ).json();
    check(
        'a paper order placed through it fills',
        order.status === 'filled',
        `${order.status} at ${order.avgFillPrice}`,
    );
    check('no page errors in the desktop window', first.errors.length === 0, first.errors.slice(0, 3).join(' | '));

    await first.app.close();
    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i++) {
        stopped = await fetch(`${base}/api/health`).then(
            () => false,
            () => true,
        );
        if (!stopped) await new Promise((r) => setTimeout(r, 250));
    }
    check('quitting the app stops its server', stopped);

    const second = await launch();
    const state = await (await fetch(`${second.base}/api/trading/paper`)).json();
    const held = state.positions.find((p: any) => p.symbol === 'SYNTH:ALPHA')?.qty;
    check('the next start finds the paper position kept in the app’s data folder', held === 1, `position ${held}`);
    await second.app.close();
} catch (err: any) {
    check('the desktop app runs', false, String(err?.message ?? err).split('\n')[0]);
} finally {
    rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
process.exit();
