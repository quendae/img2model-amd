import type { BackendId, GenerationOptions } from '../domain/types';

interface GenerationPanelProps {
  backend: BackendId;
  profile: GenerationOptions['profile'];
  seed: number;
  steps: number;
  removeBackground: boolean;
  busy: boolean;
  canGenerate: boolean;
  onBackendChange: (backend: BackendId) => void;
  onProfileChange: (profile: GenerationOptions['profile']) => void;
  onSeedChange: (seed: number) => void;
  onStepsChange: (steps: number) => void;
  onRemoveBackgroundChange: (enabled: boolean) => void;
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
  busy,
  canGenerate,
  onBackendChange,
  onProfileChange,
  onSeedChange,
  onStepsChange,
  onRemoveBackgroundChange,
  onGenerate,
}: GenerationPanelProps) {
  const backendReady = backend === 'native-rocm';

  return (
    <section className="panel generation-panel" aria-labelledby="generation-heading">
      <div className="panel-heading">
        <div>
          <h2 id="generation-heading">Generation</h2>
          <p>Hunyuan3D 2 Mini · shape-first pipeline</p>
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

      <button
        type="button"
        className="primary-button"
        disabled={!canGenerate || !backendReady || busy}
        onClick={onGenerate}
      >
        {busy ? 'Generating…' : 'Generate shape'}
      </button>
    </section>
  );
}
