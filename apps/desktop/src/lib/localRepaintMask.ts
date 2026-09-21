export interface RepaintMask {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface AtlasSample {
  x: number;
  y: number;
}

export interface MaskBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TextureUvTransform {
  offsetX: number;
  offsetY: number;
  repeatX: number;
  repeatY: number;
  rotationRad: number;
  centerX: number;
  centerY: number;
  flipY: boolean;
}

function requireDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createRepaintMask(width: number, height: number): RepaintMask {
  const resolvedWidth = requireDimension(width, 'Mask width');
  const resolvedHeight = requireDimension(height, 'Mask height');
  return {
    width: resolvedWidth,
    height: resolvedHeight,
    data: new Uint8ClampedArray(resolvedWidth * resolvedHeight),
  };
}

export function textureUvToAtlasPixel(
  uv: { x: number; y: number },
  width: number,
  height: number,
  transform: TextureUvTransform,
): AtlasSample {
  const resolvedWidth = requireDimension(width, 'Atlas width');
  const resolvedHeight = requireDimension(height, 'Atlas height');
  const cos = Math.cos(transform.rotationRad);
  const sin = Math.sin(transform.rotationRad);

  // Match Three.js Texture.setUvTransform/updateMatrix semantics. This allows
  // callers to pass the active texture's offset/repeat/rotation/center values
  // without importing Three.js into this pure math module.
  const transformedX = (
    transform.repeatX * cos * uv.x
    + transform.repeatX * sin * uv.y
    + transform.offsetX
    + transform.centerX
    - transform.repeatX * (cos * transform.centerX + sin * transform.centerY)
  );
  let transformedY = (
    -transform.repeatY * sin * uv.x
    + transform.repeatY * cos * uv.y
    + transform.offsetY
    + transform.centerY
    - transform.repeatY * (-sin * transform.centerX + cos * transform.centerY)
  );

  if (transform.flipY) transformedY = 1 - transformedY;

  return {
    x: clamp(Math.floor(transformedX * resolvedWidth), 0, resolvedWidth - 1),
    y: clamp(Math.floor(transformedY * resolvedHeight), 0, resolvedHeight - 1),
  };
}

export function stampMaskSamples(
  mask: RepaintMask,
  samples: readonly AtlasSample[],
  mode: 'paint' | 'erase',
  radiusPx: number,
): RepaintMask {
  const radius = Math.max(0, Math.floor(Number.isFinite(radiusPx) ? radiusPx : 0));
  const radiusSquared = radius * radius;
  const value = mode === 'paint' ? 255 : 0;

  for (const sample of samples) {
    const centerX = clamp(Math.round(sample.x), 0, mask.width - 1);
    const centerY = clamp(Math.round(sample.y), 0, mask.height - 1);
    const minX = Math.max(0, centerX - radius);
    const maxX = Math.min(mask.width - 1, centerX + radius);
    const minY = Math.max(0, centerY - radius);
    const maxY = Math.min(mask.height - 1, centerY + radius);

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        if (dx * dx + dy * dy > radiusSquared) continue;
        mask.data[y * mask.width + x] = value;
      }
    }
  }

  return mask;
}

export function maskBounds(mask: RepaintMask): MaskBounds | null {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}
