import type { SymbolInfo } from '@ts/core';
import { useEffect, useState } from 'react';
import type { ServerClient } from './client.ts';

export interface Quote {
    symbol: string;
    last: number | null;
    prevClose: number | null;
    info: SymbolInfo | null;
}

/** The last price and trading rules of a symbol, refreshed every `everyMs` while mounted. */
export function useQuote(client: ServerClient, symbol: string | undefined, everyMs = 1000): Quote | null {
    const [quote, setQuote] = useState<Quote | null>(null);
    useEffect(() => {
        if (!symbol) {
            setQuote(null);
            return;
        }
        let live = true;
        let info: SymbolInfo | null = null;
        setQuote({ symbol, last: null, prevClose: null, info: null });
        client
            .symbolInfo(symbol)
            .then((i) => {
                info = i;
                if (live) setQuote((q) => (q && q.symbol === symbol ? { ...q, info: i } : q));
            })
            .catch(() => {});
        const read = async () => {
            try {
                const [row] = await client.json<{ symbol: string; last?: number; prevClose?: number }[]>(
                    `/api/quotes?symbols=${encodeURIComponent(symbol)}`,
                );
                if (!live || row?.last === undefined) return;
                setQuote({ symbol, last: row.last, prevClose: row.prevClose ?? null, info });
            } catch {}
        };
        void read();
        const timer = setInterval(read, everyMs);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [client, symbol, everyMs]);
    return quote;
}

/** Decimals a price of this symbol is shown with. */
export const priceDecimals = (tick: number | undefined): number => {
    if (!tick || !(tick > 0)) return 2;
    const text = String(tick);
    if (text.includes('e-')) return Number(text.split('e-')[1]);
    return (text.split('.')[1] ?? '').length;
};
