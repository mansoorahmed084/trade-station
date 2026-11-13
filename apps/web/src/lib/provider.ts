import { decimalsOf, normalizeTimeframe } from '@ts/core';
import type { ServerClient } from './client.ts';

/** Bars painted first on a deep load. */
const HEAD_BARS = 500;

/** The subset of Vela's `DataProvider` port this app implements. */
interface OHLCV {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
}

/**
 * Bridges the chart engine to our server, one instance per venue. The chart never talks to an
 * exchange directly, so the bars it draws are the same bars alerts, backtests and orders use.
 */
export class ServerProvider {
    private client: ServerClient;
    private venue: string;

    constructor(client: ServerClient, venue: string) {
        this.client = client;
        this.venue = venue.toUpperCase();
    }

    info() {
        return {
            name: this.venue.toLowerCase(),
            displayName: this.venue,
            requiresApiKey: false,
            capabilities: { enumerate: true, stream: true, symbolInfo: true },
        };
    }

    async listSymbols() {
        const list = await this.client.symbols(this.venue);
        return list.map((s) => ({ ticker: s.ticker, description: s.description, type: s.type }));
    }

    async getSymbolInfo(ticker: string) {
        const s = await this.client.symbolInfo(`${this.venue}:${ticker}`);
        const decimals = decimalsOf(s.tickSize);
        const pricescale = 10 ** decimals;
        return {
            ticker: s.ticker,
            timezone: s.timezone,
            session: s.session,
            // Pine `syminfo.*`
            tickerid: s.symbol,
            prefix: s.provider,
            root: s.baseCurrency ?? s.ticker,
            description: s.description,
            type: s.type,
            currency: s.currency,
            basecurrency: s.baseCurrency ?? '',
            mintick: s.tickSize,
            pricescale,
            minmove: Math.round(s.tickSize * pricescale),
            pointvalue: 1,
            mincontract: s.minQty,
            volumetype: 'base',
        };
    }

    async getBars(
        ticker: string,
        timeframe: string,
        range: { from?: number; to?: number; limit?: number },
    ): Promise<OHLCV[]> {
        const series = await this.client.bars(`${this.venue}:${ticker}`, normalizeTimeframe(timeframe), {
            from: range.from,
            to: range.to,
            limit: range.limit,
        });
        return series.toBars();
    }

    /**
     * Deep loads paint the newest bars first, then extend backward: the chart is usable after one
     * small request instead of waiting for the whole depth.
     */
    async getBarsProgressive(
        ticker: string,
        timeframe: string,
        range: { from?: number; to?: number; limit?: number },
        onBatch: (bars: OHLCV[]) => void,
        opts?: { signal?: AbortSignal },
    ): Promise<OHLCV[]> {
        const limit = range.limit ?? 0;
        if (range.from !== undefined || limit <= HEAD_BARS * 1.5) return this.getBars(ticker, timeframe, range);
        const symbol = `${this.venue}:${ticker}`;
        const tf = normalizeTimeframe(timeframe);
        const head = (await this.client.bars(symbol, tf, { to: range.to, limit: HEAD_BARS })).toBars();
        if (opts?.signal?.aborted || head.length < HEAD_BARS) return head;
        onBatch(head);
        try {
            const older = (
                await this.client.bars(symbol, tf, { to: head[0].time - 1, limit: limit - head.length }, opts?.signal)
            ).toBars();
            // Bars already handed to the chart never change between snapshots: keep the head as painted.
            return [...older.filter((b) => b.time < head[0].time), ...head];
        } catch (err) {
            // An abort means the chart moved on to another market: that is not a failure.
            if (!opts?.signal?.aborted) console.warn('[provider] deep history failed, keeping the recent bars', err);
            return head;
        }
    }

    subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
        return this.client.subscribe(`${this.venue}:${ticker}`, normalizeTimeframe(timeframe), onBar);
    }
}

/** Vela storage adapter that keeps workspace state on the server, so it follows you across browsers. */
export function serverStorage(client: ServerClient) {
    return {
        get: (key: string) => client.kvGet(`workspace:${key}`),
        set: (key: string, value: string) => client.kvSet(`workspace:${key}`, value),
        remove: (key: string) => {
            void fetch(`/api/kv/${encodeURIComponent(`workspace:${key}`)}`, { method: 'DELETE' }).catch(() => {});
        },
    };
}
