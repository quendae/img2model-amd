// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

describe('GenerationPanel', () => {
  it('warns instead of silently falling back when WSL is selected', () => {
    render(
      <GenerationPanel
        backend="wsl-rocm"
        profile="balanced"
        seed={1234}
        steps={30}
        removeBackground
        busy={false}
        canGenerate
        onBackendChange={vi.fn()}
        onProfileChange={vi.fn()}
        onSeedChange={vi.fn()}
        onStepsChange={vi.fn()}
        onRemoveBackgroundChange={vi.fn()}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByText(/not executable in this MVP/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate shape/i })).toHaveProperty('disabled', true);
  });

  it('allows generation through native ROCm when input and output are ready', () => {
    const onGenerate = vi.fn();
    render(
      <GenerationPanel
        backend="native-rocm"
        profile="balanced"
        seed={1234}
        steps={30}
        removeBackground
        busy={false}
        canGenerate
        onBackendChange={vi.fn()}
        onProfileChange={vi.fn()}
        onSeedChange={vi.fn()}
        onStepsChange={vi.fn()}
        onRemoveBackgroundChange={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /generate shape/i }));
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByText(/native ROCm worker/i)).toBeTruthy();
  });
});
