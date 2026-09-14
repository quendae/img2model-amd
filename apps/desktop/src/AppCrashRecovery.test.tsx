// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSystemDiagnostics: vi.fn(),
  useGenerationJob: vi.fn(),
  useRuntimeStartup: vi.fn(),
}));

vi.mock('./components/InputPanel', () => ({
  InputPanel: () => <div data-testid="input-panel" />,
}));

vi.mock('./components/GenerationPanel', () => ({
  GenerationPanel: () => <div data-testid="generation-panel" />,
}));

vi.mock('./components/DiagnosticsPanel', () => ({
  DiagnosticsPanel: () => <div data-testid="diagnostics-panel" />,
}));

vi.mock('./components/ModelViewer', () => ({
  ModelViewer: () => {
    throw new Error('preview render failed');
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('./lib/tauri', () => ({
  chooseInputImage: vi.fn(),
  chooseInputMesh: vi.fn(),
  chooseOutputModel: vi.fn(),
  getSystemDiagnostics: mocks.getSystemDiagnostics,
  restartHunyuanWorker: vi.fn(),
  clearHunyuanWorkerCache: vi.fn(),
  localAssetUrl: (path: string) => path,
}));

vi.mock('./lib/useGenerationJob', () => ({
  useGenerationJob: mocks.useGenerationJob,
}));

vi.mock('./lib/useRuntimeStartup', () => ({
  useRuntimeStartup: mocks.useRuntimeStartup,
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

function runtimeState() {
  return {
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
    shapePreloadMs: 1,
    error: null,
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureShapePreloaded: vi.fn().mockResolvedValue(undefined),
    markShapeEvicted: vi.fn(),
  };
}

beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: {},
    configurable: true,
  });
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.getSystemDiagnostics.mockReset().mockResolvedValue({
    os: 'windows',
    arch: 'x86_64',
    wslAvailable: false,
    amdGpus: ['AMD Radeon RX 6950 XT'],
  });
  mocks.useGenerationJob.mockReset().mockReturnValue(jobState());
  mocks.useRuntimeStartup.mockReset().mockReturnValue(runtimeState());
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

describe('App crash recovery', () => {
  it('shows a diagnostic fallback instead of leaving a blank window when React crashes', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: /Interface error/i })).toBeTruthy();
    expect(screen.getByText(/preview render failed/i)).toBeTruthy();
    expect(screen.getByText(/Img2ModelAMD.*logs.*img2model-amd\.log/i)).toBeTruthy();

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      'append_diagnostic_log',
      expect.objectContaining({
        source: 'react',
        message: expect.stringMatching(/preview render failed/i),
      }),
    ));
  });
});
