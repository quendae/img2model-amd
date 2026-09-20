import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildUvTemplateSvg, collectUvLayout } from './uvTemplate';

describe('UV template foundation', () => {
  it('collects UV triangles and texture metadata from a loaded Three.js root', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ],
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        [
          0, 0,
          1, 0,
          1, 1,
          0, 0,
          1, 1,
          0, 1,
        ],
        2,
      ),
    );

    const material = new THREE.MeshStandardMaterial();
    material.map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));

    const layout = collectUvLayout(root);

    expect(layout.meshCount).toBe(1);
    expect(layout.uvMeshCount).toBe(1);
    expect(layout.triangleCount).toBe(2);
    expect(layout.materialCount).toBe(1);
    expect(layout.textureCount).toBe(1);
    expect(layout.triangles).toHaveLength(2);
  });

  it('exports a deterministic SVG with triangle guides, island boundaries and metadata', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ],
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute(
        [
          0, 0,
          1, 0,
          1, 1,
          0, 0,
          1, 1,
          0, 1,
        ],
        2,
      ),
    );
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const svg = buildUvTemplateSvg(collectUvLayout(root), { resolution: 1024 });

    expect(svg).toContain('viewBox="0 0 1024 1024"');
    expect(svg).toContain('id="img2model-uv-metadata"');
    expect(svg).toContain('"resolution":1024');
    expect(svg).toContain('"triangleCount":2');
    expect((svg.match(/data-edge-kind="boundary"/g) ?? [])).toHaveLength(4);
    expect(svg).toContain('data-edge-kind="triangle"');
  });
});
