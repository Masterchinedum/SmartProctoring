import { describe, expect, it } from 'vitest';
import { cameraDiffers } from './checks.js';

describe('cameraDiffers', () => {
  it('treats the same label with a re-randomised deviceId (incognito reload) as the same camera', () => {
    expect(cameraDiffers({ cameraLabel: 'FaceTime HD Camera', cameraIdHash: 'a'.repeat(64) }, { cameraLabel: 'FaceTime HD Camera', cameraIdHash: 'b'.repeat(64) })).toBe(false);
  });
  it('detects a different camera by label', () => {
    expect(cameraDiffers({ cameraLabel: 'FaceTime HD Camera', cameraIdHash: 'a' }, { cameraLabel: 'Logitech C920', cameraIdHash: 'a' })).toBe(true);
  });
  it('falls back to the deviceId hash when a label is missing', () => {
    expect(cameraDiffers({ cameraLabel: '', cameraIdHash: 'a' }, { cameraLabel: 'X', cameraIdHash: 'b' })).toBe(true);
    expect(cameraDiffers({ cameraLabel: '', cameraIdHash: 'a' }, { cameraLabel: '', cameraIdHash: 'a' })).toBe(false);
    expect(cameraDiffers({ cameraLabel: null, cameraIdHash: null }, { cameraLabel: '', cameraIdHash: 'b' })).toBe(false);
  });
});
