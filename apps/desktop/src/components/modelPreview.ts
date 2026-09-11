export type PreviewModelFormat = 'glb' | 'obj';

export function modelFormatFromUrl(modelUrl: string): PreviewModelFormat {
  const pathname = modelUrl.split(/[?#]/, 1)[0].toLowerCase();
  if (pathname.endsWith('.glb') || pathname.endsWith('.gltf')) return 'glb';
  if (pathname.endsWith('.obj')) return 'obj';
  throw new Error(`Unsupported preview model format: ${modelUrl}`);
}
