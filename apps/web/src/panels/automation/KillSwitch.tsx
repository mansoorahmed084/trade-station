import { useState } from 'react';
import { killSwitch, resumeTrading, useAutomation } from '../../lib/automation-store.ts';
import { Button, Modal } from '../../ui.tsx';

/** Always in the status bar: halt everything automatic, cancel every order, optionally close every position. */
export function KillSwitch() {
    const halt = useAutomation((s) => s.halt);
    const [open, setOpen] = useState(false);
    const [flatten, setFlatten] = useState(true);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    if (halt) {
        return (
            <span className="kill-halted" data-testid="halted">
                <b>HALTED</b>
                <button type="button" className="link" onClick={() => void resumeTrading().catch(() => {})}>
                    Resume
                </button>
            </span>
        );
    }
    return (
        <>
            <button
                type="button"
                className="kill-button"
                onClick={() => setOpen(true)}
                data-testid="kill-switch"
                title="Stop all automated trading and cancel every order"
            >
                Kill switch
            </button>
            {open && (
                <Modal title="Stop all trading?" onClose={() => setOpen(false)} width={440}>
                    <div className="kill-dialog" data-testid="kill-dialog">
                        <p>
                            Every strategy stops, webhooks are refused and every working order on every account is
                            cancelled. It stays that way until you resume.
                        </p>
                        <label className="check">
                            <input
                                type="checkbox"
                                checked={flatten}
                                onChange={(e) => setFlatten(e.target.checked)}
                                data-testid="kill-flatten"
                            />
                            Also close every position at the market
                        </label>
                        <label className="field">
                            <span className="field-label">Reason (for the audit log)</span>
                            <input
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="kill switch"
                            />
                        </label>
                        {result && <p className="muted">{result}</p>}
                        <div className="row end">
                            <Button variant="ghost" onClick={() => setOpen(false)}>
                                Cancel
                            </Button>
                            <Button
                                variant="danger"
                                disabled={busy}
                                data-testid="kill-confirm"
                                onClick={async () => {
                                    setBusy(true);
                                    try {
                                        const r = await killSwitch(flatten, reason || 'kill switch');
                                        setResult(
                                            `${r.cancelled} order(s) cancelled, ${r.closed} position(s) closed${r.errors.length ? `; ${r.errors.length} problem(s)` : ''}.`,
                                        );
                                        setOpen(false);
                                    } catch {
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                            >
                                {busy ? 'Stopping…' : 'Stop all trading'}
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </>
    );
}
