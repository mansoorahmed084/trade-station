import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useState } from 'react';
import {
    type ChartTypeParams,
    type DerivedStyle,
    isDerived,
    refreshChartTypes,
    STYLE_LABEL,
} from '../lib/chart-types.ts';
import type { ServerClient } from '../lib/client.ts';
import { useParams } from '../lib/params.ts';
import { Button, Field, Modal } from '../ui.tsx';

const SIZE_LABEL: Record<Exclude<DerivedStyle, 'linebreak'>, string> = {
    renko: 'Box size',
    kagi: 'Reversal amount',
    pnf: 'Box size',
    range: 'Range',
};

export function ChartTypeDialog({
    client,
    workspace,
    onClose,
}: {
    client: ServerClient;
    workspace: VelaWorkspace;
    onClose: () => void;
}) {
    const cell: any = workspace.active;
    const style: string = cell?.requestedPriceStyle ?? cell?.priceStyle ?? '';
    const saved = useParams((s) => s.chartTypes);
    const setSaved = useParams((s) => s.setChartTypes);
    const [draft, setDraft] = useState<ChartTypeParams>(saved);

    if (!isDerived(style)) {
        return (
            <Modal title="Chart type settings" onClose={onClose}>
                <p className="muted">
                    Pick Renko, Line break, Kagi, Point &amp; figure or Range from the chart style menu first.
                </p>
            </Modal>
        );
    }

    const num = (v: string, min: number) => Math.max(min, Number(v) || min);
    const apply = () => {
        setSaved(client, draft);
        refreshChartTypes(workspace, draft);
        onClose();
    };

    return (
        <Modal title={`${STYLE_LABEL[style]} settings`} onClose={onClose} width={400}>
            {style === 'linebreak' ? (
                <Field
                    label="Number of lines"
                    hint="A reversal needs the close to pass the extreme of this many lines."
                >
                    <input
                        className="text"
                        type="number"
                        min={1}
                        max={10}
                        value={draft.linebreak.lines}
                        onChange={(e) =>
                            setDraft({ ...draft, linebreak: { lines: Math.round(num(e.target.value, 1)) } })
                        }
                    />
                </Field>
            ) : (
                <>
                    <Field label={`${SIZE_LABEL[style]} from`}>
                        <select
                            className="text"
                            value={draft[style].mode}
                            onChange={(e) =>
                                setDraft({
                                    ...draft,
                                    [style]: { ...draft[style], mode: e.target.value as 'atr' | 'fixed' },
                                })
                            }
                        >
                            <option value="atr">Average True Range (adapts to the symbol)</option>
                            <option value="fixed">A fixed price amount</option>
                        </select>
                    </Field>
                    {draft[style].mode === 'atr' ? (
                        <Field
                            label="ATR length"
                            hint="Measured over the loaded history when the series is first built."
                        >
                            <input
                                className="text"
                                type="number"
                                min={1}
                                max={200}
                                value={draft[style].atr}
                                onChange={(e) =>
                                    setDraft({
                                        ...draft,
                                        [style]: { ...draft[style], atr: Math.round(num(e.target.value, 1)) },
                                    })
                                }
                            />
                        </Field>
                    ) : (
                        <Field label={`${SIZE_LABEL[style]} (price units)`}>
                            <input
                                className="text"
                                type="number"
                                min={0}
                                step="any"
                                value={draft[style].size}
                                onChange={(e) =>
                                    setDraft({
                                        ...draft,
                                        [style]: { ...draft[style], size: num(e.target.value, 1e-8) },
                                    })
                                }
                            />
                        </Field>
                    )}
                    {style === 'pnf' && (
                        <Field label="Reversal (boxes)">
                            <input
                                className="text"
                                type="number"
                                min={1}
                                max={10}
                                value={draft.pnf.reversal}
                                onChange={(e) =>
                                    setDraft({
                                        ...draft,
                                        pnf: { ...draft.pnf, reversal: Math.round(num(e.target.value, 1)) },
                                    })
                                }
                            />
                        </Field>
                    )}
                </>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={apply}>
                    Apply
                </Button>
            </div>
        </Modal>
    );
}
