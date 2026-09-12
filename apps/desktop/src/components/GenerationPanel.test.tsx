// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

afterEach(() => cleanup());

const commonProps = {
  profile: 'balanced' as const,
  seed: 1234,
  steps: 30,
  removeBackground: true,
  texture: false,
  textureAvailable: false,
  busy: false,
  canGenerate: true,
  onBackendChange: vi.fn(),
  onProfileChange: vi.fn(),
  onSeedChange: vi.fn(),
  onStepsChange: vi.fn(),
  onRemoveBackgroundChange: vi.fn(),
  onTextureChange: vi.fn(),
  onGenerate: vi.fn(),
};

describe('GenerationPanel', () => {
  it('warns instead of silently falling back when WSL is selected', () => {
    render(<GenerationPanel {...commonProps} backend="wsl-rocm" />);

    expect(screen.getByText(/not executable in this MVP/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate shape/i })).toHaveProperty('disabled', true);
  });

  it('allows generation through native ROCm when input and output are ready', () => {
    const onGenerate = vi.fn();
    render(<GenerationPanel {...commonProps} backend="native-rocm" onGenerate={onGenerate} />);

    fireEvent.click(screen.getByRole('button', { name: /generate shape/i }));
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByText(/native ROCm worker/i)).toBeTruthy();
  });

  it('keeps texture opt-in disabled until the texture runtime is healthy', () => {
    render(<GenerationPanel {...commonProps} backend="native-rocm" textureAvailable={false} />);

    const texture = screen.getByRole('checkbox', { name: /generate texture/i });
    expect(texture).toHaveProperty('disabled', true);
    expect(screen.getByText(/texture runtime is not ready/i)).toBeTruthy();
  });

  it('allows explicit texture opt-in when the texture runtime is healthy', () => {
    const onTextureChange = vi.fn();
    render(
      <GenerationPanel
        {...commonProps}
        backend="native-rocm"
        textureAvailable
        onTextureChange={onTextureChange}
      />,
    );

    const texture = screen.getByRole('checkbox', { name: /generate texture/i });
    expect(texture).toHaveProperty('disabled', false);
    fireEvent.click(texture);
    expect(onTextureChange).toHaveBeenCalledWith(true);
  });
});
