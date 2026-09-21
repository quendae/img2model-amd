// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelViewer } from './ModelViewer';

const mocks = vi.hoisted(() => ({
  paintHit: false,
  localRepaint: vi.fn(),
  cancelLocalRepaint: vi.fn(),
  chooseInputImage: vi.fn(),
  makeLoadedRoot: null as null | (() => unknown),
}));

vi.mock('../lib/tauri', () => ({
  chooseInputImage: mocks.chooseInputImage,
  localAssetUrl: (path: string) => path,
  localRepaint: mocks.localRepaint,
  cancelLocalRepaint: mocks.cancelLocalRepaint,
}));

vi.mock('../lib/localRepaintAtlas', () => ({
  captureEditableAtlas: () => ({
    width: 16,
    height: 16,
    rgba: new Uint8ClampedArray(16 * 16 * 4).fill(10),
    flipY: false,
    name: 'fixture-atlas',
  }),
  extractRepaintPatch: (atlas: any) => ({
    sourcePatch: {
      width: 1,
      height: 1,
      rgba: new Uint8ClampedArray([atlas.rgba[0], 0, 0, 255]),
      flipY: false,
      name: 'fixture-patch',
    },
    maskPatch: { width: 1, height: 1, data: new Uint8ClampedArray([255]) },
    rect: { x: 8, y: 8, width: 1, height: 1 },
  }),
  repaintMaskToEditableAtlas: () => ({
    width: 1,
    height: 1,
    rgba: new Uint8ClampedArray([255, 255, 255, 255]),
    flipY: false,
    name: 'fixture-mask',
  }),
  editableAtlasToPng: async (atlas: any) => new Uint8Array([atlas.rgba[0] ?? 0, 1]),
  pngBytesToEditableAtlas: async (bytes: Uint8Array) => ({
    width: 1,
    height: 1,
    rgba: new Uint8ClampedArray([bytes[0] ?? 0, 0, 0, 255]),
    flipY: false,
    name: 'fixture-result',
  }),
  compositeRepaintPatch: (source: any, edited: any) => {
    const rgba = new Uint8ClampedArray(source.rgba);
    rgba[0] = edited.rgba[0];
    return { ...source, rgba };
  },
  atlasToCanvasTexture: (_atlas: any, sourceTexture: any) => sourceTexture,
}));

