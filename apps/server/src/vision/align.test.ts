import { describe, expect, it } from 'vitest';
import { ARCFACE_TEMPLATE_112, alignFace, applySimilarity, estimateSimilarityTransform, invertSimilarity, warpSimilarity, type SimilarityTransform } from './align';
import type { RgbImage } from './image';

const transformPoints = (t: SimilarityTransform, pts: readonly { x: number; y: number }[]) => pts.map((p) => applySimilarity(t, p));

function makeT(scale: number, angleDeg: number, tx: number, ty: number): SimilarityTransform {
  const r = (angleDeg * Math.PI) / 180;
  return { a: scale * Math.cos(r), b: scale * Math.sin(r), tx, ty };
}

describe('estimateSimilarityTransform', () => {
  it('recovers an exact similarity transform', () => {
    const truth = makeT(2.7, 17, -40, 125);
    const src = [
      { x: 10, y: 20 },
      { x: 55, y: 18 },
      { x: 33, y: 40 },
      { x: 15, y: 62 },
      { x: 50, y: 61 },
    ];
    const t = estimateSimilarityTransform(src, transformPoints(truth, src));
    expect(t.a).toBeCloseTo(truth.a, 9);
    expect(t.b).toBeCloseTo(truth.b, 9);
    expect(t.tx).toBeCloseTo(truth.tx, 7);
    expect(t.ty).toBeCloseTo(truth.ty, 7);
  });

  it('is the least-squares fit under noise (residual not larger than the truth)', () => {
    const truth = makeT(0.4, -8, 12, -3);
    const src = ARCFACE_TEMPLATE_112.map((p) => ({ x: p.x * 3 + 100, y: p.y * 3 + 50 }));
    const noise = [
      [0.8, -0.5],
      [-0.3, 0.9],
      [0.4, 0.2],
      [-0.7, -0.6],
      [0.1, 0.5],
    ];
    const dst = transformPoints(truth, src).map((p, i) => ({ x: p.x + noise[i][0], y: p.y + noise[i][1] }));
    const t = estimateSimilarityTransform(src, dst);
    const sse = (tt: SimilarityTransform) => transformPoints(tt, src).reduce((s, p, i) => s + (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2, 0);
    expect(sse(t)).toBeLessThanOrEqual(sse(truth) + 1e-9);
    expect(Math.hypot(t.a, t.b)).toBeCloseTo(0.4, 2);
  });

  it('never produces a reflection (mirrored input cannot be fitted exactly)', () => {
    const mirrored = ARCFACE_TEMPLATE_112.map((p) => ({ x: 112 - p.x, y: p.y }));
    // Keep the semantic order (left eye first) so a reflection would be needed for a perfect fit.
    const t = estimateSimilarityTransform(mirrored, ARCFACE_TEMPLATE_112);
    const mapped = transformPoints(t, mirrored);
    const residual = mapped.reduce((s, p, i) => s + Math.hypot(p.x - ARCFACE_TEMPLATE_112[i].x, p.y - ARCFACE_TEMPLATE_112[i].y), 0);
    expect(residual).toBeGreaterThan(10);
    // The [a -b; b a] form always has a positive determinant.
    expect(t.a * t.a + t.b * t.b).toBeGreaterThan(0);
  });

  it('rejects degenerate input', () => {
    expect(() => estimateSimilarityTransform([{ x: 1, y: 1 }, { x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow();
    expect(() => estimateSimilarityTransform([{ x: 1, y: 1 }], [{ x: 0, y: 0 }])).toThrow();
  });

  it('inverts', () => {
    const t = makeT(1.9, 33, 5, -7);
    const inv = invertSimilarity(t);
    const p = { x: 12.5, y: -4.25 };
    const back = applySimilarity(inv, applySimilarity(t, p));
    expect(back.x).toBeCloseTo(p.x, 10);
    expect(back.y).toBeCloseTo(p.y, 10);
  });
});

function gradientImage(w: number, h: number): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 3;
      data[p] = x % 256;
      data[p + 1] = y % 256;
      data[p + 2] = (x + y) % 256;
    }
  return { data, width: w, height: h };
}

describe('warpSimilarity / alignFace', () => {
  it('a pure translation copies pixels (RGB planar output)', () => {
    const img = gradientImage(200, 150);
    const face = warpSimilarity(img, { a: 1, b: 0, tx: -30, ty: -20 }, 112);
    const plane = 112 * 112;
    // Output (u, v) samples source (u + 30, v + 20).
    for (const [u, v] of [
      [0, 0],
      [50, 60],
      [111, 111],
    ]) {
      const o = v * 112 + u;
      expect(face.rgb[o]).toBeCloseTo(u + 30, 5);
      expect(face.rgb[plane + o]).toBeCloseTo(v + 20, 5);
      expect(face.rgb[2 * plane + o]).toBeCloseTo((u + 30 + v + 20) % 256, 5);
      expect(face.valid[o]).toBe(1);
    }
  });

  it('bilinear interpolation at half-pixel offsets', () => {
    const img = gradientImage(200, 150);
    const face = warpSimilarity(img, { a: 1, b: 0, tx: -10.5, ty: -10.5 }, 112);
    expect(face.rgb[0]).toBeCloseTo(10.5, 5);
  });

  it('marks samples outside the source as invalid and black', () => {
    const img = gradientImage(60, 60);
    const face = warpSimilarity(img, { a: 1, b: 0, tx: 0, ty: 0 }, 112);
    const o = 100 * 112 + 100;
    expect(face.valid[o]).toBe(0);
    expect(face.rgb[o]).toBe(0);
    expect(face.valid[10 * 112 + 10]).toBe(1);
  });

  it('landmarks equal to the template give the identity transform', () => {
    const img = gradientImage(112, 112);
    const face = alignFace(img, ARCFACE_TEMPLATE_112);
    expect(face.transform.a).toBeCloseTo(1, 9);
    expect(face.transform.b).toBeCloseTo(0, 9);
    expect(face.transform.tx).toBeCloseTo(0, 7);
    expect(face.gray.length).toBe(112 * 112);
  });

  it('maps scaled / rotated landmarks onto the template', () => {
    const t = makeT(3, 25, 200, 80);
    const inv = invertSimilarity(t);
    // Landmarks in a big image = template mapped by t; alignment must recover t's inverse.
    const lm = ARCFACE_TEMPLATE_112.map((p) => applySimilarity(t, p));
    const face = alignFace(gradientImage(800, 700), lm);
    expect(face.transform.a).toBeCloseTo(inv.a, 9);
    expect(face.transform.b).toBeCloseTo(inv.b, 9);
  });
});
