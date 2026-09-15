import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken page from blanking the whole app: React unmounts the entire tree on an uncaught render or
 * effect error, which shows as an empty white screen until a refresh. The boundary shows what went wrong and offers
 * a reload; `resetKey` (the current path) resets it on navigation so the next page renders normally.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[bitripay] page error', error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" style={{ margin: 16 }}>
        <h3 style={{ marginTop: 0 }}>This page hit a problem</h3>
        <p className="small muted" style={{ overflowWrap: 'anywhere' }}>
          {this.state.error.message || String(this.state.error)}
        </p>
        <div className="row wrap">
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button className="btn secondary" type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