vi.mock('three', () => {
  class Object3D {
    children: any[] = [];
    userData: Record<string, unknown> = {};
    renderOrder = 0;
    visible = true;
    parent: Object3D | null = null;
    position = { x: 0, y: 0, z: 0, set() {}, sub() { return this; } };
    quaternion = { x: 0, y: 0, z: 0, w: 1, set() {} };
    scale = { x: 1, y: 1, z: 1, setScalar() {}, set() {} };
    add(child: any) { child.parent = this; this.children.push(child); }
    remove(child: any) { this.children = this.children.filter((candidate) => candidate !== child); child.parent = null; }
    traverse(callback: (object: any) => void) {
      callback(this);
      for (const child of this.children) child.traverse?.(callback) ?? callback(child);
    }
    updateMatrixWorld() {}
  }

  class Scene extends Object3D { background: unknown; }
  class Color { constructor(_value: number) {} }
  class Vector2 {
    x = 0;
    y = 0;
    set(x: number, y: number) { this.x = x; this.y = y; return this; }
    copy(other: { x: number; y: number }) { this.x = other.x; this.y = other.y; return this; }
  }
  class Vector3 {
    x = 1; y = 1; z = 1;
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
  }
  class HemisphereLight { constructor(_sky: number, _ground: number, _intensity: number) {} }
  class DirectionalLight {
    position = { set() {} };
    constructor(_color: number, _intensity: number) {}
  }
  class GridHelper {
    position = { y: 0 };
    constructor(_size: number, _divisions: number, _color1: number, _color2: number) {}
  }
  class Attribute {
    count = 3;
    getX(index: number) { return index === 1 ? 1 : 0; }
    getY(index: number) { return index === 2 ? 1 : 0; }
  }
  class Geometry {
    dispose() {}
    getAttribute(name: string) { return name === 'uv' || name === 'position' ? new Attribute() : null; }
    getIndex() { return null; }
  }
  class Texture {
    isTexture = true;
    image: any = { width: 16, height: 16 };
    flipY = false;
    name = 'base-color';
    colorSpace: unknown = 'srgb';
    wrapS: unknown;
    wrapT: unknown;
    magFilter: unknown;
    minFilter: unknown;
    generateMipmaps = true;
    needsUpdate = false;
    rotation = 0;
    offset = new Vector2();
    repeat = Object.assign(new Vector2(), { x: 1, y: 1 });
    center = new Vector2();
    updateMatrix() {}
    dispose() {}
  }
  class CanvasTexture extends Texture {
    constructor(image: any) { super(); this.image = image; }
  }
  class Material {
    wireframe = false;
    needsUpdate = false;
    map: Texture | null;
    transparent = false;
    opacity = 1;
    depthWrite = true;
    polygonOffset = false;
    polygonOffsetFactor = 0;
    polygonOffsetUnits = 0;
    alphaMap: Texture | null = null;
    constructor(options: any = {}) { this.map = options.map ?? null; Object.assign(this, options); }
    dispose() {}
  }
  class ShaderMaterial extends Material {}
  class MeshBasicMaterial extends Material {}
  class Mesh extends Object3D {
    isMesh = true;
    geometry: Geometry;
    material: Material | Material[];
    constructor(geometry: Geometry = new Geometry(), material: Material | Material[] = new Material()) {
      super(); this.geometry = geometry; this.material = material;
    }
  }
  class WireframeGeometry extends Geometry { constructor(_geometry: unknown) { super(); } }
  class LineBasicMaterial extends Material {}
  class LineSegments extends Object3D {
    visible = false;
    constructor(public geometry: WireframeGeometry, public material: LineBasicMaterial) { super(); }
  }
  class Raycaster {
    setFromCamera() {}
    intersectObjects() {
      return mocks.paintHit ? [{ uv: { x: 0.5, y: 0.5 } }] : [];
    }
  }
  class TextureLoader { load(_url: string, onLoad: (texture: Texture) => void) { onLoad(new Texture()); } }

  mocks.makeLoadedRoot = () => {
    const root = new Object3D();
    root.add(new Mesh(new Geometry(), new Material({ map: new Texture() })));
    return root;
  };

  return {
    Object3D, Scene, Color, Vector2, Vector3, Box3, PerspectiveCamera, WebGLRenderer,
    HemisphereLight, DirectionalLight, GridHelper, Mesh, Texture, CanvasTexture, TextureLoader,
    ShaderMaterial, MeshBasicMaterial, WireframeGeometry, LineBasicMaterial, LineSegments, Raycaster,
    DoubleSide: 'double-side', SRGBColorSpace: 'srgb', ACESFilmicToneMapping: 'aces',
    ClampToEdgeWrapping: 'clamp', NearestFilter: 'nearest', LinearFilter: 'linear',
    LinearMipmapLinearFilter: 'linear-mipmap', MathUtils: { degToRad: (value: number) => value * Math.PI / 180 },
  };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    enableDamping = false;
    enabled = true;
    target = { set() {} };
    update() {}
    dispose() {}
  },
}));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { load(_url: string, onLoad?: (gltf: { scene: unknown }) => void) { onLoad?.({ scene: mocks.makeLoadedRoot?.() }); } },
}));
vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({
  OBJLoader: class { load(_url: string, onLoad?: (root: unknown) => void) { onLoad?.(mocks.makeLoadedRoot?.()); } },
}));

beforeEach(() => {
  mocks.paintHit = false;
  mocks.localRepaint.mockReset();
  mocks.cancelLocalRepaint.mockReset();
  mocks.chooseInputImage.mockReset();
  mocks.localRepaint.mockResolvedValue({ ok: true, editedPng: [1, 2, 3] });
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => {
    if (kind !== '2d') return null;
    return {
      createImageData(width: number, height: number) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData() {},
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function paintMaskAndPrompt(prompt = 'red leather') {
  fireEvent.click(await screen.findByRole('button', { name: 'Local Repaint' }));
  mocks.paintHit = true;
  const canvas = document.querySelector('.viewer-canvas canvas');
  expect(canvas).toBeTruthy();
  canvas!.dispatchEvent(new MouseEvent('pointerdown', {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
  }));
  canvas!.dispatchEvent(new MouseEvent('pointerup', {
    bubbles: true,
    button: 0,
    clientX: 100,
    clientY: 100,
  }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Local Repaint prompt' }), { target: { value: prompt } });
}

describe('ModelViewer Local Repaint apply flow', () => {
  it('sends a prompt-only painted request through Local Repaint IPC', async () => {
    render(<ModelViewer modelUrl="textured.glb" busy={false} />);
    await paintMaskAndPrompt('red leather');

    const apply = screen.getByRole('button', { name: 'Apply repaint' }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);

    await waitFor(() => expect(mocks.localRepaint).toHaveBeenCalledTimes(1));
    expect(mocks.localRepaint.mock.calls[0][0]).toMatchObject({
      prompt: 'red leather',
      referenceImage: null,
    });
  });
});
