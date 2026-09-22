import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { writeDiagnosticLog } from '../lib/diagnosticLog';
import {
  atlasToCanvasTexture,
  captureEditableAtlas,
  compositeRepaintPatch,
  editableAtlasToPng,
  extractRepaintPatch,
  pngBytesToEditableAtlas,
  repaintMaskToEditableAtlas,
  type EditableAtlas,
} from '../lib/localRepaintAtlas';
import {
  createRepaintMask,
  maskBounds,
  stampMaskSamples,
  textureUvToAtlasPixel,
  type RepaintMask,
  type TextureUvTransform as RepaintTextureUvTransform,
} from '../lib/localRepaintMask';
import { exportTexturedGlb } from '../lib/modelExport';
import { cancelLocalRepaint, chooseInputImage, localAssetUrl, localRepaint } from '../lib/tauri';
import { exportUvTemplate } from '../lib/uvExport';
import type { TextureStylePreset } from '../domain/types';
import { modelFormatFromUrl } from './modelPreview';
import { buildUvTemplateSvg, collectUvLayout, type UvLayout } from './uvTemplate';
import { validateUvTextureDimensions } from './uvTexture';
import {
  DEFAULT_UV_TEXTURE_TRANSFORM,
  applyUvTextureTransform,
  normalizeUvTextureTransform,
  type UvTextureTransform,
} from './uvTextureTransform';

export interface ModelComparison {
  beforeUrl: string;
  afterUrl: string;
  beforeTriangles?: number;
  afterTriangles?: number;
}

type InspectionMode = 'solid' | 'wireframe' | 'solid-wire' | 'uv-checker';
type RepaintBrushMode = 'paint' | 'erase';
type RepaintAtlasError = 'no_albedo' | 'multiple_albedo';

interface ModelViewerProps {
  modelUrl: string | null;
  comparison?: ModelComparison | null;
  busy: boolean;
  progress?: number | null;
  progressLabel?: string | null;
  textureStylePreset?: TextureStylePreset;
}

interface UvTextureInfo {
  path: string;
  name: string;
  width: number;
  height: number;
  warning: string | null;
  meshCount: number;
  materialCount: number;
}

interface TransformSnapshot {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

interface InternalViewerDataSnapshot {
  mesh: THREE.Mesh;
  hadOriginal: boolean;
  original: unknown;
  hadChecker: boolean;
  checker: unknown;
}

interface EditableAtlasResolution {
  texture: THREE.Texture | null;
  meshes: THREE.Mesh[];
  error: RepaintAtlasError | null;
}

const WIRE_OVERLAY_KEY = 'img2modelWireOverlay';
const ORIGINAL_MATERIAL_KEY = 'img2modelOriginalMaterial';
const UV_CHECKER_MATERIAL_KEY = 'img2modelUvCheckerMaterial';
const REPAINT_OVERLAY_KEY = 'img2modelRepaintOverlay';
const UV_TEMPLATE_RESOLUTION = 2048;
const LOCAL_REPAINT_PADDING_PX = 32;
const LOCAL_REPAINT_FEATHER_PX = 8;

function setMaterialWireframe(material: THREE.Material, enabled: boolean) {
  const candidate = material as THREE.Material & { wireframe?: boolean };
  if (typeof candidate.wireframe === 'boolean') {
    candidate.wireframe = enabled;
    candidate.needsUpdate = true;
  }
}

function wireOverlayFor(mesh: THREE.Mesh): THREE.LineSegments | null {
  return (mesh.children.find((child) => child.userData?.[WIRE_OVERLAY_KEY] === true) as THREE.LineSegments | undefined) ?? null;
}

function ensureWireOverlay(mesh: THREE.Mesh): THREE.LineSegments {
  const existing = wireOverlayFor(mesh);
  if (existing) return existing;

  const geometry = new THREE.WireframeGeometry(mesh.geometry);
  const material = new THREE.LineBasicMaterial({
    color: 0xf1f3f5,
    transparent: true,
    opacity: 0.72,
    depthTest: true,
    depthWrite: false,
  });
  const overlay = new THREE.LineSegments(geometry, material);
  overlay.userData[WIRE_OVERLAY_KEY] = true;
  overlay.renderOrder = 2;
  overlay.visible = false;
  mesh.add(overlay);
  return overlay;
}

function isRepaintOverlay(object: THREE.Object3D): boolean {
  return object.userData?.[REPAINT_OVERLAY_KEY] === true;
}

function originalMaterialFor(mesh: THREE.Mesh): THREE.Material | THREE.Material[] {
  if (mesh.userData[ORIGINAL_MATERIAL_KEY] === undefined) {
    mesh.userData[ORIGINAL_MATERIAL_KEY] = mesh.material;
  }
  return mesh.userData[ORIGINAL_MATERIAL_KEY] as THREE.Material | THREE.Material[];
}

function restoreOriginalMaterial(mesh: THREE.Mesh) {
  const original = mesh.userData[ORIGINAL_MATERIAL_KEY] as THREE.Material | THREE.Material[] | undefined;
  if (original !== undefined) mesh.material = original;
}

function uvCheckerMaterialFor(mesh: THREE.Mesh): THREE.ShaderMaterial {
  const existing = mesh.userData[UV_CHECKER_MATERIAL_KEY] as THREE.ShaderMaterial | undefined;
  if (existing) return existing;

  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    toneMapped: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        vec2 grid = vUv * 16.0;
        float parity = mod(floor(grid.x) + floor(grid.y), 2.0);
        vec3 darkCell = vec3(0.12, 0.16, 0.22);
        vec3 lightCell = vec3(0.78, 0.84, 0.91);
        vec3 color = mix(darkCell, lightCell, parity);
        vec2 cell = fract(grid);
        float distanceToLine = min(min(cell.x, 1.0 - cell.x), min(cell.y, 1.0 - cell.y));
        float gridLine = 1.0 - smoothstep(0.025, 0.055, distanceToLine);
        color = mix(color, vec3(0.92, 0.27, 0.22), gridLine * 0.82);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  mesh.userData[UV_CHECKER_MATERIAL_KEY] = material;
  return material;
}

function meshHasUv(mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  return typeof geometry.getAttribute === 'function' && Boolean(geometry.getAttribute('uv'));
}

function applyInspectionMode(root: THREE.Object3D, mode: InspectionMode) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || isRepaintOverlay(object)) return;

    const original = originalMaterialFor(object);
    restoreOriginalMaterial(object);
    const materials = Array.isArray(original) ? original : [original];
    materials.forEach((material) => setMaterialWireframe(material, mode === 'wireframe'));

    const existingOverlay = wireOverlayFor(object);
    if (mode === 'solid-wire') {
      ensureWireOverlay(object).visible = true;
    } else if (existingOverlay) {
      existingOverlay.visible = false;
    }

    if (mode === 'uv-checker' && meshHasUv(object)) {
      object.material = uvCheckerMaterialFor(object);
    }
  });
}

