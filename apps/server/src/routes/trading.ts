import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditLog } from '../trading/audit.ts';
import type { TradingService } from '../trading/service.ts';

/** The account the screen sending the request is switched to (see `TradingService.place`). */
const confirmed = (req: FastifyRequest) => {
    const v = req.headers['x-ts-account'];
    return typeof v === 'string' && v ? v : undefined;
};
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
const account = (req: FastifyRequest) => String((req.params as any).account);

export function registerTradingRoutes(server: FastifyInstance, trading: TradingService, audit?: AuditLog): void {
    /** Run a person's action and write it to the audit log with its outcome. */
    const recorded = async <T>(
        action: string,
        req: FastifyRequest,
        symbol: unknown,
        run: () => Promise<T>,
    ): Promise<T> => {
        const detail: Record<string, unknown> = { ...body(req) };
        const accountId = (req.params as any)?.account;
        try {
            const result: any = await run();
            const rejected = result && typeof result === 'object' && result.status === 'rejected';
            audit?.record({
                actor: 'user',
                action,
                account: accountId,
                symbol: symbol ? String(symbol) : undefined,
                outcome: rejected ? 'rejected' : 'ok',
                detail: {
                    ...detail,
                    ...(result?.id ? { order: result.id, status: result.status, reason: result.reason } : {}),
                },
            });
            return result;
        } catch (err: any) {
            const code = err?.statusCode ?? 500;
            audit?.record({
                actor: 'user',
                action,
                account: accountId,
                symbol: symbol ? String(symbol) : undefined,
                outcome: code === 403 || code === 422 || code === 400 ? 'rejected' : 'error',
                detail: { ...detail, reason: err?.message },
            });
            throw err;
        }
    };

    /** The kill switch: halt automation, cancel every working order, optionally close every position. */
    server.post('/api/trading/kill', async (req) => {
        const b = body(req);
        return trading.kill({ flatten: !!b.flatten, reason: b.reason ? String(b.reason) : undefined, by: 'user' });
    });
    server.post('/api/trading/resume', async () => {
        trading.resume('user');
        return { halt: null };
    });
    server.get('/api/trading/risk', async () => ({ rules: trading.risk.rules, halt: trading.risk.halt }));
    server.put('/api/trading/risk', async (req) => ({
        rules: trading.setRisk(body(req), 'user'),
        halt: trading.risk.halt,
    }));

    /** The audit log, newest first: `?limit=&actor=&account=&before=`. */
    server.get('/api/audit', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        return (
            audit?.list({
                limit: q.limit ? Number(q.limit) : undefined,
                actor: q.actor,
                account: q.account,
                before: q.before ? Number(q.before) : undefined,
            }) ?? []
        );
    });

    server.get('/api/trading/accounts', async () => trading.accountsList());

    server.get('/api/trading/limits', async () => trading.limits);
    server.put('/api/trading/limits', async (req) =>
        recorded('limits', req, undefined, async () => trading.setLimits(body(req))),
    );

    /** Start the paper account over. */
    server.post('/api/trading/paper/reset', async (req) =>
        recorded('reset paper account', req, undefined, async () => trading.resetPaper(body(req))),
    );

    server.get('/api/trading/:account', async (req) => trading.state(account(req)));

    /** Place an order. A rejected order is answered 422 with the order and its reason. */
    server.post('/api/trading/:account/orders', async (req, reply) => {
        const order = await recorded('place', req, body(req).symbol, () =>
            trading.place(account(req), body(req) as any, confirmed(req)),
        );
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return reply.code(201).send(order);
    });

    server.patch('/api/trading/:account/orders/:id', async (req) =>
        recorded('modify', req, undefined, () =>
            trading.modify(account(req), String((req.params as any).id), body(req), confirmed(req)),
        ),
    );

    server.delete('/api/trading/:account/orders/:id', async (req) =>
        recorded('cancel', req, undefined, () =>
            trading.cancel(account(req), String((req.params as any).id), confirmed(req)),
        ),
    );

    server.post('/api/trading/:account/orders/cancel-all', async (req) => ({
        cancelled: await recorded('cancel all', req, body(req).symbol, () =>
            trading.cancelAll(account(req), body(req).symbol, confirmed(req)),
        ),
    }));

    server.post('/api/trading/:account/positions/close', async (req, reply) => {
        const b = body(req);
        const order = await recorded('close position', req, b.symbol, () =>
            trading.closePosition(
                account(req),
                b.symbol,
                b.qty === undefined ? undefined : Number(b.qty),
                confirmed(req),
            ),
        );
        if (!order) return reply.code(404).send({ error: `there is no ${b.symbol} position` });
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return order;
    });

    server.post('/api/trading/:account/positions/reverse', async (req, reply) => {
        const order = await recorded('reverse position', req, body(req).symbol, () =>
            trading.reversePosition(account(req), body(req).symbol, confirmed(req)),
        );
        if (!order) return reply.code(404).send({ error: `there is no ${body(req).symbol} position` });
        if (order.status === 'rejected') return reply.code(422).send({ error: order.reason, order });
        return order;
    });

    /** Protect a whole position: `{ symbol, takeProfit, stopLoss }`, where null removes a leg. */
    server.put('/api/trading/:account/positions/brackets', async (req) => {
        const b = body(req);
        return recorded('position protection', req, b.symbol, () =>
            trading.setBrackets(
                account(req),
                b.symbol,
                { takeProfit: b.takeProfit, stopLoss: b.stopLoss },
                confirmed(req),
            ),
        );
    });
}
