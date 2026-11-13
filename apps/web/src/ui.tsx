import { type ButtonHTMLAttributes, type ReactNode, useEffect } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                props.onClose();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [props.onClose]);
    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
            <div className="modal" style={{ width: props.width ?? 460 }} role="dialog" aria-label={props.title}>
                <div className="modal-head">
                    <span>{props.title}</span>
                    <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
                        ×
                    </button>
                </div>
                <div className="modal-body">{props.children}</div>
            </div>
        </div>
    );
}

export function Button({
    variant,
    className,
    ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost' }) {
    return <button type="button" {...rest} className={`btn ${variant ? `btn-${variant}` : ''} ${className ?? ''}`} />;
}

export function Tabs<T extends string>(props: {
    tabs: { id: T; label: string }[];
    value: T;
    onChange: (id: T) => void;
}) {
    return (
        <div className="tabs" role="tablist">
            {props.tabs.map((t) => (
                <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={props.value === t.id}
                    className={`tab ${props.value === t.id ? 'tab-on' : ''}`}
                    onClick={() => props.onChange(t.id)}
                >
                    {t.label}
                </button>
            ))}
        </div>
    );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
    return (
        <label className="field">
            <span className="field-label">{props.label}</span>
            {props.children}
            {props.hint && <span className="field-hint">{props.hint}</span>}
        </label>
    );
}
