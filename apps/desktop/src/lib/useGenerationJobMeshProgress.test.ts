// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationJob } from './useGenerationJob';

const tauriMocks = vi.hoisted(() => ({
  cleanupMesh: vi.fn(),
}));

vi.mock('./tauri', () => ({
  cleanupMesh: tauriMocks.cleanupMesh,
  generateShape: vi.fn(),
  textureMesh: vi.fn(),
}));

beforeEach(() => {
  tauriMocks.cleanupMesh.mockReset();
});

describe('mesh cleanup progress', () => {
  it('shows the detailed reduction stage while a heavy cleanup is running', async () => {
    let release!: () => void;
    tauriMocks.cleanupMesh.mockImplementation(async (_request, onProgress) => {
      onProgress({ event: 'progress', stage: 'reducing_mesh', progress: 0.55 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, event: 'completed', output: 'C:/clean.glb' };
    });

    const { result } = renderHook(() => useGenerationJob());
    let job!: Promise<string | null>;
    act(() => {
      job = result.current.runMeshWorkflow({
        input: 'C:/raw.glb',
        output: 'C:/clean.glb',
        preset: 'game-ready',
        overrides: {},
      });
    });

    await waitFor(() => {
      expect(result.current.progress?.label).toBe('Reducing mesh to game-ready budget…');
      expect(result.current.progress?.value).toBeCloseTo(0.55);
    });

    release();
    await act(async () => {
      await job;
    });
  });
});