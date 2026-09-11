import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { GenerationPanel } from './components/GenerationPanel';
import { InputPanel } from './components/InputPanel';
import { ModelViewer } from './components/ModelViewer';
import type { BackendId, GenerationOptions, SystemDiagnostics, WorkerHealth } from './domain/types';
import {
  chooseInputImage,
  chooseOutputModel,
  generateShape,
  getHunyuanHealth,
  getSystemDiagnostics,
  localAssetUrl,
} from './lib/tauri';

const profileSteps: Record<GenerationOptions['profile'], number> = {
  fast: 20,
  balanced: 30,
  quality: 50,
};

export function App() {
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendId>('native-rocm');
  const [profile, setProfile] = useState<GenerationOptions['profile']>('balanced');
  const [seed, setSeed] = useState(1234);
  const [steps, setSteps] = useState(profileSteps.balanced);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [busy, setBusy] = useState(false);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [health, setHealth] = useState<WorkerHealth | null>(null);
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
      setMessage(result.ok ? 'Hunyuan runtime is ready.' : 'Hunyuan runtime needs setup or repair.');
    } catch (reason) {
      setHealth(null);
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

    setBusy(true);
    setError(null);
    setMessage('Running Hunyuan shape generation…');
    try {
      const result = await generateShape({
        backend,
        input: inputPath,
        output,
        model: 'tencent/Hunyuan3D-2mini',
        subfolder: 'hunyuan3d-dit-v2-mini',
        steps,
        seed,
        removeBackground,
      });

      if (!result.ok) {
        setError(result.error ?? 'Generation failed without an error message.');
        setMessage('Generation failed.');
        return;
      }

      const generatedPath = result.output ?? output;
      setModelPath(generatedPath);
      setMessage(`Completed: ${generatedPath}`);
    } catch (reason) {
      setError(String(reason));
      setMessage('Generation failed.');
    } finally {
      setBusy(false);
    }
  };

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
            busy={busy}
            canGenerate={Boolean(inputPath)}
            onBackendChange={setBackend}
            onProfileChange={changeProfile}
            onSeedChange={setSeed}
            onStepsChange={setSteps}
            onRemoveBackgroundChange={setRemoveBackground}
            onGenerate={runGeneration}
          />
        </aside>

        <ModelViewer modelUrl={modelUrl} busy={busy} />

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
              <span>Texture</span><strong>Shape only (MVP)</strong>
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}
