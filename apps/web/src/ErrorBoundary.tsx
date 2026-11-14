import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps a failure in one panel from blanking the whole app: that panel shows the error and a retry. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
    override state = { error: null as Error | null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
        console.error(`[${this.props.name}]`, error, info.componentStack);
    }

    override render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="panel-crash" role="alert" data-testid="panel-crash">
                <b>{this.props.name} stopped working.</b>
                <span className="muted">{this.state.error.message}</span>
                <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
                    Try again
                </button>
            </div>
        );
    }
}
