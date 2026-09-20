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

describe('useGenerationJob texture style', () => {
  it('forwards stylePreset to Hunyuan texture requests', async () => {
    tauriMocks.textureMesh.mockResolvedValue({ ok: true, event: 'completed', output: 'C:/textured.glb' });
    const { result } = renderHook(() => useGenerationJob());

    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'balanced',
        stylePreset: 'stylized',
        mesh: 'C:/shape.glb',
        image: 'C:/source.png',
        output: 'C:/textured.glb',
        removeBackground: true,
      } as any);
    });

    expect(tauriMocks.textureMesh.mock.calls[0][0]).toMatchObject({ stylePreset: 'stylized' });
  });

  it('keeps stylePreset when retrying with Safe profile', async () => {
    tauriMocks.textureMesh
      .mockResolvedValueOnce({
        ok: false,
        event: 'error',
        stage: 'texture',
        error_kind: 'out_of_memory',
        error: 'CUDA out of memory',
      })
      .mockResolvedValueOnce({ ok: true, event: 'completed', output: 'C:/retry.glb' });

    const { result } = renderHook(() => useGenerationJob());
    await act(async () => {
      await result.current.runTextureWorkflow({
        backend: 'native-rocm',
        engine: 'hunyuan-paint',
        profile: 'quality',
        stylePreset: 'cartoon',
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
      stylePreset: 'cartoon',
    });
  });
});
