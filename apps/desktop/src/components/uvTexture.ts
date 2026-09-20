export interface UvTextureValidation {
  ok: boolean;
  warning: string | null;
  error: string | null;
}

export function validateUvTextureDimensions(
  width: number,
  height: number,
  expectedResolution = 2048,
): UvTextureValidation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      warning: null,
      error: 'Could not determine UV texture dimensions.',
    };
  }

  const normalizedWidth = Math.round(width);
  const normalizedHeight = Math.round(height);
  if (normalizedWidth !== normalizedHeight) {
    return {
      ok: false,
      warning: null,
      error: `UV texture must be square. Selected image is ${normalizedWidth}×${normalizedHeight}.`,
    };
  }

  const expected = Number.isFinite(expectedResolution) && expectedResolution > 0
    ? Math.round(expectedResolution)
    : 2048;
  if (normalizedWidth !== expected) {
    return {
      ok: true,
      warning: `Selected UV texture is ${normalizedWidth}×${normalizedHeight}; the exported template is ${expected}×${expected}. UV mapping will be preserved, but texel density will differ.`,
      error: null,
    };
  }

  return { ok: true, warning: null, error: null };
}
