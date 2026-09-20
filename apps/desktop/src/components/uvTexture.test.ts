import { describe, expect, it } from 'vitest';
import { validateUvTextureDimensions } from './uvTexture';

describe('direct UV texture validation', () => {
  it('accepts an atlas that exactly matches the exported UV template resolution', () => {
    expect(validateUvTextureDimensions(2048, 2048, 2048)).toEqual({
      ok: true,
      warning: null,
      error: null,
    });
  });

  it('accepts a square atlas at a different resolution but reports the mismatch', () => {
    const result = validateUvTextureDimensions(1024, 1024, 2048);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.warning).toMatch(/1024.*2048/i);
  });

  it('rejects non-square atlases instead of silently stretching them', () => {
    const result = validateUvTextureDimensions(2048, 1024, 2048);

    expect(result.ok).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.error).toMatch(/square/i);
  });

  it('rejects missing or invalid image dimensions', () => {
    expect(validateUvTextureDimensions(0, 2048, 2048).ok).toBe(false);
    expect(validateUvTextureDimensions(Number.NaN, 2048, 2048).ok).toBe(false);
  });
});
