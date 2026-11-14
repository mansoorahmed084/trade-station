import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AutomationService } from '../automation/runner.ts';
import type { WebhookService } from '../automation/webhook.ts';

const confirmed = (req: FastifyRequest) => {
    const v = req.headers['x-ts-account'];
    return typeof v === 'string' && v ? v : undefined;
};
const id = (req: FastifyRequest) => String((req.params as any).id);
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;

export function registerAutomationRoutes(
    server: FastifyInstance,
    automation: AutomationService,
    webhooks: WebhookService,
): void {
    server.get('/api/automation/runners', async () => automation.list());
    server.get('/api/automation/runners/:id', async (req) => automation.get(id(req)));
    server.post('/api/automation/runners', async (req, reply) => {
        try {
            return reply.code(201).send(await automation.create(body(req), confirmed(req)));
        } catch (err: any) {
            if (err?.stage)
                return reply
                    .code(422)
                    .send({ error: err.message, stage: err.stage, line: err.line, column: err.column });
            throw err;
        }
    });
    server.post('/api/automation/runners/:id/start', async (req) => automation.startRunner(id(req), confirmed(req)));
    server.post('/api/automation/runners/:id/stop', async (req) => automation.stopRunner(id(req)));
    server.post('/api/automation/runners/:id/verify', async (req) => automation.verify(id(req)));
    server.delete('/api/automation/runners/:id', async (req, reply) => {
        automation.remove(id(req));
        return reply.code(204).send();
    });

    server.get('/api/automation/webhooks', async () => webhooks.list());
    server.post('/api/automation/webhooks', async (req, reply) =>
        reply.code(201).send(webhooks.create(body(req), confirmed(req))),
    );
    server.patch('/api/automation/webhooks/:id', async (req) => webhooks.update(id(req), body(req)));
    server.delete('/api/automation/webhooks/:id', async (req, reply) => {
        webhooks.remove(id(req));
        return reply.code(204).send();
    });

    /** Where a TradingView alert (or any program) sends orders. Reachable from outside the machine. */
    server.post('/api/webhook/:id', async (req, reply) => {
        const result = await webhooks.receive(id(req), req.body);
        if (result.order?.status === 'rejected')
            return reply.code(422).send({ ok: false, error: result.order.reason, order: result.order });
        return { ok: true, ...result };
    });
}
