import { parentPort } from 'node:worker_threads';
import { BarSeries, type SymbolInfo } from '@ts/core';
import type { ScriptData } from '@ts/script-engine';
import { execute, type RunJob } from './execute.ts';

/**
 * A backtest worker thread. It has no market data of its own: bars and symbol facts are asked for
 * from the main thread and kept for as long as jobs of the same group keep arriving, so the runs
 * of a parameter search load their history once.
 */

export type ToWorker =
    | { type: 'job'; id: number; job: RunJob }
    | { type: 'reply'; req: number; ok: true; value: unknown }
    | { type: 'reply'; req: number; ok: false; error: string; statusCode?: number };

export type FromWorker =
    | { type: 'ready' }
    | { type: 'ask'; req: number; what: 'bars'; symbol: string; timeframe: string; query: BarQueryLike }
    | { type: 'ask'; req: number; what: 'describe'; symbol: string }
    | { type: 'done'; id: number; result: unknown }
    | { type: 'failed'; id: number; error: WorkerError };

export interface BarQueryLike {
    from?: number;
    to?: number;
    limit?: number;
}

export interface WorkerError {
    message: string;
    statusCode?: number;
    stage?: string;
    line?: number;
    column?: number;
}

const port = parentPort;
if (!port) throw new Error('backtest/worker.ts must run as a worker thread');

let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const ask = <T>(message: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const req = ++seq;
        waiting.set(req, { resolve, reject });
        port.postMessage({ type: 'ask', req, ...message });
    });

let group = '';
let idle: ReturnType<typeof setTimeout> | undefined;
let now = Date.now();
const bars = new Map<string, Promise<BarSeries>>();
const symbols = new Map<string, Promise<SymbolInfo>>();

const data: ScriptData = {
    clock: () => now,
    getBars(symbol, timeframe, query = {}) {
        const key = `${symbol}|${timeframe}|${query.from ?? ''}|${query.to ?? ''}|${query.limit ?? ''}`;
        let hit = bars.get(key);
        if (!hit) {
            hit = ask<ArrayBuffer>({ what: 'bars', symbol, timeframe, query }).then((buffer) =>
                BarSeries.decode(buffer),
            );
            bars.set(key, hit);
            hit.catch(() => bars.delete(key));
        }
        return hit;
    },
    describe(symbol) {
        let hit = symbols.get(symbol);
        if (!hit) {
            hit = ask<SymbolInfo>({ what: 'describe', symbol });
            symbols.set(symbol, hit);
            hit.catch(() => symbols.delete(symbol));
        }
        return hit;
    },
};

port.on('message', async (message: ToWorker) => {
    if (message.type === 'reply') {
        const entry = waiting.get(message.req);
        if (!entry) return;
        waiting.delete(message.req);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(Object.assign(new Error(message.error), { statusCode: message.statusCode }));
        return;
    }
    const { id, job } = message;
    clearTimeout(idle);
    if (job.group !== group) {
        group = job.group;
        bars.clear();
        symbols.clear();
    }
    now = job.now;
    try {
        port.postMessage({ type: 'done', id, result: await execute(job, data) } satisfies FromWorker);
    } catch (err: any) {
        const error: WorkerError = {
            message: String(err?.message ?? err),
            statusCode: err?.statusCode,
            stage: err?.stage,
            line: err?.line,
            column: err?.column,
        };
        port.postMessage({ type: 'failed', id, error } satisfies FromWorker);
    }
    // A deep run can hold hundreds of megabytes of bars: let them go once the thread has been quiet.
    idle = setTimeout(() => {
        group = '';
        bars.clear();
        symbols.clear();
    }, 60_000);
    idle.unref();
});

port.postMessage({ type: 'ready' } satisfies FromWorker);
