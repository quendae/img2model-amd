import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { GenerationPanel } from './components/GenerationPanel';
import { InputPanel } from './components/InputPanel';
import { ModelViewer } from './components/ModelViewer';
import type {
  BackendId,
  CleanupAdvancedOverrides,
  CleanupPreset,
  GenerationOptions,
  ShapeOutputMode,
  SystemDiagnostics,
  TextureEngineId,
  TextureHealth,
  TextureProfile,
  WorkerHealth,
  WorkflowMode,
} from './domain/types';
import {
  chooseInputImage,
  chooseInputMesh,
  chooseOutputModel,
  clearHunyuanWorkerCache,
  getHunyuanHealth,
  getHunyuanTextureHealth,
  getSystemDiagnostics,
  localAssetUrl,
  restartHunyuanWorker,
} from './lib/tauri';
import { useGenerationJob } from './lib/useGenerationJob';

const profileSteps: Record<GenerationOptions['profile'], number> = {
  fast: 20,
  balanced: 30,
  quality: 50,
};

const cleanupPresetLabels: Record<CleanupPreset, string> = {
  off: 'Off',
  light: 'Light',
  'game-ready': 'Game-ready',
  aggressive: 'Aggressive',
};

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
}

function cleanupLabel(preset: CleanupPreset, overrides: CleanupAdvancedOverrides): string {
  const base = cleanupPresetLabels[preset];
  return Object.keys(overrides).length > 0 ? `Custom (from ${base})` : base;
}

function cleanedOutputSuggestion(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= separator) return `${path}-clean.glb`;
  return `${path.slice(0, dot)}-clean${path.slice(dot)}`;
}

