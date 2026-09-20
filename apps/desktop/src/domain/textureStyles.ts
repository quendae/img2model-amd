import type { TextureStylePreset } from './types';

export const DEFAULT_TEXTURE_STYLE_PRESET: TextureStylePreset = 'match-source';

export const TEXTURE_STYLE_OPTIONS: ReadonlyArray<{
  id: TextureStylePreset;
  label: string;
  description: string;
}> = [
  { id: 'match-source', label: 'Match source', description: 'Current Hunyuan Paint behavior; preserve the source image character.' },
  { id: 'realistic', label: 'Realistic', description: 'Style contract for a natural material/detail atlas pass.' },
  { id: 'stylized', label: 'Stylized', description: 'Style contract for simplified game-art treatment.' },
  { id: 'hand-painted', label: 'Hand-painted', description: 'Style contract for painterly color and reduced photographic detail.' },
  { id: 'cartoon', label: 'Cartoon', description: 'Style contract for broad color regions and graphic separation.' },
  { id: 'pixel-art', label: 'Pixel-art', description: 'Uses crisp nearest sampling for direct UV textures; atlas stylization comes next.' },
];

export function textureStyleDescription(style: TextureStylePreset): string {
  return TEXTURE_STYLE_OPTIONS.find((option) => option.id === style)?.description
    ?? TEXTURE_STYLE_OPTIONS[0].description;
}
