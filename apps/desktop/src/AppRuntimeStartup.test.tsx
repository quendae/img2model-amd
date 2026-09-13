// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  useRuntimeStartup: vi.fn(),
  useGenerationJob: vi.fn(),
  getSystemDiagnostics: vi.fn(),
}));

vi.mock('./components/InputPanel', () => ({
  InputPanel: () => <div data-testid="input-panel" />,
}));

vi.mock('./components/GenerationPanel', () => ({
  GenerationPanel: () => <div data-testid="generation-panel" />,
}));

vi.mock('./components/ModelViewer', () => ({
  ModelViewer: () => <div data-testid="model-viewer" />,
}));

vi.mock('./components/DiagnosticsPanel', () => ({
  DiagnosticsPanel: (props: any) => (
    <div data-testid="diagnostics-panel">
      <span data-testid="manual-health-prop">{String(Boolean(props.onHealthCheck))}</span>
      <span data-testid="runtime-phase-prop">{props.runtimePhase ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('./lib/useRuntimeStartup', () => ({
  useRuntimeStartup: mocks.useRuntimeStartup,
}));

vi.mock('./lib/useGenerationJob', () => ({
  useGenerationJob: mocks.useGenerationJob,
}));

vi.mock('./lib/tauri', () => ({
  chooseInputImage: vi.fn(),
  chooseInputMesh: vi.fn(),
  chooseOutputModel: vi.fn(),
  getSystemDiagnostics: mocks.getSystemDiagnostics,
  getHunyuanHealth: vi.fn(),
  getHunyuanTextureHealth: vi.fn(),
  restartHunyuanWorker: vi.fn(),
  clearHunyuanWorkerCache: vi.fn(),
  localAssetUrl: (path: string) => path,
}));

function jobState() {
  return {
    busy: false,
    progress: null,
    message: 'Ready.',
    error: null,
    technicalError: null,
    resultPath: null,
    preservedShapePath: null,
    cleanedShapePath: null,
    retryContext: null,
    timingSummary: null,
    workerNeedsRestart: false,
    runShapeWorkflow: vi.fn(),
    runTextureWorkflow: vi.fn(),
    runMeshWorkflow: vi.fn(),
    retryTexture: vi.fn(),
    retryTextureSafe: vi.fn(),
    clearError: vi.fn(),
    setStatusMessage: vi.fn(),
    resetForNewInput: vi.fn(),
    markWorkerRestarted: vi.fn(),
  };
}

describe('App runtime startup integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemDiagnostics.mockResolvedValue({
      os: 'windows',
      arch: 'x86_64',
      wslAvailable: false,
      amdGpus: ['AMD Radeon RX 6950 XT'],
    });
    mocks.useGenerationJob.mockReturnValue(jobState());
    mocks.useRuntimeStartup.mockReturnValue({
      phase: 'ready',
      health: {
        ok: true,
        python: 'python.exe',
        torch_available: true,
        hunyuan_available: true,
        torch_version: '2.13.0',
        hip_version: '7.15',
        device_name: 'AMD Radeon RX 6950 XT',
        error: null,
      },
      textureHealth: {
        ok: true,
        texgen_available: true,
        custom_rasterizer_available: true,
        mesh_processor_available: true,
        texture_import_ok: true,
        error: null,
      },
      shapeCacheReady: true,
      shapePreloadMs: 17000,
      error: null,
      initialize: vi.fn(),
      ensureShapePreloaded: vi.fn(),
      markShapeEvicted: vi.fn(),
    });
  });

  afterEach(() => cleanup());

  it('uses automatic runtime state and no longer exposes a manual health-check contract', () => {
    render(<App />);

    expect(mocks.useRuntimeStartup).toHaveBeenCalled();
    expect(screen.getByText('Hunyuan3D ready')).toBeTruthy();
    expect(screen.getByTestId('manual-health-prop').textContent).toBe('false');
    expect(screen.getByTestId('runtime-phase-prop').textContent).toBe('ready');
  });

  it('renders the desktop controls as a dedicated two-column control rail', () => {
    render(<App />);

    const rail = screen.getByTestId('control-rail');
    expect(rail.className).toContain('control-rail');
    expect(rail.querySelectorAll('.control-column')).toHaveLength(2);
    expect(rail.querySelector('[data-testid="input-panel"]')).toBeTruthy();
    expect(rail.querySelector('[data-testid="generation-panel"]')).toBeTruthy();
  });
});
