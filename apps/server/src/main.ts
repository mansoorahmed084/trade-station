import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await createApp(config);
const address = await app.listen();
const { symbols } = app.data.stats();
console.log(
    `[server] listening on ${address} — ${symbols} symbols from ${config.providers.join(', ')}; data in ${config.dataDir}`,
);

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close().catch(() => {});
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
