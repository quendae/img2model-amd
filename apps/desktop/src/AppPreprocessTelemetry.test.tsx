// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  getSystemDiagnostics: vi.fn(),
  useGenerationJob: vi.fn(),
}));

vi.mock('./components/InputPanel', () => ({ InputPanel: () => <div /> }));
vi.mock('./components/GenerationPanel', () => ({ GenerationPanel: () => <div /> }));
vi.mock('./components/ModelViewer', () => ({ ModelViewer: () => <div /> }));
vi.mock('./components/DiagnosticsPanel', () => ({ DiagnosticsPanel: () => <div /> }));

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

vi.mock('./lib/useGenerationJob', () => ({ useGenerationJob: mocks.useGenerationJob }));

beforeEach(() => {
  mocks.getSystemDiagnostics.mockResolvedValue({ os: 'windows', arch: 'x86_64', wslAvailable: false, amdGpus: [] });
  mocks.useGenerationJob.mockReturnValue({
    busy: false,
    progress: null,
    message: 'Texture completed.',
    error: null,
    technicalError: null,
    resultPath: null,
    preservedShapePath: null,
    retryContext: null,
    workerNeedsRestart: false,
    timingSummary: {
      totalMs: 31000,
      textureMs: 31000,
      cacheHit: true,
      cacheKind: 'texture',
      imageCacheHit: true,
      meshCacheHit: true,
      modelLoadMs: 0,
      imagePreprocessMs: 120,
      meshPreprocessMs: 35,
      preprocessMs: 155,
      inferenceMs: 29000,
      exportMs: 0,
      outputSizeBytes: 1_500_000,
    },
    runShapeWorkflow: vi.fn(),
    runTextureWorkflow: vi.fn(),
    retryTexture: vi.fn(),
    retryTextureSafe: vi.fn(),
    clearError: vi.fn(),
    setStatusMessage: vi.fn(),
    resetForNewInput: vi.fn(),
    markWorkerRestarted: vi.fn(),
  });
});

afterEach(() => cleanup());

describe('Activity preprocessing telemetry', () => {
  it('shows image and mesh cache status, timings and output file size', () => {
    render(<App />);

    expect(screen.getByText('Image cache')).toBeTruthy();
    expect(screen.getByText('Mesh cache')).toBeTruthy();
    expect(screen.getByText('Image prep')).toBeTruthy();
    expect(screen.getByText('Mesh prep')).toBeTruthy();
    expect(screen.getByText('Output size')).toBeTruthy();
    expect(screen.getByText('1.43 MiB')).toBeTruthy();
  });
});