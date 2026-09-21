// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  convertFileSrc: (path: string) => path,
  invoke,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { cancelLocalRepaint, localRepaint } from './tauri';

const valid = {
  sourcePng: [1, 2, 3],
  maskPng: [4, 5, 6],
  prompt: 'red leather',
  referenceImage: null,
  featherPx: 8,
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ ok: true, editedPng: [7, 8, 9] });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
});

describe('localRepaint Tauri contract', () => {
  it('rejects an empty source patch before invoking Tauri', async () => {
    await expect(localRepaint({ ...valid, sourcePng: [] })).rejects.toThrow('Local Repaint source PNG is empty.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an empty mask before invoking Tauri', async () => {
    await expect(localRepaint({ ...valid, maskPng: [] })).rejects.toThrow('Local Repaint mask PNG is empty.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('requires prompt or reference before invoking Tauri', async () => {
    await expect(localRepaint({ ...valid, prompt: '   ', referenceImage: null })).rejects.toThrow(
      'Local Repaint requires a prompt or reference image.',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts a reference-only request and forwards camelCase request data', async () => {
    await localRepaint({ ...valid, prompt: null, referenceImage: 'reference.png' });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('local_repaint');
    expect(invoke.mock.calls[0][1].request).toMatchObject({
      sourcePng: [1, 2, 3],
      maskPng: [4, 5, 6],
      prompt: null,
      referenceImage: 'reference.png',
      featherPx: 8,
    });
  });

  it('cancels through a dedicated Tauri command', async () => {
    invoke.mockResolvedValueOnce(undefined);
    await cancelLocalRepaint();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('cancel_local_repaint');
  });
});
