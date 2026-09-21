import * as THREE from 'three';
import { createRepaintMask, maskBounds, type MaskBounds, type RepaintMask } from './localRepaintMask';

export interface EditableAtlas {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  flipY: boolean;
  name: string;
}

export interface PatchRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedRepaintPatch {
  sourcePatch: EditableAtlas;
  maskPatch: RepaintMask;
  rect: PatchRect;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function requireAtlasStorage(atlas: EditableAtlas, label = 'Atlas') {
  requirePositiveInteger(atlas.width, `${label} width`);
  requirePositiveInteger(atlas.height, `${label} height`);
  if (atlas.rgba.length !== atlas.width * atlas.height * 4) {
    throw new Error(`${label} RGBA storage does not match its dimensions.`);
  }
}

function clampedPadding(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function expandMaskBounds(
  bounds: MaskBounds,
  paddingPx: number,
  atlasWidth: number,
  atlasHeight: number,
): PatchRect {
  const width = requirePositiveInteger(atlasWidth, 'Atlas width');
  const height = requirePositiveInteger(atlasHeight, 'Atlas height');
  const padding = clampedPadding(paddingPx);
  const minX = Math.max(0, Math.min(width - 1, Math.floor(bounds.minX) - padding));
  const minY = Math.max(0, Math.min(height - 1, Math.floor(bounds.minY) - padding));
  const maxX = Math.max(minX, Math.min(width - 1, Math.ceil(bounds.maxX) + padding));
  const maxY = Math.max(minY, Math.min(height - 1, Math.ceil(bounds.maxY) + padding));
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function extractAtlasRgba(source: EditableAtlas, rect: PatchRect): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const sourceOffset = ((rect.y + y) * source.width + rect.x) * 4;
    const targetOffset = y * rect.width * 4;
    rgba.set(source.rgba.subarray(sourceOffset, sourceOffset + rect.width * 4), targetOffset);
  }
  return rgba;
}

function extractMask(source: RepaintMask, rect: PatchRect): RepaintMask {
  const patch = createRepaintMask(rect.width, rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const sourceOffset = (rect.y + y) * source.width + rect.x;
    const targetOffset = y * rect.width;
    patch.data.set(source.data.subarray(sourceOffset, sourceOffset + rect.width), targetOffset);
  }
  return patch;
}

export function extractRepaintPatch(
  atlas: EditableAtlas,
  mask: RepaintMask,
  paddingPx: number,
): ExtractedRepaintPatch {
  requireAtlasStorage(atlas);
  if (mask.width !== atlas.width || mask.height !== atlas.height) {
    throw new Error('Local Repaint mask dimensions must match the atlas.');
  }
  const bounds = maskBounds(mask);
  if (!bounds) throw new Error('Local Repaint mask is empty.');
  const rect = expandMaskBounds(bounds, paddingPx, atlas.width, atlas.height);
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Local Repaint patch dimensions must be positive.');
  return {
    sourcePatch: {
      width: rect.width,
      height: rect.height,
      rgba: extractAtlasRgba(atlas, rect),
      flipY: atlas.flipY,
      name: `${atlas.name || 'atlas'}-repaint-source`,
    },
    maskPatch: extractMask(mask, rect),
    rect,
  };
}

export function repaintMaskToEditableAtlas(mask: RepaintMask): EditableAtlas {
  requirePositiveInteger(mask.width, 'Local Repaint mask width');
  requirePositiveInteger(mask.height, 'Local Repaint mask height');
  if (mask.data.length !== mask.width * mask.height) {
    throw new Error('Local Repaint mask storage does not match its dimensions.');
  }

  const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let index = 0; index < mask.data.length; index += 1) {
    const value = mask.data[index];
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  return {
    width: mask.width,
    height: mask.height,
    rgba,
    flipY: false,
    name: 'local-repaint-mask',
  };
}

function featherAlpha(mask: RepaintMask, featherPx: number): Float32Array {
  const total = mask.width * mask.height;
  const alpha = new Float32Array(total);
  const radius = clampedPadding(featherPx);
  if (radius === 0) {
    for (let index = 0; index < total; index += 1) alpha[index] = mask.data[index] / 255;
    return alpha;
  }

  const distance = new Int32Array(total);
  distance.fill(-1);
  const queue = new Int32Array(total);
  let read = 0;
  let write = 0;

  for (let index = 0; index < total; index += 1) {
    const coverage = mask.data[index] / 255;
    if (coverage <= 0) continue;
    alpha[index] = coverage;
    distance[index] = 0;
    queue[write++] = index;
  }

  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],            [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ] as const;

  while (read < write) {
    const index = queue[read++];
    const currentDistance = distance[index];
    if (currentDistance >= radius) continue;
    const x = index % mask.width;
    const y = Math.floor(index / mask.width);
    const nextDistance = currentDistance + 1;
    for (const [dx, dy] of neighbors) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= mask.width || ny < 0 || ny >= mask.height) continue;
      const neighbor = ny * mask.width + nx;
      if (distance[neighbor] !== -1) continue;
      distance[neighbor] = nextDistance;
      alpha[neighbor] = (radius - nextDistance + 1) / (radius + 1);
      queue[write++] = neighbor;
    }
  }

  return alpha;
}