export function App() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [textureMeshPath, setTextureMeshPath] = useState<string | null>(null);
  const [meshInputPath, setMeshInputPath] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendId>('native-rocm');
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('shape');
  const [shapeOutputMode, setShapeOutputMode] = useState<ShapeOutputMode>('model-only');
  const [profile, setProfile] = useState<GenerationOptions['profile']>('balanced');
  const [textureProfile, setTextureProfile] = useState<TextureProfile>('auto');
  const [textureEngine] = useState<TextureEngineId>('hunyuan-paint');
  const [shapeCleanupPreset, setShapeCleanupPreset] = useState<CleanupPreset>('light');
  const [shapeCleanupOverrides, setShapeCleanupOverrides] = useState<CleanupAdvancedOverrides>({});
  const [meshCleanupPreset, setMeshCleanupPreset] = useState<CleanupPreset>('game-ready');
  const [meshCleanupOverrides, setMeshCleanupOverrides] = useState<CleanupAdvancedOverrides>({});
  const [seed, setSeed] = useState(1234);
  const [steps, setSteps] = useState(profileSteps.balanced);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [textureHealth, setTextureHealth] = useState<TextureHealth | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const job = useGenerationJob();

  const previewUrl = useMemo(() => (inputPath ? localAssetUrl(inputPath) : null), [inputPath]);
  const modelUrl = useMemo(() => (modelPath ? localAssetUrl(modelPath) : null), [modelPath]);
  const activeCleanupPreset = workflowMode === 'mesh' ? meshCleanupPreset : shapeCleanupPreset;
  const activeCleanupOverrides = workflowMode === 'mesh' ? meshCleanupOverrides : shapeCleanupOverrides;
  const activeCleanupLabel = cleanupLabel(activeCleanupPreset, activeCleanupOverrides);
  const canGenerate = workflowMode === 'shape'
    ? Boolean(inputPath)
    : workflowMode === 'texture'
      ? Boolean(inputPath && textureMeshPath && textureHealth?.ok)
      : Boolean(meshInputPath);

  useEffect(() => {
    if (job.resultPath) setModelPath(job.resultPath);
  }, [job.resultPath]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticError(null);
    try {
      setDiagnostics(await getSystemDiagnostics());
    } catch (reason) {
      setDiagnosticError(`Diagnostics failed: ${String(reason)}`);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  const checkHealth = async () => {
    setHealthLoading(true);
    setDiagnosticError(null);
    try {
      const result = await getHunyuanHealth();
      setHealth(result);

      try {
        const textureResult = await getHunyuanTextureHealth();
        setTextureHealth(textureResult);
        job.setStatusMessage(
          result.ok
            ? textureResult.ok
              ? 'Hunyuan shape and texture runtimes are ready.'
              : 'Hunyuan shape is ready; texture extensions still need setup.'
            : 'Hunyuan runtime needs setup or repair.',
        );
      } catch (textureReason) {
        setTextureHealth(null);
        job.setStatusMessage(
          result.ok
            ? 'Hunyuan shape is ready; texture runtime is not available.'
            : 'Hunyuan runtime needs setup or repair.',
        );
        if (!result.ok) setDiagnosticError(String(textureReason));
      }
    } catch (reason) {
      setHealth(null);
      setTextureHealth(null);
      setDiagnosticError(String(reason));
      job.setStatusMessage('Hunyuan runtime needs setup or repair.');
    } finally {
      setHealthLoading(false);
    }
  };

  const restartWorker = async () => {
    if (job.busy) return;
    setDiagnosticError(null);
    try {
      await restartHunyuanWorker();
      job.markWorkerRestarted();
      job.setStatusMessage('Worker restarted. The next job will load a fresh pipeline.');
    } catch (reason) {
      setDiagnosticError(`Worker restart failed: ${String(reason)}`);
    }
  };

  const clearWorkerCache = async () => {
    if (job.busy) return;
    setDiagnosticError(null);
    try {
      await clearHunyuanWorkerCache();
      job.setStatusMessage('Worker cache cleared. The next job will reload its pipeline.');
    } catch (reason) {
      setDiagnosticError(`Worker cache clear failed: ${String(reason)}`);
    }
  };

  const chooseImage = async () => {
    const path = await chooseInputImage();
    if (!path) return;
    setInputPath(path);
    setModelPath(null);
    setTextureMeshPath(null);
    setMeshInputPath(null);
    setDiagnosticError(null);
    job.resetForNewInput('Source image loaded. Choose settings and start generation.');
  };

  const chooseMesh = async () => {
    const path = await chooseInputMesh();
    if (!path) return;
    setModelPath(path);
    if (workflowMode === 'mesh') {
      setMeshInputPath(path);
      job.setStatusMessage('Existing model selected. Choose cleanup settings and process the mesh.');
    } else {
      setTextureMeshPath(path);
      job.setStatusMessage('Existing model selected. Choose a texture profile and generate texture.');
    }
  };

  const changeProfile = (nextProfile: GenerationOptions['profile']) => {
    setProfile(nextProfile);
    setSteps(profileSteps[nextProfile]);
  };

  const changeCleanupPreset = (preset: CleanupPreset) => {
    if (workflowMode === 'mesh') {
      setMeshCleanupPreset(preset);
      setMeshCleanupOverrides({});
    } else {
      setShapeCleanupPreset(preset);
      setShapeCleanupOverrides({});
    }
  };

  const changeCleanupOverrides = (overrides: CleanupAdvancedOverrides) => {
    if (workflowMode === 'mesh') {
      setMeshCleanupOverrides(overrides);
    } else {
      setShapeCleanupOverrides(overrides);
    }
  };

  const runGeneration = async () => {
    if (workflowMode === 'mesh') {
      if (!meshInputPath) return;
      const output = await chooseOutputModel(cleanedOutputSuggestion(meshInputPath));
      if (!output) return;
      await job.runMeshWorkflow({
        input: meshInputPath,
        output,
        preset: meshCleanupPreset,
        overrides: meshCleanupOverrides,
      });
      return;
    }

    if (!inputPath || backend !== 'native-rocm') return;
    if (workflowMode === 'texture' && (!textureMeshPath || !textureHealth?.ok)) return;
    const output = await chooseOutputModel();
    if (!output) return;

    if (workflowMode === 'shape') {
      await job.runShapeWorkflow({
        backend,
        image: inputPath,
        output,
        outputMode: shapeOutputMode,
        shapeProfile: profile,
        steps,
        seed,
        removeBackground,
        textureEngine,
        textureProfile,
        cleanupPreset: shapeCleanupPreset,
        cleanupOverrides: shapeCleanupOverrides,
      });
      return;
    }

    await job.runTextureWorkflow({
      backend,
      engine: textureEngine,
      profile: textureProfile,
      mesh: textureMeshPath!,
      image: inputPath,
      output,
      removeBackground,
    });
  };

  const openTextureForCurrentModel = () => {
    const mesh = job.cleanedShapePath ?? job.resultPath ?? job.preservedShapePath ?? modelPath;
    if (!mesh) return;
    setTextureMeshPath(mesh);
    setWorkflowMode('texture');
    job.setStatusMessage('Shape is ready for a texture-only run.');
  };

  const openRetryInTextureMode = () => {
    const context = job.retryContext;
    if (!context) return;
    setInputPath(context.image);
    setTextureMeshPath(context.mesh);
    setBackend(context.backend);
    setTextureProfile(context.profile);
    setWorkflowMode('texture');
    setModelPath(context.mesh);
    job.setStatusMessage('Failed texture job loaded in Texture mode. Adjust settings or retry.');
  };

  const progressPercent = job.busy && job.progress
    ? Math.round(job.progress.value * 100)
    : null;
  const progressLabelText = job.busy ? job.progress?.label ?? null : null;
  const displayError = job.error ?? diagnosticError;
  const timing = job.timingSummary;
  const inferenceMs = timing?.inferenceMs ?? timing?.textureStages?.running_texture;
  const hasSplitPreprocessTiming = timing?.imagePreprocessMs !== undefined || timing?.meshPreprocessMs !== undefined;
  const canTextureCurrentModel = Boolean(
    workflowMode === 'shape'
      && shapeOutputMode === 'model-only'
      && inputPath
      && (job.cleanedShapePath ?? job.resultPath ?? job.preservedShapePath)
      && !job.busy,
  );
  const meshComparison = workflowMode === 'mesh' && meshInputPath && job.cleanedShapePath
    ? {
        beforeUrl: localAssetUrl(meshInputPath),
        afterUrl: localAssetUrl(job.cleanedShapePath),
        beforeTriangles: timing?.cleanupReport?.triangles_before,
        afterTriangles: timing?.cleanupReport?.triangles_after,
      }
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-symbol" aria-hidden="true"><span /></div>
          <div>
            <h1>Img2Model AMD</h1>
            <p>Local image-to-3D for Radeon</p>
          </div>
        </div>
        <div className="header-runtime">
          <span className={`header-status ${health?.ok ? 'online' : ''}`} />
          {health?.ok ? 'ROCm worker ready' : 'Runtime not verified'}
        </div>
      </header>

      <main className="workspace">
        <aside className="left-rail">
          <InputPanel
            inputPath={inputPath}
            previewUrl={previewUrl}
            onChoose={chooseImage}
            onClear={() => {
              setInputPath(null);
              setModelPath(null);
              setTextureMeshPath(null);
              setMeshInputPath(null);
              job.resetForNewInput();
            }}
          />
          <GenerationPanel
            backend={backend}
            workflowMode={workflowMode}
            outputMode={shapeOutputMode}
            profile={profile}
            textureProfile={textureProfile}
            textureEngine={textureEngine}
            textureMeshPath={textureMeshPath}
            meshInputPath={meshInputPath}
            cleanupPreset={activeCleanupPreset}
            cleanupConfigLabel={activeCleanupLabel}
            cleanupOverrides={activeCleanupOverrides}
            seed={seed}
            steps={steps}
            removeBackground={removeBackground}
            textureAvailable={Boolean(textureHealth?.ok)}
            busy={job.busy}
            canGenerate={canGenerate}
            progress={progressPercent}
            progressLabel={progressLabelText}
            onBackendChange={setBackend}
            onWorkflowModeChange={setWorkflowMode}
            onShapeOutputModeChange={setShapeOutputMode}
            onProfileChange={changeProfile}
            onTextureProfileChange={setTextureProfile}
            onCleanupPresetChange={changeCleanupPreset}
            onCleanupOverridesChange={changeCleanupOverrides}
            onSeedChange={setSeed}
            onStepsChange={setSteps}
            onRemoveBackgroundChange={setRemoveBackground}
            onChooseMesh={chooseMesh}
            onGenerate={runGeneration}
          />
        </aside>

        <ModelViewer
          modelUrl={modelUrl}
          comparison={meshComparison}
          busy={job.busy}
          progress={progressPercent}
          progressLabel={progressLabelText}
        />

        <aside className="right-rail">
          <DiagnosticsPanel
            diagnostics={diagnostics}
            health={health}
            loading={diagnosticsLoading}
            healthLoading={healthLoading}
            onRefresh={refreshDiagnostics}
            onHealthCheck={checkHealth}
          />

          <section className="panel activity-panel" aria-labelledby="activity-heading">
            <div className="panel-heading">
              <div>
                <h2 id="activity-heading">Activity</h2>
                <p>Current job status</p>
              </div>
            </div>
            <div className="activity-line">
              <span className={`activity-indicator ${job.busy ? 'working' : ''}`} aria-hidden="true" />
              <span>{job.message}</span>
            </div>

            {displayError && <div className="error-summary">{displayError}</div>}
            {job.technicalError && (
              <details className="technical-details">
                <summary>Technical details</summary>
                <pre className="error-box">{job.technicalError}</pre>
              </details>
            )}

            {(job.workerNeedsRestart || (health?.ok && !job.busy)) && (
              <div className="worker-actions">
                {job.workerNeedsRestart && (
                  <button type="button" className="secondary-button" disabled={job.busy} onClick={() => void restartWorker()}>
                    Restart worker
                  </button>
                )}
                {health?.ok && !job.busy && (
                  <button type="button" className="ghost-button" onClick={() => void clearWorkerCache()}>
                    Clear cache
                  </button>
                )}
              </div>
            )}

            {(canTextureCurrentModel || job.retryContext) && (
              <div className="recovery-actions">
                {canTextureCurrentModel && (
                  <button type="button" className="secondary-button" onClick={openTextureForCurrentModel}>
                    Texture this model
                  </button>
                )}
                {job.retryContext && (
                  <>
                    <button type="button" className="secondary-button" disabled={job.busy} onClick={() => void job.retryTexture()}>
                      Retry texture only
                    </button>
                    {job.retryContext.profile !== 'safe' && (
                      <button type="button" className="secondary-button" disabled={job.busy} onClick={() => void job.retryTextureSafe()}>
                        Retry with Safe
                      </button>
                    )}
                    <button type="button" className="ghost-button" disabled={job.busy} onClick={openRetryInTextureMode}>
                      Open Texture mode
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="activity-meta">
              <span>Model</span><strong>Hunyuan3D 2 Mini</strong>
              <span>Output</span><strong>GLB / OBJ</strong>
              <span>Texture</span><strong>{textureHealth?.ok ? 'Hunyuan Paint ready' : 'Optional · runtime not ready'}</strong>
              {timing?.shapeMs !== undefined && <><span>Shape</span><strong>{formatDuration(timing.shapeMs)}</strong></>}
              {timing?.meshCleanupMs !== undefined && <><span>Mesh cleanup</span><strong>{formatDuration(timing.meshCleanupMs)}</strong></>}
              {timing?.textureMs !== undefined && <><span>Texture</span><strong>{formatDuration(timing.textureMs)}</strong></>}
              {timing && <><span>Total</span><strong>{formatDuration(timing.totalMs)}</strong></>}
              {timing?.cacheHit !== undefined && (
                <>
                  <span>Cache</span>
                  <strong>{timing.cacheHit ? 'hit' : 'miss'}{timing.cacheKind ? ` · ${timing.cacheKind}` : ''}</strong>
                </>
              )}
              {timing?.cleanupCacheHit !== undefined && (
                <>
                  <span>Cleanup cache</span>
                  <strong>{timing.cleanupCacheHit ? 'hit' : 'miss'}</strong>
                </>
              )}
              {timing?.imageCacheHit !== undefined && (
                <>
                  <span>Image cache</span>
                  <strong>{timing.imageCacheHit ? 'hit' : 'miss'}</strong>
                </>
              )}
              {timing?.meshCacheHit !== undefined && (
                <>
                  <span>Mesh cache</span>
                  <strong>{timing.meshCacheHit ? 'hit' : 'miss'}</strong>
                </>
              )}
              {timing?.modelLoadMs !== undefined && <><span>Load</span><strong>{formatDuration(timing.modelLoadMs)}</strong></>}
              {timing?.imagePreprocessMs !== undefined && <><span>Image prep</span><strong>{formatDuration(timing.imagePreprocessMs)}</strong></>}
              {timing?.meshPreprocessMs !== undefined && <><span>Mesh prep</span><strong>{formatDuration(timing.meshPreprocessMs)}</strong></>}
              {!hasSplitPreprocessTiming && timing?.preprocessMs !== undefined && <><span>Prep</span><strong>{formatDuration(timing.preprocessMs)}</strong></>}
              {inferenceMs !== undefined && <><span>Inference</span><strong>{formatDuration(inferenceMs)}</strong></>}
              {timing?.exportMs !== undefined && <><span>Export</span><strong>{formatDuration(timing.exportMs)}</strong></>}
              {timing?.trianglesBefore !== undefined && timing.trianglesAfter !== undefined && (
                <>
                  <span>Mesh</span>
                  <strong>{timing.trianglesBefore.toLocaleString()} → {timing.trianglesAfter.toLocaleString()} triangles</strong>
                </>
              )}
              {timing?.cleanupReport && (
                <>
                  <span>Cleanup preset</span>
                  <strong>{timing.cleanupReport.config_label}</strong>
                  <span>Triangles</span>
                  <strong>{timing.cleanupReport.triangles_before.toLocaleString()} → {timing.cleanupReport.triangles_after.toLocaleString()}</strong>
                  <span>Vertices</span>
                  <strong>{timing.cleanupReport.vertices_before.toLocaleString()} → {timing.cleanupReport.vertices_after.toLocaleString()}</strong>
                  <span>Components</span>
                  <strong>{timing.cleanupReport.components_before.toLocaleString()} → {timing.cleanupReport.components_after.toLocaleString()}</strong>
                  <span>Components removed</span>
                  <strong>{(timing.cleanupReport.components_removed ?? 0).toLocaleString()}</strong>
                  <span>Vertices welded</span>
                  <strong>{(timing.cleanupReport.vertices_welded ?? 0).toLocaleString()}</strong>
                  <span>Spikes adjusted</span>
                  <strong>{(timing.cleanupReport.spikes_adjusted ?? 0).toLocaleString()}</strong>
                  <span>Algorithm</span>
                  <strong>{timing.cleanupReport.algorithm_version}</strong>
                </>
              )}
              {timing?.resolvedTextureProfile && (
                <><span>Profile</span><strong>{timing.resolvedTextureProfile}</strong></>
              )}
            </div>

            {timing?.cleanupReport?.warnings?.map((warning) => (
              <div key={warning} className="backend-note warning">{warning}</div>
            ))}
          </section>
        </aside>
      </main>
    </div>
  );
}
