import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function browserDownload(bytes: Uint8Array, defaultPath: string): string {
  const blob = new Blob([bytes.slice().buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = defaultPath;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return defaultPath;
}

export async function exportTexturedGlb(
  bytes: Uint8Array,
  defaultPath = 'model-uv-textured.glb',
): Promise<string | null> {
  if (!isTauri()) return browserDownload(bytes, defaultPath);

  const selected = await save({
    defaultPath,
    filters: [{ name: 'glTF Binary', extensions: ['glb'] }],
  });
  if (!selected) return null;

  return invoke<string>('save_textured_glb', {
    path: selected,
    bytes: Array.from(bytes),
  });
}
