import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(name) {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
}

describe('ModelViewer UV foundation contract', () => {
  it('offers UV checker inspection and UV-template export from the loaded model', () => {
    const viewer = source('./ModelViewer.tsx');

    expect(viewer).toContain("'uv-checker'");
    expect(viewer).toContain('UV Checker');
    expect(viewer).toContain('Export UV template');
    expect(viewer).toContain('collectUvLayout');
    expect(viewer).toContain('buildUvTemplateSvg');
    expect(viewer).toContain('exportUvTemplate');
  });
});
