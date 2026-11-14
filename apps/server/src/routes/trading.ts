import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TradingService } from '../trading/service.ts';

/** The account the screen sending the request is switched to (see `TradingService.place`). */
const confirmed = (req: FastifyRequest) => {
    const v = req.headers['x-ts-account'];
    return typeof v === 'string' && v ? v : undefined;
};
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
const account = (req: FastifyRequest) => String((req.params as any).account);

export function registerTradingRoutes(server: FastifyInstance, trading: TradingService): void {
    server.get('/api/trading/accounts', async () => trading.accountsList());

    server.get('/api/trading/limits', async () => trading.limits);
    server.put('/api/trading/limits', async (req) => trading.setLimits(body(req)));

    /** Start the paper account over. */
    server.post('/api/trading/paper/reset', async (req) => trading.resetPaper(body(req)));

    server.get('/api/trading/:account', async (req) => trading.state(account(req)));

    /** Place an order. A rejected order is answered 422 with the order and its reason. */
    server.post('/api/trading/:account/orders', async (req, reply) => {
        const order = await trading.place(account(req), body(req) as any, confirmed(req));
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return reply.code(201).send(order);
    });

    server.patch('/api/trading/:account/orders/:id', async (req) =>
        trading.modify(account(req), String((req.params as any).id), body(req), confirmed(req)),
    );

    server.delete('/api/trading/:account/orders/:id', async (req) =>
        trading.cancel(account(req), String((req.params as any).id), confirmed(req)),
    );

    server.post('/api/trading/:account/orders/cancel-all', async (req) => ({
        cancelled: await trading.cancelAll(account(req), body(req).symbol, confirmed(req)),
    }));

    server.post('/api/trading/:account/positions/close', async (req, reply) => {
        const b = body(req);
        const order = await trading.closePosition(
            account(req),
            b.symbol,
            b.qty === undefined ? undefined : Number(b.qty),
            confirmed(req),
        );
        if (!order) return reply.code(404).send({ error: `there is no ${b.symbol} position` });
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return order;
    });

    server.post('/api/trading/:account/positions/reverse', async (req, reply) => {
        const order = await trading.reversePosition(account(req), body(req).symbol, confirmed(req));
        if (!order) return reply.code(404).send({ error: `there is no ${body(req).symbol} position` });
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return order;
    });

    /** Protect a whole position: `{ symbol, takeProfit, stopLoss }`, where null removes a leg. */
    server.put('/api/trading/:account/positions/brackets', async (req) => {
        const b = body(req);
        return trading.setBrackets(
            account(req),
            b.symbol,
            { takeProfit: b.takeProfit, stopLoss: b.stopLoss },
            confirmed(req),
        );
    });
}
