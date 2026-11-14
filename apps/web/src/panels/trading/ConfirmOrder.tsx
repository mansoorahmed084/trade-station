import { useTrading } from '../../lib/trading-store.ts';
import { Button, Modal } from '../../ui.tsx';

/** The question asked before an order leaves from the chart or the ladder (when confirmations are on). */
export function ConfirmOrder() {
    const confirm = useTrading((s) => s.confirm);
    const setConfirmOrders = useTrading((s) => s.setConfirmOrders);
    if (!confirm) return null;
    return (
        <Modal title={confirm.title} onClose={() => confirm.resolve(false)} width={400}>
            <div className="confirm-order" data-testid="confirm-order">
                {confirm.lines.map((line, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of lines
                    <p key={i} className={i === 0 ? 'confirm-main' : 'muted'}>
                        {line}
                    </p>
                ))}
                <div className="row end">
                    <button
                        type="button"
                        className="link"
                        onClick={() => {
                            setConfirmOrders(false);
                            confirm.resolve(true);
                        }}
                    >
                        Send, and stop asking
                    </button>
                    <span className="grow" />
                    <Button variant="ghost" onClick={() => confirm.resolve(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant={confirm.danger ? 'danger' : 'primary'}
                        onClick={() => confirm.resolve(true)}
                        autoFocus
                        data-testid="confirm-send"
                    >
                        Send
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
