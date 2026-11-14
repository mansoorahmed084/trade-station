import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { ServerClient } from '../../lib/client.ts';
import { placeOrder, useTrading } from '../../lib/trading-store.ts';
import { useChartMarket } from '../../lib/use-chart-market.ts';
import { priceDecimals, useQuote } from '../../lib/use-quote.ts';

/** One-click market buttons over the chart, sized from the order ticket. */
export function QuickTrade({ client, workspace }: { client: ServerClient; workspace: VelaWorkspace }) {
    const market = useChartMarket(workspace);
    const symbol = market?.symbol;
    const quote = useQuote(client, symbol);
    const position = useTrading((s) => (symbol ? s.positions[symbol] : undefined));
    const size = useTrading((s) => s.ticket.qty);
    const setTicket = useTrading((s) => s.setTicket);
    const account = useTrading((s) => s.account);
    const last = position?.lastPrice ?? quote?.last ?? null;
    const decimals = priceDecimals(quote?.info?.tickSize);
    if (!symbol) return null;
    const send = (side: 'buy' | 'sell') => {
        const qty = Number(size);
        if (!(qty > 0)) return;
        void placeOrder({ symbol, side, type: 'market', qty, source: 'chart' }, true).catch(() => {});
    };
    return (
        <div className={`quick-trade acct-${account?.kind ?? 'paper'}`} data-testid="quick-trade">
            <button
                type="button"
                className="qt-sell"
                onClick={() => send('sell')}
                data-testid="quick-sell"
                title="Sell at the market"
            >
                <span>SELL</span>
                <b>{last !== null ? last.toFixed(decimals) : '…'}</b>
            </button>
            <input
                type="number"
                min={0}
                value={size}
                aria-label="Quantity"
                onChange={(e) => setTicket({ qty: e.target.value, sizing: 'units' })}
                data-testid="quick-qty"
            />
            <button
                type="button"
                className="qt-buy"
                onClick={() => send('buy')}
                data-testid="quick-buy"
                title="Buy at the market"
            >
                <span>BUY</span>
                <b>{last !== null ? last.toFixed(decimals) : '…'}</b>
            </button>
        </div>
    );
}
