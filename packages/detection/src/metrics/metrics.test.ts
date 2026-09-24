import { describe, expect, it } from 'vitest';
import { computeFrameMetrics, createFrameMetricsTracker, regionStats, rgbaToGray } from './frame';
import { dhash64, hammingHex, majorityHash, popcount32 } from './hash';
import { Rng } from '../eval/prng';

const W = 160;
const H = 120;

/** A textured synthetic "room": gradients + blobs, deterministic. */
function scene(shiftX = 0, seed = 1): Uint8Array {
  const r = new Rng(seed);
  const blobs = Array.from({ length: 12 }, () => ({ x: r.range(0, W), y: r.range(0, H), s: r.range(6, 20), a: r.pick([-1, 1]) * r.range(50, 100) }));
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 110 + (x * 20) / W + (y * 10) / H;
      for (const b of blobs) v += b.a * Math.exp(-((x - shiftX - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s));
      g[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  return g;
}

function withNoise(g: Uint8Array, std: number, seed: number): Uint8Array {
  const r = new Rng(seed);
  return g.map((v) => Math.max(0, Math.min(255, Math.round(v + r.normal(0, std)))));
}

describe('rgbaToGray', () => {
  it('uses BT.601 luma weights', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const g = rgbaToGray(rgba, 4, 1);
    expect(Array.from(g)).toEqual([76, 149, 28, 255]);
  });
});

describe('computeFrameMetrics', () => {
  it('luma / contrast / sharpness / diff', () => {
    const flat = new Uint8Array(W * H).fill(100);
    const m = computeFrameMetrics(flat, W, H);
    expect(m.luma).toBe(100);
    expect(m.contrast).toBe(0);
    expect(m.sharpness).toBe(0);
    expect(m.diffFromPrev).toBeNull();
    const brighter = new Uint8Array(W * H).fill(110);
    expect(computeFrameMetrics(brighter, W, H, flat).diffFromPrev).toBe(10);
    const tex = scene();
    const mt = computeFrameMetrics(tex, W, H);
    expect(mt.contrast).toBeGreaterThan(10);
    expect(mt.sharpness).toBeGreaterThan(0);
    expect(mt.dhash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('identical frames → diff 0 and identical dHash (frozen signature); sensor noise → diff > 0.15', () => {
    const a = scene();
    const same = computeFrameMetrics(a, W, H, a.slice());
    expect(same.diffFromPrev).toBe(0);
    expect(same.dhash).toBe(computeFrameMetrics(a, W, H).dhash);
    const noisy = withNoise(a, 2, 7);
    expect(computeFrameMetrics(noisy, W, H, a).diffFromPrev!).toBeGreaterThan(0.15);
  });

  it('tracker keeps the previous frame (copy) and resets', () => {
    const t = createFrameMetricsTracker();
    const buf = scene();
    expect(t.next(buf, W, H).diffFromPrev).toBeNull();
    buf.fill(0); // host reuses its buffer
    expect(t.next(buf, W, H).diffFromPrev!).toBeGreaterThan(10);
    t.reset();
    expect(t.next(buf, W, H).diffFromPrev).toBeNull();
  });
});

describe('dhash64 / hammingHex', () => {
  it('stable under sensor noise and global brightness change', () => {
    const a = scene();
    const h = dhash64(a, W, H);
    for (let s = 0; s < 5; s++) expect(hammingHex(h, dhash64(withNoise(a, 3, s + 10), W, H))).toBeLessThanOrEqual(3);
    const brighter = a.map((v) => Math.min(255, v + 20));
    expect(hammingHex(h, dhash64(brighter, W, H))).toBeLessThanOrEqual(2);
  });

  it('sensitive to scene changes and movement', () => {
    const a = dhash64(scene(0, 1), W, H);
    expect(hammingHex(a, dhash64(scene(0, 2), W, H))).toBeGreaterThanOrEqual(12);
    expect(hammingHex(a, dhash64(scene(20, 1), W, H))).toBeGreaterThanOrEqual(5);
  });

  it('hamming distance basics', () => {
    expect(hammingHex('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingHex('0000000000000001', '0000000000000000')).toBe(1);
    expect(hammingHex('8000000000000000', '0000000000000000')).toBe(1);
    expect(hammingHex('abc', 'abc')).toBe(0);
    expect(hammingHex('ab', 'abcd')).toBe(8);
    expect(popcount32(0xffffffff)).toBe(32);
  });

  it('majority hash is the bitwise median', () => {
    expect(majorityHash(['ffff000000000000', 'ffff000000000001', 'fff0000000000001'])).toBe('ffff000000000001');
    expect(majorityHash([])).toBe('');
  });

  it('handles tiny images', () => {
    expect(dhash64(new Uint8Array([1, 2, 3, 4]), 2, 2)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('regionStats', () => {
  it('computes stats of a normalized box, clamped to the image', () => {
    const g = new Uint8Array(W * H).fill(200);
    for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) g[y * W + x] = 20;
    const r = regionStats(g, W, H, { x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(r.mean).toBe(20);
    expect(r.std).toBe(0);
    const whole = regionStats(g, W, H, { x: -0.5, y: -0.5, w: 2, h: 2 });
    expect(whole.mean).toBeCloseTo(155, 0);
    expect(whole.std).toBeGreaterThan(50);
    expect(whole.sharpness).toBeGreaterThan(0);
    expect(regionStats(g, W, H, { x: 2, y: 2, w: 0.1, h: 0.1 })).toEqual({ mean: 0, std: 0, sharpness: 0 });
  });
});
