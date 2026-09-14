// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationPanel } from './GenerationPanel';

afterEach(() => cleanup());

it('places Process mesh inside the generation action dock', () => {
  render(
    <GenerationPanel
      backend="native-rocm"
      workflowMode="mesh"
      outputMode="model-only"
      profile="balanced"
      textureProfile="auto"
      textureEngine="hunyuan-paint"
      textureMeshPath={null}
      meshInputPath="C:/import.glb"
      cleanupPreset="game-ready"
      cleanupConfigLabel="Game-ready"
      cleanupOverrides={{}}
      seed={1234}
      steps={30}
      removeBackground
      textureAvailable
      busy={false}
      canGenerate
      onBackendChange={vi.fn()}
      onWorkflowModeChange={vi.fn()}
      onShapeOutputModeChange={vi.fn()}
      onProfileChange={vi.fn()}
      onTextureProfileChange={vi.fn()}
      onCleanupPresetChange={vi.fn()}
      onCleanupOverridesChange={vi.fn()}
      onSeedChange={vi.fn()}
      onStepsChange={vi.fn()}
      onRemoveBackgroundChange={vi.fn()}
      onChooseMesh={vi.fn()}
      onGenerate={vi.fn()}
    />,
  );

  const action = screen.getByRole('button', { name: 'Process mesh' });
  expect(action.closest('.generation-action-dock')).not.toBeNull();
});
