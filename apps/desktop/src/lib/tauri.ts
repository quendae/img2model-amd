import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type {
  BackendId,
  CleanupAdvancedOverrides,
  CleanupPreset,
  MeshCleanupReport,
  SystemDiagnostics,
  TextureEngineId,
  TextureHealth,
  TextureProfile,
  WorkerHealth,
} from '../domain/types';

export interface GenerateShapeRequest {
  backend: BackendId;
  input: string;
  output: string;
  model?: string;
  subfolder?: string;
  steps: number;
  seed: number;
  removeBackground: boolean;
}

export interface TextureMeshRequest {
  backend: BackendId;
  engine: TextureEngineId;
  profile: TextureProfile;
  maxFaces?: number;
  mesh: string;
  image: string;
  output: string;
  model?: string;
  subfolder?: string;
  removeBackground: boolean;
}

export interface MeshCleanupRequest {
  input: string;
  output: string;
  preset: CleanupPreset;
  overrides?: CleanupAdvancedOverrides;
}

export interface GenerateResult {
  ok: boolean;
  event: string;
  output?: string | null;
  error?: string | null;
  error_kind?: string | null;
  stage?: string | null;
  requested_profile?: string | null;
  resolved_profile?: string | null;
  faces_before?: number | null;
  faces_after?: number | null;
  max_faces?: number | null;
  model?: string | null;
  subfolder?: string | null;
  job_id?: string | null;
  cache_hit?: boolean | null;
  cache_kind?: string | null;
  image_cache_hit?: boolean | null;
  mesh_cache_hit?: boolean | null;
  cleanup_cache_hit?: boolean | null;
  cleanup_report?: MeshCleanupReport | null;
  mesh_cleanup_ms?: number | null;
  model_load_ms?: number | null;
  image_preprocess_ms?: number | null;
  mesh_preprocess_ms?: number | null;
  inference_ms?: number | null;
  preprocess_ms?: number | null;
  export_ms?: number | null;
  output_size_bytes?: number | null;
}

export interface WorkerProgressEvent {
  event: 'progress' | 'cache' | 'completed' | 'error' | string;
  job_id?: string | null;
  stage?: string | null;
  progress?: number | null;
  error_kind?: string | null;
  requested_profile?: string | null;
  resolved_profile?: string | null;
  faces_before?: number | null;
  faces_after?: number | null;
  max_faces?: number | null;
  cpu_offload?: boolean | null;
  attention_slicing?: string | null;
  cache_hit?: boolean | null;
  cache_kind?: string | null;
  image_cache_hit?: boolean | null;
  mesh_cache_hit?: boolean | null;
  cleanup_cache_hit?: boolean | null;
  cleanup_report?: MeshCleanupReport | null;
  mesh_cleanup_ms?: number | null;
  model_load_ms?: number | null;
  image_preprocess_ms?: number | null;
  mesh_preprocess_ms?: number | null;
  inference_ms?: number | null;
  preprocess_ms?: number | null;
  export_ms?: number | null;
}

export type ProgressHandler = (event: WorkerProgressEvent) => void;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function getSystemDiagnostics(): Promise<SystemDiagnostics> {
  if (!isTauri()) {
    return {
      os: navigator.platform || 'browser',
      arch: 'browser-dev',
      wslAvailable: false,
      python: undefined,
      amdGpus: [],
    };
  }
  return invoke<SystemDiagnostics>('get_system_diagnostics');
}

export async function getHunyuanHealth(): Promise<WorkerHealth> {
  if (!isTauri()) {
    return {
      ok: false,
      python: 'browser-dev',
      torch_available: false,
      hunyuan_available: false,
      torch_version: null,
      hip_version: null,
      device_name: null,
      error: 'Hunyuan health is available inside the Tauri desktop app.',
    };
  }
  return invoke<WorkerHealth>('hunyuan_health');
}

export async function getHunyuanTextureHealth(): Promise<TextureHealth> {
  if (!isTauri()) {
    return {
      ok: false,
      texgen_available: false,
      custom_rasterizer_available: false,
      mesh_processor_available: false,
      texture_import_ok: false,
      error: 'Texture health is available inside the Tauri desktop app.',
    };
  }
  return invoke<TextureHealth>('hunyuan_texture_health');
}

export async function preloadHunyuanShape(): Promise<GenerateResult> {
  if (!isTauri()) {
    throw new Error('Shape preload requires the Tauri desktop runtime.');
  }
  return invoke<GenerateResult>('preload_hunyuan_shape');
}

export async function chooseInputImage(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function chooseInputMesh(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '3D mesh', extensions: ['glb', 'obj'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function chooseOutputModel(defaultPath = 'model.glb'): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save({
    defaultPath,
    filters: [
      { name: 'glTF Binary', extensions: ['glb'] },
      { name: 'Wavefront OBJ', extensions: ['obj'] },
    ],
  });
  return selected ?? null;
}

function progressChannel(onProgress?: ProgressHandler): Channel<WorkerProgressEvent> {
  const channel = new Channel<WorkerProgressEvent>();
  channel.onmessage = (event) => onProgress?.(event);
  return channel;
}

export async function generateShape(
  request: GenerateShapeRequest,
  onProgress?: ProgressHandler,
): Promise<GenerateResult> {
  if (!isTauri()) {
    throw new Error('Generation requires the Tauri desktop runtime.');
  }
  return invoke<GenerateResult>('generate_shape', {
    request,
    onEvent: progressChannel(onProgress),
  });
}

export async function textureMesh(
  request: TextureMeshRequest,
  onProgress?: ProgressHandler,
): Promise<GenerateResult> {
  if (!isTauri()) {
    throw new Error('Texture generation requires the Tauri desktop runtime.');
  }
  return invoke<GenerateResult>('texture_mesh', {
    request,
    onEvent: progressChannel(onProgress),
  });
}

export async function cleanupMesh(
  request: MeshCleanupRequest,
  onProgress?: ProgressHandler,
): Promise<GenerateResult> {
  if (!isTauri()) {
    throw new Error('Mesh cleanup requires the Tauri desktop runtime.');
  }
  return invoke<GenerateResult>('cleanup_mesh', {
    request,
    onEvent: progressChannel(onProgress),
  });
}

export async function restartHunyuanWorker(): Promise<void> {
  if (!isTauri()) throw new Error('Worker restart requires the Tauri desktop runtime.');
  await invoke('restart_hunyuan_worker');
}

export async function clearHunyuanWorkerCache(): Promise<void> {
  if (!isTauri()) throw new Error('Worker cache control requires the Tauri desktop runtime.');
  await invoke('clear_hunyuan_worker_cache');
}

export function localAssetUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}
