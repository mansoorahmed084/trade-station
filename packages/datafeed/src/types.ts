import type { Bar, SymbolInfo, Tick, Unsubscribe } from '@ts/core';

export interface BarQuery {
    /** Inclusive lower bound on bar open time (epoch ms). */
    from?: number;
    /** Inclusive upper bound on bar open time. Omitted = now. */
    to?: number;
    /** Keep only the newest `limit` bars of the window. */
    limit?: number;
}

/**
 * One venue. Mirrors the shape of TradingView's Datafeed API (resolve / getBars / subscribeBars)
 * so adapters written for that contract port over with little change.
 */
export interface MarketDataAdapter {
    /** Upper-case provider id, the prefix in `PROVIDER:TICKER`. */
    readonly name: string;
    /** Timeframes the venue serves directly, in canonical notation. Everything else is aggregated. */
    readonly nativeTimeframes: readonly string[];
    listSymbols(): Promise<SymbolInfo[]>;
    /** Open time of the oldest bar the venue has for this series. */
    firstBarTime(ticker: string, timeframe: string): Promise<number>;
    /** Bars ascending by open time. The newest may be the forming bar. Adapters paginate internally. */
    getBars(ticker: string, timeframe: string, query: BarQuery): Promise<Bar[]>;
    /** Live bar stream for a native timeframe: repeated updates of the forming bar, then the next bar. */
    subscribeBars(ticker: string, timeframe: string, onBar: (bar: Bar, eventTime: number) => void): Unsubscribe;
    /** Live trade prints, when the venue has them. */
    subscribeTrades?(ticker: string, onTick: (tick: Tick) => void): Unsubscribe;
    /** The order book's best levels, when the venue publishes it. */
    getDepth?(ticker: string, levels: number): Promise<Depth>;
    /** Fires after the upstream connection dropped and came back: subscribers may have missed data. */
    onReconnect?(handler: () => void): Unsubscribe;
    /** Open connections ahead of the first request, so it does not pay for a handshake. */
    warm?(): Promise<void>;
    close?(): void;
}

/** Resting size by price: bids best (highest) first, asks best (lowest) first. */
export interface Depth {
    bids: [price: number, size: number][];
    asks: [price: number, size: number][];
    time: number;
}

export interface SeriesKey {
    provider: string;
    ticker: string;
    timeframe: string;
}

export const seriesId = (k: SeriesKey): string => `${k.provider}:${k.ticker}@${k.timeframe}`;
