import { Component, type ErrorInfo, type ReactNode } from 'react';
import { DIAGNOSTIC_LOG_PATH_HINT, writeDiagnosticLog } from '../lib/diagnosticLog';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void writeDiagnosticLog('error', 'react', error.message || 'React render error', {
      name: error.name,
      stack: error.stack ?? null,
      componentStack: info.componentStack ?? null,
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app-shell">
        <main
          role="alert"
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '32px',
            background: '#101216',
            color: '#f4f5f7',
          }}
        >
          <section className="panel" style={{ width: 'min(760px, 100%)', padding: '28px' }}>
            <h1 style={{ marginTop: 0 }}>Interface error</h1>
            <p>
              Img2Model AMD caught an unexpected interface error instead of closing the UI.
              The worker may still be running.
            </p>
            <pre className="error-box" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</pre>
            <p style={{ marginBottom: 0 }}>
              Diagnostic log: <code>{DIAGNOSTIC_LOG_PATH_HINT}</code>
            </p>
          </section>
        </main>
      </div>
    );
  }
}
