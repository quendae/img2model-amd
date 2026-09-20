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

  texture.center.set(0.5, 0.5);
  texture.repeat.set(repeat, repeat);
  texture.rotation = THREE.MathUtils.degToRad(normalized.rotationDegrees);
  texture.needsUpdate = true;

  return normalized;
}
