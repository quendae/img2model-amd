import { textureProfileDescriptions, textureProfileLabels } from '../domain/textureProfiles';
import type {
  BackendId,
  CleanupAdvancedOverrides,
  CleanupPreset,
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
  meshInputPath?: string | null;
  cleanupPreset?: CleanupPreset;
  cleanupConfigLabel?: string;
  cleanupOverrides?: CleanupAdvancedOverrides;
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
  onCleanupPresetChange?: (preset: CleanupPreset) => void;
  onCleanupOverridesChange?: (overrides: CleanupAdvancedOverrides) => void;
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
const cleanupPresets: CleanupPreset[] = ['off', 'light', 'game-ready', 'aggressive'];
const cleanupPresetLabels: Record<CleanupPreset, string> = {
  off: 'Off',
  light: 'Light',
  'game-ready': 'Game-ready',
  aggressive: 'Aggressive',
};

const cleanupDefaults: Record<CleanupPreset, Required<Pick<CleanupAdvancedOverrides,
  'remove_small_islands' | 'weld_vertices' | 'spike_cleanup' | 'smooth_surface' | 'smoothing_iterations' | 'recompute_normals' | 'min_component_area_ratio'
>>> = {
  off: {
    remove_small_islands: false,
    weld_vertices: false,
    spike_cleanup: false,
    smooth_surface: false,
    smoothing_iterations: 0,
    recompute_normals: false,
    min_component_area_ratio: 0,
  },
  light: {
    remove_small_islands: true,
    weld_vertices: true,
    spike_cleanup: false,
    smooth_surface: false,
    smoothing_iterations: 0,
    recompute_normals: true,
    min_component_area_ratio: 0.00001,
  },
  'game-ready': {
    remove_small_islands: true,
    weld_vertices: true,
    spike_cleanup: true,
    smooth_surface: true,
    smoothing_iterations: 2,
    recompute_normals: true,
    min_component_area_ratio: 0.0005,
  },
  aggressive: {
    remove_small_islands: true,
    weld_vertices: true,
    spike_cleanup: true,
    smooth_surface: true,
    smoothing_iterations: 4,
    recompute_normals: true,
    min_component_area_ratio: 0.002,
  },
};

export function GenerationPanel({
  backend,
  workflowMode,
  outputMode,
  profile,
  textureProfile,
  textureEngine,
  textureMeshPath,
  meshInputPath = null,
  cleanupPreset = 'light',
  cleanupConfigLabel = 'Light',
  cleanupOverrides = {},
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
  onCleanupPresetChange = () => {},
  onCleanupOverridesChange = () => {},
  onSeedChange,
  onStepsChange,
  onRemoveBackgroundChange,
  onChooseMesh,
  onGenerate,
}: GenerationPanelProps) {
  const backendReady = backend === 'native-rocm';
  const progressValue = Math.min(100, Math.max(0, progress ?? 0));
  const textureRequested = workflowMode === 'texture' || (workflowMode === 'shape' && outputMode === 'model-and-texture');
  const cleanupVisible = workflowMode === 'shape' || workflowMode === 'mesh';
  const missingTextureRuntime = textureRequested && !textureAvailable;
  const missingMesh = workflowMode === 'texture'
    ? !textureMeshPath
    : workflowMode === 'mesh'
      ? !meshInputPath
      : false;
  const actionLabel = workflowMode === 'texture'
    ? 'Generate texture'
    : workflowMode === 'mesh'
      ? 'Process mesh'
      : outputMode === 'model-and-texture'
        ? 'Generate model + texture'
        : 'Generate model';
  const backendRequired = workflowMode !== 'mesh';
  const actionDisabled = !canGenerate
    || (backendRequired && !backendReady)
    || busy
    || missingTextureRuntime
    || missingMesh;
  const selectedDefaults = cleanupDefaults[cleanupPreset];
  const cleanupValue = <K extends keyof typeof selectedDefaults>(key: K): (typeof selectedDefaults)[K] => (
    cleanupOverrides[key] as (typeof selectedDefaults)[K] | undefined
  ) ?? selectedDefaults[key];
  const setCleanupOverride = <K extends keyof CleanupAdvancedOverrides>(key: K, value: CleanupAdvancedOverrides[K]) => {
    onCleanupOverridesChange({ ...cleanupOverrides, [key]: value });
  };

  return (
    <section className="panel generation-panel" aria-labelledby="generation-heading">
      <div className="panel-heading">
        <div>
          <h2 id="generation-heading">Generation</h2>
          <p>Hunyuan3D 2 Mini · separate shape, mesh and texture jobs</p>
        </div>
      </div>

      <div className="mode-tabs" role="tablist" aria-label="Generation mode">
        {(['shape', 'texture', 'mesh'] as WorkflowMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={workflowMode === mode}
            className={workflowMode === mode ? 'active' : ''}
            disabled={busy}
            onClick={() => onWorkflowModeChange(mode)}
          >
            {mode === 'shape' ? 'Shape' : mode === 'texture' ? 'Texture' : 'Mesh'}
          </button>
        ))}
      </div>

      {workflowMode !== 'mesh' && (
        <>
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
        </>
      )}

      {workflowMode === 'shape' && (
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
      )}

      {workflowMode === 'texture' && (
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

      {workflowMode === 'mesh' && (
        <div className="field">
          <span>Existing model</span>
          <div className="mesh-picker">
            <div title={meshInputPath ?? undefined}>{meshInputPath ?? 'No GLB / OBJ selected'}</div>
            <button type="button" className="secondary-button" disabled={busy} onClick={onChooseMesh}>
              Choose model
            </button>
          </div>
        </div>
      )}

      {cleanupVisible && (
        <div className="field">
          <span>Mesh cleanup</span>
          <div className="segmented-control" aria-label="Mesh cleanup preset">
            {cleanupPresets.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={cleanupPreset === value}
                className={cleanupPreset === value ? 'active' : ''}
                disabled={busy}
                onClick={() => onCleanupPresetChange(value)}
              >
                {cleanupPresetLabels[value]}
              </button>
            ))}
          </div>
          <small>{cleanupConfigLabel}</small>
          {cleanupPreset === 'aggressive' && (
            <div className="backend-note warning">Aggressive cleanup may alter silhouette and fine detail.</div>
          )}

          {workflowMode === 'mesh' && (
            <details className="cleanup-advanced">
              <summary>Advanced</summary>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(cleanupValue('remove_small_islands'))}
                  onChange={(event) => setCleanupOverride('remove_small_islands', event.target.checked)}
                />
                <span>Remove small islands</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(cleanupValue('weld_vertices'))}
                  onChange={(event) => setCleanupOverride('weld_vertices', event.target.checked)}
                />
                <span>Weld nearby vertices</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(cleanupValue('spike_cleanup'))}
                  onChange={(event) => setCleanupOverride('spike_cleanup', event.target.checked)}
                />
                <span>Spike cleanup</span>
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(cleanupValue('smooth_surface'))}
                  onChange={(event) => setCleanupOverride('smooth_surface', event.target.checked)}
                />
                <span>Smooth surface</span>
              </label>
              <label className="field">
                <span>Smoothing iterations</span>
                <input
                  type="number"
                  min={0}
                  max={20}
                  value={Number(cleanupValue('smoothing_iterations'))}
                  onChange={(event) => setCleanupOverride('smoothing_iterations', Number(event.target.value))}
                />
              </label>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={Boolean(cleanupValue('recompute_normals'))}
                  onChange={(event) => setCleanupOverride('recompute_normals', event.target.checked)}
                />
                <span>Recompute normals</span>
              </label>
              <label className="field">
                <span>Minimum component size</span>
                <input
                  type="number"
                  min={0}
                  max={0.25}
                  step={0.00001}
                  value={Number(cleanupValue('min_component_area_ratio'))}
                  onChange={(event) => setCleanupOverride('min_component_area_ratio', Number(event.target.value))}
                />
              </label>
            </details>
          )}
        </div>
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

      {workflowMode !== 'mesh' && (
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
      )}

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
