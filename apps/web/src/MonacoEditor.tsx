import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { PINE, registerPine } from './lib/pine-language.ts';

export interface EditorMarker {
    message: string;
    line: number;
    column?: number;
    severity: 'error' | 'warning';
}

interface Props {
    /** Changing this swaps the document (and resets undo history). */
    docId: string;
    value: string;
    markers: EditorMarker[];
    onChange: (value: string) => void;
    onSave: () => void;
    onRun: () => void;
    /** Receives a function that moves the cursor to a line. */
    onReady?: (reveal: (line: number, column?: number) => void) => void;
}

let loader: Promise<typeof Monaco> | null = null;

/** Monaco is large: it is fetched the first time an editor is shown, never at app start. */
function loadMonaco(): Promise<typeof Monaco> {
    loader ??= (async () => {
        const [monaco, { default: EditorWorker }, builtins] = await Promise.all([
            import('monaco-editor'),
            import('monaco-editor/editor/editor.worker?worker'),
            fetch('/api/scripts/builtins')
                .then((r) => (r.ok ? r.json() : {}))
                .catch(() => ({})),
        ]);
        (self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
        registerPine(monaco, builtins);
        return monaco;
    })();
    return loader;
}

export function MonacoEditor({ docId, value, markers, onChange, onSave, onRun, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof Monaco | null>(null);
    const handlers = useRef({ onChange, onSave, onRun });
    handlers.current = { onChange, onSave, onRun };
    const [failed, setFailed] = useState<string | null>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let disposed = false;
        loadMonaco()
            .then((monaco) => {
                if (disposed || !host.current) return;
                monacoRef.current = monaco;
                const ed = monaco.editor.create(host.current, {
                    value: '',
                    language: PINE,
                    theme: 'ts-dark',
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    tabSize: 4,
                    insertSpaces: true,
                    scrollBeyondLastLine: false,
                    renderLineHighlight: 'line',
                    wordWrap: 'off',
                    fixedOverflowWidgets: true,
                });
                editor.current = ed;
                // Handles for end-to-end tests and for poking at the editor from the console.
                (window as any).__tsEditor = ed;
                (window as any).__tsMonaco = monaco;
                ed.onDidChangeModelContent(() => handlers.current.onChange(ed.getValue()));
                ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave());
                ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun());
                onReady?.((line, column = 1) => {
                    ed.revealLineInCenter(line);
                    ed.setPosition({ lineNumber: line, column });
                    ed.focus();
                });
                setReady(true);
            })
            .catch((err) => !disposed && setFailed(err?.message ?? 'could not load the editor'));
        return () => {
            disposed = true;
            editor.current?.getModel()?.dispose();
            editor.current?.dispose();
            editor.current = null;
        };
        // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once
    }, []);

    // Swap documents without recreating the editor.
    // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is read when the document changes, not on every keystroke
    useEffect(() => {
        const ed = editor.current;
        if (!ed || !ready) return;
        if (ed.getValue() !== value) {
            ed.setValue(value);
            ed.setScrollTop(0);
        }
    }, [docId, ready]);

    // An external change to the text (reverting, importing) while the document id stays the same.
    useEffect(() => {
        const ed = editor.current;
        if (ed && ready && ed.getValue() !== value) ed.setValue(value);
    }, [value, ready]);

    useEffect(() => {
        const monaco = monacoRef.current;
        const model = editor.current?.getModel();
        if (!monaco || !model || !ready) return;
        monaco.editor.setModelMarkers(
            model,
            'pine',
            markers.map((m) => {
                const line = Math.min(Math.max(1, m.line), model.getLineCount());
                return {
                    message: m.message,
                    severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                    startLineNumber: line,
                    endLineNumber: line,
                    startColumn: m.column ?? 1,
                    endColumn: m.column ? m.column + 1 : model.getLineMaxColumn(line),
                };
            }),
        );
    }, [markers, ready]);

    if (failed) return <div className="notice">The editor failed to load: {failed}</div>;
    return (
        <div className="monaco-host" ref={host} data-testid="pine-editor">
            {!ready && <div className="notice">Loading editor…</div>}
        </div>
    );
}
