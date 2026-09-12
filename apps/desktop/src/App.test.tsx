// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  restartHunyuanWorker: vi.fn(),
  clearHunyuanWorkerCache: vi.fn(),
  getSystemDiagnostics: vi.fn(),
  getHunyuanHealth: vi.fn(),
  getHunyuanTextureHealth: vi.fn(),
  useGenerationJob: vi.fn(),
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
  DiagnosticsPanel: ({ onHealthCheck }: { onHealthCheck: () => void }) => (
    <button type="button" onClick={onHealthCheck}>Check health</button>
  ),
}));

vi.mock('./lib/tauri', () => ({
  chooseInputImage: vi.fn(),
  chooseInputMesh: vi.fn(),
  chooseOutputModel: vi.fn(),
  getSystemDiagnostics: mocks.getSystemDiagnostics,
  getHunyuanHealth: mocks.getHunyuanHealth,
  getHunyuanTextureHealth: mocks.getHunyuanTextureHealth,
  restartHunyuanWorker: mocks.restartHunyuanWorker,
  clearHunyuanWorkerCache: mocks.clearHunyuanWorkerCache,
  localAssetUrl: (path: string) => path,
}));

vi.mock('./lib/useGenerationJob', () => ({
  useGenerationJob: mocks.useGenerationJob,
}));

function jobState(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    progress: null,
    message: 'Ready.',
    error: null,
    technicalError: null,
    resultPath: null,
    preservedShapePath: null,
    retryContext: null,
    timingSummary: null,
    workerNeedsRestart: false,
    runShapeWorkflow: vi.fn(),
    runTextureWorkflow: vi.fn(),
    retryTexture: vi.fn(),
    retryTextureSafe: vi.fn(),
    clearError: vi.fn(),
    setStatusMessage: vi.fn(),
    resetForNewInput: vi.fn(),
    markWorkerRestarted: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.restartHunyuanWorker.mockReset().mockResolvedValue(undefined);
  mocks.clearHunyuanWorkerCache.mockReset().mockResolvedValue(undefined);
  mocks.getSystemDiagnostics.mockReset().mockResolvedValue({
    os: 'windows',
    arch: 'x86_64',
    wslAvailable: false,
    amdGpus: ['AMD Radeon RX 6950 XT'],
  });
  mocks.getHunyuanHealth.mockReset().mockResolvedValue({
    ok: true,
    python: 'python.exe',
    torch_available: true,
    hunyuan_available: true,
  });
  mocks.getHunyuanTextureHealth.mockReset().mockResolvedValue({
    ok: true,
    texgen_available: true,
    custom_rasterizer_available: true,
    mesh_processor_available: true,
    texture_import_ok: true,
  });
  mocks.useGenerationJob.mockReset().mockReturnValue(jobState());
});

afterEach(() => cleanup());

describe('App persistent worker controls', () => {
  it('offers an explicit worker restart after a crash', async () => {
    const markWorkerRestarted = vi.fn();
    const setStatusMessage = vi.fn();
    mocks.useGenerationJob.mockReturnValue(jobState({
      workerNeedsRestart: true,
      markWorkerRestarted,
      setStatusMessage,
    }));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /restart worker/i }));

    await waitFor(() => expect(mocks.restartHunyuanWorker).toHaveBeenCalledOnce());
    expect(markWorkerRestarted).toHaveBeenCalledOnce();
    expect(setStatusMessage).toHaveBeenCalledWith(expect.stringMatching(/worker restarted/i));
  });

  it('offers clear cache after the runtime health check succeeds', async () => {
    const setStatusMessage = vi.fn();
    mocks.useGenerationJob.mockReturnValue(jobState({ setStatusMessage }));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /check health/i }));

    const clearCache = await screen.findByRole('button', { name: /clear cache/i });
    fireEvent.click(clearCache);

    await waitFor(() => expect(mocks.clearHunyuanWorkerCache).toHaveBeenCalledOnce());
    expect(setStatusMessage).toHaveBeenCalledWith(expect.stringMatching(/cache cleared/i));
  });

  it('shows cache and worker timing metadata when available', () => {
    mocks.useGenerationJob.mockReturnValue(jobState({
      timingSummary: {
        totalMs: 67000,
        textureMs: 67000,
        cacheHit: true,
        cacheKind: 'texture',
        meshCacheHit: true,
        modelLoadMs: 2.5,
        preprocessMs: 12100,
        inferenceMs: 30900,
        exportMs: 8300,
        trianglesBefore: 604308,
        trianglesAfter: 20000,
        resolvedTextureProfile: 'balanced',
      },
    }));

    render(<App />);

    expect(screen.getByText('Cache')).toBeTruthy();
    expect(screen.getByText(/hit.*texture/i)).toBeTruthy();
    expect(screen.getByText('Mesh cache')).toBeTruthy();
    expect(screen.getByText('hit', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Load')).toBeTruthy();
    expect(screen.getByText('Prep')).toBeTruthy();
    expect(screen.getByText('Inference')).toBeTruthy();
    expect(screen.getByText('Export')).toBeTruthy();
  });
});
