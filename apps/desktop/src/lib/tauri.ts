import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { SystemDiagnostics, WorkerHealth } from '../domain/types';

export interface GenerateShapeRequest {
  backend: 'native-rocm' | 'wsl-rocm' | 'vulkan';
  input: string;
  output: string;
  model?: string;
  subfolder?: string;
  steps: number;
  seed: number;
  removeBackground: boolean;
}

export interface GenerateShapeResult {
  ok: boolean;
  event: string;
  output?: string | null;
  error?: string | null;
  model?: string | null;
  subfolder?: string | null;
}

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

export async function chooseInputImage(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

export async function chooseOutputModel(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save({
    defaultPath: 'model.glb',
    filters: [
      { name: 'glTF Binary', extensions: ['glb'] },
      { name: 'Wavefront OBJ', extensions: ['obj'] },
    ],
  });
  return selected ?? null;
}

export async function generateShape(request: GenerateShapeRequest): Promise<GenerateShapeResult> {
  if (!isTauri()) {
    throw new Error('Generation requires the Tauri desktop runtime.');
  }
  return invoke<GenerateShapeResult>('generate_shape', { request });
}

export function localAssetUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}
