import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface ModelViewerProps {
  modelUrl: string | null;
  busy: boolean;
}

export function ModelViewer({ modelUrl, busy }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x171a1f);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    camera.position.set(2.6, 1.8, 3.4);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
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

    if (modelUrl) {
      setLoadError(null);
      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => {
          if (disposed) return;
          loadedRoot = gltf.scene;
          scene.add(gltf.scene);

          const box = new THREE.Box3().setFromObject(gltf.scene);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
          const scale = 1.8 / maxDimension;
          gltf.scene.scale.setScalar(scale);
          gltf.scene.position.sub(center.multiplyScalar(scale));
          gltf.scene.position.y += size.y * scale * 0.5;
          controls.target.set(0, Math.min(size.y * scale * 0.4, 0.8), 0);
          controls.update();
        },
        undefined,
        (error) => {
          if (!disposed) setLoadError(`Could not load generated GLB: ${String(error)}`);
        },
      );
    }

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (loadedRoot) {
        loadedRoot.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry?.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material?.dispose());
          }
        });
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [modelUrl]);

  return (
    <section className="viewer-shell" aria-label="3D model preview">
      <div ref={hostRef} className="viewer-canvas" />
      {!modelUrl && !busy && (
        <div className="viewer-empty">
          <div className="wire-cube" aria-hidden="true" />
          <strong>3D preview</strong>
          <span>Your generated GLB will appear here.</span>
        </div>
      )}
      {busy && (
        <div className="viewer-status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>Generating shape</strong>
            <small>Hunyuan is running in the configured AMD Python environment.</small>
          </div>
        </div>
      )}
      {loadError && <div className="viewer-error">{loadError}</div>}
      <div className="viewer-hint">Drag to orbit · wheel to zoom · right drag to pan</div>
    </section>
  );
}
