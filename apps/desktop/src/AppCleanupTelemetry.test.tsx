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
  preloadHunyuanShape: vi.fn(),
  restartHunyuanWorker: vi.fn(),
  clearHunyuanWorkerCache: vi.fn(),
  localAssetUrl: (path: string) => path,
}));

vi.mock('./lib/useGenerationJob', () => ({ useGenerationJob: mocks.useGenerationJob }));

function cleanupReport(overrides: Record<string, unknown> = {}) {
  return {
    preset: 'game-ready',
    config_label: 'Custom (from Game-ready)',
    algorithm_version: 'mesh-cleanup-v2',
    triangles_before: 534364,
    triangles_after: 5000,
    vertices_before: 267184,
    vertices_after: 2502,
    components_before: 1,
    components_after: 1,
    components_removed: 0,
    vertices_welded: 0,
    spikes_adjusted: 0,
    cleanup_ms: 12000,
    watertight_before: false,
    watertight_after: true,
    manifold_before: false,
    manifold_after: true,
    boundary_edges_before: 42,
    boundary_edges_after: 0,
    holes_closed: 2,
    non_manifold_edges_fixed: 5,
    reduction_ratio: 0.99064,
    remeshed: true,
    repair_backend: 'pymeshlab+manifold3d',
    normalized_error: 0.0042,
    target_triangles: 5000,
    warnings: [],
    ...overrides,
  };
}

function jobState(report = cleanupReport()) {
  return {
    busy: false,
    progress: null,
    message: 'Mesh cleanup completed.',
    error: null,
    technicalError: null,
    resultPath: null,
    preservedShapePath: null,
    cleanedShapePath: null,
    retryContext: null,
    workerNeedsRestart: false,
    timingSummary: {
      totalMs: 12000,
      meshCleanupMs: 12000,
      cleanupReport: report,
    },
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

beforeEach(() => {
  mocks.getSystemDiagnostics.mockResolvedValue({ os: 'windows', arch: 'x86_64', wslAvailable: false, amdGpus: [] });
  mocks.useGenerationJob.mockReturnValue(jobState());
});

afterEach(() => cleanup());

describe('Activity cleanup v2 telemetry', () => {
  it('shows reduction and topology instead of emphasizing legacy spike metrics', () => {
    render(<App />);

    expect(screen.getByText('Reduction')).toBeTruthy();
    expect(screen.getByText('99.1%')).toBeTruthy();
    expect(screen.getByText('Watertight')).toBeTruthy();
    expect(screen.getAllByText('No → Yes').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Repair backend')).toBeTruthy();
    expect(screen.getByText('pymeshlab+manifold3d')).toBeTruthy();
    expect(screen.getByText('Geometry error')).toBeTruthy();
    expect(screen.getByText('0.420%')).toBeTruthy();
    expect(screen.getByText('Target triangles')).toBeTruthy();
    expect(screen.getByText('5,000')).toBeTruthy();
    expect(screen.queryByText('Spikes adjusted')).toBeNull();
  });

  it('renders a completed auto-budget cleanup report when optional worker fields are null', () => {
    mocks.useGenerationJob.mockReturnValue(jobState(cleanupReport({
      config_label: 'Game-ready',
      triangles_after: 3000,
      vertices_after: 1502,
      watertight_before: true,
      watertight_after: true,
      manifold_before: true,
      manifold_after: true,
      boundary_edges_before: 0,
      boundary_edges_after: 0,
      holes_closed: null,
      non_manifold_edges_fixed: null,
      normalized_error: 0.0008451891542219474,
      target_triangles: null,
    })));

    render(<App />);

    expect(screen.getByText('534,364 → 3,000')).toBeTruthy();
    expect(screen.getByText('Repair backend')).toBeTruthy();
    expect(screen.getByText('0.085%')).toBeTruthy();
    expect(screen.queryByText('Holes closed')).toBeNull();
    expect(screen.queryByText('Non-manifold edges fixed')).toBeNull();
    expect(screen.queryByText('Target triangles')).toBeNull();
  });
});
