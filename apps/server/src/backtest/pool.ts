import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ScriptData } from '@ts/script-engine';
import type { RunJob, RunOutput } from './execute.ts';
import type { FromWorker, ToWorker } from './worker.ts';

interface Task {
    id: number;
    job: RunJob;
    resolve(value: RunOutput): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

interface Slot {
    worker: Worker;
    task: Task | null;
    ready: boolean;
}

/**
 * Worker threads that run backtests. Threads start when first needed and stay warm; each asks this
 * thread for the bars it needs, so the store and the venue connections have a single owner.
 */
export class WorkerPool {
    readonly size: number;
    private data: ScriptData;
    private slots: Slot[] = [];
    private queue: Task[] = [];
    private seq = 0;
    private closed = false;

    constructor(data: ScriptData, size = Math.max(1, Math.min(8, availableParallelism() - 1))) {
        this.data = data;
        this.size = size;
    }

    /** Threads started so far, and jobs waiting for one. */
    stats(): { workers: number; busy: number; queued: number } {
        return {
            workers: this.slots.length,
            busy: this.slots.filter((s) => s.task).length,
            queued: this.queue.length,
        };
    }

    /** Run a job on the next free thread. Aborting the signal drops it, stopping its thread if it has started. */
    run(job: RunJob, signal?: AbortSignal): Promise<RunOutput> {
        if (this.closed) return Promise.reject(new Error('the backtest pool is closed'));
        return new Promise<RunOutput>((resolve, reject) => {
            if (signal?.aborted) return reject(cancelled());
            const task: Task = { id: ++this.seq, job, resolve, reject, signal };
            if (signal) {
                task.onAbort = () => this.abort(task);
                signal.addEventListener('abort', task.onAbort, { once: true });
            }
            this.queue.push(task);
            this.pump();
        });
    }

    close(): void {
        this.closed = true;
        for (const task of this.queue.splice(0)) this.finish(task, cancelled());
        for (const slot of this.slots.splice(0)) {
            if (slot.task) this.finish(slot.task, cancelled());
            void slot.worker.terminate();
        }
    }

    private finish(task: Task, error: Error | null, value?: RunOutput): void {
        if (task.onAbort) task.signal?.removeEventListener('abort', task.onAbort);
        if (error) task.reject(error);
        else task.resolve(value as RunOutput);
    }

    private abort(task: Task): void {
        const queued = this.queue.indexOf(task);
        if (queued >= 0) {
            this.queue.splice(queued, 1);
            this.finish(task, cancelled());
            return;
        }
        const slot = this.slots.find((s) => s.task === task);
        if (!slot) return;
        // A run cannot be interrupted from outside: stop its thread and let the pool start another.
        slot.task = null;
        this.slots.splice(this.slots.indexOf(slot), 1);
        void slot.worker.terminate();
        this.finish(task, cancelled());
        this.pump();
    }

    private pump(): void {
        while (this.queue.length) {
            let slot = this.slots.find((s) => s.ready && !s.task);
            if (!slot) {
                // Start another thread only when every existing one is spoken for.
                const starting = this.slots.filter((s) => !s.ready).length;
                if (this.slots.length < this.size && starting < this.queue.length) this.spawn();
                return;
            }
            const task = this.queue.shift()!;
            slot.task = task;
            slot.worker.postMessage({ type: 'job', id: task.id, job: task.job } satisfies ToWorker);
            slot = undefined;
        }
    }

    private spawn(): void {
        const worker = new Worker(new URL('./worker.ts', import.meta.url));
        const slot: Slot = { worker, task: null, ready: false };
        this.slots.push(slot);
        const reply = (message: ToWorker) => worker.postMessage(message);
        worker.on('message', (message: FromWorker) => {
            switch (message.type) {
                case 'ready':
                    slot.ready = true;
                    return this.pump();
                case 'ask': {
                    const { req } = message;
                    const answer =
                        message.what === 'bars'
                            ? this.data
                                  .getBars(message.symbol, message.timeframe, message.query)
                                  .then((series) => series.encode())
                            : this.data.describe(message.symbol);
                    answer.then(
                        (value) => {
                            if (value instanceof ArrayBuffer)
                                worker.postMessage({ type: 'reply', req, ok: true, value }, [value]);
                            else reply({ type: 'reply', req, ok: true, value });
                        },
                        (err) =>
                            reply({
                                type: 'reply',
                                req,
                                ok: false,
                                error: String(err?.message ?? err),
                                statusCode: err?.statusCode,
                            }),
                    );
                    return;
                }
                case 'done':
                case 'failed': {
                    const task = slot.task;
                    slot.task = null;
                    if (task && task.id === message.id) {
                        if (message.type === 'done') this.finish(task, null, message.result as RunOutput);
                        else this.finish(task, Object.assign(new Error(message.error.message), message.error));
                    }
                    return this.pump();
                }
            }
        });
        const lost = (reason: string) => {
            const index = this.slots.indexOf(slot);
            if (index < 0) return; // stopped on purpose
            this.slots.splice(index, 1);
            if (slot.task) this.finish(slot.task, new Error(`the backtest worker stopped: ${reason}`));
            slot.task = null;
            if (!this.closed) this.pump();
        };
        worker.on('error', (err) => lost(String((err as Error)?.message ?? err)));
        worker.on('exit', (code) => lost(`exit code ${code}`));
    }
}

const cancelled = () => Object.assign(new Error('cancelled'), { statusCode: 499, cancelled: true });
