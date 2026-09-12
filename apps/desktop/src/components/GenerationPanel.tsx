import type { BackendId, GenerationOptions } from '../domain/types';

interface GenerationPanelProps {
  backend: BackendId;
  profile: GenerationOptions['profile'];
  seed: number;
  steps: number;
  removeBackground: boolean;
  texture: boolean;
  textureAvailable: boolean;
  busy: boolean;
  canGenerate: boolean;
  progress?: number | null;
  progressLabel?: string | null;
  onBackendChange: (backend: BackendId) => void;
  onProfileChange: (profile: GenerationOptions['profile']) => void;
  onSeedChange: (seed: number) => void;
  onStepsChange: (steps: number) => void;
  onRemoveBackgroundChange: (enabled: boolean) => void;
  onTextureChange: (enabled: boolean) => void;
  onGenerate: () => void;
}

const backendLabels: Record<BackendId, string> = {
  'native-rocm': 'Native ROCm / TheRock',
  'wsl-rocm': 'WSL2 ROCm',
  vulkan: 'Vulkan (experimental)',
};

export function GenerationPanel({
  backend,
  profile,
  seed,
  steps,
  removeBackground,
  texture,
  textureAvailable,
  busy,
  canGenerate,
  progress,
  progressLabel,
  onBackendChange,
  onProfileChange,
  onSeedChange,
  onStepsChange,
  onRemoveBackgroundChange,
  onTextureChange,
  onGenerate,
}: GenerationPanelProps) {
  const backendReady = backend === 'native-rocm';
  const progressValue = Math.min(100, Math.max(0, progress ?? 0));

  return (
    <section className="panel generation-panel" aria-labelledby="generation-heading">
      <div className="panel-heading">
        <div>
          <h2 id="generation-heading">Generation</h2>
          <p>Hunyuan3D 2 Mini · shape + optional paint stage</p>
        </div>
      </div>

      <label className="field">
        <span>Backend</span>
        <select value={backend} onChange={(event) => onBackendChange(event.target.value as BackendId)}>
          {Object.entries(backendLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      <div className={`backend-note ${backendReady ? 'ready' : 'warning'}`}>
        {backendReady
          ? 'Native ROCm worker is executable in this MVP. The app will not switch backends behind your back.'
          : `${backendLabels[backend]} is not executable in this MVP yet. No silent fallback will be applied.`}
      </div>

      <label className="field">
        <span>Quality profile</span>
        <select
          value={profile}
          onChange={(event) => onProfileChange(event.target.value as GenerationOptions['profile'])}
        >
          <option value="fast">Fast</option>
          <option value="balanced">Balanced</option>
          <option value="quality">Quality</option>
        </select>
      </label>

      <div className="field-grid">
        <label className="field">
          <span>Steps</span>
          <input
            type="number"
            min={8}
            max={80}
            value={steps}
            onChange={(event) => onStepsChange(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>Seed</span>
          <input
            type="number"
            min={0}
            value={seed}
            onChange={(event) => onSeedChange(Number(event.target.value))}
          />
        </label>
      </div>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={removeBackground}
          onChange={(event) => onRemoveBackgroundChange(event.target.checked)}
        />
        <span>
          <strong>Remove background</strong>
          <small>Uses Hunyuan preprocessing when available.</small>
        </span>
      </label>

      <label className="toggle-row">
        <input
          type="checkbox"
          checked={texture}
          disabled={!textureAvailable}
          aria-label="Generate texture"
          onChange={(event) => onTextureChange(event.target.checked)}
        />
        <span>
          <strong>Generate texture</strong>
          <small>
            {textureAvailable
              ? 'Hunyuan Paint runs as a separate stage with CPU offload on 16 GB VRAM.'
              : 'Texture runtime is not ready. Install the AMD texture extensions first.'}
          </small>
        </span>
      </label>

      <button
        type="button"
        className="primary-button"
        disabled={!canGenerate || !backendReady || busy}
        onClick={onGenerate}
      >
        {busy ? 'Generating…' : texture ? 'Generate shape + texture' : 'Generate shape'}
      </button>

      {busy && (
        <div className="generation-progress" aria-live="polite">
          <div className="generation-progress-copy">
            <span>{progressLabel ?? 'Working…'}</span>
            <strong>{Math.round(progressValue)}%</strong>
          </div>
          <div
            className="generation-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressValue)}
            aria-label="Generation progress"
          >
            <span style={{ width: `${progressValue}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}
