import { randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import type { OrderState, PlaceOrderRequest } from '@ts/oms';
import type { Db } from '../db.ts';
import type { AuditLog } from '../trading/audit.ts';
import type { TradingService } from '../trading/service.ts';

/**
 * Orders from outside — a TradingView alert's webhook, or any program — in the shape TradingView
 * alerts can send. Each webhook has its own address and passphrase and trades one account, through
 * the risk manager like everything automatic.
 *
 * The alert message is JSON. Recognised fields (TradingView placeholders in brackets):
 *   passphrase                    required; must match the webhook's
 *   symbol | ticker (+ exchange)  {{ticker}}, {{exchange}}
 *   action | side                 buy, sell, long, short, close, exit, flat — or {{strategy.order.action}}
 *   qty | quantity | contracts    {{strategy.order.contracts}}; default: the webhook's size
 *   position_size                 {{strategy.position_size}}: trade to this position instead
 *   type | order_type             market (default), limit, stop
 *   price | limit, stop           for limit and stop orders
 * `strategy.order.action` and the like may also be sent as nested objects.
 */

export interface WebhookConfig {
    id: string;
    name: string;
    passphrase: string;
    accountId: string;
    /** Units per order when the message gives none. */
    defaultQty: number;
    enabled: boolean;
    createdAt: number;
    lastUsedAt?: number;
    uses: number;
}

const KEY = 'automation.webhooks';
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** Read `a.b.c`, or a flattened `a_b_c` / `b_c`, from a message. */
function field(msg: Record<string, any>, ...paths: string[]): unknown {
    for (const path of paths) {
        let v: any = msg;
        for (const part of path.split('.')) v = v?.[part];
        if (v !== undefined && v !== null && v !== '') return v;
        const flat = msg[path.replace(/\./g, '_')];
        if (flat !== undefined && flat !== null && flat !== '') return flat;
    }
    return undefined;
}

export class WebhookService {
    private hooks: WebhookConfig[];
    private deps: { db: Db; data: MarketDataService; trading: TradingService; audit?: AuditLog };

    constructor(deps: { db: Db; data: MarketDataService; trading: TradingService; audit?: AuditLog }) {
        this.deps = deps;
        this.hooks = deps.db.kvJson<WebhookConfig[]>(KEY, []);
    }

    list(): WebhookConfig[] {
        return this.hooks.map((h) => ({ ...h }));
    }

    create(
        input: { name?: unknown; accountId?: unknown; defaultQty?: unknown },
        confirmedAccount?: string,
    ): WebhookConfig {
        const accountId = String(input.accountId ?? 'paper');
        const broker = this.deps.trading.broker(accountId);
        if (!broker) throw fail(`no account "${accountId}"`, 404);
        if (broker.kind !== 'paper' && confirmedAccount !== broker.id) {
            throw fail(
                `"${broker.name}" trades real money: set the webhook up from a screen switched to that account`,
                403,
            );
        }
        const qty = Number(input.defaultQty ?? 1);
        if (!(qty > 0)) throw fail('the default size must be above zero');
        const hook: WebhookConfig = {
            id: newId('wh'),
            name:
                String(input.name ?? '')
                    .trim()
                    .slice(0, 80) || 'Webhook',
            passphrase: randomBytes(18).toString('base64url'),
            accountId,
            defaultQty: qty,
            enabled: true,
            createdAt: this.deps.data.clock(),
            uses: 0,
        };
        this.hooks.push(hook);
        this.save();
        this.deps.audit?.record({
            actor: 'user',
            action: 'webhook created',
            account: accountId,
            outcome: 'ok',
            detail: { id: hook.id, name: hook.name },
        });
        return { ...hook };
    }

    update(
        id: string,
        patch: { enabled?: unknown; rotate?: unknown; defaultQty?: unknown; name?: unknown },
    ): WebhookConfig {
        const hook = this.find(id);
        if (patch.enabled !== undefined) hook.enabled = !!patch.enabled;
        if (patch.rotate) hook.passphrase = randomBytes(18).toString('base64url');
        if (patch.defaultQty !== undefined) {
            const qty = Number(patch.defaultQty);
            if (!(qty > 0)) throw fail('the default size must be above zero');
            hook.defaultQty = qty;
        }
        if (typeof patch.name === 'string' && patch.name.trim()) hook.name = patch.name.trim().slice(0, 80);
        this.save();
        this.deps.audit?.record({
            actor: 'user',
            action: 'webhook changed',
            account: hook.accountId,
            outcome: 'ok',
            detail: { id, enabled: hook.enabled, rotated: !!patch.rotate },
        });
        return { ...hook };
    }

    remove(id: string): void {
        const hook = this.find(id);
        this.hooks = this.hooks.filter((h) => h !== hook);
        this.save();
        this.deps.audit?.record({
            actor: 'user',
            action: 'webhook deleted',
            account: hook.accountId,
            outcome: 'ok',
            detail: { id },
        });
    }

    /** Handle an incoming message. Throws with a status code when it is refused. */
    async receive(id: string, raw: unknown): Promise<{ order: OrderState | null; note?: string }> {
        const hook = this.hooks.find((h) => h.id === id);
        // An unknown address and a wrong passphrase look the same from outside.
        if (!hook) throw fail('unknown webhook or wrong passphrase', 401);
        let msg: Record<string, any>;
        try {
            msg = typeof raw === 'string' ? JSON.parse(raw) : ((raw ?? {}) as Record<string, any>);
        } catch {
            throw this.refuse(hook, 'the message is not JSON', 400);
        }
        const given = Buffer.from(String(msg.passphrase ?? ''));
        const expected = Buffer.from(hook.passphrase);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            this.deps.audit?.record({
                actor: `webhook:${hook.id}`,
                action: 'webhook',
                account: hook.accountId,
                outcome: 'rejected',
                detail: { reason: 'wrong passphrase' },
            });
            throw fail('unknown webhook or wrong passphrase', 401);
        }
        if (!hook.enabled) throw this.refuse(hook, 'this webhook is switched off', 409);
        hook.uses++;
        hook.lastUsedAt = this.deps.data.clock();
        this.save();

        // The symbol: `BINANCE:BTCUSDT`, or a ticker with or without its exchange.
        let symbol = String(field(msg, 'symbol', 'ticker') ?? '').trim();
        const exchange = String(field(msg, 'exchange') ?? '')
            .trim()
            .toUpperCase();
        if (!symbol) throw this.refuse(hook, 'the message names no symbol (symbol or ticker)');
        if (!symbol.includes(':') && exchange) symbol = `${exchange}:${symbol}`;
        try {
            symbol = this.deps.data.underlying(symbol).symbol;
        } catch {
            throw this.refuse(hook, `unknown symbol ${symbol}`, 404);
        }
        const action = String(field(msg, 'action', 'side', 'strategy.order.action', 'order.action') ?? '')
            .trim()
            .toLowerCase();
        const broker = this.deps.trading.broker(hook.accountId)!;
        const held = broker.positions().find((p) => p.symbol === symbol)?.qty ?? 0;
        const actor = `webhook:${hook.id}`;

        if (['close', 'exit', 'flat', 'flatten'].includes(action)) {
            if (held === 0) return { order: null, note: `no ${symbol} position to close` };
            const order = await this.deps.trading.placeAutomated(
                hook.accountId,
                {
                    symbol,
                    side: held > 0 ? 'sell' : 'buy',
                    type: 'market',
                    qty: Math.abs(held),
                    reduceOnly: true,
                    source: 'webhook',
                    comment: hook.name,
                },
                actor,
            );
            return { order };
        }

        let side: 'buy' | 'sell';
        let qty: number;
        const target = field(msg, 'position_size', 'strategy.position_size', 'position');
        if (target !== undefined && Number.isFinite(Number(target))) {
            // Trade to a position (what a TradingView strategy alert reports after its order).
            const delta = Number(target) - held;
            if (Math.abs(delta) < 1e-12) return { order: null, note: `already at ${held}` };
            side = delta > 0 ? 'buy' : 'sell';
            qty = Math.abs(delta);
        } else {
            if (['buy', 'long'].includes(action)) side = 'buy';
            else if (['sell', 'short'].includes(action)) side = 'sell';
            else throw this.refuse(hook, `the action "${action}" is not buy, sell or close`);
            qty = Number(
                field(msg, 'qty', 'quantity', 'contracts', 'strategy.order.contracts', 'order.contracts') ??
                    hook.defaultQty,
            );
            if (!(qty > 0)) throw this.refuse(hook, 'the quantity must be above zero');
        }
        const typeText = String(field(msg, 'type', 'order_type') ?? 'market').toLowerCase();
        const request: PlaceOrderRequest = { symbol, side, type: 'market', qty, source: 'webhook', comment: hook.name };
        if (typeText === 'limit') {
            request.type = 'limit';
            request.limit = Number(field(msg, 'limit', 'price'));
        } else if (typeText === 'stop') {
            request.type = 'stop';
            request.stop = Number(field(msg, 'stop', 'price'));
        } else if (typeText !== 'market')
            throw this.refuse(hook, `the order type "${typeText}" is not market, limit or stop`);
        const order = await this.deps.trading.placeAutomated(hook.accountId, request, actor);
        return { order };
    }

    private refuse(hook: WebhookConfig, reason: string, statusCode = 400): Error {
        this.deps.audit?.record({
            actor: `webhook:${hook.id}`,
            action: 'webhook',
            account: hook.accountId,
            outcome: 'rejected',
            detail: { reason },
        });
        return fail(reason, statusCode);
    }

    private find(id: string): WebhookConfig {
        const hook = this.hooks.find((h) => h.id === id);
        if (!hook) throw fail('webhook not found', 404);
        return hook;
    }

    private save(): void {
        this.deps.db.kvSet(KEY, JSON.stringify(this.hooks));
    }
}
