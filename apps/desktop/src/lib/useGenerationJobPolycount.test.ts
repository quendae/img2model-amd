// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationJob } from './useGenerationJob';

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

beforeEach(() => {
  tauriMocks.generateShape.mockReset();
  tauriMocks.cleanupMesh.mockReset();
  tauriMocks.textureMesh.mockReset();
});

describe('useGenerationJob texture polycount propagation', () => {
  it('passes the exact standalone texture target to Tauri and reports it in timings', async () => {
    tauriMocks.textureMesh.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/textured.glb',
      max_faces: 5_000,
      faces_before: 100_000,
      faces_after: 5_000,
      resolved_profile: 'balanced',
      output_size_bytes: 1_500_000,
    });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'auto',
        maxFaces: 5_000,
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      } as any);
    });

    expect(tauriMocks.textureMesh).toHaveBeenCalledWith(
      expect.objectContaining({ maxFaces: 5_000 }),
      expect.any(Function),
    );
    expect(result.current.timingSummary).toMatchObject({
      textureTargetTriangles: 5_000,
      trianglesBefore: 100_000,
      trianglesAfter: 5_000,
      outputSizeBytes: 1_500_000,
    });
  });

  it('preserves the chosen target when retrying texture in Safe mode', async () => {
    tauriMocks.textureMesh
      .mockResolvedValueOnce({
        ok: false,
        event: 'error',
        stage: 'texture',
        error_kind: 'out_of_memory',
        error: 'out of memory',
      })
      .mockResolvedValueOnce({
        ok: true,
        event: 'completed',
        output: 'C:/retry.glb',
        max_faces: 2_500,
      });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'quality',
        maxFaces: 2_500,
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/retry.glb',
        removeBackground: true,
      } as any);
    });
    await act(async () => {
      await result.current.retryTextureSafe();
    });

    expect(tauriMocks.textureMesh.mock.calls[1][0]).toMatchObject({
      profile: 'safe',
      maxFaces: 2_500,
    });
  });

  it('passes the exact target through shape + texture workflow', async () => {
    tauriMocks.generateShape.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/shape.glb' });
    tauriMocks.textureMesh.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/final.glb', max_faces: 10_000 });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runShapeWorkflow({
        backend: 'native-rocm',
        image: 'C:/source.png',
        output: 'C:/final.glb',
        outputMode: 'model-and-texture',
        shapeProfile: 'balanced',
        steps: 30,
        seed: 1234,
        removeBackground: true,
        textureEngine: 'hunyuan-paint',
        textureProfile: 'auto',
        textureMaxFaces: 10_000,
        cleanupPreset: 'off',
        cleanupOverrides: {},
      } as any);
    });

    expect(tauriMocks.textureMesh).toHaveBeenCalledWith(
      expect.objectContaining({ maxFaces: 10_000 }),
      expect.any(Function),
    );
  });
});
