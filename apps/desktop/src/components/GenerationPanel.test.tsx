// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  onSeedChange: vi.fn(),
  onStepsChange: vi.fn(),
  onRemoveBackgroundChange: vi.fn(),
  onChooseMesh: vi.fn(),
  onGenerate: vi.fn(),
};

describe('GenerationPanel', () => {
  it('shows Shape and Texture mode tabs', () => {
    render(<GenerationPanel {...commonProps} />);
    expect(screen.getByRole('tab', { name: 'Shape' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Texture' })).toBeTruthy();
  });

  it('shows Model only and Model + texture choices in Shape mode', () => {
    render(<GenerationPanel {...commonProps} />);
    expect(screen.getByRole('button', { name: 'Model only' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model + texture' })).toBeTruthy();
  });

  it('shows all four texture profiles when Model + texture is selected', () => {
    render(<GenerationPanel {...commonProps} outputMode="model-and-texture" />);
    for (const profile of ['Auto', 'Safe', 'Balanced', 'Quality']) {
      expect(screen.getByRole('button', { name: new RegExp(profile, 'i') })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Generate model + texture' })).toBeTruthy();
  });

  it('shows mesh selection and Hunyuan Paint engine in Texture mode', () => {
    render(<GenerationPanel {...commonProps} workflowMode="texture" textureMeshPath="C:/shape.glb" />);
    expect(screen.getByLabelText('Texture engine')).toHaveProperty('value', 'hunyuan-paint');
    expect(screen.getByText('C:/shape.glb')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose model' })).toBeTruthy();
  });

  it('disables Generate texture until image, mesh, runtime and backend are ready', () => {
    const { rerender } = render(
      <GenerationPanel {...commonProps} workflowMode="texture" textureAvailable={false} textureMeshPath={null} />,
    );
    expect(screen.getByRole('button', { name: 'Generate texture' })).toHaveProperty('disabled', true);

    rerender(
      <GenerationPanel {...commonProps} workflowMode="texture" textureAvailable textureMeshPath="C:/shape.glb" />,
    );
    expect(screen.getByRole('button', { name: 'Generate texture' })).toHaveProperty('disabled', false);
  });

  it('keeps non-native backends visibly unsupported without fallback', () => {
    render(<GenerationPanel {...commonProps} backend="wsl-rocm" />);
    expect(screen.getByText(/not executable in this workflow/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate model' })).toHaveProperty('disabled', true);
  });

  it('emits the selected workflow and profile choices', () => {
    const onWorkflowModeChange = vi.fn();
    const onShapeOutputModeChange = vi.fn();
    render(
      <GenerationPanel
        {...commonProps}
        onWorkflowModeChange={onWorkflowModeChange}
        onShapeOutputModeChange={onShapeOutputModeChange}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Texture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model + texture' }));
    expect(onWorkflowModeChange).toHaveBeenCalledWith('texture');
    expect(onShapeOutputModeChange).toHaveBeenCalledWith('model-and-texture');
  });
});
