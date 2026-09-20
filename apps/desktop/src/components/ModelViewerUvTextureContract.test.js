import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('ModelViewer direct UV texture contract', () => {
  it('offers deterministic UV texture import and textured GLB export controls', () => {
    const viewer = source('./ModelViewer.tsx');

    expect(viewer).toContain('Import UV texture');
    expect(viewer).toContain('Export textured GLB');
    expect(viewer).toContain('validateUvTextureDimensions');
    expect(viewer).toContain('chooseInputImage');
  });
});
