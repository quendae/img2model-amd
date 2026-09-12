export type BackendId = 'native-rocm' | 'wsl-rocm' | 'vulkan';

export type WorkflowMode = 'shape' | 'texture';
export type ShapeOutputMode = 'model-only' | 'model-and-texture';
export type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';
export type TextureEngineId = 'hunyuan-paint';
export type GenerationPhase = 'shape' | 'texture';

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

export interface GenerationProgress {
  phase: GenerationPhase;
  value: number;
  label: string;
}

export interface GenerationTimingSummary {
  shapeMs?: number;
  textureMs?: number;
  totalMs: number;
  textureStages?: Record<string, number>;
  trianglesBefore?: number;
  trianglesAfter?: number;
  resolvedTextureProfile?: Exclude<TextureProfile, 'auto'>;
  cacheHit?: boolean;
  cacheKind?: string;
  imageCacheHit?: boolean;
  meshCacheHit?: boolean;
  modelLoadMs?: number;
  imagePreprocessMs?: number;
  meshPreprocessMs?: number;
  inferenceMs?: number;
  preprocessMs?: number;
  exportMs?: number;
}

export interface TextureRetryContext {
  image: string;
  mesh: string;
  output: string;
  backend: BackendId;
  engine: TextureEngineId;
  profile: TextureProfile;
  removeBackground: boolean;
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

export interface TextureHealth {
  ok: boolean;
  texgen_available: boolean;
  custom_rasterizer_available: boolean;
  mesh_processor_available: boolean;
  texture_import_ok: boolean;
  error?: string | null;
}
