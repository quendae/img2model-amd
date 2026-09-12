import type { TextureProfile } from './types';

export const textureProfileLabels: Record<TextureProfile, string> = {
  auto: 'Auto',
  safe: 'Safe',
  balanced: 'Balanced',
  quality: 'Quality',
};

export const textureProfileDescriptions: Record<TextureProfile, string> = {
  auto: 'Chooses a conservative profile from detected GPU memory.',
  safe: 'Lowest memory pressure · 10k working triangles.',
  balanced: 'Medium working mesh · 20k triangles.',
  quality: 'Largest working mesh · 40k triangles.',
};
