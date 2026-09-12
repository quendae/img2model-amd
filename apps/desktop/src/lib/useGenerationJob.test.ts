// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overallProgress, useGenerationJob, type ShapeWorkflowRequest } from './useGenerationJob';

const tauriMocks = vi.hoisted(() => ({
  generateShape: vi.fn(),
  textureMesh: vi.fn(),
}));

vi.mock('./tauri', () => ({
  generateShape: tauriMocks.generateShape,
  textureMesh: tauriMocks.textureMesh,
}));

const baseRequest: ShapeWorkflowRequest = {
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
};

beforeEach(() => {
  tauriMocks.generateShape.mockReset();
  tauriMocks.textureMesh.mockReset();
});

describe('useGenerationJob', () => {
  it('does not start texture for model-only output', async () => {
    tauriMocks.generateShape.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/model.glb',
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow(baseRequest);
    });

    expect(tauriMocks.generateShape).toHaveBeenCalledOnce();
    expect(tauriMocks.textureMesh).not.toHaveBeenCalled();
    expect(result.current.resultPath).toBe('C:/model.glb');
    expect(result.current.preservedShapePath).toBe('C:/model.glb');
  });

  it('runs texture only after successful shape', async () => {
    const order: string[] = [];
    tauriMocks.generateShape.mockImplementation(async () => {
      order.push('shape');
      return { ok: true, event: 'completed', output: 'C:/model-shape.glb' };
    });
    tauriMocks.textureMesh.mockImplementation(async () => {
      order.push('texture');
      return {
        ok: true,
        event: 'completed',
        output: 'C:/model.glb',
        resolved_profile: 'balanced',
        faces_before: 40000,
        faces_after: 20000,
      };
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({ ...baseRequest, outputMode: 'model-and-texture' });
    });

    expect(order).toEqual(['shape', 'texture']);
    expect(tauriMocks.textureMesh.mock.calls[0][0]).toMatchObject({
      mesh: 'C:/model-shape.glb',
      image: 'C:/source.png',
      profile: 'auto',
    });
    expect(result.current.resultPath).toBe('C:/model.glb');
    expect(result.current.preservedShapePath).toBe('C:/model-shape.glb');
  });

  it('preserves shape and creates retry context when texture OOMs', async () => {
    tauriMocks.generateShape.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/model-shape.glb',
    });
    tauriMocks.textureMesh.mockResolvedValue({
      ok: false,
      event: 'error',
      stage: 'texture',
      error_kind: 'out_of_memory',
      error: 'CUDA out of memory',
      resolved_profile: 'balanced',
      faces_before: 40000,
      faces_after: 20000,
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({ ...baseRequest, outputMode: 'model-and-texture' });
    });

    expect(result.current.error).toMatch(/out of gpu memory/i);
    expect(result.current.technicalError).toBe('CUDA out of memory');
    expect(result.current.resultPath).toBe('C:/model-shape.glb');
    expect(result.current.retryContext).toMatchObject({
      mesh: 'C:/model-shape.glb',
      image: 'C:/source.png',
      profile: 'auto',
    });
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
