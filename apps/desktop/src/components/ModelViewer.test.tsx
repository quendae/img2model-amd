// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelViewer } from './ModelViewer';

const mocks = vi.hoisted(() => ({
  loadedUrls: [] as string[],
  rendererShouldThrow: false,
  rendererInstances: 0,
}));

vi.mock('three', () => {
  class Scene {
    background: unknown;
    add() {}
  }

  class Color {
    constructor(_value: number) {}
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
      if (mocks.rendererShouldThrow) {
        throw new Error('WebGL context unavailable');
      }
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

  class Mesh {}

  return {
    Scene,
    Color,
    PerspectiveCamera,
    WebGLRenderer,
    HemisphereLight,
    DirectionalLight,
    GridHelper,
    Mesh,
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
    load(url: string) {
      mocks.loadedUrls.push(url);
    }
  },
}));

vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({
  OBJLoader: class {
    load(url: string) {
      mocks.loadedUrls.push(url);
    }
  },
}));

beforeEach(() => {
  mocks.loadedUrls.length = 0;
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
