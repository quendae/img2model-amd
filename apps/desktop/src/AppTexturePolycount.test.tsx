// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const mocks = vi.hoisted(() => ({
  chooseInputImage: vi.fn(),
  chooseInputMesh: vi.fn(),
  chooseOutputModel: vi.fn(),
  getSystemDiagnostics: vi.fn(),
  runTextureWorkflow: vi.fn(),
  runShapeWorkflow: vi.fn(),
  useGenerationJob: vi.fn(),
  useRuntimeStartup: vi.fn(),
}));

vi.mock('./components/InputPanel', () => ({
  InputPanel: (props: any) => <button type="button" onClick={props.onChoose}>Pick image</button>,
}));

vi.mock('./components/GenerationPanel', () => ({
  GenerationPanel: (props: any) => (
    <div>
      <span data-testid="texture-target">{String(props.textureTargetTriangles)}</span>
      <button type="button" onClick={() => props.onTextureTargetTrianglesChange(5_000)}>Select High 5k</button>
      <button type="button" onClick={() => props.onWorkflowModeChange('texture')}>Switch Texture</button>
      <button type="button" onClick={() => props.onShapeOutputModeChange('model-and-texture')}>Shape + texture</button>
      <button type="button" onClick={props.onChooseMesh}>Pick model</button>
      <button type="button" onClick={props.onGenerate}>Run</button>
    </div>
  ),
}));

vi.mock('./components/ModelViewer', () => ({ ModelViewer: () => <div /> }));
vi.mock('./components/DiagnosticsPanel', () => ({ DiagnosticsPanel: () => <div /> }));

vi.mock('./lib/tauri', () => ({
  chooseInputImage: mocks.chooseInputImage,
  chooseInputMesh: mocks.chooseInputMesh,
  chooseOutputModel: mocks.chooseOutputModel,
  getSystemDiagnostics: mocks.getSystemDiagnostics,
  restartHunyuanWorker: vi.fn(),
  clearHunyuanWorkerCache: vi.fn(),
  localAssetUrl: (path: string) => path,
}));

vi.mock('./lib/useGenerationJob', () => ({ useGenerationJob: mocks.useGenerationJob }));
vi.mock('./lib/useRuntimeStartup', () => ({ useRuntimeStartup: mocks.useRuntimeStartup }));

beforeEach(() => {
  mocks.chooseInputImage.mockReset().mockResolvedValue('C:/source.png');
  mocks.chooseInputMesh.mockReset().mockResolvedValue('C:/shape.glb');
  mocks.chooseOutputModel.mockReset().mockResolvedValue('C:/output.glb');
  mocks.getSystemDiagnostics.mockReset().mockResolvedValue({ os: 'windows', arch: 'x86_64', wslAvailable: false, amdGpus: [] });
  mocks.runTextureWorkflow.mockReset().mockResolvedValue('C:/output.glb');
  mocks.runShapeWorkflow.mockReset().mockResolvedValue('C:/output.glb');
  mocks.useGenerationJob.mockReset().mockReturnValue({
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
    runShapeWorkflow: mocks.runShapeWorkflow,
    runTextureWorkflow: mocks.runTextureWorkflow,
    runMeshWorkflow: vi.fn(),
    retryTexture: vi.fn(),
    retryTextureSafe: vi.fn(),
    clearError: vi.fn(),
    setStatusMessage: vi.fn(),
    resetForNewInput: vi.fn(),
    markWorkerRestarted: vi.fn(),
  });
  mocks.useRuntimeStartup.mockReset().mockReturnValue({
    phase: 'ready',
    health: { ok: true, device_name: 'AMD Radeon RX 6950 XT' },
    textureHealth: { ok: true },
    shapeCacheReady: true,
    error: null,
    initialize: vi.fn(),
    ensureShapePreloaded: vi.fn(),
    markShapeEvicted: vi.fn(),
  });
});

afterEach(() => cleanup());

describe('App texture polycount', () => {
  it('defaults texture target to Hero 10k and passes changed target to standalone texture job', async () => {
    render(<App />);
    expect(screen.getByTestId('texture-target').textContent).toBe('10000');

    fireEvent.click(screen.getByRole('button', { name: 'Pick image' }));
    await waitFor(() => expect(mocks.chooseInputImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Switch Texture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick model' }));
    await waitFor(() => expect(mocks.chooseInputMesh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Select High 5k' }));
    expect(screen.getByTestId('texture-target').textContent).toBe('5000');

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(mocks.runTextureWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      maxFaces: 5_000,
    })));
  });

  it('passes the same selected target to Shape + texture', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick image' }));
    await waitFor(() => expect(mocks.chooseInputImage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Shape + texture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select High 5k' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(mocks.runShapeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      textureMaxFaces: 5_000,
    })));
  });
});
