import { resolve } from 'node:path';

export interface Config {
    host: string;
    port: number;
    dataDir: string;
    /** Market-data adapters to enable, in resolution order for bare tickers. */
    providers: string[];
    /** Built web app to serve, when present. */
    webDir: string;
    /** Credentials for outside notification channels. Read from the environment, never stored or returned by the API. */
    notifier: { telegramToken?: string; smtpUrl?: string; smtpFrom?: string };
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
        notifier: {
            telegramToken: env.TS_TELEGRAM_TOKEN || undefined,
            smtpUrl: env.TS_SMTP_URL || undefined,
            smtpFrom: env.TS_SMTP_FROM || undefined,
        },
    };
}
