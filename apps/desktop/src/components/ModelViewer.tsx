import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { writeDiagnosticLog } from '../lib/diagnosticLog';
import { modelFormatFromUrl } from './modelPreview';

export interface ModelComparison {
  beforeUrl: string;
  afterUrl: string;
  beforeTriangles?: number;
  afterTriangles?: number;
}

interface ModelViewerProps {
  modelUrl: string | null;
  comparison?: ModelComparison | null;
  busy: boolean;
  progress?: number | null;
  progressLabel?: string | null;
}

export function ModelViewer({ modelUrl, comparison, busy, progress, progressLabel }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comparisonSide, setComparisonSide] = useState<'before' | 'after'>('after');

  useEffect(() => {
    setComparisonSide('after');
  }, [comparison?.beforeUrl, comparison?.afterUrl]);

  const activeModelUrl = comparison
    ? comparisonSide === 'before'
      ? comparison.beforeUrl
      : comparison.afterUrl
    : modelUrl;

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
      scene.add(root);

      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
      const scale = 1.8 / maxDimension;
      root.scale.setScalar(scale);
      root.position.sub(center.multiplyScalar(scale));
      root.position.y += size.y * scale * 0.5;
      controls.target.set(0, Math.min(size.y * scale * 0.4, 0.8), 0);
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
      if (loadedRoot) {
        loadedRoot.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry?.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material?.dispose());
          }
        });
      }
      try {
        renderer.dispose();
        renderer.domElement.remove();
      } catch (error) {
        void writeDiagnosticLog('warn', 'webgl', 'Failed to dispose 3D preview cleanly.', error);
      }
    };
  }, [activeModelUrl, busy]);

  return (
    <section className="viewer-shell" aria-label="3D model preview">
      <div ref={hostRef} className="viewer-canvas" />
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
