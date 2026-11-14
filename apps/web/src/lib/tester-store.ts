import type {
    BacktestProperties,
    BacktestRequest,
    BacktestResult,
    JobStatus,
    StrategyDescription,
    StrategyRef,
} from '@ts/backtest/api';
import { create } from 'zustand';
import type { ServerClient } from './client.ts';

export type StrategyChoice =
    | { kind: 'native'; id: string }
    | { kind: 'pine'; scriptId: string }
    /** Source handed over from the editor without saving it. */
    | { kind: 'draft' };

export type RangeChoice =
    | { mode: 'bars'; bars: number }
    | { mode: 'dates'; from: string; to: string }
    /** Everything the venue has. */
    | { mode: 'all' };

export type TesterTab = 'overview' | 'performance' | 'trades' | 'optimize' | 'montecarlo';
export type InputValues = Record<string, number | boolean | string>;

/** One input's search range in the optimiser. */
export interface Vary {
    on: boolean;
    from: number;
    to: number;
    step: number;
}

/** The optimiser's form. It lives here so it survives switching tabs. */
export interface OptimizerSetup {
    /** Ranges by strategy, then by input name. */
    vary: Record<string, Record<string, Vary>>;
    objective: JobStatus['objective'];
    method: 'grid' | 'random';
    samples: number;
    mode: 'search' | 'walkforward';
    folds: number;
    /** In-sample share, in percent. */
    share: number;
}

export interface Market {
    symbol: string;
    timeframe: string;
}

interface TesterState {
    choice: StrategyChoice;
    draft: { title: string; source: string; rev: number } | null;
    /** Input values, kept per strategy so switching back restores them. */
    inputs: Record<string, InputValues>;
    properties: BacktestProperties;
    range: RangeChoice;
    tab: TesterTab;
    showMarkers: boolean;
    description: StrategyDescription | null;
    result: BacktestResult | null;
    running: boolean;
    error: string | null;
    /** Settings changed since the result on screen was computed. */
    stale: boolean;
    optimizer: OptimizerSetup;
    /** The parameter search or walk-forward last started, with its rows. */
    job: JobStatus | null;
    patch(patch: Partial<TesterState>): void;
    setInputs(values: InputValues): void;
    testDraft(title: string, source: string): void;
}

const KEY = 'ts.tester';
const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<TesterState>;
    } catch {
        return {};
    }
})();

export const choiceKey = (c: StrategyChoice): string =>
    c.kind === 'native' ? `native:${c.id}` : c.kind === 'pine' ? `pine:${c.scriptId}` : 'draft';

export const useTester = create<TesterState>((set, get) => {
    const persist = () => {
        const s = get();
        try {
            localStorage.setItem(
                KEY,
                JSON.stringify({
                    choice: s.choice.kind === 'draft' ? undefined : s.choice,
                    inputs: s.inputs,
                    properties: s.properties,
                    range: s.range,
                    tab: s.tab,
                    showMarkers: s.showMarkers,
                }),
            );
        } catch {}
    };
    return {
        choice: saved.choice ?? { kind: 'native', id: 'ema-cross' },
        draft: null,
        inputs: saved.inputs ?? {},
        properties: saved.properties ?? {},
        range: saved.range ?? { mode: 'bars', bars: 5000 },
        tab: saved.tab ?? 'overview',
        showMarkers: saved.showMarkers ?? true,
        description: null,
        result: null,
        running: false,
        error: null,
        stale: false,
        optimizer: {
            vary: {},
            objective: 'netProfit',
            method: 'grid',
            samples: 200,
            mode: 'search',
            folds: 4,
            share: 70,
        },
        job: null,
        patch(patch) {
            set(patch);
            persist();
        },
        setInputs(values) {
            const key = choiceKey(get().choice);
            set({ inputs: { ...get().inputs, [key]: values } });
            persist();
        },
        testDraft(title, source) {
            set({
                draft: { title, source, rev: (get().draft?.rev ?? 0) + 1 },
                choice: { kind: 'draft' },
                tab: 'overview',
            });
        },
    };
});

/** The strategy reference the server understands for the current choice. */
export function strategyRef(): StrategyRef | null {
    const { choice, draft } = useTester.getState();
    if (choice.kind === 'native') return { kind: 'native', id: choice.id };
    if (choice.kind === 'pine') return { kind: 'pine', scriptId: choice.scriptId };
    return draft ? { kind: 'pine', source: draft.source } : null;
}

/** The request for the current settings on a market, or null when no strategy is chosen. */
export function buildRequest(market: Market): BacktestRequest | null {
    const s = useTester.getState();
    const strategy = strategyRef();
    if (!strategy) return null;
    const window =
        s.range.mode === 'bars'
            ? { bars: s.range.bars }
            : s.range.mode === 'all'
              ? { from: 0 }
              : {
                    from: Date.parse(`${s.range.from}T00:00:00Z`) || 0,
                    to: Date.parse(`${s.range.to}T23:59:59Z`) || undefined,
                };
    return {
        strategy,
        symbol: market.symbol,
        timeframe: market.timeframe,
        ...window,
        inputs: s.inputs[choiceKey(s.choice)] ?? {},
        properties: s.properties,
    };
}

let runSeq = 0;

/** Run the current settings. A newer run supersedes an older one still in flight. */
export async function runTester(client: ServerClient, market: Market): Promise<void> {
    const request = buildRequest(market);
    if (!request) return;
    const seq = ++runSeq;
    useTester.setState({ running: true, error: null });
    try {
        const result = await client.post<BacktestResult>('/api/backtest/run', request);
        if (seq !== runSeq) return;
        useTester.setState({ result, running: false, stale: false });
    } catch (err: any) {
        if (seq !== runSeq) return;
        useTester.setState({ running: false, error: String(err?.message ?? err) });
    }
}