function validateRectWithinAtlas(rect: PatchRect, atlas: EditableAtlas) {
  if (
    !Number.isInteger(rect.x) || !Number.isInteger(rect.y)
    || !Number.isInteger(rect.width) || !Number.isInteger(rect.height)
    || rect.width <= 0 || rect.height <= 0
    || rect.x < 0 || rect.y < 0
    || rect.x + rect.width > atlas.width
    || rect.y + rect.height > atlas.height
  ) {
    throw new Error('Local Repaint patch rectangle is outside the source atlas.');
  }
}

export function compositeRepaintPatch(
  source: EditableAtlas,
  edited: EditableAtlas,
  maskPatch: RepaintMask,
  rect: PatchRect,
  featherPx: number,
): EditableAtlas {
  requireAtlasStorage(source, 'Source atlas');
  requireAtlasStorage(edited, 'Edited repaint patch');
  validateRectWithinAtlas(rect, source);
  if (edited.width !== rect.width || edited.height !== rect.height) {
    throw new Error('Edited repaint patch dimensions do not match the requested patch.');
  }
  if (maskPatch.width !== rect.width || maskPatch.height !== rect.height) {
    throw new Error('Local Repaint mask patch dimensions do not match the requested patch.');
  }

  const alpha = featherAlpha(maskPatch, featherPx);
  const rgba = new Uint8ClampedArray(source.rgba);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const patchPixel = y * rect.width + x;
      const weight = alpha[patchPixel];
      if (weight <= 0) continue;
      const sourcePixel = (rect.y + y) * source.width + rect.x + x;
      const sourceOffset = sourcePixel * 4;
      const editedOffset = patchPixel * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const before = source.rgba[sourceOffset + channel];
        const after = edited.rgba[editedOffset + channel];
        rgba[sourceOffset + channel] = Math.round(before * (1 - weight) + after * weight);
      }
    }
  }

  return { ...source, rgba };
}

function imageDimensions(image: CanvasImageSource): { width: number; height: number } {
  const candidate = image as CanvasImageSource & {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  };
  const width = Number(candidate.naturalWidth ?? candidate.videoWidth ?? candidate.width ?? 0);
  const height = Number(candidate.naturalHeight ?? candidate.videoHeight ?? candidate.height ?? 0);
  return { width, height };
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable for Local Repaint.');
  return context;
}

function atlasCanvas(atlas: EditableAtlas): HTMLCanvasElement {
  requireAtlasStorage(atlas);
  const canvas = document.createElement('canvas');
  canvas.width = atlas.width;
  canvas.height = atlas.height;
  const context = canvasContext(canvas);
  const pixels = context.createImageData(atlas.width, atlas.height);
  pixels.data.set(atlas.rgba);
  context.putImageData(pixels, 0, 0);
  return canvas;
}

export function captureEditableAtlas(texture: THREE.Texture): EditableAtlas {
  const image = texture.image as CanvasImageSource | null | undefined;
  if (!image) throw new Error('Local Repaint requires a readable base-color image.');
  const { width, height } = imageDimensions(image);
  requirePositiveInteger(Math.round(width), 'Base-color width');
  requirePositiveInteger(Math.round(height), 'Base-color height');
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const context = canvasContext(canvas);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8ClampedArray(imageData.data),
    flipY: texture.flipY,
    name: texture.name || 'base-color',
  };
}

export function atlasToCanvasTexture(atlas: EditableAtlas, sourceTexture: THREE.Texture): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(atlasCanvas(atlas));
  texture.name = atlas.name;
  texture.flipY = sourceTexture.flipY;
  texture.colorSpace = sourceTexture.colorSpace;
  texture.wrapS = sourceTexture.wrapS;
  texture.wrapT = sourceTexture.wrapT;
  texture.magFilter = sourceTexture.magFilter;
  texture.minFilter = sourceTexture.minFilter;
  texture.generateMipmaps = sourceTexture.generateMipmaps;
  texture.offset.copy(sourceTexture.offset);
  texture.repeat.copy(sourceTexture.repeat);
  texture.center.copy(sourceTexture.center);
  texture.rotation = sourceTexture.rotation;
  texture.updateMatrix();
  texture.needsUpdate = true;
  return texture;
}

export async function editableAtlasToPng(atlas: EditableAtlas): Promise<Uint8Array> {
  const canvas = atlasCanvas(atlas);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('Local Repaint could not encode the PNG patch.'));
    }, 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function loadBlobImage(blob: Blob): Promise<{ source: CanvasImageSource; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, release: () => bitmap.close() };
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Local Repaint returned an invalid PNG image.'));
      element.src = url;
    });
    return { source: image, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function pngBytesToEditableAtlas(bytes: Uint8Array): Promise<EditableAtlas> {
  if (bytes.length === 0) throw new Error('Local Repaint returned an empty PNG image.');
  const ownedBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ownedBuffer).set(bytes);
  const loaded = await loadBlobImage(new Blob([ownedBuffer], { type: 'image/png' }));
  try {
    const { width, height } = imageDimensions(loaded.source);
    const canvas = document.createElement('canvas');
    canvas.width = requirePositiveInteger(Math.round(width), 'Decoded repaint width');
    canvas.height = requirePositiveInteger(Math.round(height), 'Decoded repaint height');
    const context = canvasContext(canvas);
    context.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      rgba: new Uint8ClampedArray(imageData.data),
      flipY: false,
      name: 'local-repaint-result',
    };
  } finally {
    loaded.release();
  }
}