function disposeMaterialValue(value: THREE.Material | THREE.Material[] | undefined, disposed: Set<THREE.Material>) {
  if (!value) return;
  const materials = Array.isArray(value) ? value : [value];
  for (const material of materials) {
    if (disposed.has(material)) continue;
    disposed.add(material);
    material.dispose();
  }
}

function disposeLoadedRoot(root: THREE.Object3D) {
  const disposedMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      if (isRepaintOverlay(object)) {
        disposeMaterialValue(object.material as THREE.Material | THREE.Material[], disposedMaterials);
        return;
      }
      object.geometry?.dispose();
      disposeMaterialValue(object.material as THREE.Material | THREE.Material[], disposedMaterials);
      disposeMaterialValue(
        object.userData[ORIGINAL_MATERIAL_KEY] as THREE.Material | THREE.Material[] | undefined,
        disposedMaterials,
      );
      disposeMaterialValue(
        object.userData[UV_CHECKER_MATERIAL_KEY] as THREE.Material | undefined,
        disposedMaterials,
      );
      return;
    }

    if (object instanceof THREE.LineSegments && object.userData?.[WIRE_OVERLAY_KEY] === true) {
      object.geometry?.dispose();
      disposeMaterialValue(object.material as THREE.Material | THREE.Material[], disposedMaterials);
    }
  });
}

function materialsForMesh(mesh: THREE.Mesh): THREE.Material[] {
  const source = mesh.userData[ORIGINAL_MATERIAL_KEY] ?? mesh.material;
  return (Array.isArray(source) ? source : [source]).filter(Boolean) as THREE.Material[];
}

function materialBaseColorTexture(material: THREE.Material): THREE.Texture | null {
  const candidate = material as THREE.Material & { map?: THREE.Texture | null };
  return 'map' in candidate && candidate.map ? candidate.map : null;
}

function resolveEditableBaseColorTexture(root: THREE.Object3D, preferred: THREE.Texture | null = null): EditableAtlasResolution {
  const byTexture = new Map<THREE.Texture, THREE.Mesh[]>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || isRepaintOverlay(object) || !meshHasUv(object)) return;
    for (const material of materialsForMesh(object)) {
      const texture = materialBaseColorTexture(material);
      if (!texture) continue;
      const meshes = byTexture.get(texture) ?? [];
      if (!meshes.includes(object)) meshes.push(object);
      byTexture.set(texture, meshes);
    }
  });

  if (preferred && byTexture.has(preferred)) {
    return { texture: preferred, meshes: byTexture.get(preferred) ?? [], error: null };
  }
  if (byTexture.size === 0) return { texture: null, meshes: [], error: 'no_albedo' };
  if (byTexture.size > 1) return { texture: null, meshes: [], error: 'multiple_albedo' };
  const [texture, meshes] = [...byTexture.entries()][0];
  return { texture, meshes, error: null };
}

function repaintTextureTransform(texture: THREE.Texture): RepaintTextureUvTransform {
  return {
    offsetX: texture.offset?.x ?? 0,
    offsetY: texture.offset?.y ?? 0,
    repeatX: texture.repeat?.x ?? 1,
    repeatY: texture.repeat?.y ?? 1,
    rotationRad: texture.rotation ?? 0,
    centerX: texture.center?.x ?? 0,
    centerY: texture.center?.y ?? 0,
    flipY: texture.flipY ?? false,
  };
}

function brushDiskSamples(sizePx: number): Array<readonly [number, number]> {
  const radius = Math.max(0, sizePx / 2);
  const step = Math.max(1, Math.floor(radius / 5));
  const samples: Array<readonly [number, number]> = [];
  for (let y = -radius; y <= radius; y += step) {
    for (let x = -radius; x <= radius; x += step) {
      if (x * x + y * y <= radius * radius) samples.push([x, y]);
    }
  }
  if (!samples.some(([x, y]) => x === 0 && y === 0)) samples.push([0, 0]);
  return samples;
}

function copyTextureSampling(source: THREE.Texture, target: THREE.Texture) {
  target.flipY = source.flipY;
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.offset.copy(source.offset);
  target.repeat.copy(source.repeat);
  target.center.copy(source.center);
  target.rotation = source.rotation;
  target.updateMatrix();
  target.needsUpdate = true;
}

function modelStem(modelUrl: string | null): string {
  if (!modelUrl) return 'model';
  const withoutQuery = modelUrl.split(/[?#]/, 1)[0];
  const lastSegment = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) ?? 'model';
  const decoded = (() => {
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  })();
  return decoded.replace(/\.[^.]+$/, '') || 'model';
}

function uvTemplateFilename(modelUrl: string | null): string {
  return `${modelStem(modelUrl)}-uv-template.svg`;
}

function texturedModelFilename(modelUrl: string | null): string {
  return `${modelStem(modelUrl)}-uv-textured.glb`;
}

function inputFilename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'UV texture';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function captureTransform(root: THREE.Object3D): TransformSnapshot {
  const position = root.position as unknown as { x?: number; y?: number; z?: number };
  const quaternion = (root as unknown as { quaternion?: { x?: number; y?: number; z?: number; w?: number } }).quaternion;
  const scale = root.scale as unknown as { x?: number; y?: number; z?: number };
  return {
    position: [finiteOr(position.x, 0), finiteOr(position.y, 0), finiteOr(position.z, 0)],
    quaternion: [
      finiteOr(quaternion?.x, 0),
      finiteOr(quaternion?.y, 0),
      finiteOr(quaternion?.z, 0),
      finiteOr(quaternion?.w, 1),
    ],
    scale: [finiteOr(scale.x, 1), finiteOr(scale.y, 1), finiteOr(scale.z, 1)],
  };
}

function applyTransform(root: THREE.Object3D, snapshot: TransformSnapshot) {
  root.position.set(...snapshot.position);
  root.quaternion.set(...snapshot.quaternion);
  root.scale.set(...snapshot.scale);
}

function updateWorldMatrix(root: THREE.Object3D) {
  const candidate = root as THREE.Object3D & { updateMatrixWorld?: (force?: boolean) => void };
  candidate.updateMatrixWorld?.(true);
}

function detachInternalViewerData(root: THREE.Object3D): InternalViewerDataSnapshot[] {
  const snapshots: InternalViewerDataSnapshot[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || isRepaintOverlay(object)) return;
    const hadOriginal = Object.prototype.hasOwnProperty.call(object.userData, ORIGINAL_MATERIAL_KEY);
    const hadChecker = Object.prototype.hasOwnProperty.call(object.userData, UV_CHECKER_MATERIAL_KEY);
    snapshots.push({
      mesh: object,
      hadOriginal,
      original: object.userData[ORIGINAL_MATERIAL_KEY],
      hadChecker,
      checker: object.userData[UV_CHECKER_MATERIAL_KEY],
    });
    delete object.userData[ORIGINAL_MATERIAL_KEY];
    delete object.userData[UV_CHECKER_MATERIAL_KEY];
  });
  return snapshots;
}

