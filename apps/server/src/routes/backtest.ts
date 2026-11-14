import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BacktestService } from '../backtest/service.ts';

/** A script that fails to compile or run is the caller's to fix: answer 422 with where it failed. */
async function guard(reply: FastifyReply, work: () => unknown): Promise<unknown> {
    try {
        return await work();
    } catch (err: any) {
        if (err?.stage) {
            return reply.code(422).send({ error: err.message, stage: err.stage, line: err.line, column: err.column });
        }
        throw err;
    }
}

export function registerBacktestRoutes(server: FastifyInstance, backtest: BacktestService): void {
    /** The built-in strategies and their inputs. */
    server.get('/api/backtest/strategies', async () => backtest.strategies());

    /** A strategy's name and inputs, without running it. */
    server.post('/api/backtest/describe', async (req, reply) =>
        guard(reply, () => backtest.describe(((req.body ?? {}) as any).strategy)),
    );

    /** Run one backtest and return its report. */
    server.post('/api/backtest/run', async (req, reply) => guard(reply, () => backtest.run((req.body ?? {}) as any)));

    /** Start a parameter search; progress arrives on the `backtest` topic. */
    server.post('/api/backtest/optimize', async (req, reply) =>
        guard(reply, async () => reply.code(202).send(await backtest.optimize((req.body ?? {}) as any))),
    );

    server.post('/api/backtest/walk-forward', async (req, reply) =>
        guard(reply, async () => reply.code(202).send(await backtest.walkForward((req.body ?? {}) as any))),
    );

    server.get('/api/backtest/jobs/:id', async (req, reply) => {
        const status = backtest.status((req.params as any).id);
        return status ?? reply.code(404).send({ error: 'job not found' });
    });

    /** Stop a running job. Its finished rows stay readable. */
    server.delete('/api/backtest/jobs/:id', async (req, reply) =>
        backtest.cancel((req.params as any).id)
            ? reply.code(204).send()
            : reply.code(404).send({ error: 'job not found' }),
    );
}
