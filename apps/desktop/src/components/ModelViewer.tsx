import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { writeDiagnosticLog } from '../lib/diagnosticLog';
import { exportUvTemplate } from '../lib/uvExport';
import { modelFormatFromUrl } from './modelPreview';
import { buildUvTemplateSvg, collectUvLayout, type UvLayout } from './uvTemplate';

export interface ModelComparison {
  beforeUrl: string;
  afterUrl: string;
  beforeTriangles?: number;
  afterTriangles?: number;
}

type InspectionMode = 'solid' | 'wireframe' | 'solid-wire' | 'uv-checker';

interface ModelViewerProps {
  modelUrl: string | null;
  comparison?: ModelComparison | null;
  busy: boolean;
  progress?: number | null;
  progressLabel?: string | null;
}

const WIRE_OVERLAY_KEY = 'img2modelWireOverlay';
const ORIGINAL_MATERIAL_KEY = 'img2modelOriginalMaterial';
const UV_CHECKER_MATERIAL_KEY = 'img2modelUvCheckerMaterial';

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
    if (!(object instanceof THREE.Mesh)) return;

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

function uvTemplateFilename(modelUrl: string | null): string {
  if (!modelUrl) return 'model-uv-template.svg';
  const withoutQuery = modelUrl.split(/[?#]/, 1)[0];
  const lastSegment = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) ?? 'model';
  const decoded = (() => {
    try {
      return decodeURIComponent(lastSegment);
    } catch {
      return lastSegment;
    }
  })();
  const stem = decoded.replace(/\.[^.]+$/, '') || 'model';
  return `${stem}-uv-template.svg`;
}

export function ModelViewer({ modelUrl, comparison, busy, progress, progressLabel }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const loadedRootRef = useRef<THREE.Object3D | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comparisonSide, setComparisonSide] = useState<'before' | 'after'>('after');
  const [inspectionMode, setInspectionMode] = useState<InspectionMode>('solid');
  const [uvLayout, setUvLayout] = useState<UvLayout | null>(null);
  const [uvExportStatus, setUvExportStatus] = useState<string | null>(null);

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
    setUvLayout(null);
    setUvExportStatus(null);
  }, [activeModelUrl]);

  const handleExportUvTemplate = async () => {
    const root = loadedRootRef.current;
    if (!root) return;
    const layout = collectUvLayout(root);
    if (layout.triangleCount === 0) {
      setUvExportStatus('No UV coordinates found on this model.');
      return;
    }

    try {
      const svg = buildUvTemplateSvg(layout, { resolution: 2048 });
      const savedPath = await exportUvTemplate(svg, uvTemplateFilename(activeModelUrl));
      if (!savedPath) return;
      setUvExportStatus('UV template saved.');
      void writeDiagnosticLog('info', 'uv', 'UV template exported.', {
        path: savedPath,
        resolution: 2048,
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
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
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
            title="Export a 2048×2048 SVG UV template with triangle guides, island boundaries and metadata."
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
      {uvExportStatus && activeModelUrl && !busy && (
        <div className="viewer-uv-export-status" role="status">{uvExportStatus}</div>
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
      <div className="viewer-hint">Drag to orbit · wheel to zoom · right drag to pan</div>
    </section>
  );
}
