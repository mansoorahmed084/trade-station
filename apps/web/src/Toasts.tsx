import { useAlerts } from './lib/alerts-store.ts';

/** Notifications stacked in the corner: fired alerts, and later order fills. */
export function Toasts() {
    const toasts = useAlerts((s) => s.toasts);
    const dismiss = useAlerts((s) => s.dismiss);
    if (toasts.length === 0) return null;
    return (
        <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
                <div key={t.id} className={`toast toast-${t.kind}`} data-testid="toast">
                    <div className="toast-head">
                        <span>{t.title}</span>
                        <button type="button" className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                            ×
                        </button>
                    </div>
                    <div className="toast-text">{t.text}</div>
                </div>
            ))}
        </div>
    );
}
