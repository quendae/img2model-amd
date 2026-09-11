import { describe, expect, it } from 'vitest';
import { canTransition } from './jobState';
import type { JobState } from './types';

describe('canTransition', () => {
  it('allows the normal shape-generation path', () => {
    const path: JobState[] = [
      'queued',
      'preparing_input',
      'starting_backend',
      'running_shape',
      'postprocessing',
      'loading_preview',
      'completed',
    ];

    for (let index = 0; index < path.length - 1; index += 1) {
      expect(canTransition(path[index], path[index + 1])).toBe(true);
    }
  });

  it('allows cancellation while work is active', () => {
    for (const state of ['queued', 'preparing_input', 'starting_backend', 'running_shape', 'running_texture', 'postprocessing'] as JobState[]) {
      expect(canTransition(state, 'cancelled')).toBe(true);
    }
  });

  it('does not allow a completed job to restart itself', () => {
    expect(canTransition('completed', 'running_shape')).toBe(false);
  });
});
