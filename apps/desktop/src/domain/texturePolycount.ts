export type TextureTrianglePreset = 'mobile' | 'low' | 'medium' | 'high' | 'hero' | 'quality' | 'custom';

export interface TextureTrianglePresetOption {
  id: Exclude<TextureTrianglePreset, 'custom'>;
  label: string;
  triangles: number;
}

export const MIN_TEXTURE_TARGET_TRIANGLES = 300;
export const MAX_TEXTURE_TARGET_TRIANGLES = 40_000;
export const DEFAULT_TEXTURE_TARGET_TRIANGLES = 10_000;

export const TEXTURE_TRIANGLE_PRESETS: TextureTrianglePresetOption[] = [
  { id: 'mobile', label: 'Mobile', triangles: 500 },
  { id: 'low', label: 'Low', triangles: 1_000 },
  { id: 'medium', label: 'Medium', triangles: 2_500 },
  { id: 'high', label: 'High', triangles: 5_000 },
  { id: 'hero', label: 'Hero', triangles: 10_000 },
  { id: 'quality', label: 'Quality', triangles: 40_000 },
];

export function clampTextureTargetTriangles(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXTURE_TARGET_TRIANGLES;
  return Math.min(MAX_TEXTURE_TARGET_TRIANGLES, Math.max(MIN_TEXTURE_TARGET_TRIANGLES, Math.round(value)));
}

export function texturePresetForTarget(value: number): TextureTrianglePreset {
  const match = TEXTURE_TRIANGLE_PRESETS.find((preset) => preset.triangles === value);
  return match?.id ?? 'custom';
}

export function textureTargetForPreset(preset: TextureTrianglePreset): number | null {
  if (preset === 'custom') return null;
  return TEXTURE_TRIANGLE_PRESETS.find((option) => option.id === preset)?.triangles ?? null;
}

export function textureTargetToSlider(value: number): number {
  const clamped = clampTextureTargetTriangles(value);
  const ratio = MAX_TEXTURE_TARGET_TRIANGLES / MIN_TEXTURE_TARGET_TRIANGLES;
  return Math.round((Math.log(clamped / MIN_TEXTURE_TARGET_TRIANGLES) / Math.log(ratio)) * 100);
}

export function textureSliderToTarget(position: number): number {
  const clamped = Math.min(100, Math.max(0, position));
  const ratio = MAX_TEXTURE_TARGET_TRIANGLES / MIN_TEXTURE_TARGET_TRIANGLES;
  const value = MIN_TEXTURE_TARGET_TRIANGLES * ratio ** (clamped / 100);
  return clampTextureTargetTriangles(Math.round(value / 100) * 100);
}
