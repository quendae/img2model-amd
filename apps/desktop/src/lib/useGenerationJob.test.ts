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
        resolved_profile: 'safe',
        faces_before: 40000,
        faces_after: 10000,
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
      resolved_profile: 'safe',
      faces_before: 40000,
      faces_after: 10000,
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

  it('maps shape and texture overall progress as 25/75', () => {
    expect(overallProgress('shape', 1, true)).toBe(0.25);
    expect(overallProgress('texture', 0.5, true)).toBe(0.625);
    expect(overallProgress('shape', 0.5, false)).toBe(0.5);
  });
});
