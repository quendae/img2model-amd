import { describe, expect, it } from 'vitest';
import { chooseBackend } from './backendPolicy';
import type { BackendStatus } from './types';

const status = (id: BackendStatus['id'], healthy: boolean): BackendStatus => ({
  id,
  label: id,
  installed: healthy,
  available: healthy,
  healthy,
});

describe('chooseBackend', () => {
  it('uses a healthy explicit preference', () => {
    const result = chooseBackend([
      status('native-rocm', true),
      status('wsl-rocm', true),
      status('vulkan', true),
    ], 'wsl-rocm');

    expect(result.backend).toBe('wsl-rocm');
    expect(result.error).toBeUndefined();
  });

  it('does not silently fall back when explicit preference is unhealthy', () => {
    const result = chooseBackend([
      status('native-rocm', true),
      status('wsl-rocm', false),
      status('vulkan', true),
    ], 'wsl-rocm');

    expect(result.backend).toBeUndefined();
    expect(result.error).toContain('wsl-rocm');
  });

  it('prefers native ROCm in automatic mode', () => {
    const result = chooseBackend([
      status('vulkan', true),
      status('wsl-rocm', true),
      status('native-rocm', true),
    ]);

    expect(result.backend).toBe('native-rocm');
  });

  it('falls back to WSL then Vulkan only in automatic mode', () => {
    expect(chooseBackend([
      status('native-rocm', false),
      status('wsl-rocm', true),
      status('vulkan', true),
    ]).backend).toBe('wsl-rocm');

    expect(chooseBackend([
      status('native-rocm', false),
      status('wsl-rocm', false),
      status('vulkan', true),
    ]).backend).toBe('vulkan');
  });
});
