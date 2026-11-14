import type { BacktestProperties, BacktestResult, InputMeta } from '@ts/backtest/api';
import { choiceKey, type InputValues, useTester } from '../../lib/tester-store.ts';
import { Button, Field, Modal } from '../../ui.tsx';

const numberOrUndefined = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

function InputField({ meta, value, onChange }: { meta: InputMeta; value: unknown; onChange: (v: unknown) => void }) {
    if (meta.type === 'bool') {
        return (
            <label className="check">
                <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
                {meta.title}
            </label>
        );
    }
    if (meta.options?.length) {
        return (
            <Field label={meta.title}>
                <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
                    {meta.options.map((o) => (
                        <option key={String(o)} value={String(o)}>
                            {String(o)}
                        </option>
                    ))}
                </select>
            </Field>
        );
    }
    if (meta.type === 'int' || meta.type === 'float') {
        return (
            <Field label={meta.title}>
                <input
                    type="number"
                    value={value === undefined ? '' : Number(value)}
                    min={meta.min}
                    max={meta.max}
                    step={meta.step ?? (meta.type === 'int' ? 1 : 'any')}
                    onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
                />
            </Field>
        );
    }
    return (
        <Field label={meta.title}>
            <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </Field>
    );
}

/** Inputs and account settings of the strategy under test. Every change re-runs the test. */
export function TesterSettings({ onClose }: { onClose: () => void }) {
    const choice = useTester((s) => s.choice);
    const description = useTester((s) => s.description);
    const result = useTester((s) => s.result);
    const values = useTester((s) => s.inputs[choiceKey(s.choice)]) ?? {};
    const properties = useTester((s) => s.properties);
    const setInputs = useTester((s) => s.setInputs);
    const patch = useTester((s) => s.patch);

    const inputs = description?.inputs ?? result?.inputs ?? [];
    const pine = choice.kind !== 'native';
    const used: Partial<BacktestResult['properties']> = result?.properties ?? {};
    const setProp = (change: Partial<BacktestProperties>) => {
        const next = { ...properties, ...change };
        for (const key of Object.keys(next) as (keyof BacktestProperties)[])
            if (next[key] === undefined) delete next[key];
        patch({ properties: next });
    };
    const setInput = (name: string, v: unknown) => {
        const next: InputValues = { ...values };
        if (v === undefined) delete next[name];
        else next[name] = v as number | boolean | string;
        setInputs(next);
    };
    // For a Pine strategy an empty field means "what the script declares"; show that value as the hint.
    const hint = (v: unknown) => (pine ? `Script: ${v ?? '—'}` : `Default: ${v ?? '—'}`);

    return (
        <Modal title="Strategy settings" onClose={onClose} width={560}>
            <div className="tester-settings" data-testid="tester-settings">
                <section>
                    <h4>Inputs</h4>
                    {inputs.length === 0 && <p className="muted">This strategy has no inputs.</p>}
                    <div className="grid-2">
                        {inputs.map((meta) => (
                            <InputField
                                key={meta.name}
                                meta={meta}
                                value={values[meta.name] ?? meta.defval}
                                onChange={(v) => setInput(meta.name, v)}
                            />
                        ))}
                    </div>
                    {Object.keys(values).length > 0 && (
                        <Button variant="ghost" onClick={() => setInputs({})}>
                            Reset inputs
                        </Button>
                    )}
                </section>
                <section>
                    <h4>Properties</h4>
                    <div className="grid-2">
                        <Field label="Initial capital" hint={hint(used.initialCapital)}>
                            <input
                                type="number"
                                min={1}
                                placeholder={String(used.initialCapital ?? '')}
                                value={properties.initialCapital ?? ''}
                                onChange={(e) => setProp({ initialCapital: numberOrUndefined(e.target.value) })}
                            />
                        </Field>
                        <Field label="Slippage (ticks)" hint={hint(used.slippageTicks)}>
                            <input
                                type="number"
                                min={0}
                                step={1}
                                placeholder={String(used.slippageTicks ?? '')}
                                value={properties.slippageTicks ?? ''}
                                onChange={(e) => setProp({ slippageTicks: numberOrUndefined(e.target.value) })}
                            />
                        </Field>
                        <Field
                            label="Order size"
                            hint={hint(used.qty ? `${used.qty.value} ${used.qty.type}` : undefined)}
                        >
                            <div className="row">
                                <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    className="grow"
                                    placeholder={String(used.qty?.value ?? '')}
                                    value={properties.qty?.value ?? ''}
                                    onChange={(e) => {
                                        const value = numberOrUndefined(e.target.value);
                                        setProp({
                                            qty:
                                                value === undefined
                                                    ? undefined
                                                    : {
                                                          type:
                                                              properties.qty?.type ??
                                                              used.qty?.type ??
                                                              'percent_of_equity',
                                                          value,
                                                      },
                                        });
                                    }}
                                />
                                <select
                                    value={properties.qty?.type ?? used.qty?.type ?? 'percent_of_equity'}
                                    onChange={(e) =>
                                        setProp({
                                            qty: {
                                                type: e.target.value as any,
                                                value: properties.qty?.value ?? used.qty?.value ?? 10,
                                            },
                                        })
                                    }
                                >
                                    <option value="percent_of_equity">% of equity</option>
                                    <option value="cash">Cash</option>
                                    <option value="fixed">Units</option>
                                </select>
                            </div>
                        </Field>
                        <Field
                            label="Commission"
                            hint={hint(
                                used.commission ? `${used.commission.value} ${used.commission.type}` : undefined,
                            )}
                        >
                            <div className="row">
                                <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    className="grow"
                                    placeholder={String(used.commission?.value ?? '')}
                                    value={properties.commission?.value ?? ''}
                                    onChange={(e) => {
                                        const value = numberOrUndefined(e.target.value);
                                        setProp({
                                            commission:
                                                value === undefined
                                                    ? undefined
                                                    : {
                                                          type:
                                                              properties.commission?.type ??
                                                              used.commission?.type ??
                                                              'percent',
                                                          value,
                                                      },
                                        });
                                    }}
                                />
                                <select
                                    value={properties.commission?.type ?? used.commission?.type ?? 'percent'}
                                    onChange={(e) =>
                                        setProp({
                                            commission: {
                                                type: e.target.value as any,
                                                value: properties.commission?.value ?? used.commission?.value ?? 0,
                                            },
                                        })
                                    }
                                >
                                    <option value="percent">%</option>
                                    <option value="cash_per_order">Per order</option>
                                    <option value="cash_per_contract">Per unit</option>
                                </select>
                            </div>
                        </Field>
                        <Field label="Pyramiding (entries per side)" hint={hint(used.pyramiding)}>
                            <input
                                type="number"
                                min={1}
                                max={100}
                                step={1}
                                placeholder={String(used.pyramiding ?? '')}
                                value={properties.pyramiding ?? ''}
                                onChange={(e) => setProp({ pyramiding: numberOrUndefined(e.target.value) })}
                            />
                        </Field>
                    </div>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={properties.processOrdersOnClose ?? used.processOrdersOnClose ?? false}
                            onChange={(e) => setProp({ processOrdersOnClose: e.target.checked })}
                        />
                        Fill market orders at the close of the bar that placed them
                    </label>
                    <label className="check">
                        <input
                            type="checkbox"
                            checked={!!properties.barMagnifier}
                            onChange={(e) => setProp({ barMagnifier: e.target.checked || undefined })}
                        />
                        Bar magnifier: decide fills from smaller bars inside each chart bar
                    </label>
                    {pine && properties.barMagnifier && (
                        <p className="muted">
                            The Pine runtime fills from the chart bar alone; the magnifier applies to built-in
                            strategies.
                        </p>
                    )}
                    {Object.keys(properties).length > 0 && (
                        <Button variant="ghost" onClick={() => patch({ properties: {} })}>
                            Reset properties
                        </Button>
                    )}
                </section>
                <div className="row end">
                    <Button variant="primary" onClick={onClose}>
                        Done
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
