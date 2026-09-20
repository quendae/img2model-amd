import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UV_TEXTURE_TRANSFORM,
  applyUvTextureTransform,
  normalizeUvTextureTransform,
} from './uvTextureTransform';

describe('direct UV texture transform', () => {
  it('scales and rotates the atlas around its center', () => {
    const texture = new THREE.Texture();
    const transform = normalizeUvTextureTransform({ scalePercent: 200, rotationDegrees: 90 });
    const versionBefore = texture.version;

    applyUvTextureTransform(texture, transform);

    expect(texture.center.x).toBeCloseTo(0.5);
    expect(texture.center.y).toBeCloseTo(0.5);
    expect(texture.repeat.x).toBeCloseTo(0.5);
    expect(texture.repeat.y).toBeCloseTo(0.5);
    expect(texture.rotation).toBeCloseTo(Math.PI / 2);
    expect(texture.version).toBeGreaterThan(versionBefore);
  });

  it('clamps scale and normalizes rotation to the supported UI range', () => {
    expect(normalizeUvTextureTransform({ scalePercent: 10, rotationDegrees: 270 })).toEqual({
      scalePercent: 50,
      rotationDegrees: -90,
    });
    expect(normalizeUvTextureTransform({ scalePercent: 500, rotationDegrees: -540 })).toEqual({
      scalePercent: 200,
      rotationDegrees: -180,
    });
  });

  it('defines reset as 100 percent scale and zero rotation', () => {
    expect(DEFAULT_UV_TEXTURE_TRANSFORM).toEqual({ scalePercent: 100, rotationDegrees: 0 });
  });
});
