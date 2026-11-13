import { create } from 'zustand';
import { type ChartTypeParams, DEFAULT_PARAMS } from './chart-types.ts';
import type { ServerClient } from './client.ts';

interface ParamsState {
    chartTypes: ChartTypeParams;
    load(client: ServerClient): Promise<void>;
    setChartTypes(client: ServerClient, next: ChartTypeParams): void;
}

/** User-tunable settings that are not part of a chart layout. Saved on the server. */
export const useParams = create<ParamsState>((set) => ({
    chartTypes: DEFAULT_PARAMS,
    async load(client) {
        const raw = await client.kvGet('chartTypeParams').catch(() => null);
        if (!raw) return;
        try {
            const saved = JSON.parse(raw) as Partial<ChartTypeParams>;
            set({
                chartTypes: {
                    renko: { ...DEFAULT_PARAMS.renko, ...saved.renko },
                    kagi: { ...DEFAULT_PARAMS.kagi, ...saved.kagi },
                    range: { ...DEFAULT_PARAMS.range, ...saved.range },
                    pnf: { ...DEFAULT_PARAMS.pnf, ...saved.pnf },
                    linebreak: { ...DEFAULT_PARAMS.linebreak, ...saved.linebreak },
                },
            });
        } catch {}
    },
    setChartTypes(client, next) {
        set({ chartTypes: next });
        client.kvSet('chartTypeParams', JSON.stringify(next));
    },
}));
