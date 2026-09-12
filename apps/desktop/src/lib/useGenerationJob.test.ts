// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overallProgress, useGenerationJob, type ShapeWorkflowRequest } from './useGenerationJob';

const tauriMocks = vi.hoisted(() => ({
  generateShape: vi.fn(),
  cleanupMesh: vi.fn(),
  textureMesh: vi.fn(),
}));

vi.mock('./tauri', () => ({
  generateShape: tauriMocks.generateShape,
  cleanupMesh: tauriMocks.cleanupMesh,
  textureMesh: tauriMocks.textureMesh,
}));

const baseRequest = {
  backend: 'native-rocm',
  image: 'C:/source.png',
  output: 'C:/model.glb',
  outputMode: 'model-only',
  shapeProfile: 'balanced',
  steps: 30,
  seed: 1234,
  removeBackground: true,
  textureEngine: 'hunyuan-paint',
  textureProfile: 'auto',
  cleanupPreset: 'off',
  cleanupOverrides: {},
} as ShapeWorkflowRequest & {
  cleanupPreset: 'off' | 'light' | 'game-ready' | 'aggressive';
  cleanupOverrides: Record<string, unknown>;
};

beforeEach(() => {
  tauriMocks.generateShape.mockReset();
  tauriMocks.cleanupMesh.mockReset();
  tauriMocks.textureMesh.mockReset();
});

