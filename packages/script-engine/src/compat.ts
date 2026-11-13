import { PineTS } from 'pinets';
import { stripCommentsAndStrings } from './source.ts';

export { readHeader, type ScriptHeader, stripCommentsAndStrings } from './source.ts';

/**
 * Static part of the compatibility report: which built-in functions and constants a script
 * references that the Pine runtime does not implement. The runtime is asked directly — its own
 * namespaces are enumerated once — so the answer tracks whatever version is installed.
 */

/** Namespaces whose members can be enumerated. `syminfo` is a dynamic proxy and is skipped. */
const NAMESPACES = [
    'ta',
    'math',
    'request',
    'strategy',
    'array',
    'str',
    'input',
    'color',
    'line',
    'label',
    'box',
    'table',
    'matrix',
    'map',
    'ticker',
    'polyline',
    'linefill',
    'log',
    'runtime',
    'timeframe',
    'session',
    'barstate',
    'chart',
    'plot',
    'shape',
    'location',
    'size',
    'position',
    'display',
    'format',
    'text',
    'xloc',
    'yloc',
    'extend',
    'hline',
    'currency',
    'alert',
    'order',
    'scale',
    'font',
    'dayofweek',
    'earnings',
    'dividends',
    'splits',
    'adjustment',
];

let members: Promise<Map<string, Set<string>>> | null = null;

/** Every member of every runtime namespace, discovered by running a one-line script. */
export function runtimeMembers(): Promise<Map<string, Set<string>>> {
    members ??= (async () => {
        const bars = Array.from({ length: 5 }, (_, i) => ({
            openTime: 1.7e12 + i * 60_000,
            closeTime: 1.7e12 + i * 60_000 + 59_999,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
        }));
        const ctx: any = await new PineTS(bars as any).run('//@version=6\nindicator("probe")\nplot(close)');
        const out = new Map<string, Set<string>>();
        for (const ns of NAMESPACES) {
            const names = new Set<string>();
            let cur = ctx.pine?.[ns];
            while (cur && cur !== Object.prototype && cur !== Function.prototype) {
                for (const key of Object.getOwnPropertyNames(cur)) names.add(key);
                cur = Object.getPrototypeOf(cur);
            }
            // A namespace the runtime does not have at all is left out: it cannot be judged member by member.
            if (names.size > 0) out.set(ns, names);
        }
        return out;
    })();
    return members;
}

export interface UnsupportedReference {
    /** `namespace.member` as written in the script. */
    name: string;
    line: number;
    column: number;
}

/** References to runtime namespaces whose member the runtime lacks. One entry per distinct name. */
export async function findUnsupported(source: string): Promise<UnsupportedReference[]> {
    const known = await runtimeMembers();
    const code = stripCommentsAndStrings(source);
    const seen = new Set<string>();
    const out: UnsupportedReference[] = [];
    const lines = code.split('\n');
    // A user variable can shadow a namespace name (`line = line.new(...)` is fine, `array = …` is not a
    // namespace use). Only `name.member` with no identifier character or dot before `name` counts.
    const pattern = /(?<![A-Za-z0-9_.])([a-z_]+)\.([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let ln = 0; ln < lines.length; ln++) {
        for (const m of lines[ln].matchAll(pattern)) {
            const set = known.get(m[1]);
            if (!set || set.has(m[2])) continue;
            const name = `${m[1]}.${m[2]}`;
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({ name, line: ln + 1, column: (m.index ?? 0) + 1 });
        }
    }
    return out;
}