function restoreInternalViewerData(snapshots: InternalViewerDataSnapshot[]) {
  for (const snapshot of snapshots) {
    if (snapshot.hadOriginal) snapshot.mesh.userData[ORIGINAL_MATERIAL_KEY] = snapshot.original;
    if (snapshot.hadChecker) snapshot.mesh.userData[UV_CHECKER_MATERIAL_KEY] = snapshot.checker;
  }
}

function imageDimensions(texture: THREE.Texture): [number, number] {
  const image = texture.image as {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  } | null | undefined;
  return [
    Number(image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0),
    Number(image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0),
  ];
}

function loadUvTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, resolve, undefined, reject);
  });
}

function applyUvTexture(root: THREE.Object3D, texture: THREE.Texture): { meshCount: number; materialCount: number } {
  let meshCount = 0;
  const changedMaterials = new Set<THREE.Material>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || isRepaintOverlay(object) || !meshHasUv(object)) return;
    const baseMaterials = originalMaterialFor(object);
    const materials = Array.isArray(baseMaterials) ? baseMaterials : [baseMaterials];
    let changedMesh = false;

    for (const material of materials) {
      const candidate = material as THREE.Material & { map?: THREE.Texture | null };
      if (!(material && 'map' in candidate)) continue;
      candidate.map = texture;
      candidate.needsUpdate = true;
      changedMaterials.add(material);
      changedMesh = true;
    }

    if (changedMesh) meshCount += 1;
  });

  return { meshCount, materialCount: changedMaterials.size };
}

