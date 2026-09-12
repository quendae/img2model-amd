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
  chooseInputMesh: vi.fn(),
  chooseOutputModel: vi.fn(),
  useGenerationJob: vi.fn(),
}));

vi.mock('./components/InputPanel', () => ({
  InputPanel: () => <div data-testid="input-panel" />,
}));

vi.mock('./components/GenerationPanel', () => ({
  GenerationPanel: (props: any) => (
    <div data-testid="generation-panel">
      <span data-testid="workflow-mode">{props.workflowMode}</span>
      <span data-testid="cleanup-preset">{String(props.cleanupPreset)}</span>
      <span data-testid="mesh-input">{props.meshInputPath ?? 'none'}</span>
      <span data-testid="can-generate">{String(props.canGenerate)}</span>
      <button type="button" onClick={() => props.onWorkflowModeChange('mesh')}>Switch Mesh</button>
      <button type="button" onClick={props.onChooseMesh}>Choose model</button>
      <button type="button" onClick={props.onGenerate}>Run current workflow</button>
    </div>
  ),
}));

vi.mock('./components/ModelViewer', () => ({
  ModelViewer: ({ modelUrl, comparison }: any) => (
    <div data-testid="model-viewer">
      <span data-testid="model-url">{modelUrl ?? 'none'}</span>
      <span data-testid="comparison-before">{comparison?.beforeUrl ?? 'none'}</span>
      <span data-testid="comparison-after">{comparison?.afterUrl ?? 'none'}</span>
      <span data-testid="comparison-before-triangles">{comparison?.beforeTriangles ?? 'none'}</span>
      <span data-testid="comparison-after-triangles">{comparison?.afterTriangles ?? 'none'}</span>
    </div>
  ),
}));

vi.mock('./components/DiagnosticsPanel', () => ({
  DiagnosticsPanel: ({ onHealthCheck }: { onHealthCheck: () => void }) => (
    <button type="button" onClick={onHealthCheck}>Check health</button>
  ),
}));

vi.mock('./lib/tauri', () => ({
  chooseInputImage: vi.fn(),
  chooseInputMesh: mocks.chooseInputMesh,
  chooseOutputModel: mocks.chooseOutputModel,
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
    ...overrides,
  };
}

beforeEach(() => {
  mocks.restartHunyuanWorker.mockReset().mockResolvedValue(undefined);
  mocks.clearHunyuanWorkerCache.mockReset().mockResolvedValue(undefined);
  mocks.chooseInputMesh.mockReset().mockResolvedValue('C:/import.glb');
  mocks.chooseOutputModel.mockReset().mockResolvedValue('C:/import-clean.glb');
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

describe('App cleanup workflows', () => {
  it('uses Light as the default Shape cleanup preset', () => {
    render(<App />);
    expect(screen.getByTestId('workflow-mode').textContent).toBe('shape');
    expect(screen.getByTestId('cleanup-preset').textContent).toBe('light');
  });

  it('runs standalone Mesh with Game-ready without requiring an image or texture runtime', async () => {
    const runMeshWorkflow = vi.fn().mockResolvedValue('C:/import-clean.glb');
    mocks.useGenerationJob.mockReturnValue(jobState({ runMeshWorkflow }));
    mocks.getHunyuanTextureHealth.mockResolvedValue({
      ok: false,
      texgen_available: false,
      custom_rasterizer_available: false,
      mesh_processor_available: false,
      texture_import_ok: false,
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch Mesh' }));
    expect(screen.getByTestId('workflow-mode').textContent).toBe('mesh');
    expect(screen.getByTestId('cleanup-preset').textContent).toBe('game-ready');

    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    await waitFor(() => expect(screen.getByTestId('mesh-input').textContent).toBe('C:/import.glb'));
    expect(screen.getByTestId('can-generate').textContent).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Run current workflow' }));
    await waitFor(() => expect(runMeshWorkflow).toHaveBeenCalledWith({
      input: 'C:/import.glb',
      output: 'C:/import-clean.glb',
      preset: 'game-ready',
      overrides: {},
    }));
  });

  it('shows the full cleanup report in Activity', () => {
    mocks.useGenerationJob.mockReturnValue(jobState({
      timingSummary: {
        totalMs: 1800,
        meshCleanupMs: 1800,
        cleanupCacheHit: true,
        cleanupReport: {
          preset: 'game-ready',
          config_label: 'Game-ready',
          algorithm_version: 'mesh-cleanup-v1',
          triangles_before: 312000,
          triangles_after: 305000,
          vertices_before: 158000,
          vertices_after: 151000,
          components_before: 93,
          components_after: 12,
          components_removed: 81,
          vertices_welded: 6400,
          spikes_adjusted: 214,
          cleanup_ms: 1800,
          warnings: ['Mesh is still not watertight after cleanup.'],
        },
      },
    }));

    render(<App />);

    expect(screen.getByText('Cleanup cache')).toBeTruthy();
    expect(screen.getByText('Mesh cleanup')).toBeTruthy();
    expect(screen.getByText('Triangles')).toBeTruthy();
    expect(screen.getByText(/312,000.*305,000/)).toBeTruthy();
    expect(screen.getByText('Vertices')).toBeTruthy();
    expect(screen.getByText(/158,000.*151,000/)).toBeTruthy();
    expect(screen.getByText('Islands')).toBeTruthy();
    expect(screen.getByText(/93.*12/)).toBeTruthy();
    expect(screen.getByText('Welded')).toBeTruthy();
    expect(screen.getByText(/6,400/)).toBeTruthy();
    expect(screen.getByText('Spikes')).toBeTruthy();
    expect(screen.getByText(/214/)).toBeTruthy();
    expect(screen.getByText(/not watertight/i)).toBeTruthy();
  });

  it('passes Mesh-mode source and cleaned output to the ModelViewer comparison', async () => {
    mocks.useGenerationJob.mockReturnValue(jobState({
      resultPath: 'C:/import-clean.glb',
      preservedShapePath: 'C:/import.glb',
      cleanedShapePath: 'C:/import-clean.glb',
      timingSummary: {
        totalMs: 1800,
        meshCleanupMs: 1800,
        cleanupReport: {
          preset: 'game-ready',
          config_label: 'Game-ready',
          algorithm_version: 'mesh-cleanup-v1',
          triangles_before: 312000,
          triangles_after: 305000,
          vertices_before: 158000,
          vertices_after: 151000,
          components_before: 2,
          components_after: 1,
          cleanup_ms: 1800,
          warnings: [],
        },
      },
    }));

    render(<App />);
    expect(screen.getByTestId('comparison-before').textContent).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Switch Mesh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));

    await waitFor(() => expect(screen.getByTestId('mesh-input').textContent).toBe('C:/import.glb'));
    expect(screen.getByTestId('comparison-before').textContent).toBe('C:/import.glb');
    expect(screen.getByTestId('comparison-after').textContent).toBe('C:/import-clean.glb');
    expect(screen.getByTestId('comparison-before-triangles').textContent).toBe('312000');
    expect(screen.getByTestId('comparison-after-triangles').textContent).toBe('305000');
  });
});

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
