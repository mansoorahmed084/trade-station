import type * as Monaco from 'monaco-editor';

export const PINE = 'pine';

const KEYWORDS = [
    'if',
    'else',
    'for',
    'to',
    'by',
    'in',
    'while',
    'switch',
    'var',
    'varip',
    'import',
    'export',
    'as',
    'type',
    'enum',
    'method',
    'not',
    'and',
    'or',
    'true',
    'false',
    'na',
    'continue',
    'break',
    'return',
];
const TYPES = [
    'int',
    'float',
    'bool',
    'string',
    'color',
    'line',
    'label',
    'box',
    'table',
    'array',
    'matrix',
    'map',
    'series',
    'simple',
    'const',
    'linefill',
    'polyline',
];
const SERIES = [
    'open',
    'high',
    'low',
    'close',
    'volume',
    'time',
    'time_close',
    'hl2',
    'hlc3',
    'ohlc4',
    'hlcc4',
    'bar_index',
    'last_bar_index',
    'timenow',
];
const DECLARATIONS = [
    'indicator',
    'strategy',
    'library',
    'plot',
    'plotshape',
    'plotchar',
    'plotarrow',
    'plotcandle',
    'plotbar',
    'hline',
    'fill',
    'bgcolor',
    'barcolor',
    'alert',
    'alertcondition',
    'nz',
    'fixnan',
    'timestamp',
];

let registered = false;

/** Teach Monaco Pine Script: colouring, comments and brackets, and completion from the runtime's own built-ins. */
export function registerPine(monaco: typeof Monaco, builtins: Record<string, string[]>): void {
    if (registered) return;
    registered = true;
    const namespaces = Object.keys(builtins);

    monaco.languages.register({ id: PINE, extensions: ['.pine'], aliases: ['Pine Script'] });
    monaco.languages.setLanguageConfiguration(PINE, {
        comments: { lineComment: '//' },
        brackets: [
            ['(', ')'],
            ['[', ']'],
        ],
        autoClosingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '"', close: '"', notIn: ['string'] },
            { open: "'", close: "'", notIn: ['string'] },
        ],
        surroundingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '"', close: '"' },
        ],
        indentationRules: {
            increaseIndentPattern: /^\s*(if|else|for|while|switch|type|enum|method)\b.*$|=>\s*$/,
            decreaseIndentPattern: /^\s*else\b/,
        },
    });
    monaco.languages.setMonarchTokensProvider(PINE, {
        keywords: KEYWORDS,
        typeKeywords: TYPES,
        series: SERIES,
        declarations: DECLARATIONS,
        namespaces,
        tokenizer: {
            root: [
                [/\/\/\s*@\w+.*$/, 'annotation'],
                [/\/\/.*$/, 'comment'],
                [/"([^"\\]|\\.)*"/, 'string'],
                [/'([^'\\]|\\.)*'/, 'string'],
                [/#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b/, 'number.hex'],
                [/\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
                [/\.\d+/, 'number'],
                // `ta.ema(`  →  namespace + function
                [
                    /([a-z_]+)(\.)([A-Za-z_]\w*)(?=\s*\()/,
                    [
                        { cases: { '@namespaces': 'type.identifier', '@default': 'identifier' } },
                        'delimiter',
                        'function',
                    ],
                ],
                [
                    /([a-z_]+)(\.)([A-Za-z_]\w*)/,
                    [
                        { cases: { '@namespaces': 'type.identifier', '@default': 'identifier' } },
                        'delimiter',
                        'constant',
                    ],
                ],
                [
                    /[A-Za-z_]\w*(?=\s*\()/,
                    {
                        cases: {
                            '@keywords': 'keyword',
                            '@declarations': 'function.declaration',
                            '@typeKeywords': 'type',
                            '@default': 'function',
                        },
                    },
                ],
                [
                    /[A-Za-z_]\w*/,
                    {
                        cases: {
                            '@keywords': 'keyword',
                            '@typeKeywords': 'type',
                            '@series': 'variable.predefined',
                            '@default': 'identifier',
                        },
                    },
                ],
                [/:=|=>|==|!=|<=|>=|\+=|-=|\*=|\/=|[-+*/%<>=?:]/, 'operator'],
                [/[()[\],.]/, 'delimiter'],
            ],
        },
    });

    monaco.editor.defineTheme('ts-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'annotation', foreground: 'c586c0' },
            { token: 'comment', foreground: '6a7684' },
            { token: 'keyword', foreground: '569cd6' },
            { token: 'type', foreground: '4ec9b0' },
            { token: 'type.identifier', foreground: '4ec9b0' },
            { token: 'function', foreground: 'dcdcaa' },
            { token: 'function.declaration', foreground: 'e3b341' },
            { token: 'constant', foreground: '9cdcfe' },
            { token: 'variable.predefined', foreground: '9cdcfe' },
            { token: 'number', foreground: 'b5cea8' },
            { token: 'number.hex', foreground: 'ce9178' },
            { token: 'string', foreground: 'ce9178' },
            { token: 'operator', foreground: 'd4d4d4' },
        ],
        colors: {
            'editor.background': '#0e1116',
            'editorLineNumber.foreground': '#3d4653',
            'editorGutter.background': '#0e1116',
        },
    });

    monaco.languages.registerCompletionItemProvider(PINE, {
        triggerCharacters: ['.'],
        provideCompletionItems(model, position) {
            const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };
            const member = /(?<![A-Za-z0-9_.])([a-z_]+)\.\w*$/.exec(line);
            if (member && builtins[member[1]]) {
                return {
                    suggestions: builtins[member[1]].map((name) => ({
                        label: name,
                        kind: monaco.languages.CompletionItemKind.Function,
                        insertText: name,
                        detail: `${member[1]}.${name}`,
                        range,
                    })),
                };
            }
            const plain = [
                ...KEYWORDS.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.Keyword })),
                ...TYPES.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.TypeParameter })),
                ...SERIES.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.Variable })),
                ...DECLARATIONS.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.Function })),
                ...namespaces.map((label) => ({ label, kind: monaco.languages.CompletionItemKind.Module })),
            ];
            return { suggestions: plain.map((s) => ({ ...s, insertText: s.label, range })) };
        },
    });
}
