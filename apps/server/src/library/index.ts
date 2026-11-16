import { EXAMPLES } from '../examples.ts';
import { TECHNICAL_SENTIMENT_COMPOSITE } from './technical-sentiment-composite.ts';
import { WAVE_FLOW_MATRIX } from './wave-flow-matrix.ts';

/** A script that ships with the app and is put into the script library for you. */
export interface BundledScript {
    id: string;
    name: string;
    source: string;
    author: string;
    license: string | null;
    origin: string | null;
}

/**
 * Indicators carried over from the StockCryptoScreener project. Both are independent
 * implementations written from public descriptions of the method: they cover the ground of
 * LuxAlgo-style confluence and oscillator suites but contain no LuxAlgo code, so the rule that
 * LuxAlgo's own scripts are not bundled (docs/phase-3-findings.md) does not apply to them.
 */
export const INDICATORS: BundledScript[] = [
    {
        id: 'indicator-technical-sentiment-composite',
        name: 'Technical Sentiment Composite',
        source: TECHNICAL_SENTIMENT_COMPOSITE,
        author: 'StockCryptoScreener',
        license: null,
        origin: 'pine/technical_sentiment_composite.pine — independent implementation, not affiliated with LuxAlgo',
    },
    {
        id: 'indicator-wave-flow-matrix',
        name: 'Wave & Flow Matrix',
        source: WAVE_FLOW_MATRIX,
        author: 'StockCryptoScreener',
        license: null,
        origin: 'pine/wave_flow_matrix.pine — independent implementation, not affiliated with LuxAlgo',
    },
];

/** Every bundled script, in the order a new library lists them. */
export const BUNDLED: BundledScript[] = [
    ...EXAMPLES.map((e) => ({ ...e, author: 'Trade Station', license: 'Example — use freely', origin: null })),
    ...INDICATORS,
];
