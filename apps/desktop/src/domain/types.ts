export type BackendId = 'native-rocm' | 'wsl-rocm' | 'vulkan';

export type JobState =
  | 'queued'
  | 'preparing_input'
  | 'starting_backend'
  | 'running_shape'
  | 'running_texture'
  | 'postprocessing'
  | 'loading_preview'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BackendStatus {
  id: BackendId;
  label: string;
  installed: boolean;
  available: boolean;
  healthy: boolean;
  version?: string;
  lastError?: string;
}

export interface BackendDecision {
  backend?: BackendId;
  reason: string;
  error?: string;
}

export interface GenerationOptions {
  profile: 'fast' | 'balanced' | 'quality';
  texture: boolean;
  seed: number;
  steps: number;
}

export interface GenerationJob {
  id: string;
  inputPath: string;
  outputPath?: string;
  backend: BackendId;
  modelId: string;
  state: JobState;
  progress: number;
  options: GenerationOptions;
  error?: string;
}

export interface SystemDiagnostics {
  os: string;
  arch: string;
  wslAvailable: boolean;
  python?: string;
  amdGpus: string[];
}

export interface WorkerHealth {
  ok: boolean;
  python: string;
  torch_available: boolean;
  hunyuan_available: boolean;
  torch_version?: string | null;
  hip_version?: string | null;
  device_name?: string | null;
  error?: string | null;
}
