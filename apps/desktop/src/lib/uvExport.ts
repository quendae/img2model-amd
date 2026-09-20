import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function browserDownload(svg: string, defaultPath: string): string {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
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

export async function exportUvTemplate(svg: string, defaultPath = 'model-uv-template.svg'): Promise<string | null> {
  if (!isTauri()) return browserDownload(svg, defaultPath);

  const selected = await save({
    defaultPath,
    filters: [{ name: 'UV template (SVG)', extensions: ['svg'] }],
  });
  if (!selected) return null;

  return invoke<string>('save_uv_template', {
    path: selected,
    contents: svg,
  });
}
