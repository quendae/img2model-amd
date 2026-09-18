export type BackendId = 'native-rocm' | 'wsl-rocm' | 'vulkan';

export type WorkflowMode = 'shape' | 'texture' | 'mesh';
export type ShapeOutputMode = 'model-only' | 'model-and-texture';
export type TextureProfile = 'auto' | 'safe' | 'balanced' | 'quality';
export type TextureEngineId = 'hunyuan-paint';
export type GenerationPhase = 'shape' | 'mesh' | 'texture';
export type CleanupPreset = 'off' | 'light' | 'game-ready' | 'aggressive';

export interface CleanupAdvancedOverrides {
  remove_degenerate?: boolean;
  weld_vertices?: boolean;
  weld_relative_epsilon?: number;
  remove_small_islands?: boolean;
  min_component_area_ratio?: number;
  spike_cleanup?: boolean;
  spike_edge_ratio?: number;
  spike_max_area_ratio?: number;
  spike_normal_angle_deg?: number;
  smooth_surface?: boolean;
  smoothing_iterations?: number;
  taubin_lambda?: number;
  taubin_nu?: number;
  recompute_normals?: boolean;
  triangle_budget_mode?: 'auto' | 'manual';
  target_triangles?: number | null;
}

export interface MeshCleanupReport {
  preset: CleanupPreset;
  config_label: string;
  algorithm_version: string;
  triangles_before: number;
  triangles_after: number;
  vertices_before: number;
  vertices_after: number;
  components_before: number;
  components_after: number;
  components_removed?: number | null;
  vertices_welded?: number | null;
  spikes_adjusted?: number | null;
  cleanup_ms: number;
  watertight_before?: boolean | null;
  watertight_after?: boolean | null;
  manifold_before?: boolean | null;
  manifold_after?: boolean | null;
  boundary_edges_before?: number | null;
  boundary_edges_after?: number | null;
  pre_repair_watertight?: boolean | null;
  pre_repair_manifold?: boolean | null;
  pre_repair_boundary_edges?: number | null;
  holes_closed?: number | null;
  non_manifold_edges_fixed?: number | null;
  reduction_ratio?: number | null;
  remeshed?: boolean | null;
  repair_backend?: string | null;
  normalized_error?: number | null;
  target_triangles?: number | null;
  stage_ms?: Record<string, number> | null;
  warnings: string[];
}

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
  meshCleanupMs?: number;
  textureMs?: number;
  totalMs: number;
  textureStages?: Record<string, number>;
  textureTargetTriangles?: number;
  trianglesBefore?: number;
  trianglesAfter?: number;
  resolvedTextureProfile?: Exclude<TextureProfile, 'auto'>;
  cacheHit?: boolean;
  cacheKind?: string;
  imageCacheHit?: boolean;
  meshCacheHit?: boolean;
  cleanupCacheHit?: boolean;
  cleanupReport?: MeshCleanupReport;
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
  maxFaces?: number;
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