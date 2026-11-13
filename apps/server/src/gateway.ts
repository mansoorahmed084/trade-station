import type { Server } from 'node:http';
import type { Bar, Unsubscribe } from '@ts/core';
import type { MarketDataService } from '@ts/datafeed';
import { type ClientMessage, encodeBarFrame, PROTOCOL_VERSION, type ServerMessage } from '@ts/protocol';
import { type WebSocket, WebSocketServer } from 'ws';

interface Sub {
    stop: Unsubscribe;
    /** Latest unsent state of the bar being formed (a live reference — values are read at flush time). */
    dirty: Bar | null;
    opened: boolean;
}

interface Client {
    ws: WebSocket;
    subs: Map<number, Sub>;
    topics: Set<string>;
}

const FLUSH_MS = 16;
const MAX_BUFFERED = 1 << 20;
const MAX_SUBS = 400;

/**
 * WebSocket gateway. Bar updates are conflated per subscription to one frame per flush tick
 * (~60 Hz): a burst of trades costs one message, and a slow client can never build a backlog.
 */
export class Gateway {
    private wss: WebSocketServer;
    private clients = new Set<Client>();
    private timer: ReturnType<typeof setInterval>;
    private data: MarketDataService;

    constructor(server: Server, data: MarketDataService) {
        this.data = data;
        this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
        server.on('upgrade', (req, socket, head) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname !== '/ws') {
                socket.destroy();
                return;
            }
            // Browsers send Origin on WebSocket handshakes: refuse pages from other sites.
            const origin = req.headers.origin;
            if (origin && !isLocalOrigin(origin)) {
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
        });
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        this.timer.unref?.();
    }

    private accept(ws: WebSocket): void {
        const client: Client = { ws, subs: new Map(), topics: new Set() };
        this.clients.add(client);
        this.send(client, { op: 'hello', version: PROTOCOL_VERSION, now: Date.now() });
        ws.on('message', (raw, isBinary) => {
            if (isBinary) return;
            let msg: ClientMessage;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                this.send(client, { op: 'error', message: 'malformed message' });
                return;
            }
            this.handle(client, msg);
        });
        const drop = () => {
            for (const sub of client.subs.values()) sub.stop();
            client.subs.clear();
            this.clients.delete(client);
        };
        ws.on('close', drop);
        ws.on('error', drop);
    }

    private handle(client: Client, msg: ClientMessage): void {
        switch (msg.op) {
            case 'ping':
                this.send(client, { op: 'pong', t: msg.t, now: Date.now() });
                return;
            case 'listen':
                for (const t of msg.topics ?? []) client.topics.add(String(t));
                return;
            case 'unsub': {
                const sub = client.subs.get(msg.id);
                if (sub) {
                    sub.stop();
                    client.subs.delete(msg.id);
                }
                return;
            }
            case 'sub': {
                if (client.subs.has(msg.id)) return;
                if (client.subs.size >= MAX_SUBS) {
                    this.send(client, { op: 'error', id: msg.id, message: 'too many subscriptions' });
                    return;
                }
                try {
                    const sub: Sub = { stop: () => {}, dirty: null, opened: false };
                    sub.stop = this.data.subscribe(msg.symbol, msg.tf, (bar, opened) => {
                        if (opened && sub.dirty && sub.dirty !== bar) {
                            // Deliver the final state of the bar that just closed before the new one.
                            this.sendBar(client, msg.id, sub.dirty, sub.opened);
                            sub.opened = false;
                        }
                        sub.dirty = bar;
                        if (opened) sub.opened = true;
                    });
                    client.subs.set(msg.id, sub);
                    this.send(client, { op: 'subscribed', id: msg.id });
                } catch (err: any) {
                    this.send(client, { op: 'error', id: msg.id, message: err?.message ?? 'subscribe failed' });
                }
                return;
            }
        }
    }

    private sendBar(client: Client, id: number, bar: Bar, opened: boolean): void {
        if (client.ws.readyState !== client.ws.OPEN) return;
        client.ws.send(encodeBarFrame(id, bar, opened, Date.now()), { binary: true });
    }

    private flush(): void {
        for (const client of this.clients) {
            if (client.ws.readyState !== client.ws.OPEN || client.ws.bufferedAmount > MAX_BUFFERED) continue;
            for (const [id, sub] of client.subs) {
                if (!sub.dirty) continue;
                this.sendBar(client, id, sub.dirty, sub.opened);
                sub.dirty = null;
                sub.opened = false;
            }
        }
    }

    private send(client: Client, msg: ServerMessage): void {
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
    }

    /** Push an application event (alert fired, order update, …) to every client listening on its topic. */
    publish(topic: string, data: unknown): void {
        const text = JSON.stringify({ op: 'event', topic, data } satisfies ServerMessage);
        for (const client of this.clients) {
            if (client.ws.readyState !== client.ws.OPEN) continue;
            if (client.topics.has(topic) || client.topics.has('*')) client.ws.send(text);
        }
    }

    get connections(): number {
        return this.clients.size;
    }

    close(): void {
        clearInterval(this.timer);
        for (const client of this.clients) client.ws.terminate();
        this.wss.close();
    }
}

export function isLocalOrigin(origin: string): boolean {
    try {
        const host = new URL(origin).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
    } catch {
        return false;
    }
}
