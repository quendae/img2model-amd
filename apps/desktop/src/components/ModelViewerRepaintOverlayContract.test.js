import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ModelViewer.tsx', import.meta.url), 'utf8');
const refreshStart = source.indexOf('const refreshRepaintOverlay');
const installStart = source.indexOf('const installRepaintOverlay');
const resetStart = source.indexOf('const resetRepaintSession');

const refreshSection = source.slice(refreshStart, installStart);
const installSection = source.slice(installStart, resetStart);

describe('Local Repaint overlay render contract', () => {
  it('stores the mask in RGBA alpha so unpainted pixels are actually transparent', () => {
    expect(refreshSection).toContain('imageData.data[offset + 3] = value;');
    expect(refreshSection).not.toContain('imageData.data[offset + 3] = 255;');
  });

  it('renders the mask with an explicit shader that samples mask alpha', () => {
    expect(installSection).toContain('new THREE.ShaderMaterial');
    expect(installSection).toContain('uniform sampler2D maskMap');
    expect(installSection).toContain('texture2D(maskMap, vUv).a');
    expect(installSection).toContain('gl_FragColor');
    expect(installSection).not.toContain('new THREE.MeshBasicMaterial');
  });
});
