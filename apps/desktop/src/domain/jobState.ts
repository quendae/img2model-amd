import type { JobState } from './types';

const transitions: Record<JobState, readonly JobState[]> = {
  queued: ['preparing_input', 'cancelled', 'failed'],
  preparing_input: ['starting_backend', 'cancelled', 'failed'],
  starting_backend: ['running_shape', 'cancelled', 'failed'],
  running_shape: ['running_texture', 'postprocessing', 'cancelled', 'failed'],
  running_texture: ['postprocessing', 'cancelled', 'failed'],
  postprocessing: ['loading_preview', 'cancelled', 'failed'],
  loading_preview: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}
