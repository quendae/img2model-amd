import * as THREE from 'three';

export type UvPoint = readonly [number, number];

export interface UvTriangle {
  a: UvPoint;
  b: UvPoint;
  c: UvPoint;
}

export interface UvLayout {
  triangles: UvTriangle[];
  meshCount: number;
  uvMeshCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
}

export interface UvTemplateOptions {
  resolution?: number;
}

function materialsFor(mesh: THREE.Mesh): THREE.Material[] {
  const value = mesh.material;
  return (Array.isArray(value) ? value : [value]).filter(Boolean) as THREE.Material[];
}

function textureValues(material: THREE.Material): THREE.Texture[] {
  const textures: THREE.Texture[] = [];
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture === true) {
      textures.push(value as THREE.Texture);
    }
  }
  return textures;
}

function attributeFor(geometry: THREE.BufferGeometry, name: string): THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null {
  if (typeof geometry.getAttribute !== 'function') return null;
  return geometry.getAttribute(name) ?? null;
}

function uvPoint(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number): UvPoint {
  return [Number(attribute.getX(index)), Number(attribute.getY(index))];
}

export function collectUvLayout(root: THREE.Object3D): UvLayout {
  const triangles: UvTriangle[] = [];
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let meshCount = 0;
  let uvMeshCount = 0;

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshCount += 1;

    for (const material of materialsFor(object)) {
      materials.add(material);
      for (const texture of textureValues(material)) textures.add(texture);
    }

    const geometry = object.geometry as THREE.BufferGeometry;
    const uv = attributeFor(geometry, 'uv');
    const position = attributeFor(geometry, 'position');
    if (!uv || !position || uv.count < 3 || position.count < 3) return;

    const index = typeof geometry.getIndex === 'function' ? geometry.getIndex() : null;
    const cornerCount = index?.count ?? position.count;
    if (cornerCount < 3) return;
    uvMeshCount += 1;

    const vertexIndexAt = (corner: number) => {
      const value = index ? Number(index.getX(corner)) : corner;
      return Number.isFinite(value) ? Math.trunc(value) : -1;
    };

    for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
      const ia = vertexIndexAt(corner);
      const ib = vertexIndexAt(corner + 1);
      const ic = vertexIndexAt(corner + 2);
      if (ia < 0 || ib < 0 || ic < 0 || ia >= uv.count || ib >= uv.count || ic >= uv.count) continue;
      triangles.push({ a: uvPoint(uv, ia), b: uvPoint(uv, ib), c: uvPoint(uv, ic) });
    }
  });

  return {
    triangles,
    meshCount,
    uvMeshCount,
    triangleCount: triangles.length,
    materialCount: materials.size,
    textureCount: textures.size,
  };
}

function normalizedResolution(value: number | undefined): number {
  if (!Number.isFinite(value)) return 2048;
  return Math.max(64, Math.min(16384, Math.round(value as number)));
}

function quantizedPointKey(point: UvPoint): string {
  const precision = 1_000_000;
  return `${Math.round(point[0] * precision)},${Math.round(point[1] * precision)}`;
}

function edgeKey(first: UvPoint, second: UvPoint): string {
  const a = quantizedPointKey(first);
  const b = quantizedPointKey(second);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(3)).toString();
}

function svgPoint(point: UvPoint, resolution: number): [number, number] {
  return [point[0] * resolution, (1 - point[1]) * resolution];
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildUvTemplateSvg(layout: UvLayout, options: UvTemplateOptions = {}): string {
  const resolution = normalizedResolution(options.resolution);
  const edgeOccurrences = new Map<string, { count: number; a: UvPoint; b: UvPoint }>();

  for (const triangle of layout.triangles) {
    for (const [a, b] of [
      [triangle.a, triangle.b],
      [triangle.b, triangle.c],
      [triangle.c, triangle.a],
    ] as const) {
      const key = edgeKey(a, b);
      const previous = edgeOccurrences.get(key);
      if (previous) previous.count += 1;
      else edgeOccurrences.set(key, { count: 1, a, b });
    }
  }

  const metadata = JSON.stringify({
    format: 'img2model-uv-template-v1',
    resolution,
    meshCount: layout.meshCount,
    uvMeshCount: layout.uvMeshCount,
    triangleCount: layout.triangleCount,
    materialCount: layout.materialCount,
    textureCount: layout.textureCount,
  });

  const trianglePaths = layout.triangles.map((triangle) => {
    const [ax, ay] = svgPoint(triangle.a, resolution);
    const [bx, by] = svgPoint(triangle.b, resolution);
    const [cx, cy] = svgPoint(triangle.c, resolution);
    return `    <path data-edge-kind="triangle" d="M ${svgNumber(ax)} ${svgNumber(ay)} L ${svgNumber(bx)} ${svgNumber(by)} L ${svgNumber(cx)} ${svgNumber(cy)} Z" />`;
  });

  const boundaryLines = [...edgeOccurrences.values()]
    .filter((edge) => edge.count === 1)
    .map((edge) => {
      const [ax, ay] = svgPoint(edge.a, resolution);
      const [bx, by] = svgPoint(edge.b, resolution);
      return `    <line data-edge-kind="boundary" x1="${svgNumber(ax)}" y1="${svgNumber(ay)}" x2="${svgNumber(bx)}" y2="${svgNumber(by)}" />`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${resolution}" height="${resolution}" viewBox="0 0 ${resolution} ${resolution}">`,
    `  <metadata id="img2model-uv-metadata">${escapeXml(metadata)}</metadata>`,
    '  <rect width="100%" height="100%" fill="#ffffff" />',
    '  <g fill="none" stroke="#b9bec6" stroke-width="0.6" vector-effect="non-scaling-stroke" opacity="0.55">',
    ...trianglePaths,
    '  </g>',
    '  <g fill="none" stroke="#111317" stroke-width="1.5" vector-effect="non-scaling-stroke">',
    ...boundaryLines,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
