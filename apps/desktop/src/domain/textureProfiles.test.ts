import { describe, expect, it } from 'vitest';
import { textureProfileDescriptions, textureProfileLabels } from './textureProfiles';

describe('texture profiles', () => {
  it('exposes all user-facing profiles', () => {
    expect(Object.keys(textureProfileLabels)).toEqual(['auto', 'safe', 'balanced', 'quality']);
  });

  it('describes auto as hardware-selected rather than a fixed triangle limit', () => {
    expect(textureProfileDescriptions.auto.toLowerCase()).toContain('gpu');
    expect(textureProfileDescriptions.auto).not.toContain('10000');
  });
});
