import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXTURE_TARGET_TRIANGLES,
  MAX_TEXTURE_TARGET_TRIANGLES,
  MIN_TEXTURE_TARGET_TRIANGLES,
  TEXTURE_TRIANGLE_PRESETS,
  clampTextureTargetTriangles,
  texturePresetForTarget,
} from './texturePolycount';

describe('texture polycount presets', () => {
  it('exposes the approved game-ready triangle budgets and defaults to Hero', () => {
    expect(TEXTURE_TRIANGLE_PRESETS.map(({ id, triangles }) => [id, triangles])).toEqual([
      ['mobile', 500],
      ['low', 1_000],
      ['medium', 2_500],
      ['high', 5_000],
      ['hero', 10_000],
      ['quality', 40_000],
    ]);
    expect(DEFAULT_TEXTURE_TARGET_TRIANGLES).toBe(10_000);
  });

  it('keeps custom targets inside the approved GUI range', () => {
    expect(MIN_TEXTURE_TARGET_TRIANGLES).toBe(300);
    expect(MAX_TEXTURE_TARGET_TRIANGLES).toBe(40_000);
    expect(clampTextureTargetTriangles(120)).toBe(300);
    expect(clampTextureTargetTriangles(12_345)).toBe(12_345);
    expect(clampTextureTargetTriangles(90_000)).toBe(40_000);
  });

  it('recognizes exact presets and leaves other values as custom', () => {
    expect(texturePresetForTarget(5_000)).toBe('high');
    expect(texturePresetForTarget(10_000)).toBe('hero');
    expect(texturePresetForTarget(7_500)).toBe('custom');
  });
});
