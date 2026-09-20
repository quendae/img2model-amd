import type { TextureStylePreset } from './types';

export const DEFAULT_TEXTURE_STYLE_PRESET: TextureStylePreset = 'match-source';

export const TEXTURE_STYLE_OPTIONS: ReadonlyArray<{
  id: TextureStylePreset;
  label: string;
  description: string;
}> = [
  { id: 'match-source', label: 'Match source', description: 'Current Hunyuan Paint behavior; preserve the source image character.' },
  { id: 'realistic', label: 'Realistic', description: 'Adds contrast, color and detail to the generated atlas.' },
  { id: 'stylized', label: 'Stylized', description: 'Simplifies tones and colors for game-art readability.' },
  { id: 'hand-painted', label: 'Hand-painted', description: 'Smooths photographic detail into broader painted color regions.' },
  { id: 'cartoon', label: 'Cartoon', description: 'Posterizes color regions and adds graphic edge separation.' },
  { id: 'pixel-art', label: 'Pixel-art', description: 'Pixelates and palette-reduces the atlas, with nearest-neighbor sampling in the viewer.' },
];

export function textureStyleDescription(style: TextureStylePreset): string {
  return TEXTURE_STYLE_OPTIONS.find((option) => option.id === style)?.description
    ?? TEXTURE_STYLE_OPTIONS[0].description;
}
