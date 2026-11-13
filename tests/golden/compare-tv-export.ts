/**
 * Compare a Pine script's output here against TradingView's own numbers.
 *
 * In TradingView: add the script to a chart, then use "Export chart data" (paid plans). The CSV holds
 * time, open, high, low, close and one column per plot. This tool runs the same script over the CSV's
 * own bars, so the data is identical and any difference comes from the script engine alone.
 *
 *   node tests/golden/compare-tv-export.ts <export.csv> <script.pine> [--tolerance 1e-8] [--skip 500]
 *
 * `--skip` ignores the first N bars: TradingView computed its values over history the export does
 * not contain, so indicators with memory (EMA, RSI, ATR…) need a warm-up before they can agree.
 */
import { readFileSync } from 'node:fs';
import { PineTS } from 'pinets';

export interface Comparison {
    plot: string;
    compared: number;
    /** Largest |ours − theirs| / max(1, |theirs|). */
    worst: number;
    worstAt: string;
    ok: boolean;
}

export function parseCsv(text: string): { columns: string[]; rows: string[][] } {
    const lines = text
        .replace(/\r/g, '')
        .split('\n')
        .filter((l) => l.trim().length > 0);
    const split = (line: string) => {
        const out: string[] = [];
        let cur = '';
        let quoted = false;
        for (const ch of line) {
            if (ch === '"') quoted = !quoted;
            else if (ch === ',' && !quoted) {
                out.push(cur);
                cur = '';
            } else cur += ch;
        }
        out.push(cur);
        return out.map((s) => s.trim());
    };
    return { columns: split(lines[0]), rows: lines.slice(1).map(split) };
}

/** TradingView writes `time` as Unix seconds or as an ISO timestamp, depending on the export setting. */
export function parseTime(raw: string): number {
    if (/^\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        return n < 1e11 ? n * 1000 : n;
    }
    const t = Date.parse(raw);
    if (Number.isNaN(t)) throw new Error(`cannot read time "${raw}"`);
    return t;
}

export async function compareExport(
    csv: string,
    script: string,
    opts: { tolerance?: number; skip?: number } = {},
): Promise<Comparison[]> {
    const tolerance = opts.tolerance ?? 1e-8;
    const skip = opts.skip ?? 500;
    const { columns, rows } = parseCsv(csv);
    const col = (name: string) => columns.findIndex((c) => c.toLowerCase() === name);
    const idx = {
        time: col('time'),
        open: col('open'),
        high: col('high'),
        low: col('low'),
        close: col('close'),
        volume: col('volume'),
    };
    for (const key of ['time', 'open', 'high', 'low', 'close'] as const)
        if (idx[key] < 0) throw new Error(`the CSV has no "${key}" column`);
    const times = rows.map((r) => parseTime(r[idx.time]));
    const step = times.length > 1 ? times[1] - times[0] : 60_000;
    const klines = rows.map((r, i) => ({
        openTime: times[i],
        closeTime: times[i] + step - 1,
        open: Number(r[idx.open]),
        high: Number(r[idx.high]),
        low: Number(r[idx.low]),
        close: Number(r[idx.close]),
        volume: idx.volume >= 0 ? Number(r[idx.volume]) : 0,
    }));
    const ctx: any = await new PineTS(klines as any).run(script);
    const reserved = new Set(Object.values(idx).filter((i) => i >= 0));
    const out: Comparison[] = [];
    for (let c = 0; c < columns.length; c++) {
        if (reserved.has(c)) continue;
        const ours = ctx.plots?.[columns[c]]?.data;
        if (!ours) {
            out.push({
                plot: columns[c],
                compared: 0,
                worst: Number.NaN,
                worstAt: 'no plot with this title in the script',
                ok: false,
            });
            continue;
        }
        let worst = 0;
        let worstAt = '';
        let compared = 0;
        for (let i = skip; i < rows.length; i++) {
            const theirs = Number(rows[i][c]);
            const mine = ours[i]?.value;
            if (rows[i][c] === '' || Number.isNaN(theirs) || typeof mine !== 'number' || Number.isNaN(mine)) continue;
            compared++;
            const diff = Math.abs(mine - theirs) / Math.max(1, Math.abs(theirs));
            if (diff > worst) {
                worst = diff;
                worstAt = `${new Date(times[i]).toISOString()}: ours ${mine}, theirs ${theirs}`;
            }
        }
        out.push({ plot: columns[c], compared, worst, worstAt, ok: compared > 0 && worst <= tolerance });
    }
    return out;
}

if (process.argv[1]?.endsWith('compare-tv-export.ts')) {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
        const i = args.indexOf(name);
        return i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
    };
    const tolerance = flag('--tolerance');
    const skip = flag('--skip');
    if (args.length < 2) {
        console.error(
            'usage: node tests/golden/compare-tv-export.ts <export.csv> <script.pine> [--tolerance 1e-8] [--skip 500]',
        );
        process.exit(2);
    }
    const results = await compareExport(readFileSync(args[0], 'utf8'), readFileSync(args[1], 'utf8'), {
        tolerance,
        skip,
    });
    for (const r of results) {
        console.log(
            `${r.ok ? 'MATCH' : 'DIFF '}  ${r.plot.padEnd(28)} ${String(r.compared).padStart(6)} bars  worst ${Number.isNaN(r.worst) ? '—' : r.worst.toExponential(2)}  ${r.ok ? '' : r.worstAt}`,
        );
    }
    if (results.length === 0) console.log('The CSV has no plot columns to compare.');
    if (results.some((r) => !r.ok)) process.exitCode = 1;
}
