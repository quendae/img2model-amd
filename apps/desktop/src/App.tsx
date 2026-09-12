import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { GenerationPanel } from './components/GenerationPanel';
import { InputPanel } from './components/InputPanel';
import { ModelViewer } from './components/ModelViewer';
import type {
  BackendId,
  GenerationOptions,
  SystemDiagnostics,
  TextureHealth,
  WorkerHealth,
} from './domain/types';
import {
  chooseInputImage,
  chooseOutputModel,
  generateShape,
  getHunyuanHealth,
  getHunyuanTextureHealth,
  getSystemDiagnostics,
  localAssetUrl,
  textureMesh,
  type WorkerProgressEvent,
} from './lib/tauri';

const profileSteps: Record<GenerationOptions['profile'], number> = {
  fast: 20,
  balanced: 30,
  quality: 50,
};

type GenerationPhase = 'shape' | 'texture';

interface GenerationProgress {
  phase: GenerationPhase;
  value: number;
  label: string;
}

const stageLabels: Record<string, string> = {
  starting_backend: 'Starting AMD backend…',
  preparing_input: 'Preparing source image…',
  loading_model: 'Loading Hunyuan model…',
  running_shape: 'Generating 3D shape…',
  preparing_mesh: 'Preparing mesh for texturing…',
  mesh_ready: 'Texture mesh is ready…',
  running_texture: 'Generating Hunyuan Paint texture…',
  postprocessing: 'Exporting model…',
  completed: 'Generation complete.',
};

function addSuffixBeforeExtension(path: string, suffix: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= separator) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

