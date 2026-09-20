// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

afterEach(() => cleanup());

const props = {
  backend: 'native-rocm' as const,
  workflowMode: 'texture' as const,
  outputMode: 'model-only' as const,
  profile: 'balanced' as const,
  textureProfile: 'auto' as const,
  textureStylePreset: 'cartoon' as const,
  textureStyleStrength: 0.75,
  preserveSourceColors: true,
  styleReferencePath: null,
  textureEngine: 'hunyuan-paint' as const,
  textureMeshPath: 'C:/shape.glb',
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
  onTextureStylePresetChange: vi.fn(),
  onTextureStyleStrengthChange: vi.fn(),
  onPreserveSourceColorsChange: vi.fn(),
  onChooseStyleReference: vi.fn(),
  onClearStyleReference: vi.fn(),
  onTextureTargetTrianglesChange: vi.fn(),
  onCleanupPresetChange: vi.fn(),
  onCleanupOverridesChange: vi.fn(),
  onSeedChange: vi.fn(),
  onStepsChange: vi.fn(),
  onRemoveBackgroundChange: vi.fn(),
  onChooseMesh: vi.fn(),
  onGenerate: vi.fn(),
};

describe('GenerationPanel texture style controls', () => {
  it('shows functional style strength, preserve colors and reference controls for styled presets', () => {
    render(<GenerationPanel {...(props as any)} />);
    const strength = screen.getByLabelText('Style strength') as HTMLInputElement;
    expect(strength.value).toBe('75');
    expect((screen.getByLabelText('Preserve source colors') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Choose style reference' })).toBeTruthy();
  });

  it('dispatches strength and preserve-color changes', () => {
    const onTextureStyleStrengthChange = vi.fn();
    const onPreserveSourceColorsChange = vi.fn();
    render(
      <GenerationPanel
        {...(props as any)}
        onTextureStyleStrengthChange={onTextureStyleStrengthChange}
        onPreserveSourceColorsChange={onPreserveSourceColorsChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('Style strength'), { target: { value: '40' } });
    fireEvent.click(screen.getByLabelText('Preserve source colors'));
    expect(onTextureStyleStrengthChange).toHaveBeenCalledWith(0.4);
    expect(onPreserveSourceColorsChange).toHaveBeenCalledWith(false);
  });

  it('hides inactive stylizer controls for Match source', () => {
    render(<GenerationPanel {...(props as any)} textureStylePreset="match-source" />);
    expect(screen.queryByLabelText('Style strength')).toBeNull();
    expect(screen.queryByLabelText('Preserve source colors')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose style reference' })).toBeNull();
  });
});
