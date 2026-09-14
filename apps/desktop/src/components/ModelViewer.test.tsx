// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelViewer } from './ModelViewer';

const mocks = vi.hoisted(() => ({
  loadedUrls: [] as string[],
  rendererShouldThrow: false,
  rendererInstances: 0,
  materials: [] as Array<{ wireframe: boolean; needsUpdate: boolean }>,
  overlays: [] as Array<{ visible: boolean }>,
  makeLoadedRoot: null as null | (() => unknown),
}));

vi.mock('three', () => {
  class Object3D {
    children: any[] = [];
    userData: Record<string, unknown> = {};
    renderOrder = 0;
    position = { y: 0, sub() { return this; } };
    scale = { setScalar() {} };
    add(child: any) { this.children.push(child); }
    traverse(callback: (object: any) => void) {
      callback(this);
      for (const child of this.children) child.traverse?.(callback) ?? callback(child);
    }
  }

  class Scene extends Object3D {
    background: unknown;
  }

  class Color {
    constructor(_value: number) {}
  }

  class Vector3 {
    x = 1;
    y = 1;
    z = 1;
    multiplyScalar() { return this; }
  }

  class Box3 {
    setFromObject() { return this; }
    getSize(target: Vector3) { target.x = 1; target.y = 1; target.z = 1; return target; }
    getCenter(target: Vector3) { target.x = 0; target.y = 0; target.z = 0; return target; }
  }

  class PerspectiveCamera {
    position = { set() {} };
    aspect = 1;
    updateProjectionMatrix() {}
    constructor(_fov: number, _aspect: number, _near: number, _far: number) {}
  }

  class WebGLRenderer {
    domElement = document.createElement('canvas');
    outputColorSpace: unknown;
    toneMapping: unknown;
    toneMappingExposure = 1;
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
    constructor(_options: unknown) {
      mocks.rendererInstances += 1;
      if (mocks.rendererShouldThrow) throw new Error('WebGL context unavailable');
    }
  }

  class HemisphereLight {
    constructor(_sky: number, _ground: number, _intensity: number) {}
  }

  class DirectionalLight {
    position = { set() {} };
    constructor(_color: number, _intensity: number) {}
  }

  class GridHelper {
    position = { y: 0 };
    constructor(_size: number, _divisions: number, _color1: number, _color2: number) {}
  }

  class Geometry {
    dispose() {}
  }

  class Material {
    wireframe = false;
    needsUpdate = false;
    dispose() {}
    constructor() { mocks.materials.push(this); }
  }

  class Mesh extends Object3D {
    isMesh = true;
    geometry = new Geometry();
    material: Material | Material[] = new Material();
  }

  class WireframeGeometry extends Geometry {
    constructor(_geometry: unknown) { super(); }
  }

  class LineBasicMaterial {
    dispose() {}
    constructor(_options: unknown) {}
  }

  class LineSegments extends Object3D {
    visible = false;
    geometry: WireframeGeometry;
    material: LineBasicMaterial;
    constructor(geometry: WireframeGeometry, material: LineBasicMaterial) {
      super();
      this.geometry = geometry;
      this.material = material;
      mocks.overlays.push(this);
    }
  }

  mocks.makeLoadedRoot = () => {
    const root = new Object3D();
    root.add(new Mesh());
    return root;
  };

  return {
    Object3D,
    Scene,
    Color,
    Vector3,
    Box3,
    PerspectiveCamera,
    WebGLRenderer,
    HemisphereLight,
    DirectionalLight,
    GridHelper,
    Mesh,
    WireframeGeometry,
    LineBasicMaterial,
    LineSegments,
    SRGBColorSpace: 'srgb',
    ACESFilmicToneMapping: 'aces',
  };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enableDamping = false;
    target = { set() {} };
    update() {}
    dispose() {}
    constructor(_camera: unknown, _element: unknown) {}
  },
}));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    load(url: string, onLoad?: (gltf: { scene: unknown }) => void) {
      mocks.loadedUrls.push(url);
      onLoad?.({ scene: mocks.makeLoadedRoot?.() });
    }
  },
}));

vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({
  OBJLoader: class {
    load(url: string, onLoad?: (root: unknown) => void) {
      mocks.loadedUrls.push(url);
      onLoad?.(mocks.makeLoadedRoot?.());
    }
  },
}));

beforeEach(() => {
  mocks.loadedUrls.length = 0;
  mocks.materials.length = 0;
  mocks.overlays.length = 0;
  mocks.rendererShouldThrow = false;
  mocks.rendererInstances = 0;
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelViewer mesh comparison', () => {
  it('defaults to After and switches the loaded mesh between Before and After', async () => {
    render(
      <ModelViewer
        modelUrl="after.glb"
        comparison={{
          beforeUrl: 'before.glb',
          afterUrl: 'after.glb',
          beforeTriangles: 312000,
          afterTriangles: 305000,
        }}
        busy={false}
      />,
    );

    const before = screen.getByRole('button', { name: /Before.*312,000/i });
    const after = screen.getByRole('button', { name: /After.*305,000/i });

    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(mocks.loadedUrls.at(-1)).toBe('after.glb');

    fireEvent.click(before);
    await waitFor(() => expect(mocks.loadedUrls.at(-1)).toBe('before.glb'));

    fireEvent.click(after);
    await waitFor(() => expect(mocks.loadedUrls.at(-1)).toBe('after.glb'));
  });

  it('offers Solid, Wireframe and Solid + Wire inspection modes', () => {
    render(<ModelViewer modelUrl="model.glb" busy={false} />);

    expect(screen.getByRole('button', { name: 'Solid' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Wireframe' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Solid + Wire' })).toBeTruthy();
  });

  it('switches materials to wireframe and can overlay wire edges over the solid model', async () => {
    render(<ModelViewer modelUrl="model.glb" busy={false} />);

    await waitFor(() => expect(mocks.materials.length).toBeGreaterThan(0));
    const meshMaterial = mocks.materials[0];
    expect(meshMaterial.wireframe).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Wireframe' }));
    await waitFor(() => expect(meshMaterial.wireframe).toBe(true));
    expect(mocks.overlays.every((overlay) => overlay.visible === false)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Solid + Wire' }));
    await waitFor(() => expect(meshMaterial.wireframe).toBe(false));
    expect(mocks.overlays.some((overlay) => overlay.visible === true)).toBe(true);
  });

  it('keeps the selected inspection mode while switching Before and After', async () => {
    render(
      <ModelViewer
        modelUrl="after.glb"
        comparison={{ beforeUrl: 'before.glb', afterUrl: 'after.glb' }}
        busy={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Wireframe' }));
    const before = screen.getByRole('button', { name: 'Before' });
    fireEvent.click(before);

    await waitFor(() => expect(mocks.loadedUrls.at(-1)).toBe('before.glb'));
    expect(screen.getByRole('button', { name: 'Wireframe' }).getAttribute('aria-pressed')).toBe('true');
    expect(mocks.materials.at(-1)?.wireframe).toBe(true);
  });

  it('shows a viewer error instead of tearing down the app when WebGL initialization fails', async () => {
    mocks.rendererShouldThrow = true;

    render(<ModelViewer modelUrl="model.glb" busy={false} />);

    expect(await screen.findByText(/3D preview unavailable.*WebGL context unavailable/i)).toBeTruthy();
  });

  it('does not keep a WebGL context alive while a generation or cleanup job is busy', () => {
    render(<ModelViewer modelUrl="model.glb" busy={true} progress={20} progressLabel="Cleaning mesh…" />);

    expect(screen.getByText('Cleaning mesh…')).toBeTruthy();
    expect(mocks.rendererInstances).toBe(0);
    expect(mocks.loadedUrls).toEqual([]);
  });
});
