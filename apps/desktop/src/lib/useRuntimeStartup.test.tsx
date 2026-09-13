// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getHunyuanHealth: vi.fn(),
  getHunyuanTextureHealth: vi.fn(),
  preloadHunyuanShape: vi.fn(),
}));

vi.mock('./tauri', () => ({
  getHunyuanHealth: mocks.getHunyuanHealth,
  getHunyuanTextureHealth: mocks.getHunyuanTextureHealth,
  preloadHunyuanShape: mocks.preloadHunyuanShape,
}));

import { useRuntimeStartup } from './useRuntimeStartup';

const readyHealth = {
  ok: true,
  python: '3.11',
  torch_available: true,
  hunyuan_available: true,
  torch_version: '2.13.0',
  hip_version: '7.15',
  device_name: 'RX 6950 XT',
  error: null,
};

const readyTexture = {
  ok: true,
  texgen_available: true,
  custom_rasterizer_available: true,
  mesh_processor_available: true,
  texture_import_ok: true,
  error: null,
};

describe('useRuntimeStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHunyuanHealth.mockResolvedValue(readyHealth);
    mocks.getHunyuanTextureHealth.mockResolvedValue(readyTexture);
    mocks.preloadHunyuanShape.mockResolvedValue({
      ok: true,
      event: 'completed',
      stage: 'shape_preloaded',
      cache_hit: false,
      model_load_ms: 17000,
    });
  });

  it('checks runtime and preloads Shape automatically after mount', async () => {
    const { result } = renderHook(() => useRuntimeStartup());

    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(mocks.getHunyuanHealth).toHaveBeenCalledTimes(1);
    expect(mocks.getHunyuanTextureHealth).toHaveBeenCalledTimes(1);
    expect(mocks.preloadHunyuanShape).toHaveBeenCalledTimes(1);
    expect(result.current.shapeCacheReady).toBe(true);
    expect(result.current.shapePreloadMs).toBe(17000);
  });

  it('keeps Shape startup usable when texture health is unavailable', async () => {
    mocks.getHunyuanTextureHealth.mockRejectedValue(new Error('paint unavailable'));
    const { result } = renderHook(() => useRuntimeStartup());

    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.health?.ok).toBe(true);
    expect(result.current.textureHealth).toBeNull();
    expect(result.current.shapeCacheReady).toBe(true);
  });

  it('can preload again after Texture evicts Shape', async () => {
    const { result } = renderHook(() => useRuntimeStartup());
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.markShapeEvicted());
    expect(result.current.shapeCacheReady).toBe(false);

    await act(async () => {
      await result.current.ensureShapePreloaded();
    });

    expect(mocks.preloadHunyuanShape).toHaveBeenCalledTimes(2);
    expect(result.current.shapeCacheReady).toBe(true);
  });
});
