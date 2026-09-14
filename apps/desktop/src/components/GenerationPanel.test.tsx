// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

afterEach(() => cleanup());

const commonProps = {
  backend: 'native-rocm' as const,
  workflowMode: 'shape' as const,
  outputMode: 'model-only' as const,
  profile: 'balanced' as const,
  textureProfile: 'auto' as const,
  textureEngine: 'hunyuan-paint' as const,
  textureMeshPath: null,
  meshInputPath: null,
  cleanupPreset: 'light' as const,
  cleanupConfigLabel: 'Light',
  cleanupOverrides: {},
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
  onCleanupPresetChange: vi.fn(),
  onCleanupOverridesChange: vi.fn(),
  onSeedChange: vi.fn(),
  onStepsChange: vi.fn(),
  onRemoveBackgroundChange: vi.fn(),
  onChooseMesh: vi.fn(),
  onGenerate: vi.fn(),
};

describe('GenerationPanel', () => {
  it('shows Shape, Texture and Mesh mode tabs', () => {
    render(<GenerationPanel {...(commonProps as any)} />);
    expect(screen.getByRole('tab', { name: 'Shape' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Texture' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Mesh' })).toBeTruthy();
  });

  it('uses the compact four-option cleanup control', () => {
    render(<GenerationPanel {...(commonProps as any)} />);
    const control = screen.getByLabelText('Mesh cleanup preset');
    expect(control.className).toContain('cleanup-presets');
    expect(control.querySelectorAll('button')).toHaveLength(4);
  });

  it('shows Model only and Model + texture choices in Shape mode', () => {
    render(<GenerationPanel {...(commonProps as any)} />);
    expect(screen.getByRole('button', { name: 'Model only' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model + texture' })).toBeTruthy();
  });

  it('shows Light mesh cleanup selected in Shape mode', () => {
    render(<GenerationPanel {...(commonProps as any)} />);
    expect(screen.getByText('Mesh cleanup')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Light' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows all four texture profiles in one compact control when Model + texture is selected', () => {
    render(<GenerationPanel {...(commonProps as any)} outputMode="model-and-texture" />);
    const control = screen.getByLabelText('Texture profile');
    const scoped = within(control);
    expect(control.className).toContain('texture-profile-control');
    expect(control.querySelectorAll('button')).toHaveLength(4);
    for (const profile of ['Auto', 'Safe', 'Balanced', 'Quality']) {
      expect(scoped.getByRole('button', { name: new RegExp(profile, 'i') })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Generate model + texture' })).toBeTruthy();
  });

  it('shows mesh selection and Hunyuan Paint engine in Texture mode', () => {
    render(<GenerationPanel {...(commonProps as any)} workflowMode="texture" textureMeshPath="C:/shape.glb" />);
    expect(screen.getByLabelText('Texture engine')).toHaveProperty('value', 'hunyuan-paint');
    expect(screen.getByText('C:/shape.glb')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose model' })).toBeTruthy();
  });

  it('shows imported model and Game-ready cleanup in Mesh mode without shape or background controls', () => {
    render(
      <GenerationPanel
        {...(commonProps as any)}
        workflowMode="mesh"
        meshInputPath="C:/import.glb"
        cleanupPreset="game-ready"
        cleanupConfigLabel="Game-ready"
      />,
    );
    expect(screen.getByText('C:/import.glb')).toBeTruthy();
    expect(screen.getByText('Mesh cleanup')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Game-ready' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Shape quality')).toBeNull();
    expect(screen.queryByText('Remove background')).toBeNull();
    expect(screen.getByRole('button', { name: 'Process mesh' })).toBeTruthy();
  });

  it('defaults Game-ready triangle budget to Auto and hides manual target', () => {
    render(
      <GenerationPanel
        {...(commonProps as any)}
        workflowMode="mesh"
        meshInputPath="C:/import.glb"
        cleanupPreset="game-ready"
        cleanupConfigLabel="Game-ready"
      />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByRole('button', { name: 'Auto triangle budget' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Manual triangle budget' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByLabelText('Target triangles')).toBeNull();
  });

  it('emits a 5000 triangle target when Manual budget is selected', () => {
    const onCleanupOverridesChange = vi.fn();
    render(
      <GenerationPanel
        {...(commonProps as any)}
        workflowMode="mesh"
        meshInputPath="C:/import.glb"
        cleanupPreset="game-ready"
        cleanupConfigLabel="Game-ready"
        onCleanupOverridesChange={onCleanupOverridesChange}
      />,
    );

    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.click(screen.getByRole('button', { name: 'Manual triangle budget' }));
    expect(onCleanupOverridesChange).toHaveBeenCalledWith({
      triangle_budget_mode: 'manual',
      target_triangles: 5000,
    });
  });

  it('shows a visible warning for Aggressive cleanup', () => {
    render(
      <GenerationPanel
        {...(commonProps as any)}
        cleanupPreset="aggressive"
        cleanupConfigLabel="Aggressive"
      />,
    );
    expect(screen.getByText(/may alter silhouette/i)).toBeTruthy();
  });

  it('shows the custom preset label supplied by resolved settings', () => {
    render(
      <GenerationPanel
        {...(commonProps as any)}
        cleanupPreset="game-ready"
        cleanupConfigLabel="Custom (from Game-ready)"
      />,
    );
    expect(screen.getByText('Custom (from Game-ready)')).toBeTruthy();
  });

  it('disables Generate texture until image, mesh, runtime and backend are ready', () => {
    const { rerender } = render(
      <GenerationPanel {...(commonProps as any)} workflowMode="texture" textureAvailable={false} textureMeshPath={null} />,
    );
    expect(screen.getByRole('button', { name: 'Generate texture' })).toHaveProperty('disabled', true);

    rerender(
      <GenerationPanel {...(commonProps as any)} workflowMode="texture" textureAvailable textureMeshPath="C:/shape.glb" />,
    );
    expect(screen.getByRole('button', { name: 'Generate texture' })).toHaveProperty('disabled', false);
  });

  it('keeps non-native backends visibly unsupported without fallback', () => {
    render(<GenerationPanel {...(commonProps as any)} backend="wsl-rocm" />);
    expect(screen.getByText(/not executable in this workflow/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate model' })).toHaveProperty('disabled', true);
  });

  it('emits workflow, output and cleanup preset choices', () => {
    const onWorkflowModeChange = vi.fn();
    const onShapeOutputModeChange = vi.fn();
    const onCleanupPresetChange = vi.fn();
    render(
      <GenerationPanel
        {...(commonProps as any)}
        onWorkflowModeChange={onWorkflowModeChange}
        onShapeOutputModeChange={onShapeOutputModeChange}
        onCleanupPresetChange={onCleanupPresetChange}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Texture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model + texture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Game-ready' }));
    expect(onWorkflowModeChange).toHaveBeenCalledWith('texture');
    expect(onShapeOutputModeChange).toHaveBeenCalledWith('model-and-texture');
    expect(onCleanupPresetChange).toHaveBeenCalledWith('game-ready');
  });
});
