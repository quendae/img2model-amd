import { textureProfileDescriptions, textureProfileLabels } from '../domain/textureProfiles';
import type {
  BackendId,
  GenerationOptions,
  ShapeOutputMode,
  TextureEngineId,
  TextureProfile,
  WorkflowMode,
} from '../domain/types';

interface GenerationPanelProps {
  backend: BackendId;
  workflowMode: WorkflowMode;
  outputMode: ShapeOutputMode;
  profile: GenerationOptions['profile'];
  textureProfile: TextureProfile;
  textureEngine: TextureEngineId;
  textureMeshPath: string | null;
  seed: number;
  steps: number;
  removeBackground: boolean;
  textureAvailable: boolean;
  busy: boolean;
  canGenerate: boolean;
  progress?: number | null;
  progressLabel?: string | null;
  onBackendChange: (backend: BackendId) => void;
  onWorkflowModeChange: (mode: WorkflowMode) => void;
  onShapeOutputModeChange: (mode: ShapeOutputMode) => void;
  onProfileChange: (profile: GenerationOptions['profile']) => void;
  onTextureProfileChange: (profile: TextureProfile) => void;
  onSeedChange: (seed: number) => void;
  onStepsChange: (steps: number) => void;
  onRemoveBackgroundChange: (enabled: boolean) => void;
  onChooseMesh: () => void;
  onGenerate: () => void;
}

const backendLabels: Record<BackendId, string> = {
  'native-rocm': 'Native ROCm / TheRock',
  'wsl-rocm': 'WSL2 ROCm',
  vulkan: 'Vulkan (experimental)',
};

const textureProfiles: TextureProfile[] = ['auto', 'safe', 'balanced', 'quality'];

export function GenerationPanel({
  backend,
  workflowMode,
  outputMode,
  profile,
  textureProfile,
  textureEngine,
  textureMeshPath,
  seed,
  steps,
  removeBackground,
  textureAvailable,
  busy,
  canGenerate,
  progress,
  progressLabel,
  onBackendChange,
  onWorkflowModeChange,
  onShapeOutputModeChange,
  onProfileChange,
  onTextureProfileChange,
  onSeedChange,
  onStepsChange,
  onRemoveBackgroundChange,
  onChooseMesh,
  onGenerate,
}: GenerationPanelProps) {
  const backendReady = backend === 'native-rocm';
  const progressValue = Math.min(100, Math.max(0, progress ?? 0));
  const textureRequested = workflowMode === 'texture' || outputMode === 'model-and-texture';
  const missingTextureRuntime = textureRequested && !textureAvailable;
  const missingMesh = workflowMode === 'texture' && !textureMeshPath;
  const actionLabel = workflowMode === 'texture'
    ? 'Generate texture'
    : outputMode === 'model-and-texture'
      ? 'Generate model + texture'
      : 'Generate model';
  const actionDisabled = !canGenerate || !backendReady || busy || missingTextureRuntime || missingMesh;

  return (
    <section className="panel generation-panel" aria-labelledby="generation-heading">
      <div className="panel-heading">
        <div>
          <h2 id="generation-heading">Generation</h2>
          <p>Hunyuan3D 2 Mini · separate shape and texture jobs</p>
        </div>
      </div>

      <div className="mode-tabs" role="tablist" aria-label="Generation mode">
        <button
          type="button"
          role="tab"
          aria-selected={workflowMode === 'shape'}
          className={workflowMode === 'shape' ? 'active' : ''}
          disabled={busy}
          onClick={() => onWorkflowModeChange('shape')}
        >
          Shape
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workflowMode === 'texture'}
          className={workflowMode === 'texture' ? 'active' : ''}
          disabled={busy}
          onClick={() => onWorkflowModeChange('texture')}
        >
          Texture
        </button>
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
          ? 'Native ROCm worker is executable. No silent backend fallback will be applied.'
          : `${backendLabels[backend]} is not executable in this workflow yet. No silent fallback will be applied.`}
      </div>

      {workflowMode === 'shape' ? (
        <>
          <label className="field">
            <span>Shape quality</span>
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

          <div className="field">
            <span>Output</span>
            <div className="segmented-control" aria-label="Shape output">
              <button
                type="button"
                aria-pressed={outputMode === 'model-only'}
                className={outputMode === 'model-only' ? 'active' : ''}
                onClick={() => onShapeOutputModeChange('model-only')}
              >
                Model only
              </button>
              <button
                type="button"
                aria-pressed={outputMode === 'model-and-texture'}
                className={outputMode === 'model-and-texture' ? 'active' : ''}
                disabled={!textureAvailable}
                onClick={() => onShapeOutputModeChange('model-and-texture')}
              >
                Model + texture
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>Texture engine</span>
            <select value={textureEngine} disabled aria-label="Texture engine">
              <option value="hunyuan-paint">Hunyuan Paint</option>
            </select>
          </label>

          <div className="field">
            <span>Existing model</span>
            <div className="mesh-picker">
              <div title={textureMeshPath ?? undefined}>{textureMeshPath ?? 'No GLB / OBJ selected'}</div>
              <button type="button" className="secondary-button" disabled={busy} onClick={onChooseMesh}>
                Choose model
              </button>
            </div>
          </div>
        </>
      )}

      {textureRequested && (
        <div className="field">
          <span>Texture profile</span>
          <div className="texture-profile-grid">
            {textureProfiles.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={textureProfile === value}
                className={textureProfile === value ? 'active' : ''}
                onClick={() => onTextureProfileChange(value)}
              >
                <strong>{textureProfileLabels[value]}</strong>
                <small>{textureProfileDescriptions[value]}</small>
              </button>
            ))}
          </div>
          {!textureAvailable && (
            <div className="backend-note warning">Texture runtime is not ready. Install the AMD texture extensions first.</div>
          )}
        </div>
      )}

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
        disabled={actionDisabled}
        onClick={onGenerate}
      >
        {busy ? 'Generating…' : actionLabel}
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
