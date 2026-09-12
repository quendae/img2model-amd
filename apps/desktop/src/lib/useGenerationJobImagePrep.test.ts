// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationJob } from './useGenerationJob';

const tauriMocks = vi.hoisted(() => ({
  generateShape: vi.fn(),
  textureMesh: vi.fn(),
}));

vi.mock('./tauri', () => ({
  generateShape: tauriMocks.generateShape,
  textureMesh: tauriMocks.textureMesh,
}));

beforeEach(() => {
  tauriMocks.generateShape.mockReset();
  tauriMocks.textureMesh.mockReset();
});

describe('useGenerationJob preprocess telemetry', () => {
  it('keeps prepared image and mesh cache metadata plus split timings', async () => {
    tauriMocks.textureMesh.mockResolvedValue({
      ok: true,
      event: 'completed',
      output: 'C:/textured.glb',
      cache_hit: true,
      cache_kind: 'texture',
      image_cache_hit: true,
      mesh_cache_hit: true,
      image_preprocess_ms: 15.5,
      mesh_preprocess_ms: 4.25,
      preprocess_ms: 19.75,
      inference_ms: 29000,
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
      imageCacheHit: true,
      meshCacheHit: true,
      imagePreprocessMs: 15.5,
      meshPreprocessMs: 4.25,
      preprocessMs: 19.75,
      inferenceMs: 29000,
    });
  });
});
