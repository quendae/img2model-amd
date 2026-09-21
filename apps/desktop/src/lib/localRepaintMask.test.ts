import { describe, expect, it } from 'vitest';
import {
  createRepaintMask,
  maskBounds,
  stampMaskSamples,
  textureUvToAtlasPixel,
  type TextureUvTransform,
} from './localRepaintMask';

const identityTransform: TextureUvTransform = {
  offsetX: 0,
  offsetY: 0,
  repeatX: 1,
  repeatY: 1,
  rotationRad: 0,
  centerX: 0,
  centerY: 0,
  flipY: false,
};

describe('Local Repaint atlas mask math', () => {
  it('creates an empty one-byte-per-pixel mask', () => {
    const mask = createRepaintMask(8, 6);
    expect(mask.width).toBe(8);
    expect(mask.height).toBe(6);
    expect(mask.data).toBeInstanceOf(Uint8ClampedArray);
    expect(mask.data).toHaveLength(48);
    expect([...mask.data].every((value) => value === 0)).toBe(true);
    expect(maskBounds(mask)).toBeNull();
  });

  it('paints and erases deterministic atlas pixels', () => {
    const mask = createRepaintMask(8, 8);
    stampMaskSamples(mask, [{ x: 4, y: 4 }], 'paint', 1);
    expect(mask.data[4 * 8 + 4]).toBe(255);
    expect(mask.data[4 * 8 + 3]).toBe(255);
    expect(mask.data[3 * 8 + 4]).toBe(255);
    expect(mask.data[3 * 8 + 3]).toBe(0);
    expect(maskBounds(mask)).toEqual({ minX: 3, minY: 3, maxX: 5, maxY: 5 });

    stampMaskSamples(mask, [{ x: 4, y: 4 }], 'erase', 1);
    expect(maskBounds(mask)).toBeNull();
  });

  it('does not paint a neighboring UV island that was not raycast-hit', () => {
    const mask = createRepaintMask(32, 32);
    stampMaskSamples(mask, [{ x: 10, y: 10 }], 'paint', 0);
    expect(mask.data[10 * 32 + 10]).toBe(255);
    expect(mask.data[10 * 32 + 11]).toBe(0);
    expect(mask.data[11 * 32 + 10]).toBe(0);
  });

  it('clamps circle stamps at atlas edges', () => {
    const mask = createRepaintMask(4, 4);
    stampMaskSamples(mask, [{ x: 0, y: 0 }], 'paint', 2);
    expect(maskBounds(mask)).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
    expect(mask.data[0]).toBe(255);
    expect(mask.data[3 * 4 + 3]).toBe(0);
  });

  it('maps identity UV coordinates to atlas pixels', () => {
    expect(textureUvToAtlasPixel({ x: 0.25, y: 0.75 }, 100, 100, identityTransform))
      .toEqual({ x: 25, y: 75 });
  });

  it('applies flipY before converting to atlas pixels', () => {
    expect(textureUvToAtlasPixel({ x: 0.25, y: 0.75 }, 100, 100, {
      ...identityTransform,
      flipY: true,
    })).toEqual({ x: 25, y: 25 });
  });

  it('applies repeat, rotation around center and offset consistently', () => {
    const transform: TextureUvTransform = {
      offsetX: 0.1,
      offsetY: 0.2,
      repeatX: 0.5,
      repeatY: 0.5,
      rotationRad: Math.PI / 2,
      centerX: 0.5,
      centerY: 0.5,
      flipY: false,
    };

    expect(textureUvToAtlasPixel({ x: 0.5, y: 0.5 }, 200, 100, transform))
      .toEqual({ x: 120, y: 70 });
  });

  it('clamps transformed UV coordinates to the atlas boundary', () => {
    expect(textureUvToAtlasPixel({ x: 2, y: -1 }, 16, 8, identityTransform))
      .toEqual({ x: 15, y: 0 });
  });
});
