/**
 * Text-level helpers for Pine source. Nothing here runs a script or needs the runtime, so the web
 * app imports this module directly (`@ts/script-engine/source`).
 */

/** Blank out comments and string literals, keeping every character's line and column. */
export function stripCommentsAndStrings(source: string): string {
    let out = '';
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') {
                out += ' ';
                i++;
            }
        } else if (ch === '"' || ch === "'") {
            out += ' ';
            i++;
            while (i < source.length && source[i] !== ch && source[i] !== '\n') {
                if (source[i] === '\\' && i + 1 < source.length && source[i + 1] !== '\n') {
                    out += ' ';
                    i++;
                }
                out += ' ';
                i++;
            }
            if (source[i] === ch) {
                out += ' ';
                i++;
            }
        } else {
            out += ch;
            i++;
        }
    }
    return out;
}

export interface ScriptHeader {
    version: number | null;
    kind: 'indicator' | 'strategy' | 'library' | null;
    title: string | null;
}

/** The `//@version` line and the declaration call, read without running anything. */
export function readHeader(source: string): ScriptHeader {
    const version = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source);
    const code = stripCommentsAndStrings(source);
    const decl = /(?<![A-Za-z0-9_.])(indicator|strategy|library|study)\s*\(/.exec(code);
    let title: string | null = null;
    if (decl) {
        const after = source.slice(decl.index);
        const t = /\(\s*(?:title\s*=\s*)?(["'])((?:\\.|(?!\1).)*)\1/.exec(after);
        if (t) title = t[2];
    }
    const word = decl?.[1];
    return {
        version: version ? Number(version[1]) : null,
        kind: word === 'study' ? 'indicator' : ((word as ScriptHeader['kind']) ?? null),
        title,
    };
}

// ── Indicator on indicator ──────────────────────────────────────────────────

export interface PlotCall {
    /** The plot's title, or `Plot N` when it has none. */
    title: string;
    /** Source text of the plotted expression (the first argument). */
    expr: string;
    /** Index of the call's closing parenthesis in the source. */
    end: number;
    /** Whether the call already sets `display=`. */
    hasDisplay: boolean;
}

/** Split an argument list at its top-level commas. `code` is `source` with comments and strings blanked. */
function splitArgs(source: string, code: string, from: number, to: number): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = from;
    for (let i = from; i < to; i++) {
        const ch = code[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
            out.push(source.slice(start, i));
            start = i + 1;
        }
    }
    out.push(source.slice(start, to));
    return out.map((a) => a.trim());
}

const literal = (arg: string): string | null => {
    const m = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(arg.trim());
    return m ? m[2] : null;
};

/** Every `plot(...)` call in a script, in source order. */
export function findPlots(source: string): PlotCall[] {
    const code = stripCommentsAndStrings(source);
    const out: PlotCall[] = [];
    for (const m of code.matchAll(/(?<![A-Za-z0-9_.])plot\s*\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let i = open; i < code.length; i++) {
            if (code[i] === '(' || code[i] === '[') depth++;
            else if (code[i] === ')' || code[i] === ']') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end < 0) continue;
        const args = splitArgs(source, code, open + 1, end);
        if (!args[0]) continue;
        let title: string | null = null;
        for (const arg of args.slice(1)) {
            const named = /^title\s*=\s*([\s\S]+)$/.exec(arg);
            if (named) title = literal(named[1]);
        }
        if (title === null && args[1] !== undefined && !/^[A-Za-z_]\w*\s*=(?!=)/.test(args[1]))
            title = literal(args[1]);
        out.push({
            title: title ?? `Plot ${out.length + 1}`,
            expr: args[0],
            end,
            hasDisplay: args.slice(1).some((a) => /^display\s*=(?!=)/.test(a)),
        });
    }
    return out;
}

export type OnPlotStudy = 'sma' | 'ema' | 'rma' | 'wma' | 'rsi' | 'stdev' | 'roc' | 'highest' | 'lowest' | 'bb';

export const ON_PLOT_STUDIES: { id: OnPlotStudy; label: string }[] = [
    { id: 'sma', label: 'Simple moving average' },
    { id: 'ema', label: 'Exponential moving average' },
    { id: 'rma', label: "Wilder's moving average" },
    { id: 'wma', label: 'Weighted moving average' },
    { id: 'bb', label: 'Bollinger Bands' },
    { id: 'rsi', label: 'RSI' },
    { id: 'stdev', label: 'Standard deviation' },
    { id: 'roc', label: 'Rate of change' },
    { id: 'highest', label: 'Highest' },
    { id: 'lowest', label: 'Lowest' },
];

/**
 * Indicator on indicator: a new script that computes `study` on one plot of an existing indicator.
 * The base script is kept whole (its plots hidden) and the study is appended, so the result is an
 * ordinary self-contained script that needs nothing from the chart it is added to.
 */
export function composeOnPlot(
    source: string,
    plotIndex: number,
    study: OnPlotStudy,
    length: number,
    mult = 2,
): { source: string; title: string } {
    const header = readHeader(source);
    if (header.kind !== 'indicator') throw new Error('A study can only be applied to an indicator script.');
    const plots = findPlots(source);
    const target = plots[plotIndex];
    if (!target) throw new Error('That plot was not found in the script.');
    const n = Math.max(1, Math.round(length));
    const label = `${study.toUpperCase()} ${n}`;
    const title = `${label} of ${header.title ?? 'indicator'}: ${target.title}`;

    // Hide the base script's own plots, last first so earlier positions stay valid.
    let out = source;
    for (const p of [...plots].reverse()) {
        if (!p.hasDisplay) out = `${out.slice(0, p.end)}, display=display.none${out.slice(p.end)}`;
    }
    // Retitle the declaration.
    const code = stripCommentsAndStrings(out);
    const decl = /(?<![A-Za-z0-9_.])(indicator|study)\s*\(/.exec(code);
    if (decl) {
        const rest = out.slice(decl.index);
        const t = /\(\s*(?:title\s*=\s*)?(["'])((?:\\.|(?!\1).)*)\1/.exec(rest);
        if (t) {
            const at = decl.index + t.index + t[0].length - t[2].length - 1;
            out = `${out.slice(0, at)}${title.replace(/["\\]/g, ' ')}${out.slice(at + t[2].length)}`;
        }
    }
    const lines = ['', '// ── study on plot ──', `ioiSource = ${target.expr}`];
    if (study === 'bb') {
        lines.push(`[ioiBasis, ioiUpper, ioiLower] = ta.bb(ioiSource, ${n}, ${mult})`);
        lines.push(`plot(ioiBasis, "${label} basis", color=color.orange)`);
        lines.push(`plot(ioiUpper, "${label} upper", color=color.new(color.blue, 30))`);
        lines.push(`plot(ioiLower, "${label} lower", color=color.new(color.blue, 30))`);
    } else {
        lines.push(`plot(ta.${study}(ioiSource, ${n}), "${label}", color=color.yellow, linewidth=2)`);
    }
    // The source itself stays visible so the study has something to be read against.
    lines.push(`plot(ioiSource, "Source: ${target.title.replace(/["\\]/g, ' ')}", color=color.new(color.gray, 30))`);
    return { source: `${out.replace(/\s+$/, '')}\n${lines.join('\n')}\n`, title };
}
