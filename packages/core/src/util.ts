import type { Unsubscribe } from './types.ts';

/** Minimal typed event emitter. Listener errors are isolated so one bad handler never blocks the rest. */
export class Emitter<Events extends Record<string, any>> {
    private listeners = new Map<keyof Events, Set<(payload: any) => void>>();

    on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(handler);
        return () => set.delete(handler);
    }

    emit<K extends keyof Events>(event: K, payload: Events[K]): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const handler of [...set]) {
            try {
                handler(payload);
            } catch (err) {
                console.error(`[emitter] listener for "${String(event)}" threw`, err);
            }
        }
    }

    listenerCount(event: keyof Events): number {
        return this.listeners.get(event)?.size ?? 0;
    }

    clear(): void {
        this.listeners.clear();
    }
}

/** Number of decimals needed to print a multiple of `step` exactly (0.01 → 2, 1e-8 → 8, 5 → 0). */
export function decimalsOf(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 0;
    const s = step.toString();
    if (s.includes('e-')) {
        const [mant, exp] = s.split('e-');
        return Number(exp) + (mant.split('.')[1]?.length ?? 0);
    }
    return s.split('.')[1]?.length ?? 0;
}

/** Whole number of ticks nearest to `price`. Prices are compared and stored in ticks to avoid float drift. */
export function toTicks(price: number, tickSize: number): number {
    return Math.round(price / tickSize);
}

export function fromTicks(ticks: number, tickSize: number): number {
    return Number((ticks * tickSize).toFixed(decimalsOf(tickSize)));
}

/** Snap a price onto the tick grid. */
export function roundToTick(price: number, tickSize: number): number {
    return fromTicks(toTicks(price, tickSize), tickSize);
}

/** Snap a quantity DOWN onto the lot grid (never round an order size up). */
export function floorToLot(qty: number, lotSize: number): number {
    const lots = Math.floor(qty / lotSize + 1e-9);
    return Number((lots * lotSize).toFixed(decimalsOf(lotSize)));
}

export function formatPrice(price: number, tickSize: number): string {
    return price.toFixed(decimalsOf(tickSize));
}

/** Sortable unique id: time-ordered prefix plus random suffix. */
export function newId(prefix = ''): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    return `${prefix}${t}${r}`;
}

/** Deterministic PRNG (mulberry32) for synthetic data and reproducible tests. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split `PROVIDER:TICKER` into its parts. A bare ticker has no provider. */
export function splitSymbol(symbol: string): { provider?: string; ticker: string } {
    const i = symbol.indexOf(':');
    if (i < 0) return { ticker: symbol };
    return { provider: symbol.slice(0, i).toUpperCase(), ticker: symbol.slice(i + 1) };
}
