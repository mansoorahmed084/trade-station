import { createHmac } from 'node:crypto';
import { sleep } from '@ts/core';
import type { Alert, AlertEvent, Delivery } from './types.ts';

export interface NotifierConfig {
    /** Telegram bot token (`TS_TELEGRAM_TOKEN`). Without it Telegram deliveries are reported as not configured. */
    telegramToken?: string;
    /** SMTP connection URL (`TS_SMTP_URL`, e.g. `smtps://user:pass@smtp.example.com:465`) and sender address. */
    smtpUrl?: string;
    smtpFrom?: string;
    fetch?: typeof fetch;
    /** Injected for tests; defaults to nodemailer. */
    sendMail?: (mail: { to: string; from: string; subject: string; text: string }) => Promise<void>;
    retryDelaysMs?: number[];
}

/** The JSON body a webhook receives. */
export function webhookPayload(event: AlertEvent) {
    return {
        id: event.id,
        alert: event.alertName,
        alertId: event.alertId,
        symbol: event.symbol,
        ticker: event.symbol.slice(event.symbol.indexOf(':') + 1),
        timeframe: event.timeframe,
        time: new Date(event.time).toISOString(),
        barTime: new Date(event.barTime).toISOString(),
        price: event.price,
        message: event.message,
        late: event.late,
    };
}

/** `sha256=<hex>` HMAC of the exact body bytes, for the `X-Signature` header. */
export function sign(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function post(
    fetchFn: typeof fetch,
    url: string,
    body: string,
    headers: Record<string, string>,
    delays: number[],
): Promise<string | null> {
    let last = 'failed';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            const res = await fetchFn(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body,
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) return null;
            last = `HTTP ${res.status}`;
            // A client error will not get better by repeating it.
            if (res.status >= 400 && res.status < 500 && res.status !== 429) return last;
        } catch (err: any) {
            last = err?.name === 'TimeoutError' ? 'timed out' : (err?.message ?? 'failed');
        }
        if (attempt < delays.length) await sleep(delays[attempt]);
    }
    return last;
}

/**
 * Send a fired alert to every outside channel it asks for. Never throws: each channel reports
 * whether it worked, and one failing channel does not hold up the others.
 */
export async function deliver(event: AlertEvent, alert: Alert, config: NotifierConfig = {}): Promise<Delivery[]> {
    const fetchFn = config.fetch ?? fetch;
    const delays = config.retryDelaysMs ?? [500, 2000];
    const n = alert.notify;
    const jobs: Promise<Delivery>[] = [];

    if (n.webhook) {
        const { url, secret } = n.webhook;
        const body = JSON.stringify(webhookPayload(event));
        const headers: Record<string, string> = { 'x-alert-id': event.id };
        if (secret) headers['x-signature'] = sign(body, secret);
        jobs.push(
            post(fetchFn, url, body, headers, delays).then((err) => ({
                channel: 'webhook',
                ok: !err,
                detail: err ?? undefined,
            })),
        );
    }
    if (n.discord) {
        const body = JSON.stringify({ content: event.message.slice(0, 1900) });
        jobs.push(
            post(fetchFn, n.discord.url, body, {}, delays).then((err) => ({
                channel: 'discord',
                ok: !err,
                detail: err ?? undefined,
            })),
        );
    }
    if (n.telegram) {
        if (!config.telegramToken)
            jobs.push(
                Promise.resolve({
                    channel: 'telegram',
                    ok: false,
                    detail: 'TS_TELEGRAM_TOKEN is not set on the server',
                }),
            );
        else {
            const body = JSON.stringify({ chat_id: n.telegram.chatId, text: event.message.slice(0, 4000) });
            jobs.push(
                post(fetchFn, `https://api.telegram.org/bot${config.telegramToken}/sendMessage`, body, {}, delays).then(
                    (err) => ({ channel: 'telegram', ok: !err, detail: err ?? undefined }),
                ),
            );
        }
    }
    if (n.email) {
        const to = n.email.to;
        if (!config.smtpUrl && !config.sendMail)
            jobs.push(Promise.resolve({ channel: 'email', ok: false, detail: 'TS_SMTP_URL is not set on the server' }));
        else {
            const mail = {
                to,
                from: config.smtpFrom ?? 'alerts@localhost',
                subject: `Alert: ${event.alertName}`,
                text: `${event.message}\n\n${event.symbol} ${event.timeframe} at ${new Date(event.time).toISOString()}`,
            };
            const send =
                config.sendMail ??
                (async (m: typeof mail) => {
                    const { createTransport } = await import('nodemailer');
                    await createTransport(config.smtpUrl!).sendMail(m);
                });
            jobs.push(
                send(mail).then(
                    () => ({ channel: 'email' as const, ok: true }),
                    (err) => ({ channel: 'email' as const, ok: false, detail: err?.message ?? 'failed' }),
                ),
            );
        }
    }
    return Promise.all(jobs);
}
