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
    /**
     * Exchange accounts to trade through. Keys come from the environment only and are never stored
     * or returned by the API. The live exchange also needs TS_ENABLE_LIVE=1.
     */
    brokers?: {
        binanceTestnet?: { apiKey: string; apiSecret: string };
        binanceLive?: { apiKey: string; apiSecret: string };
    };
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
        brokers: {
            binanceTestnet:
                env.TS_BINANCE_TESTNET_KEY && env.TS_BINANCE_TESTNET_SECRET
                    ? { apiKey: env.TS_BINANCE_TESTNET_KEY, apiSecret: env.TS_BINANCE_TESTNET_SECRET }
                    : undefined,
            binanceLive:
                env.TS_ENABLE_LIVE === '1' && env.TS_BINANCE_LIVE_KEY && env.TS_BINANCE_LIVE_SECRET
                    ? { apiKey: env.TS_BINANCE_LIVE_KEY, apiSecret: env.TS_BINANCE_LIVE_SECRET }
                    : undefined,
        },
    };
}
