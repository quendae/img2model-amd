import { describe, expect, it } from 'vitest';
import { createRepaintMask, stampMaskSamples } from './localRepaintMask';
import {
  compositeRepaintPatch,
  expandMaskBounds,
  extractRepaintPatch,
  repaintMaskToEditableAtlas,
  type EditableAtlas,
} from './localRepaintAtlas';

function atlas(width: number, height: number): EditableAtlas {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = (pixel * 17) % 256;
    rgba[offset + 1] = (pixel * 31) % 256;
    rgba[offset + 2] = (pixel * 47) % 256;
    rgba[offset + 3] = 255;
  }
  return { width, height, rgba, flipY: false, name: 'fixture' };
}

function solidPatch(width: number, height: number, rgbaValue: readonly [number, number, number, number]): EditableAtlas {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba.set(rgbaValue, pixel * 4);
  }
  return { width, height, rgba, flipY: false, name: 'edited' };
}

describe('Local Repaint atlas patching', () => {
  it('expands inclusive mask bounds with padding and clamps to atlas edges', () => {
    expect(expandMaskBounds({ minX: 2, minY: 3, maxX: 5, maxY: 6 }, 4, 10, 10))
      .toEqual({ x: 0, y: 0, width: 10, height: 10 });

    expect(expandMaskBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 2, 20, 20))
      .toEqual({ x: 3, y: 3, width: 5, height: 5 });
  });

  it('extracts matching source and mask patches from the padded rect', () => {
    const source = atlas(6, 5);
    const mask = createRepaintMask(6, 5);
    stampMaskSamples(mask, [{ x: 4, y: 2 }], 'paint', 0);

    const extracted = extractRepaintPatch(source, mask, 1);

    expect(extracted.rect).toEqual({ x: 3, y: 1, width: 3, height: 3 });
    expect(extracted.sourcePatch.width).toBe(3);
    expect(extracted.sourcePatch.height).toBe(3);
    expect(extracted.maskPatch.width).toBe(3);
    expect(extracted.maskPatch.height).toBe(3);
    expect(extracted.maskPatch.data[1 * 3 + 1]).toBe(255);
    expect(extracted.sourcePatch.rgba.slice(0, 4)).toEqual(source.rgba.slice((1 * 6 + 3) * 4, (1 * 6 + 3) * 4 + 4));
  });

  it('converts a repaint mask into opaque grayscale RGBA for PNG encoding', () => {
    const mask = createRepaintMask(2, 2);
    mask.data.set([0, 64, 128, 255]);

    const encoded = repaintMaskToEditableAtlas(mask);

    expect(encoded.width).toBe(2);
    expect(encoded.height).toBe(2);
    expect(encoded.flipY).toBe(false);
    expect(encoded.rgba).toEqual(new Uint8ClampedArray([
      0, 0, 0, 255,
      64, 64, 64, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ]));
  });

  it('changes exactly the selected pixel when feather is zero', () => {
    const source = atlas(4, 4);
    const before = new Uint8ClampedArray(source.rgba);
    const mask = createRepaintMask(4, 4);
    stampMaskSamples(mask, [{ x: 2, y: 1 }], 'paint', 0);
    const extracted = extractRepaintPatch(source, mask, 0);
    const edited = solidPatch(1, 1, [250, 20, 30, 255]);

    const after = compositeRepaintPatch(source, edited, extracted.maskPatch, extracted.rect, 0);
    const selectedPixel = 1 * 4 + 2;

    expect(after).not.toBe(source);
    expect(source.rgba).toEqual(before);
    expect(after.rgba.slice(selectedPixel * 4, selectedPixel * 4 + 4)).toEqual(new Uint8ClampedArray([250, 20, 30, 255]));
    for (let pixel = 0; pixel < 16; pixel += 1) {
      if (pixel === selectedPixel) continue;
      const offset = pixel * 4;
      expect(after.rgba.slice(offset, offset + 4)).toEqual(before.slice(offset, offset + 4));
    }
  });

  it('uses a deterministic feather band and leaves pixels beyond it unchanged', () => {
    const source = solidPatch(5, 5, [0, 0, 0, 255]);
    source.name = 'source';
    const mask = createRepaintMask(5, 5);
    stampMaskSamples(mask, [{ x: 2, y: 2 }], 'paint', 0);
    const extracted = extractRepaintPatch(source, mask, 2);
    const edited = solidPatch(5, 5, [200, 100, 50, 255]);

    const first = compositeRepaintPatch(source, edited, extracted.maskPatch, extracted.rect, 1);
    const second = compositeRepaintPatch(source, edited, extracted.maskPatch, extracted.rect, 1);

    expect(first.rgba).toEqual(second.rgba);
    expect(first.rgba[(2 * 5 + 2) * 4]).toBe(200);
    expect(first.rgba[(2 * 5 + 1) * 4]).toBeGreaterThan(0);
    expect(first.rgba[(2 * 5 + 1) * 4]).toBeLessThan(200);
    expect(first.rgba[(0 * 5 + 0) * 4]).toBe(0);
  });

  it('rejects an edited result whose dimensions differ from the extracted rect', () => {
    const source = atlas(6, 6);
    const mask = createRepaintMask(6, 6);
    stampMaskSamples(mask, [{ x: 3, y: 3 }], 'paint', 0);
    const extracted = extractRepaintPatch(source, mask, 1);
    const wrong = solidPatch(extracted.rect.width + 1, extracted.rect.height, [255, 0, 0, 255]);

    expect(() => compositeRepaintPatch(source, wrong, extracted.maskPatch, extracted.rect, 0))
      .toThrow('Edited repaint patch dimensions do not match the requested patch.');
  });

  it('rejects an empty mask and atlas/mask dimension mismatch before extraction', () => {
    const source = atlas(4, 4);
    expect(() => extractRepaintPatch(source, createRepaintMask(4, 4), 2)).toThrow('Local Repaint mask is empty.');

    const wrongMask = createRepaintMask(3, 4);
    stampMaskSamples(wrongMask, [{ x: 1, y: 1 }], 'paint', 0);
    expect(() => extractRepaintPatch(source, wrongMask, 2)).toThrow('Local Repaint mask dimensions must match the atlas.');
  });
});
