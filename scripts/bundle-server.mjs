// Bundle the trading server and its backtest worker into plain JavaScript for the desktop app:
// apps/desktop/build/server/{main,worker}.mjs plus shared chunks. Node built-ins stay external;
// every dependency is included, so the bundle runs without node_modules.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'desktop', 'build', 'server');
rmSync(out, { recursive: true, force: true });

const started = performance.now();
const bundle = await rolldown({
    input: {
        main: join(root, 'apps', 'server', 'src', 'main.ts'),
        worker: join(root, 'apps', 'server', 'src', 'backtest', 'worker.ts'),
    },
    platform: 'node',
    // The worker is a separate file beside the bundle.
    transform: { define: { 'process.env.TS_BACKTEST_WORKER': JSON.stringify('./worker.mjs') } },
    logLevel: 'warn',
});
await bundle.write({
    dir: out,
    format: 'esm',
    entryFileNames: '[name].mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
    // Some dependencies still call `require`: give ES modules one.
    banner: "import { createRequire as __tsCreateRequire } from 'node:module'; const require = __tsCreateRequire(import.meta.url);",
});
await bundle.close();
console.log(`server bundled into ${out} in ${Math.round(performance.now() - started)} ms`);
