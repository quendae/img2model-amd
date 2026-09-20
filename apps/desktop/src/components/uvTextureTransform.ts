import * as THREE from 'three';

export interface UvTextureTransform {
  scalePercent: number;
  rotationDegrees: number;
}

export const DEFAULT_UV_TEXTURE_TRANSFORM: UvTextureTransform = {
  scalePercent: 100,
  rotationDegrees: 0,
};

const MIN_SCALE_PERCENT = 50;
const MAX_SCALE_PERCENT = 200;

function normalizeDegrees(value: number): number {
  const normalized = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function normalizeUvTextureTransform(transform: UvTextureTransform): UvTextureTransform {
  const scale = Number.isFinite(transform.scalePercent)
    ? Math.min(MAX_SCALE_PERCENT, Math.max(MIN_SCALE_PERCENT, transform.scalePercent))
    : DEFAULT_UV_TEXTURE_TRANSFORM.scalePercent;
  const rotation = Number.isFinite(transform.rotationDegrees)
    ? normalizeDegrees(transform.rotationDegrees)
    : DEFAULT_UV_TEXTURE_TRANSFORM.rotationDegrees;

  return {
    scalePercent: scale,
    rotationDegrees: rotation,
  };
}

export function applyUvTextureTransform(texture: THREE.Texture, transform: UvTextureTransform): UvTextureTransform {
  const normalized = normalizeUvTextureTransform(transform);
  const repeat = 100 / normalized.scalePercent;
  const rotation = THREE.MathUtils.degToRad(normalized.rotationDegrees);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const center = 0.5;

  // KHR_texture_transform does not carry Three.js' `center` property. Encode the
  // same centered transform as an origin-based offset + scale + rotation so the
  // live preview and exported GLB use the same mapping.
  const offsetX = center - repeat * (cos * center + sin * center);
  const offsetY = center - repeat * (-sin * center + cos * center);

  texture.center.set(0, 0);
  texture.offset.set(offsetX, offsetY);
  texture.repeat.set(repeat, repeat);
  texture.rotation = rotation;
  texture.updateMatrix();
  texture.needsUpdate = true;

  return normalized;
}
