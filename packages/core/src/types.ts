/** One OHLCV bar. `time` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Bar {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/** One trade print. */
export interface Tick {
    time: number;
    price: number;
    size: number;
    /** Aggressor side when the venue reports it. */
    side?: 'buy' | 'sell';
}

export type AssetType = 'crypto' | 'stock' | 'forex' | 'futures' | 'index' | 'synthetic';

/** Static facts about an instrument — the symbol master record. */
export interface SymbolInfo {
    /** Canonical id, `PROVIDER:TICKER` (e.g. `BINANCE:BTCUSDT`). */
    symbol: string;
    provider: string;
    ticker: string;
    description: string;
    type: AssetType;
    /** Minimum price increment. All order prices are multiples of it. */
    tickSize: number;
    /** Minimum quantity increment. */
    lotSize: number;
    minQty: number;
    /** Minimum order value in quote currency, when the venue enforces one. */
    minNotional?: number;
    currency: string;
    baseCurrency?: string;
    /** IANA time zone of the venue. */
    timezone: string;
    /** `24x7`, or regular hours as `HHMM-HHMM` in the venue time zone. */
    session: string;
}

/** Unsubscribe function returned by every subscription in the codebase. */
export type Unsubscribe = () => void;