function clampProgress(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function progressLabel(phase: GenerationPhase, event: WorkerProgressEvent): string {
  if (event.stage === 'mesh_ready' && typeof event.faces_after === 'number') {
    return `Texture mesh ready · ${event.faces_after.toLocaleString()} triangles`;
  }
  if (event.stage && stageLabels[event.stage]) return stageLabels[event.stage];
  return phase === 'shape' ? 'Generating 3D shape…' : 'Generating texture…';
}

function combinedProgress(phase: GenerationPhase, event: WorkerProgressEvent, includesTexture: boolean): GenerationProgress {
  const raw = clampProgress(event.progress);
  const value = includesTexture
    ? phase === 'shape'
      ? raw * 0.4
      : 0.4 + raw * 0.6
    : raw;

  return {
    phase,
    value,
    label: progressLabel(phase, event),
  };
}

export function App() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendId>('native-rocm');
  const [profile, setProfile] = useState<GenerationOptions['profile']>('balanced');
  const [seed, setSeed] = useState(1234);
  const [steps, setSteps] = useState(profileSteps.balanced);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [texture, setTexture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [health, setHealth] = useState<WorkerHealth | null>(null);
  const [textureHealth, setTextureHealth] = useState<TextureHealth | null>(null);
  const [message, setMessage] = useState('Choose a source image to begin.');
  const [error, setError] = useState<string | null>(null);

  const previewUrl = useMemo(() => (inputPath ? localAssetUrl(inputPath) : null), [inputPath]);
  const modelUrl = useMemo(() => (modelPath ? localAssetUrl(modelPath) : null), [modelPath]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await getSystemDiagnostics());
    } catch (reason) {
      setError(`Diagnostics failed: ${String(reason)}`);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  const checkHealth = async () => {
    setHealthLoading(true);
    setError(null);
    try {
      const result = await getHunyuanHealth();
      setHealth(result);

      try {
        const textureResult = await getHunyuanTextureHealth();
        setTextureHealth(textureResult);
        if (!textureResult.ok) setTexture(false);
        setMessage(
          result.ok
            ? textureResult.ok
              ? 'Hunyuan shape and texture runtimes are ready.'
              : 'Hunyuan shape is ready; texture extensions still need setup.'
            : 'Hunyuan runtime needs setup or repair.',
        );
      } catch (textureReason) {
        setTextureHealth(null);
        setTexture(false);
        setMessage(result.ok ? 'Hunyuan shape is ready; texture runtime is not available.' : 'Hunyuan runtime needs setup or repair.');
        if (!result.ok) setError(String(textureReason));
      }
    } catch (reason) {
      setHealth(null);
      setTextureHealth(null);
      setTexture(false);
      setError(String(reason));
    } finally {
      setHealthLoading(false);
    }
  };

  const chooseImage = async () => {
    const path = await chooseInputImage();
    if (!path) return;
    setInputPath(path);
    setModelPath(null);
    setError(null);
    setMessage('Source image loaded. Choose settings and generate a shape.');
  };

  const changeProfile = (nextProfile: GenerationOptions['profile']) => {
    setProfile(nextProfile);
    setSteps(profileSteps[nextProfile]);
  };

  const runGeneration = async () => {
    if (!inputPath || backend !== 'native-rocm') return;
    const output = await chooseOutputModel();
    if (!output) return;

    const shapeOutput = texture ? addSuffixBeforeExtension(output, '-shape') : output;
    let preservedShapePath: string | null = null;

    const updateProgress = (phase: GenerationPhase) => (event: WorkerProgressEvent) => {
      if (event.event === 'error') return;
      const next = combinedProgress(phase, event, texture);
      setGenerationProgress(next);
      setMessage(next.label);
    };

    setBusy(true);
    setGenerationProgress({ phase: 'shape', value: 0, label: 'Starting Hunyuan shape generation…' });
    setError(null);
    setMessage('Starting Hunyuan shape generation…');
    try {
      const result = await generateShape({
        backend,
        input: inputPath,
        output: shapeOutput,
        model: 'tencent/Hunyuan3D-2mini',
        subfolder: 'hunyuan3d-dit-v2-mini',
        steps,
        seed,
        removeBackground,
      }, updateProgress('shape'));

      if (!result.ok) {
        setError(result.error ?? 'Generation failed without an error message.');
        setMessage('Generation failed.');
        return;
      }

      preservedShapePath = result.output ?? shapeOutput;
      setModelPath(preservedShapePath);

      if (!texture) {
        setGenerationProgress({ phase: 'shape', value: 1, label: 'Shape complete.' });
        setMessage(`Shape completed: ${preservedShapePath}`);
        return;
      }

      if (!textureHealth?.ok) {
        setError(`Texture runtime is not healthy. Shape was preserved at: ${preservedShapePath}`);
        setMessage('Shape completed; texture stage was skipped.');
        return;
      }

      setGenerationProgress({ phase: 'texture', value: 0.4, label: 'Starting Hunyuan Paint texture stage…' });
      setMessage('Shape completed. Starting Hunyuan Paint texture stage…');
      const textureResult = await textureMesh({
        backend,
        mesh: preservedShapePath,
        image: inputPath,
        output,
        model: 'tencent/Hunyuan3D-2',
        subfolder: 'hunyuan3d-paint-v2-0-turbo',
        cpuOffload: true,
        removeBackground,
      }, updateProgress('texture'));

      if (!textureResult.ok) {
        setError(
          `${textureResult.error ?? 'Texture generation failed without an error message.'}\n\nShape preserved at: ${preservedShapePath}`,
        );
        setMessage('Shape completed; texture stage failed.');
        return;
      }

      const texturedPath = textureResult.output ?? output;
      setModelPath(texturedPath);
      setGenerationProgress({ phase: 'texture', value: 1, label: 'Shape + texture complete.' });
      setMessage(`Shape + texture completed: ${texturedPath}`);
    } catch (reason) {
      if (preservedShapePath) {
        setError(`${String(reason)}\n\nShape preserved at: ${preservedShapePath}`);
        setMessage('Texture stage failed; shape output was preserved.');
      } else {
        setError(String(reason));
        setMessage('Generation failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const progressPercent = busy && generationProgress
    ? Math.round(generationProgress.value * 100)
    : null;
  const progressLabelText = busy ? generationProgress?.label ?? null : null;

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
              setMessage('Choose a source image to begin.');
            }}
          />
          <GenerationPanel
            backend={backend}
            profile={profile}
            seed={seed}
            steps={steps}
            removeBackground={removeBackground}
            texture={texture}
            textureAvailable={Boolean(textureHealth?.ok)}
            busy={busy}
            canGenerate={Boolean(inputPath)}
            progress={progressPercent}
            progressLabel={progressLabelText}
            onBackendChange={setBackend}
            onProfileChange={changeProfile}
            onSeedChange={setSeed}
            onStepsChange={setSteps}
            onRemoveBackgroundChange={setRemoveBackground}
            onTextureChange={setTexture}
            onGenerate={runGeneration}
          />
        </aside>

        <ModelViewer
          modelUrl={modelUrl}
          busy={busy}
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
              <span className={`activity-indicator ${busy ? 'working' : ''}`} aria-hidden="true" />
              <span>{message}</span>
            </div>
            {error && <pre className="error-box">{error}</pre>}
            <div className="activity-meta">
              <span>Model</span><strong>Hunyuan3D 2 Mini</strong>
              <span>Output</span><strong>GLB / OBJ</strong>
              <span>Texture</span><strong>{textureHealth?.ok ? 'Hunyuan Paint ready' : 'Optional · runtime not ready'}</strong>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