export function ModelViewer({ modelUrl, comparison, busy, progress, progressLabel, textureStylePreset = 'match-source' }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadedRootRef = useRef<THREE.Object3D | null>(null);
  const originalTransformRef = useRef<TransformSnapshot | null>(null);
  const importedTextureRef = useRef<THREE.Texture | null>(null);
  const currentAtlasRef = useRef<EditableAtlas | null>(null);
  const repaintModeRef = useRef(false);
  const repaintBrushModeRef = useRef<RepaintBrushMode>('paint');
  const repaintBrushSizeRef = useRef(32);
  const repaintMaskRef = useRef<RepaintMask | null>(null);
  const repaintTextureRef = useRef<THREE.Texture | null>(null);
  const repaintEditableMeshesRef = useRef<THREE.Mesh[]>([]);
  const repaintOverlayMeshesRef = useRef<THREE.Mesh[]>([]);
  const repaintOverlayTextureRef = useRef<THREE.CanvasTexture | null>(null);
  const repaintOverlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const repaintCancelRequestedRef = useRef(false);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [comparisonSide, setComparisonSide] = useState<'before' | 'after'>('after');
  const [inspectionMode, setInspectionMode] = useState<InspectionMode>('solid');
  const [uvLayout, setUvLayout] = useState<UvLayout | null>(null);
  const [uvExportStatus, setUvExportStatus] = useState<string | null>(null);
  const [uvTextureStatus, setUvTextureStatus] = useState<string | null>(null);
  const [uvTextureInfo, setUvTextureInfo] = useState<UvTextureInfo | null>(null);
  const [uvTextureBusy, setUvTextureBusy] = useState(false);
  const [uvTextureTransform, setUvTextureTransform] = useState<UvTextureTransform>(() => ({
    ...DEFAULT_UV_TEXTURE_TRANSFORM,
  }));
  const [repaintMode, setRepaintMode] = useState(false);
  const [repaintBrushMode, setRepaintBrushMode] = useState<RepaintBrushMode>('paint');
  const [repaintBrushSizePx, setRepaintBrushSizePx] = useState(32);
  const [, setRepaintMask] = useState<RepaintMask | null>(null);
  const [repaintHasMask, setRepaintHasMask] = useState(false);
  const [repaintPrompt, setRepaintPrompt] = useState('');
  const [repaintReferencePath, setRepaintReferencePath] = useState<string | null>(null);
  const [repaintBusy, setRepaintBusy] = useState(false);
  const [repaintCanRetry, setRepaintCanRetry] = useState(false);
  const [repaintStatus, setRepaintStatus] = useState<string | null>(null);
  const [repaintAtlasError, setRepaintAtlasError] = useState<RepaintAtlasError | null>(null);

  const disposeRepaintOverlay = () => {
    for (const overlay of repaintOverlayMeshesRef.current) {
      overlay.parent?.remove(overlay);
      const material = overlay.material;
      (Array.isArray(material) ? material : [material]).forEach((entry) => entry.dispose());
    }
    repaintOverlayMeshesRef.current = [];
    repaintOverlayTextureRef.current?.dispose();
    repaintOverlayTextureRef.current = null;
    repaintOverlayCanvasRef.current = null;
  };

  const refreshRepaintOverlay = (mask: RepaintMask) => {
    const canvas = repaintOverlayCanvasRef.current;
    const texture = repaintOverlayTextureRef.current;
    if (!canvas || !texture) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const imageData = context.createImageData(mask.width, mask.height);
    for (let index = 0; index < mask.data.length; index += 1) {
      const value = mask.data[index];
      const offset = index * 4;
      imageData.data[offset] = 255;
      imageData.data[offset + 1] = 255;
      imageData.data[offset + 2] = 255;
      imageData.data[offset + 3] = value;
    }
    context.putImageData(imageData, 0, 0);
    texture.needsUpdate = true;
  };

  const installRepaintOverlay = (meshes: THREE.Mesh[], sourceTexture: THREE.Texture, mask: RepaintMask) => {
    disposeRepaintOverlay();
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const texture = new THREE.CanvasTexture(canvas);
    copyTextureSampling(sourceTexture, texture);
    repaintOverlayCanvasRef.current = canvas;
    repaintOverlayTextureRef.current = texture;

    const overlays: THREE.Mesh[] = [];
    for (const mesh of meshes) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          maskMap: { value: texture },
          overlayColor: { value: new THREE.Color(0xff6655) },
          overlayOpacity: { value: 0.72 },
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D maskMap;
          uniform vec3 overlayColor;
          uniform float overlayOpacity;
          varying vec2 vUv;
          void main() {
            float maskAlpha = texture2D(maskMap, vUv).a;
            if (maskAlpha <= 0.001) discard;
            gl_FragColor = vec4(overlayColor, maskAlpha * overlayOpacity);
          }
        `,
      });
      const overlay = new THREE.Mesh(mesh.geometry, material);
      overlay.userData[REPAINT_OVERLAY_KEY] = true;
      overlay.renderOrder = 3;
      mesh.add(overlay);
      overlays.push(overlay);
    }
    repaintOverlayMeshesRef.current = overlays;
    refreshRepaintOverlay(mask);
  };

  const resetRepaintSession = (closePanel = true) => {
    disposeRepaintOverlay();
    repaintMaskRef.current = null;
    repaintTextureRef.current = null;
    repaintEditableMeshesRef.current = [];
    repaintModeRef.current = false;
    repaintCancelRequestedRef.current = false;
    setRepaintMask(null);
    setRepaintHasMask(false);
    setRepaintCanRetry(false);
    setRepaintAtlasError(null);
    setRepaintStatus(null);
    if (closePanel) setRepaintMode(false);
  };

  useEffect(() => {
    setComparisonSide('after');
  }, [comparison?.beforeUrl, comparison?.afterUrl]);

  useEffect(() => {
    if (loadedRootRef.current) applyInspectionMode(loadedRootRef.current, inspectionMode);
  }, [inspectionMode]);

  const activeModelUrl = comparison
    ? comparisonSide === 'before'
      ? comparison.beforeUrl
      : comparison.afterUrl
    : modelUrl;

  useEffect(() => {
    resetRepaintSession();
    importedTextureRef.current?.dispose();
    importedTextureRef.current = null;
    currentAtlasRef.current = null;
    originalTransformRef.current = null;
    setUvLayout(null);
    setUvExportStatus(null);
    setUvTextureStatus(null);
    setUvTextureInfo(null);
    setUvTextureBusy(false);
    setUvTextureTransform({ ...DEFAULT_UV_TEXTURE_TRANSFORM });
  }, [activeModelUrl]);

  useEffect(() => {
    const texture = importedTextureRef.current;
    if (texture) applyUvTextureTransform(texture, uvTextureTransform, textureStylePreset);
  }, [uvTextureTransform, textureStylePreset]);

  useEffect(() => () => {
    disposeRepaintOverlay();
    importedTextureRef.current?.dispose();
    importedTextureRef.current = null;
    currentAtlasRef.current = null;
  }, []);

  const updateUvTextureTransform = (patch: Partial<UvTextureTransform>) => {
    setUvTextureTransform((current) => normalizeUvTextureTransform({ ...current, ...patch }));
  };

  const resetUvTextureTransform = () => {
    setUvTextureTransform({ ...DEFAULT_UV_TEXTURE_TRANSFORM });
  };

  const handleExportUvTemplate = async () => {
    const root = loadedRootRef.current;
    if (!root) return;
    const layout = collectUvLayout(root);
    if (layout.triangleCount === 0) {
      setUvExportStatus('No UV coordinates found on this model.');
      return;
    }

    try {
      const svg = buildUvTemplateSvg(layout, { resolution: UV_TEMPLATE_RESOLUTION });
      const savedPath = await exportUvTemplate(svg, uvTemplateFilename(activeModelUrl));
      if (!savedPath) return;
      setUvExportStatus('UV template saved.');
      void writeDiagnosticLog('info', 'uv', 'UV template exported.', {
        path: savedPath,
        resolution: UV_TEMPLATE_RESOLUTION,
        triangles: layout.triangleCount,
        materials: layout.materialCount,
        textures: layout.textureCount,
      });
    } catch (error) {
      const message = `UV export failed: ${String(error)}`;
      setUvExportStatus(message);
      void writeDiagnosticLog('error', 'uv', message, { activeModelUrl });
    }
  };

  const handleImportUvTexture = async () => {
    const root = loadedRootRef.current;
    if (!root || !uvLayout || uvLayout.triangleCount === 0 || uvTextureBusy) return;

    const path = await chooseInputImage();
    if (!path) return;

    setUvTextureBusy(true);
    setUvTextureStatus('Loading UV texture…');
    let texture: THREE.Texture | null = null;
    try {
      texture = await loadUvTexture(localAssetUrl(path));
      const [width, height] = imageDimensions(texture);
      const validation = validateUvTextureDimensions(width, height, UV_TEMPLATE_RESOLUTION);
      if (!validation.ok) {
        texture.dispose();
        setUvTextureStatus(validation.error ?? 'UV texture validation failed.');
        return;
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.name = inputFilename(path);
      const resetTransform = { ...DEFAULT_UV_TEXTURE_TRANSFORM };
      applyUvTextureTransform(texture, resetTransform, textureStylePreset);

      const applied = applyUvTexture(root, texture);
      if (applied.materialCount === 0) {
        texture.dispose();
        setUvTextureStatus('No compatible UV material was found for direct texture replacement.');
        return;
      }

      resetRepaintSession();
      const previous = importedTextureRef.current;
      importedTextureRef.current = texture;
      currentAtlasRef.current = null;
      texture = null;
      previous?.dispose();
      setUvTextureTransform(resetTransform);
      setUvTextureInfo({
        path,
        name: inputFilename(path),
        width: Math.round(width),
        height: Math.round(height),
        warning: validation.warning,
        meshCount: applied.meshCount,
        materialCount: applied.materialCount,
      });
      setInspectionMode('solid');
      applyInspectionMode(root, 'solid');

      const message = validation.warning
        ? `UV texture applied. ${validation.warning}`
        : `UV texture applied at ${Math.round(width)}×${Math.round(height)}.`;
      setUvTextureStatus(message);
      void writeDiagnosticLog(validation.warning ? 'warn' : 'info', 'uv', 'Direct UV texture applied.', {
        path,
        width: Math.round(width),
        height: Math.round(height),
        meshCount: applied.meshCount,
        materialCount: applied.materialCount,
        warning: validation.warning,
        textureTransform: resetTransform,
      });
    } catch (error) {
      texture?.dispose();
      const message = `UV texture import failed: ${String(error)}`;
      setUvTextureStatus(message);
      void writeDiagnosticLog('error', 'uv', message, { activeModelUrl, path });
    } finally {
      setUvTextureBusy(false);
    }
  };

  const handleExportTexturedGlb = async () => {
    const root = loadedRootRef.current;
    const originalTransform = originalTransformRef.current;
    const currentAtlas = currentAtlasRef.current;
    if (!root || !originalTransform || (!uvTextureInfo && !currentAtlas) || uvTextureBusy) return;

    setUvTextureBusy(true);
    setUvTextureStatus('Exporting textured GLB…');
    const viewerTransform = captureTransform(root);
    const currentInspectionMode = inspectionMode;
    let viewerData: InternalViewerDataSnapshot[] = [];

    try {
      applyInspectionMode(root, 'solid');
      viewerData = detachInternalViewerData(root);
      applyTransform(root, originalTransform);
      updateWorldMatrix(root);

      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      const exporter = new GLTFExporter();
      const exported = await exporter.parseAsync(root, {
        binary: true,
        onlyVisible: true,
      });
      if (!(exported instanceof ArrayBuffer)) {
        throw new Error('GLTFExporter returned JSON instead of binary GLB data.');
      }

      const savedPath = await exportTexturedGlb(
        new Uint8Array(exported),
        texturedModelFilename(activeModelUrl),
      );
      if (!savedPath) {
        setUvTextureStatus('Textured GLB export cancelled.');
        return;
      }
      setUvTextureStatus('Textured GLB saved.');
      void writeDiagnosticLog('info', 'uv', 'Direct UV textured GLB exported.', {
        path: savedPath,
        texture: uvTextureInfo?.path ?? currentAtlas?.name ?? 'local-repaint-atlas',
        width: uvTextureInfo?.width ?? currentAtlas?.width,
        height: uvTextureInfo?.height ?? currentAtlas?.height,
        textureTransform: uvTextureTransform,
        bytes: exported.byteLength,
      });
    } catch (error) {
      const message = `Textured GLB export failed: ${String(error)}`;
      setUvTextureStatus(message);
      void writeDiagnosticLog('error', 'uv', message, { activeModelUrl });
    } finally {
      restoreInternalViewerData(viewerData);
      applyTransform(root, viewerTransform);
      updateWorldMatrix(root);
      applyInspectionMode(root, currentInspectionMode);
      setUvTextureBusy(false);
    }
  };

  const handleToggleLocalRepaint = () => {
    if (repaintModeRef.current) {
      resetRepaintSession();
      return;
    }

    const root = loadedRootRef.current;
    setRepaintMode(true);
    repaintModeRef.current = true;
    setInspectionMode('solid');
    setRepaintCanRetry(false);
    setRepaintStatus(null);
    setRepaintAtlasError(null);
    if (!root) {
      setRepaintStatus('Local Repaint requires a loaded model.');
      return;
    }

    const resolved = resolveEditableBaseColorTexture(root, importedTextureRef.current);
    if (resolved.error) {
      setRepaintAtlasError(resolved.error);
      setRepaintStatus(
        resolved.error === 'multiple_albedo'
          ? 'Local Repaint v1 supports one base-color atlas at a time.'
          : 'Local Repaint requires a base-color texture.',
      );
      repaintTextureRef.current = null;
      repaintEditableMeshesRef.current = [];
      repaintMaskRef.current = null;
      setRepaintMask(null);
      setRepaintHasMask(false);
      return;
    }

    const texture = resolved.texture;
    if (!texture) return;
    const [width, height] = imageDimensions(texture);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      setRepaintStatus('Local Repaint needs a loaded base-color image.');
      return;
    }

    const mask = createRepaintMask(Math.round(width), Math.round(height));
    repaintTextureRef.current = texture;
    repaintEditableMeshesRef.current = resolved.meshes;
    repaintMaskRef.current = mask;
    setRepaintMask(mask);
    setRepaintHasMask(false);
    installRepaintOverlay(resolved.meshes, texture, mask);
    setRepaintStatus('Paint the area to change directly on the model.');
  };

  const handleBrushMode = (mode: RepaintBrushMode) => {
    repaintBrushModeRef.current = mode;
    setRepaintBrushMode(mode);
  };

  const handleBrushSize = (value: number) => {
    const resolved = Math.min(120, Math.max(4, Math.round(value)));
    repaintBrushSizeRef.current = resolved;
    setRepaintBrushSizePx(resolved);
  };

  const handleClearRepaintMask = () => {
    const mask = repaintMaskRef.current;
    if (!mask) return;
    mask.data.fill(0);
    setRepaintHasMask(false);
    setRepaintCanRetry(false);
    refreshRepaintOverlay(mask);
  };

  const handleChooseRepaintReference = async () => {
    const path = await chooseInputImage();
    if (path) setRepaintReferencePath(path);
  };

  const handleCancelLocalRepaint = async () => {
    if (!repaintBusy) return;
    repaintCancelRequestedRef.current = true;
    setRepaintStatus('Cancelling local repaint…');
    try {
      await cancelLocalRepaint();
    } catch (error) {
      repaintCancelRequestedRef.current = false;
      setRepaintStatus(`Cancel failed: ${String(error)}`);
    }
  };

  const handleApplyLocalRepaint = async () => {
    const root = loadedRootRef.current;
    const mask = repaintMaskRef.current;
    const sourceTexture = repaintTextureRef.current;
    const prompt = repaintPrompt.trim() || null;
    const referenceImage = repaintReferencePath;
    if (!root || !mask || !sourceTexture || repaintBusy || !repaintHasMask || (!prompt && !referenceImage)) return;

    repaintCancelRequestedRef.current = false;
    setRepaintCanRetry(false);
    setRepaintBusy(true);
    setRepaintStatus('Preparing UV patch…');
    try {
      const currentAtlas = currentAtlasRef.current ?? captureEditableAtlas(sourceTexture);
      const extracted = extractRepaintPatch(currentAtlas, mask, LOCAL_REPAINT_PADDING_PX);
      const [sourcePng, maskPng] = await Promise.all([
        editableAtlasToPng(extracted.sourcePatch),
        editableAtlasToPng(repaintMaskToEditableAtlas(extracted.maskPatch)),
      ]);

      setRepaintStatus('Applying local repaint…');
      const response = await localRepaint(
        {
          sourcePng: Array.from(sourcePng),
          maskPng: Array.from(maskPng),
          prompt,
          referenceImage,
          featherPx: LOCAL_REPAINT_FEATHER_PX,
        },
        (event) => {
          if (event.stage === 'loading_repaint_model') {
            setRepaintStatus('Downloading/preparing local repaint model…');
          } else if (event.stage === 'running_repaint') {
            setRepaintStatus('Applying local repaint…');
          } else if (event.stage === 'writing_repaint') {
            setRepaintStatus('Compositing atlas…');
          }
        },
      );

      if (!response.ok) {
        if (response.errorKind === 'cancelled' || repaintCancelRequestedRef.current) {
          setRepaintCanRetry(true);
          setRepaintStatus('Local repaint cancelled.');
          return;
        }
        throw new Error(response.error || 'Local Repaint worker returned an error.');
      }
      if (!response.editedPng?.length) {
        throw new Error('Local Repaint completed without an edited PNG.');
      }

      setRepaintStatus('Compositing atlas…');
      const editedPatch = await pngBytesToEditableAtlas(Uint8Array.from(response.editedPng));
      const nextAtlas = compositeRepaintPatch(
        currentAtlas,
        editedPatch,
        extracted.maskPatch,
        extracted.rect,
        LOCAL_REPAINT_FEATHER_PX,
      );
      const replacementTexture = atlasToCanvasTexture(nextAtlas, sourceTexture);
      const applied = applyUvTexture(root, replacementTexture);
      if (applied.materialCount === 0) {
        replacementTexture.dispose();
        throw new Error('Local Repaint could not apply the edited atlas to the model materials.');
      }

      currentAtlasRef.current = nextAtlas;
      repaintTextureRef.current = replacementTexture;
      importedTextureRef.current = replacementTexture;
      mask.data.fill(0);
      setRepaintHasMask(false);
      setRepaintCanRetry(false);
      refreshRepaintOverlay(mask);
      setRepaintStatus('Local repaint applied.');
      void writeDiagnosticLog('info', 'local-repaint', 'Local Repaint applied transactionally.', {
        model: response.model,
        cacheHit: response.cacheHit,
        modelLoadMs: response.modelLoadMs,
        inferenceMs: response.inferenceMs,
        rect: extracted.rect,
      });
    } catch (error) {
      if (repaintCancelRequestedRef.current) {
        setRepaintCanRetry(true);
        setRepaintStatus('Local repaint cancelled.');
      } else {
        const message = `Local Repaint failed: ${String(error)}`;
        setRepaintCanRetry(true);
        setRepaintStatus(message);
        void writeDiagnosticLog('error', 'local-repaint', message, { activeModelUrl });
      }
    } finally {
      repaintCancelRequestedRef.current = false;
      setRepaintBusy(false);
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || busy) return undefined;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (error) {
      const message = `3D preview unavailable: ${String(error)}`;
      setLoadError(message);
      void writeDiagnosticLog('error', 'webgl', message, { activeModelUrl });
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x171a1f);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    camera.position.set(2.6, 1.8, 3.4);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.6, 0);

    scene.add(new THREE.HemisphereLight(0xe9eef8, 0x282119, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 6, 3);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xb8c9ff, 1.7);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    const grid = new THREE.GridHelper(10, 20, 0x525861, 0x2d3238);
    grid.position.y = -0.01;
    scene.add(grid);

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    let frame = 0;
    let loadedRoot: THREE.Object3D | null = null;
    let disposed = false;
    let renderFailed = false;
    let repaintDrawing = false;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const paintAtPointer = (event: PointerEvent) => {
      const mask = repaintMaskRef.current;
      const texture = repaintTextureRef.current;
      const meshes = repaintEditableMeshesRef.current;
      if (!repaintModeRef.current || !mask || !texture || meshes.length === 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const transform = repaintTextureTransform(texture);
      const samples = [] as Array<{ x: number; y: number }>;
      for (const [dx, dy] of brushDiskSamples(repaintBrushSizeRef.current)) {
        const x = event.clientX + dx;
        const y = event.clientY + dy;
        ndc.set(
          ((x - rect.left) / rect.width) * 2 - 1,
          -(((y - rect.top) / rect.height) * 2 - 1),
        );
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObjects(meshes, false).find((entry) => Boolean(entry.uv));
        if (!hit?.uv) continue;
        samples.push(textureUvToAtlasPixel(hit.uv, mask.width, mask.height, transform));
      }
      if (samples.length === 0) return;
      stampMaskSamples(mask, samples, repaintBrushModeRef.current, 0);
      setRepaintHasMask(maskBounds(mask) !== null);
      setRepaintCanRetry(false);
      refreshRepaintOverlay(mask);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !repaintModeRef.current || !repaintMaskRef.current) return;
      repaintDrawing = true;
      controls.enabled = false;
      renderer.domElement.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      paintAtPointer(event);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!repaintDrawing) return;
      event.preventDefault();
      paintAtPointer(event);
    };
    const finishPointerStroke = (event?: PointerEvent) => {
      if (!repaintDrawing) return;
      repaintDrawing = false;
      controls.enabled = true;
      if (event) renderer.domElement.releasePointerCapture?.(event.pointerId);
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', finishPointerStroke);
    renderer.domElement.addEventListener('pointercancel', finishPointerStroke);
    renderer.domElement.addEventListener('pointerleave', finishPointerStroke);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) {
        const message = '3D preview unavailable: WebGL context was lost. The job can continue without the preview.';
        setLoadError(message);
        void writeDiagnosticLog('error', 'webgl', message, { activeModelUrl });
      }
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    const attachModel = (root: THREE.Object3D) => {
      if (disposed) return;
      loadedRoot = root;
      loadedRootRef.current = root;
      originalTransformRef.current = captureTransform(root);
      scene.add(root);
      setUvLayout(collectUvLayout(root));

      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
      const scale = 1.8 / maxDimension;
      root.scale.setScalar(scale);
      root.position.sub(center.multiplyScalar(scale));
      root.position.y += size.y * scale * 0.5;
      controls.target.set(0, Math.min(size.y * scale * 0.4, 0.8), 0);
      applyInspectionMode(root, inspectionMode);
      controls.update();
    };

    if (activeModelUrl) {
      setLoadError(null);
      try {
        const format = modelFormatFromUrl(activeModelUrl);
        const onError = (error: unknown) => {
          if (!disposed) {
            const message = `Could not load generated ${format.toUpperCase()}: ${String(error)}`;
            setLoadError(message);
            void writeDiagnosticLog('error', 'viewer', message, { activeModelUrl });
          }
        };

        if (format === 'obj') {
          new OBJLoader().load(activeModelUrl, attachModel, undefined, onError);
        } else {
          new GLTFLoader().load(activeModelUrl, (gltf) => attachModel(gltf.scene), undefined, onError);
        }
      } catch (error) {
        const message = String(error);
        setLoadError(message);
        void writeDiagnosticLog('error', 'viewer', message, { activeModelUrl });
      }
    }

    const animate = () => {
      if (disposed || renderFailed) return;
      try {
        controls.update();
        renderer.render(scene, camera);
      } catch (error) {
        renderFailed = true;
        const message = `3D preview unavailable: ${String(error)}. The job can continue without the preview.`;
        setLoadError(message);
        void writeDiagnosticLog('error', 'webgl', message, { activeModelUrl });
        return;
      }
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      finishPointerStroke();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', finishPointerStroke);
      renderer.domElement.removeEventListener('pointercancel', finishPointerStroke);
      renderer.domElement.removeEventListener('pointerleave', finishPointerStroke);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      if (loadedRoot) disposeLoadedRoot(loadedRoot);
      if (loadedRootRef.current === loadedRoot) loadedRootRef.current = null;
      try {
        renderer.dispose();
        renderer.domElement.remove();
      } catch (error) {
        void writeDiagnosticLog('warn', 'webgl', 'Failed to dispose 3D preview cleanly.', error);
      }
    };
  }, [activeModelUrl, busy]);

  const uvAvailable = Boolean(uvLayout && uvLayout.triangleCount > 0);
  const hasEditableTexture = Boolean(uvTextureInfo || currentAtlasRef.current);
  const repaintCanPaint = repaintMode && !repaintBusy && repaintAtlasError === null && Boolean(repaintMaskRef.current);
  const repaintCanApply = repaintCanPaint && repaintHasMask && Boolean(repaintPrompt.trim() || repaintReferencePath);

  return (
    <section className="viewer-shell" aria-label="3D model preview">
      <div ref={hostRef} className="viewer-canvas" />

      {activeModelUrl && !busy && (
        <div className="viewer-inspection" aria-label="Viewer display mode">
          <button
            type="button"
            aria-pressed={inspectionMode === 'solid'}
            className={inspectionMode === 'solid' ? 'active' : ''}
            onClick={() => setInspectionMode('solid')}
          >
            Solid
          </button>
          <button
            type="button"
            aria-pressed={inspectionMode === 'wireframe'}
            className={inspectionMode === 'wireframe' ? 'active' : ''}
            onClick={() => setInspectionMode('wireframe')}
          >
            Wireframe
          </button>
          <button
            type="button"
            aria-pressed={inspectionMode === 'solid-wire'}
            className={inspectionMode === 'solid-wire' ? 'active' : ''}
            onClick={() => setInspectionMode('solid-wire')}
          >
            Solid + Wire
          </button>
          <button
            type="button"
            aria-pressed={inspectionMode === 'uv-checker'}
            className={inspectionMode === 'uv-checker' ? 'active' : ''}
            disabled={!uvAvailable}
            title={uvAvailable ? 'Inspect UV scale, seams and stretching with a procedural checker.' : 'This mesh has no UV coordinates.'}
            onClick={() => setInspectionMode('uv-checker')}
          >
            UV Checker
          </button>
          <span className="viewer-inspection-divider" aria-hidden="true" />
          <button
            type="button"
            className="viewer-export-uv"
            disabled={!uvAvailable}
            title={`Export a ${UV_TEMPLATE_RESOLUTION}×${UV_TEMPLATE_RESOLUTION} SVG UV template with triangle guides, island boundaries and metadata.`}
            onClick={() => void handleExportUvTemplate()}
          >
            Export UV template
          </button>
        </div>
      )}

      {uvAvailable && activeModelUrl && !busy && uvLayout && (
        <div className="viewer-uv-meta" aria-label="UV metadata">
          UV · {uvLayout.triangleCount.toLocaleString()} tris · {uvLayout.uvMeshCount}/{uvLayout.meshCount} meshes · {uvLayout.materialCount} mat · {uvLayout.textureCount} tex
        </div>
      )}

      {uvAvailable && activeModelUrl && !busy && (
        <div className="viewer-uv-tools" aria-label="Direct UV texture tools">
          <button type="button" disabled={uvTextureBusy || repaintBusy} onClick={() => void handleImportUvTexture()}>
            {uvTextureBusy && !uvTextureInfo ? 'Loading…' : 'Import UV texture'}
          </button>
          <button
            type="button"
            disabled={uvTextureBusy || repaintBusy || !hasEditableTexture}
            onClick={() => void handleExportTexturedGlb()}
          >
            Export textured GLB
          </button>
          <button
            type="button"
            aria-pressed={repaintMode}
            disabled={uvTextureBusy || repaintBusy}
            onClick={handleToggleLocalRepaint}
          >
            Local Repaint
          </button>
          {uvTextureInfo && (
            <span title={uvTextureInfo.path}>
              {uvTextureInfo.name} · {uvTextureInfo.width}×{uvTextureInfo.height}
            </span>
          )}
        </div>
      )}

      {repaintMode && activeModelUrl && !busy && (
        <div className="viewer-local-repaint" aria-label="Local Repaint controls">
          <div className="viewer-local-repaint-heading">
            <strong>Local Repaint</strong>
            <button type="button" disabled={repaintBusy} onClick={() => resetRepaintSession()}>
              Close
            </button>
          </div>
          <div className="viewer-local-repaint-modes">
            <button
              type="button"
              aria-pressed={repaintBrushMode === 'paint'}
              disabled={!repaintCanPaint}
              onClick={() => handleBrushMode('paint')}
            >
              Paint
            </button>
            <button
              type="button"
              aria-pressed={repaintBrushMode === 'erase'}
              disabled={!repaintCanPaint}
              onClick={() => handleBrushMode('erase')}
            >
              Erase
            </button>
            <button type="button" disabled={!repaintCanPaint || !repaintHasMask} onClick={handleClearRepaintMask}>
              Clear mask
            </button>
          </div>
          <label className="viewer-local-repaint-range">
            <span>Brush <output>{repaintBrushSizePx}px</output></span>
            <input
              aria-label="Local Repaint brush size"
              type="range"
              min="4"
              max="120"
              step="2"
              value={repaintBrushSizePx}
              disabled={!repaintCanPaint}
              onChange={(event) => handleBrushSize(Number(event.currentTarget.value))}
            />
          </label>
          <label className="viewer-local-repaint-prompt">
            <span>Prompt</span>
            <textarea
              aria-label="Local Repaint prompt"
              value={repaintPrompt}
              disabled={!repaintCanPaint}
              placeholder="Describe only the local change…"
              rows={2}
              onChange={(event) => setRepaintPrompt(event.currentTarget.value)}
            />
          </label>
          <div className="viewer-local-repaint-reference">
            <button type="button" disabled={!repaintCanPaint} onClick={() => void handleChooseRepaintReference()}>
              Choose reference image
            </button>
            {repaintReferencePath && <span title={repaintReferencePath}>{inputFilename(repaintReferencePath)}</span>}
          </div>
          {repaintBusy ? (
            <button type="button" className="viewer-local-repaint-apply" onClick={() => void handleCancelLocalRepaint()}>
              Cancel repaint
            </button>
          ) : repaintCanRetry ? (
            <button
              type="button"
              className="viewer-local-repaint-apply"
              disabled={!repaintCanApply}
              onClick={() => void handleApplyLocalRepaint()}
            >
              Retry repaint
            </button>
          ) : (
            <button
              type="button"
              className="viewer-local-repaint-apply"
              disabled={!repaintCanApply}
              onClick={() => void handleApplyLocalRepaint()}
            >
              Apply repaint
            </button>
          )}
          {repaintStatus && <div className={repaintAtlasError ? 'viewer-local-repaint-error' : 'viewer-local-repaint-status'}>{repaintStatus}</div>}
        </div>
      )}

      {uvTextureInfo && activeModelUrl && !busy && (
        <div className="viewer-uv-transform" aria-label="UV Transform">
          <div className="viewer-uv-transform-heading">
            <strong>UV Transform</strong>
            <button
              type="button"
              disabled={uvTextureBusy}
              onClick={resetUvTextureTransform}
            >
              Reset
            </button>
          </div>
          <label>
            <span>
              Scale
              <output>{Math.round(uvTextureTransform.scalePercent)}%</output>
            </span>
            <input
              type="range"
              min="50"
              max="200"
              step="1"
              value={uvTextureTransform.scalePercent}
              disabled={uvTextureBusy}
              aria-label="UV texture scale"
              onChange={(event) => updateUvTextureTransform({ scalePercent: Number(event.currentTarget.value) })}
            />
          </label>
          <label>
            <span>
              Rotation
              <output>{Math.round(uvTextureTransform.rotationDegrees)}°</output>
            </span>
            <input
              type="range"
              min="-180"
              max="180"
              step="1"
              value={uvTextureTransform.rotationDegrees}
              disabled={uvTextureBusy}
              aria-label="UV texture rotation"
              onChange={(event) => updateUvTextureTransform({ rotationDegrees: Number(event.currentTarget.value) })}
            />
          </label>
        </div>
      )}

      {(uvExportStatus || uvTextureStatus) && activeModelUrl && !busy && (
        <div className="viewer-uv-export-status" role="status">
          {uvTextureStatus ?? uvExportStatus}
        </div>
      )}

      {comparison && (
        <div className="viewer-comparison" aria-label="Mesh comparison">
          <button
            type="button"
            aria-pressed={comparisonSide === 'before'}
            onClick={() => setComparisonSide('before')}
          >
            Before{comparison.beforeTriangles !== undefined ? ` · ${comparison.beforeTriangles.toLocaleString()}` : ''}
          </button>
          <button
            type="button"
            aria-pressed={comparisonSide === 'after'}
            onClick={() => setComparisonSide('after')}
          >
            After{comparison.afterTriangles !== undefined ? ` · ${comparison.afterTriangles.toLocaleString()}` : ''}
          </button>
        </div>
      )}
      {!activeModelUrl && !busy && (
        <div className="viewer-empty">
          <div className="wire-cube" aria-hidden="true" />
          <strong>3D preview</strong>
          <span>Your generated GLB or OBJ will appear here.</span>
        </div>
      )}
      {busy && (
        <div className="viewer-status">
          <span className="spinner" aria-hidden="true" />
          <div className="viewer-status-copy">
            <strong>{progressLabel ?? 'Generating model…'}</strong>
            <small>{typeof progress === 'number' ? `${progress}% complete` : 'Hunyuan is running on the configured Radeon runtime.'}</small>
            {typeof progress === 'number' && (
              <div className="viewer-progress-track" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
              </div>
            )}
          </div>
        </div>
      )}
      {loadError && <div className="viewer-error">{loadError}</div>}
      <div className="viewer-hint">{repaintMode ? 'Left drag to paint mask · wheel/right drag to navigate' : 'Drag to orbit · wheel to zoom · right drag to pan'}</div>
    </section>
  );
}
