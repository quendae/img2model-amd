import { describe, expect, it } from 'vitest';
import { modelFormatFromUrl } from './modelPreview';

describe('modelFormatFromUrl', () => {
  it('detects GLB output urls', () => {
    expect(modelFormatFromUrl('asset://localhost/C:/out/model.glb')).toBe('glb');
  });

  it('detects OBJ output urls including query strings', () => {
    expect(modelFormatFromUrl('asset://localhost/C:/out/model.obj?cache=1')).toBe('obj');
  });

  it('rejects unsupported preview formats', () => {
    expect(() => modelFormatFromUrl('asset://localhost/C:/out/model.stl')).toThrow(/unsupported/i);
  });
});
