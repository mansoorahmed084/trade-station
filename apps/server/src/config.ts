import { resolve } from 'node:path';

export interface Config {
    host: string;
    port: number;
    dataDir: string;
    /** Market-data adapters to enable, in resolution order for bare tickers. */
    providers: string[];
    /** Built web app to serve, when present. */
    webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return {
        host: env.TS_HOST ?? '127.0.0.1',
        port: Number(env.TS_PORT ?? 8787),
        dataDir: resolve(env.TS_DATA_DIR ?? 'data'),
        providers: (env.TS_PROVIDERS ?? 'binance,synth')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        webDir: resolve(env.TS_WEB_DIR ?? 'apps/web/dist'),
    };
}
