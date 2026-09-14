import type { SystemDiagnostics, TextureHealth, WorkerHealth } from '../domain/types';
import type { RuntimePhase } from '../lib/useRuntimeStartup';

interface DiagnosticsPanelProps {
  diagnostics: SystemDiagnostics | null;
  health: WorkerHealth | null;
  textureHealth: TextureHealth | null;
  runtimePhase: RuntimePhase;
  loading: boolean;
  onRefresh: () => void;
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`status-dot ${ok ? 'ok' : 'off'}`} aria-hidden="true" />;
}

function phaseLabel(phase: RuntimePhase): string {
  if (phase === 'ready') return 'Ready';
  if (phase === 'preloading') return 'Loading Shape';
  if (phase === 'checking') return 'Checking';
  if (phase === 'error') return 'Error';
  return 'Starting';
}

export function DiagnosticsPanel({
  diagnostics,
  health,
  textureHealth,
  runtimePhase,
  loading,
  onRefresh,
}: DiagnosticsPanelProps) {
  const showStartupSurface = !health && (runtimePhase === 'starting' || runtimePhase === 'checking');

  return (
    <>
      {showStartupSurface && (
        <div
          className="runtime-startup-surface"
          role="status"
          aria-label="Preparing AMD runtime"
          aria-live="polite"
        >
          <div className="runtime-startup-card">
            <span className="runtime-startup-spinner" aria-hidden="true" />
            <strong>Preparing AMD runtime</strong>
            <span>Checking Radeon and Python runtime…</span>
            <div className="runtime-startup-progress" aria-hidden="true"><span /></div>
          </div>
        </div>
      )}

      <section className="panel diagnostics-panel" aria-labelledby="diagnostics-heading">
        <div className="panel-heading compact">
          <div>
            <h2 id="diagnostics-heading">Runtime</h2>
            <p>Automatic worker and model startup</p>
          </div>
          <button type="button" className="icon-button" onClick={onRefresh} disabled={loading} title="Refresh diagnostics">
            ↻
          </button>
        </div>

        <div className="runtime-health">
          <div className="health-title">
            <strong>{health?.device_name ?? diagnostics?.amdGpus[0] ?? 'AMD runtime'}</strong>
            <span className={runtimePhase === 'ready' ? 'health-ok' : 'health-off'}>{phaseLabel(runtimePhase)}</span>
          </div>
          <div className="health-details runtime-summary">
            <span><StatusDot ok={Boolean(health?.ok)} />ROCm / Hunyuan Shape</span>
            <span><StatusDot ok={Boolean(textureHealth?.ok)} />Hunyuan Paint {textureHealth?.ok ? 'ready' : 'lazy / unavailable'}</span>
          </div>
        </div>

        <details className="runtime-details">
          <summary>Runtime details</summary>
          <dl className="diagnostics-list">
            <div>
              <dt>GPU</dt>
              <dd>{diagnostics?.amdGpus.length ? diagnostics.amdGpus.join(', ') : health?.device_name ?? 'No AMD GPU reported yet'}</dd>
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
              <dd>{health?.python ?? diagnostics?.python ?? 'Not resolved'}</dd>
            </div>
            <div>
              <dt>PyTorch</dt>
              <dd>{health?.torch_available ? health.torch_version ?? 'found' : 'Not reported'}</dd>
            </div>
            <div>
              <dt>HIP</dt>
              <dd>{health?.hip_version ?? 'Not detected'}</dd>
            </div>
          </dl>
          {health?.error && <p className="error-copy">{health.error}</p>}
          {textureHealth?.error && <p className="error-copy">{textureHealth.error}</p>}
        </details>
      </section>
    </>
  );
}
