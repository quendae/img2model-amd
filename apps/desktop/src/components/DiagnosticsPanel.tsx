import type { SystemDiagnostics, WorkerHealth } from '../domain/types';

interface DiagnosticsPanelProps {
  diagnostics: SystemDiagnostics | null;
  health: WorkerHealth | null;
  loading: boolean;
  healthLoading: boolean;
  onRefresh: () => void;
  onHealthCheck: () => void;
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`status-dot ${ok ? 'ok' : 'off'}`} aria-hidden="true" />;
}

export function DiagnosticsPanel({
  diagnostics,
  health,
  loading,
  healthLoading,
  onRefresh,
  onHealthCheck,
}: DiagnosticsPanelProps) {
  return (
    <section className="panel diagnostics-panel" aria-labelledby="diagnostics-heading">
      <div className="panel-heading compact">
        <div>
          <h2 id="diagnostics-heading">Runtime</h2>
          <p>Host and Hunyuan health</p>
        </div>
        <button type="button" className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh diagnostics">
          ↻
        </button>
      </div>

      <dl className="diagnostics-list">
        <div>
          <dt>GPU</dt>
          <dd>{diagnostics?.amdGpus.length ? diagnostics.amdGpus.join(', ') : 'No AMD GPU reported yet'}</dd>
        </div>
        <div>
          <dt>OS</dt>
          <dd>{diagnostics ? `${diagnostics.os} · ${diagnostics.arch}` : '—'}</dd>
        </div>
        <div>
          <dt>WSL2</dt>
          <dd><StatusDot ok={Boolean(diagnostics?.wslAvailable)} />{diagnostics?.wslAvailable ? 'Detected' : 'Not detected'}</dd>
        </div>
        <div>
          <dt>Python</dt>
          <dd>{diagnostics?.python ?? 'Not resolved'}</dd>
        </div>
      </dl>

      <div className="runtime-health">
        <div className="health-title">
          <strong>Hunyuan worker</strong>
          <span className={health?.ok ? 'health-ok' : 'health-off'}>{health?.ok ? 'Ready' : 'Not ready'}</span>
        </div>
        {health ? (
          <div className="health-details">
            <span>PyTorch {health.torch_available ? health.torch_version ?? 'found' : 'missing'}</span>
            <span>HIP {health.hip_version ?? 'not detected'}</span>
            <span>{health.device_name ?? 'No ROCm device reported'}</span>
            {health.error && <span className="error-copy">{health.error}</span>}
          </div>
        ) : (
          <p className="muted-copy">Run a health check against the configured AMD Python environment.</p>
        )}
        <button type="button" className="secondary-button full" onClick={onHealthCheck} disabled={healthLoading}>
          {healthLoading ? 'Checking…' : 'Check Hunyuan runtime'}
        </button>
      </div>
    </section>
  );
}
