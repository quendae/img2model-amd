// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

afterEach(() => cleanup());

function props(overrides: Record<string, unknown> = {}) {
  return {
    backend: 'native-rocm' as const,
    workflowMode: 'texture' as const,
    outputMode: 'model-only' as const,
    profile: 'balanced' as const,
    textureProfile: 'auto' as const,
    textureEngine: 'hunyuan-paint' as const,
    textureMeshPath: 'C:/shape.glb',
    meshInputPath: null,
    cleanupPreset: 'light' as const,
    cleanupConfigLabel: 'Light',
    cleanupOverrides: {},
    textureTargetTriangles: 10_000,
    seed: 1234,
    steps: 30,
    removeBackground: true,
    textureAvailable: true,
    busy: false,
    canGenerate: true,
    onBackendChange: vi.fn(),
    onWorkflowModeChange: vi.fn(),
    onShapeOutputModeChange: vi.fn(),
    onProfileChange: vi.fn(),
    onTextureProfileChange: vi.fn(),
    onTextureTargetTrianglesChange: vi.fn(),
    onCleanupPresetChange: vi.fn(),
    onCleanupOverridesChange: vi.fn(),
    onSeedChange: vi.fn(),
    onStepsChange: vi.fn(),
    onRemoveBackgroundChange: vi.fn(),
    onChooseMesh: vi.fn(),
    onGenerate: vi.fn(),
    ...overrides,
  };
}

describe('GenerationPanel texture polycount', () => {
  it('shows all game-ready target presets and defaults Hero to selected at 10k', () => {
    render(<GenerationPanel {...(props() as any)} />);

    const control = screen.getByLabelText('Texture target triangles');
    const scoped = within(control);
    for (const label of ['Mobile', 'Low', 'Medium', 'High', 'Hero', 'Quality', 'Custom']) {
      expect(scoped.getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy();
    }
    expect(control.querySelectorAll('button')).toHaveLength(7);
    expect(scoped.getByRole('button', { name: /Hero/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/10,000 triangles/i)).toBeTruthy();
  });

  it('emits the exact preset target without silently changing it', () => {
    const onTextureTargetTrianglesChange = vi.fn();
    render(<GenerationPanel {...(props({ onTextureTargetTrianglesChange }) as any)} />);

    const control = screen.getByLabelText('Texture target triangles');
    fireEvent.click(within(control).getByRole('button', { name: /High/i }));
    expect(onTextureTargetTrianglesChange).toHaveBeenCalledWith(5_000);
  });

  it('reveals custom slider and numeric input for a non-preset target', () => {
    const onTextureTargetTrianglesChange = vi.fn();
    render(
      <GenerationPanel
        {...(props({ textureTargetTriangles: 7_500, onTextureTargetTrianglesChange }) as any)}
      />,
    );

    const control = screen.getByLabelText('Texture target triangles');
    expect(within(control).getByRole('button', { name: /Custom/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Custom texture triangle slider')).toBeTruthy();
    const numeric = screen.getByLabelText('Custom texture triangles') as HTMLInputElement;
    expect(numeric.value).toBe('7500');

    fireEvent.change(numeric, { target: { value: '12345' } });
    expect(onTextureTargetTrianglesChange).toHaveBeenCalledWith(12_345);
  });

  it('also shows target controls for Shape + texture output', () => {
    render(
      <GenerationPanel
        {...(props({ workflowMode: 'shape', outputMode: 'model-and-texture' }) as any)}
      />,
    );
    expect(screen.getByLabelText('Texture target triangles')).toBeTruthy();
  });
});
