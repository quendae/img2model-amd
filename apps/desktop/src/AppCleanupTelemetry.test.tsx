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
    algorithm_version: 'mesh-cleanup-v4',
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
    pre_repair_watertight: false,
    pre_repair_manifold: true,
    pre_repair_boundary_edges: 12,
    holes_closed: 2,
    non_manifold_edges_fixed: 5,
    reduction_ratio: 0.99064,
    remeshed: true,
    repair_backend: 'pymeshlab+manifold3d',
    normalized_error: 0.0042,
    target_triangles: 5000,
    stage_ms: {
      input_topology: 3200,
      remove_degenerate: 150,
      weld_vertices: 900,
      remove_small_islands: 2100,
      small_hole_fill: 1400,
      repair_winding: 3600,
      final_validation: 650,
    },
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

describe('Activity cleanup telemetry', () => {
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

  it('shows pre-repair topology and cleanup stage timings for performance diagnosis', () => {
    render(<App />);

    expect(screen.getByText('Pre-repair boundary edges')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Cleanup stage timings')).toBeTruthy();
    expect(screen.getByText('Input topology')).toBeTruthy();
    expect(screen.getByText('Repair winding')).toBeTruthy();
    expect(screen.getByText('4s')).toBeTruthy();
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
      pre_repair_watertight: null,
      pre_repair_manifold: null,
      pre_repair_boundary_edges: null,
      holes_closed: null,
      non_manifold_edges_fixed: null,
      normalized_error: 0.0008451891542219474,
      target_triangles: null,
      stage_ms: {},
    })));

    render(<App />);

    expect(screen.getByText('534,364 → 3,000')).toBeTruthy();
    expect(screen.getByText('Repair backend')).toBeTruthy();
    expect(screen.getByText('0.085%')).toBeTruthy();
    expect(screen.queryByText('Holes closed')).toBeNull();
    expect(screen.queryByText('Non-manifold edges fixed')).toBeNull();
    expect(screen.queryByText('Target triangles')).toBeNull();
    expect(screen.queryByText('Cleanup stage timings')).toBeNull();
  });

  it('shows v8 topology and readable winding sub-timings', () => {
    mocks.useGenerationJob.mockReturnValue(jobState(cleanupReport({
      algorithm_version: 'mesh-cleanup-v8',
      stage_ms: {
        input_topology: 11000,
        remove_small_islands: 12,
        repair_winding: 14000,
        repair_winding_graph_build: 0,
        repair_winding_graph_walk: 0,
        repair_winding_volume: 13750,
        final_validation: 5,
      },
    })));

    render(<App />);

    expect(screen.getByText('Watertight')).toBeTruthy();
    expect(screen.getByText('Manifold')).toBeTruthy();
    expect(screen.getByText('Winding graph build')).toBeTruthy();
    expect(screen.getByText('Winding graph walk')).toBeTruthy();
    expect(screen.getByText('Winding volume')).toBeTruthy();
  });
});