describe('useGenerationJob', () => {
  it('runs Light cleanup between shape generation and the selected model-only output', async () => {
    tauriMocks.generateShape.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/model-shape.glb' });
    tauriMocks.cleanupMesh.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/model.glb',
      cleanup_cache_hit: false,
      mesh_cleanup_ms: 125,
      cleanup_report: {
        preset: 'light',
        config_label: 'Light',
        algorithm_version: 'mesh-cleanup-v1',
        triangles_before: 1000,
        triangles_after: 950,
        vertices_before: 600,
        vertices_after: 580,
        components_before: 2,
        components_after: 1,
        components_removed: 1,
        vertices_welded: 20,
        spikes_adjusted: 0,
        cleanup_ms: 125,
        warnings: [],
      },
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({ ...baseRequest, cleanupPreset: 'light' } as any);
    });

    expect(tauriMocks.generateShape.mock.calls[0][0]).toMatchObject({ output: 'C:/model-shape.glb' });
    expect(tauriMocks.cleanupMesh).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'C:/model-shape.glb', output: 'C:/model.glb', preset: 'light' }),
      expect.any(Function),
    );
    expect(tauriMocks.textureMesh).not.toHaveBeenCalled();
    expect(result.current.preservedShapePath).toBe('C:/model-shape.glb');
    expect(result.current.cleanedShapePath).toBe('C:/model.glb');
    expect(result.current.resultPath).toBe('C:/model.glb');
    expect(result.current.timingSummary).toMatchObject({ cleanupCacheHit: false, meshCleanupMs: 125 });
  });

  it('keeps Off as a direct shape-to-final path without cleanup', async () => {
    tauriMocks.generateShape.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/model.glb' });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow(baseRequest);
    });

    expect(tauriMocks.generateShape.mock.calls[0][0]).toMatchObject({ output: 'C:/model.glb' });
    expect(tauriMocks.cleanupMesh).not.toHaveBeenCalled();
    expect(tauriMocks.textureMesh).not.toHaveBeenCalled();
    expect(result.current.resultPath).toBe('C:/model.glb');
    expect(result.current.preservedShapePath).toBe('C:/model.glb');
  });

  it('runs shape then Light cleanup then texture using the cleaned intermediate', async () => {
    const order: string[] = [];
    tauriMocks.generateShape.mockImplementation(async () => {
      order.push('shape');
      return { ok: true, event: 'completed', output: 'C:/model-shape.glb' };
    });
    tauriMocks.cleanupMesh.mockImplementation(async () => {
      order.push('cleanup');
      return { ok: true, event: 'completed', output: 'C:/model-clean.glb', mesh_cleanup_ms: 100 };
    });
    tauriMocks.textureMesh.mockImplementation(async () => {
      order.push('texture');
      return { ok: true, event: 'completed', output: 'C:/model.glb', resolved_profile: 'balanced' };
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({
        ...baseRequest,
        outputMode: 'model-and-texture',
        cleanupPreset: 'light',
      } as any);
    });

    expect(order).toEqual(['shape', 'cleanup', 'texture']);
    expect(tauriMocks.cleanupMesh.mock.calls[0][0]).toMatchObject({
      input: 'C:/model-shape.glb',
      output: 'C:/model-clean.glb',
      preset: 'light',
    });
    expect(tauriMocks.textureMesh.mock.calls[0][0]).toMatchObject({
      mesh: 'C:/model-clean.glb',
      image: 'C:/source.png',
      output: 'C:/model.glb',
    });
    expect(result.current.preservedShapePath).toBe('C:/model-shape.glb');
    expect(result.current.cleanedShapePath).toBe('C:/model-clean.glb');
    expect(result.current.resultPath).toBe('C:/model.glb');
  });

  it('preserves the raw shape and does not start texture when cleanup fails', async () => {
    tauriMocks.generateShape.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/model-shape.glb' });
    tauriMocks.cleanupMesh.mockResolvedValue({
      ok: false,
      event: 'error',
      error: 'cleanup failed',
      error_kind: 'mesh_cleanup_failed',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({
        ...baseRequest,
        outputMode: 'model-and-texture',
        cleanupPreset: 'light',
      } as any);
    });

    expect(result.current.preservedShapePath).toBe('C:/model-shape.glb');
    expect(result.current.resultPath).toBe('C:/model-shape.glb');
    expect(tauriMocks.textureMesh).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/cleanup failed/i);
  });

  it('uses the cleaned path for texture retry while preserving the raw rollback shape', async () => {
    tauriMocks.generateShape.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/model-shape.glb' });
    tauriMocks.cleanupMesh.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/model-clean.glb' });
    tauriMocks.textureMesh.mockResolvedValue({
      ok: false,
      event: 'error',
      stage: 'texture',
      error_kind: 'out_of_memory',
      error: 'CUDA out of memory',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({
        ...baseRequest,
        outputMode: 'model-and-texture',
        cleanupPreset: 'light',
      } as any);
    });

    expect(result.current.retryContext).toMatchObject({ mesh: 'C:/model-clean.glb' });
    expect(result.current.preservedShapePath).toBe('C:/model-shape.glb');
    expect(result.current.cleanedShapePath).toBe('C:/model-clean.glb');
  });

  it('runs standalone Mesh cleanup from imported input to selected output', async () => {
    tauriMocks.cleanupMesh.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/import-clean.glb',
      mesh_cleanup_ms: 80,
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runMeshWorkflow({
        input: 'C:/import.glb',
        output: 'C:/import-clean.glb',
        preset: 'game-ready',
        overrides: {},
      });
    });

    expect(tauriMocks.cleanupMesh).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'C:/import.glb', output: 'C:/import-clean.glb', preset: 'game-ready' }),
      expect.any(Function),
    );
    expect(result.current.preservedShapePath).toBe('C:/import.glb');
    expect(result.current.cleanedShapePath).toBe('C:/import-clean.glb');
    expect(result.current.resultPath).toBe('C:/import-clean.glb');
  });

  it('marks restart required and preserves the mesh after a texture worker crash', async () => {
    tauriMocks.textureMesh.mockResolvedValue({
      ok: false,
      event: 'error',
      stage: 'worker',
      error_kind: 'worker_crashed',
      error: 'Persistent worker closed stdout',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'balanced',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      });
    });

    expect(result.current.workerNeedsRestart).toBe(true);
    expect(result.current.resultPath).toBe('C:/shape.glb');
    expect(result.current.preservedShapePath).toBe('C:/shape.glb');
    expect(result.current.retryContext).toMatchObject({ mesh: 'C:/shape.glb' });
    expect(result.current.error).toMatch(/worker.*crash/i);
  });

  it('marks restart required after a shape worker crash', async () => {
    tauriMocks.generateShape.mockResolvedValue({
      ok: false,
      event: 'error',
      stage: 'worker',
      error_kind: 'worker_crashed',
      error: 'Persistent worker closed stdout',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow(baseRequest);
    });

    expect(result.current.workerNeedsRestart).toBe(true);
    expect(result.current.error).toMatch(/worker.*crash/i);
  });

  it('reports cache hit and worker timings from a texture result', async () => {
    tauriMocks.textureMesh.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/textured.glb',
      requested_profile: 'balanced',
      resolved_profile: 'balanced',
      faces_before: 604308,
      faces_after: 20000,
      cache_hit: true,
      cache_kind: 'texture',
      mesh_cache_hit: true,
      model_load_ms: 2.5,
      preprocess_ms: 12100,
      inference_ms: 30900,
      export_ms: 8300,
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'balanced',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      });
    });

    expect(result.current.timingSummary).toMatchObject({
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
    });
  });

  it('does not reset progress when a cache event arrives', async () => {
    tauriMocks.textureMesh.mockImplementation(async (_request, onProgress) => {
      onProgress({ event: 'progress', stage: 'running_texture', progress: 0.5 });
      onProgress({ event: 'cache', stage: 'cache_hit', cache_hit: true, cache_kind: 'texture' });
      return { ok: true, event: 'completed', output: 'C:/textured.glb', cache_hit: true };
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'balanced',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      });
    });

    expect(result.current.progress?.value).toBe(1);
    expect(result.current.progress?.label).toBe('Texture complete.');
  });

  it('retryTextureSafe reuses mesh and image without calling generateShape', async () => {
    tauriMocks.textureMesh
      .mockResolvedValueOnce({
        ok: false,
        event: 'error',
        stage: 'texture',
        error_kind: 'out_of_memory',
        error: 'CUDA out of memory',
      })
      .mockResolvedValueOnce({
        ok: true,
        event: 'completed',
        output: 'C:/retry.glb',
        resolved_profile: 'safe',
      });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'quality',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/retry.glb',
        removeBackground: true,
      });
    });
    await act(async () => {
      await result.current.retryTextureSafe();
    });

    expect(tauriMocks.generateShape).not.toHaveBeenCalled();
    expect(tauriMocks.textureMesh).toHaveBeenCalledTimes(2);
    expect(tauriMocks.textureMesh.mock.calls[1][0]).toMatchObject({
      profile: 'safe',
      mesh: 'C:/shape.glb',
      image: 'C:/source.png',
    });
  });

  it('clears restart-required state only after an explicit restart acknowledgement', async () => {
    tauriMocks.textureMesh.mockResolvedValue({
      ok: false,
      event: 'error',
      stage: 'worker',
      error_kind: 'worker_crashed',
      error: 'Persistent worker closed stdout',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'balanced',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      });
    });
    expect(result.current.workerNeedsRestart).toBe(true);

    act(() => result.current.markWorkerRestarted());
    expect(result.current.workerNeedsRestart).toBe(false);
  });

  it('maps shape and texture overall progress as 25/75', () => {
    expect(overallProgress('shape', 1, true)).toBe(0.25);
    expect(overallProgress('texture', 0.5, true)).toBe(0.625);
    expect(overallProgress('shape', 0.5, false)).toBe(0.5);
  });
});
