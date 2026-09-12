import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { GenerationPanel } from './components/GenerationPanel';
import { InputPanel } from './components/InputPanel';
import { ModelViewer } from './components/ModelViewer';
import type {
  BackendId,
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, '0')}` : `${seconds}s`;
}

export function App() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [textureMeshPath, setTextureMeshPath] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendId>('native-rocm');
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('shape');
  const [shapeOutputMode, setShapeOutputMode] = useState<ShapeOutputMode>('model-only');
  const [profile, setProfile] = useState<GenerationOptions['profile']>('balanced');
  const [textureProfile, setTextureProfile] = useState<TextureProfile>('auto');
  const [textureEngine] = useState<TextureEngineId>('hunyuan-paint');
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
    setDiagnosticError(null);
    job.resetForNewInput('Source image loaded. Choose settings and start generation.');
  };

  const chooseMesh = async () => {
    const path = await chooseInputMesh();
    if (!path) return;
    setTextureMeshPath(path);
    setModelPath(path);
    job.setStatusMessage('Existing model selected. Choose a texture profile and generate texture.');
  };

  const changeProfile = (nextProfile: GenerationOptions['profile']) => {
    setProfile(nextProfile);
    setSteps(profileSteps[nextProfile]);
  };

  const runGeneration = async () => {
    if (!inputPath || backend !== 'native-rocm') return;
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
      });
      return;
    }

    if (!textureMeshPath) return;
    await job.runTextureWorkflow({
      backend,
      engine: textureEngine,
      profile: textureProfile,
      mesh: textureMeshPath,
      image: inputPath,
      output,
      removeBackground,
    });
  };

  const openTextureForCurrentModel = () => {
    const mesh = job.preservedShapePath ?? job.resultPath ?? modelPath;
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
  const canTextureCurrentModel = Boolean(
    workflowMode === 'shape'
      && inputPath
      && job.preservedShapePath
      && job.resultPath === job.preservedShapePath
      && !job.busy,
  );

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
            seed={seed}
            steps={steps}
            removeBackground={removeBackground}
            textureAvailable={Boolean(textureHealth?.ok)}
            busy={job.busy}
            canGenerate={Boolean(inputPath)}
            progress={progressPercent}
            progressLabel={progressLabelText}
            onBackendChange={setBackend}
            onWorkflowModeChange={setWorkflowMode}
            onShapeOutputModeChange={setShapeOutputMode}
            onProfileChange={changeProfile}
            onTextureProfileChange={setTextureProfile}
            onSeedChange={setSeed}
            onStepsChange={setSteps}
            onRemoveBackgroundChange={setRemoveBackground}
            onChooseMesh={chooseMesh}
            onGenerate={runGeneration}
          />
        </aside>

        <ModelViewer
          modelUrl={modelUrl}
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
              {timing?.textureMs !== undefined && <><span>Texture</span><strong>{formatDuration(timing.textureMs)}</strong></>}
              {timing && <><span>Total</span><strong>{formatDuration(timing.totalMs)}</strong></>}
              {timing?.cacheHit !== undefined && (
                <>
                  <span>Cache</span>
                  <strong>{timing.cacheHit ? 'hit' : 'miss'}{timing.cacheKind ? ` · ${timing.cacheKind}` : ''}</strong>
                </>
              )}
              {timing?.meshCacheHit !== undefined && (
                <>
                  <span>Prep cache</span>
                  <strong>{timing.meshCacheHit ? 'hit' : 'miss'}</strong>
                </>
              )}
              {timing?.modelLoadMs !== undefined && <><span>Load</span><strong>{formatDuration(timing.modelLoadMs)}</strong></>}
              {timing?.preprocessMs !== undefined && <><span>Prep</span><strong>{formatDuration(timing.preprocessMs)}</strong></>}
              {inferenceMs !== undefined && <><span>Inference</span><strong>{formatDuration(inferenceMs)}</strong></>}
              {timing?.exportMs !== undefined && <><span>Export</span><strong>{formatDuration(timing.exportMs)}</strong></>}
              {timing?.trianglesBefore !== undefined && timing.trianglesAfter !== undefined && (
                <>
                  <span>Mesh</span>
                  <strong>{timing.trianglesBefore.toLocaleString()} → {timing.trianglesAfter.toLocaleString()} triangles</strong>
                </>
              )}
              {timing?.resolvedTextureProfile && (
                <><span>Profile</span><strong>{timing.resolvedTextureProfile}</strong></>
              )}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
