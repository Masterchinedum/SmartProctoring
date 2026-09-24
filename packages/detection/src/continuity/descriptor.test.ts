import { describe, expect, it } from 'vitest';
import { facePatch, geomDistance, meshGeometry, normalise, patchDistance, PATCH_SIZE } from './descriptor';
import { facesFromMediapipe, type MpLandmark } from '../mediapipe/adapters';
import { eyesOf, FRAME_H, FRAME_W, person, renderFrame } from '../testing/faces';

const BOX = { x: 0.36, y: 0.24, w: 0.28, h: 0.42 };

describe('facePatch / patchDistance', () => {
  it('is a normalised 16×16 patch: identical for the same image, invariant to brightness and contrast', () => {
    const p = person(3);
    const g = renderFrame(p, BOX, { seed: 1 });
    const a = facePatch(g, FRAME_W, FRAME_H, BOX, eyesOf(p, BOX))!;
    expect(a).toHaveLength(PATCH_SIZE * PATCH_SIZE);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
    expect(patchDistance(a, a)).toBeCloseTo(0, 6);
    const lit = facePatch(renderFrame(p, BOX, { seed: 1, gain: 1.4, offset: -20 }), FRAME_W, FRAME_H, BOX, eyesOf(p, BOX))!;
    expect(patchDistance(a, lit)).toBeLessThan(0.02);
  });

  it('the eye-aligned patch follows the face when it moves or changes size (the box-based one drifts more)', () => {
    const p = person(4);
    const a = facePatch(renderFrame(p, BOX), FRAME_W, FRAME_H, BOX, eyesOf(p, BOX))!;
    const moved = { x: 0.3, y: 0.3, w: 0.34, h: 0.51 };
    const b = facePatch(renderFrame(p, moved), FRAME_W, FRAME_H, moved, eyesOf(p, moved))!;
    expect(patchDistance(a, b)).toBeLessThan(0.05);
  });

  it('separates two different people clearly', () => {
    const pa = person(11);
    const pb = person(22);
    const a = facePatch(renderFrame(pa, BOX, { noise: 3 }), FRAME_W, FRAME_H, BOX, eyesOf(pa, BOX))!;
    const b = facePatch(renderFrame(pb, BOX, { noise: 3 }), FRAME_W, FRAME_H, BOX, eyesOf(pb, BOX))!;
    expect(patchDistance(a, b)).toBeGreaterThan(0.3);
  });

  it('returns null for a tiny face or a flat region, NaN distances for missing input', () => {
    const g = new Uint8Array(FRAME_W * FRAME_H).fill(120);
    expect(facePatch(g, FRAME_W, FRAME_H, BOX)).toBeNull(); // flat
    const p = person(5);
    const tiny = { x: 0.5, y: 0.5, w: 0.04, h: 0.06 };
    expect(facePatch(renderFrame(p, tiny), FRAME_W, FRAME_H, tiny)).toBeNull();
    expect(Number.isNaN(patchDistance(null, new Float32Array(4)))).toBe(true);
    expect(normalise(new Float32Array(16).fill(3))).toBeNull();
  });
});

describe('meshGeometry / geomDistance', () => {
  function mesh(scaleX: number, eyeSpread = 1): MpLandmark[] {
    const lm: MpLandmark[] = Array.from({ length: 478 }, (_, i) => ({ x: 0.5 + 0.1 * Math.cos(i), y: 0.5 + 0.12 * Math.sin(i) }));
    const set = (i: number, x: number, y: number) => (lm[i] = { x: 0.5 + x * scaleX, y: 0.45 + y * scaleX });
    set(468, -0.032 * eyeSpread, 0);
    set(473, 0.032 * eyeSpread, 0);
    set(33, -0.045, 0);
    set(133, -0.02, 0);
    set(362, 0.02, 0);
    set(263, 0.045, 0);
    set(234, -0.075, 0.02);
    set(454, 0.075, 0.02);
    set(61, -0.025, 0.07);
    set(291, 0.025, 0.07);
    set(129, -0.012, 0.04);
    set(358, 0.012, 0.04);
    set(172, -0.06, 0.07);
    set(397, 0.06, 0.07);
    return lm;
  }

  it('is scale-free (same face nearer or farther) and changes with facial proportions', () => {
    const a = meshGeometry(mesh(1), 640, 480)!;
    const b = meshGeometry(mesh(1.4), 640, 480)!;
    expect(a).toHaveLength(5);
    expect(geomDistance(a, b)).toBeLessThan(0.005);
    const c = meshGeometry(mesh(1, 1.15), 640, 480)!;
    expect(geomDistance(a, c)).toBeGreaterThan(0.03);
  });

  it('is null for an incomplete mesh', () => {
    expect(meshGeometry([], 640, 480)).toBeNull();
    expect(Number.isNaN(geomDistance([1, 2], [1]))).toBe(true);
  });
});

describe('facesFromMediapipe descriptors', () => {
  it('attaches a descriptor only when asked', () => {
    const lm: MpLandmark[] = Array.from({ length: 478 }, (_, i) => ({ x: 0.4 + 0.2 * ((i * 37) % 100) / 100, y: 0.3 + 0.3 * ((i * 53) % 100) / 100 }));
    const p = person(9);
    const gray = { data: renderFrame(p, BOX), width: FRAME_W, height: FRAME_H };
    const plain = facesFromMediapipe({ faceLandmarks: [lm] }, gray, { width: 640, height: 480 });
    expect('descriptor' in plain[0]).toBe(false);
    const described = facesFromMediapipe({ faceLandmarks: [lm] }, gray, { width: 640, height: 480 }, { descriptors: true });
    expect(described[0].descriptor).toBeDefined();
    expect(described[0].descriptor!.geom).toHaveLength(5);
  });
});
