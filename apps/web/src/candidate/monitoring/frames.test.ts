import { describe, expect, it } from 'vitest';
import { analysisSize, FACE_CROP_MAX, faceCropRect, graySize } from './frames';

describe('faceCropRect (identity evidence at native resolution)', () => {
  it('is a square ~2.4× the face box, centred on the face, at native resolution up to 720 px', () => {
    // 1280×720 camera, face box 200×260 px centred at (640, 330).
    const r = faceCropRect({ x: 540 / 1280, y: 200 / 720, w: 200 / 1280, h: 260 / 720 }, 1280, 720);
    expect(r.face).toBe(true);
    expect(r.sw).toBe(r.sh);
    expect(r.sw).toBe(Math.round(260 * 2.4));
    expect(r.sx + r.sw / 2).toBeCloseTo(640, 0);
    expect(r.sy + r.sh / 2).toBeCloseTo(330, 0); // fits vertically (624 px side, 720 px high)
    expect(r.width).toBe(624); // not scaled: native pixels
    expect(r.width).toBe(r.height);
  });

  it('never upscales, caps the output at 720 px and stays inside the frame near an edge', () => {
    const big = faceCropRect({ x: 0.3, y: 0.1, w: 0.4, h: 0.7 }, 1920, 1080);
    expect(big.sw).toBe(1080); // limited by the frame's shorter side
    expect(big.width).toBe(FACE_CROP_MAX);
    const edge = faceCropRect({ x: 0.9, y: 0.05, w: 0.1, h: 0.2 }, 640, 480);
    expect(edge.sx + edge.sw).toBeLessThanOrEqual(640);
    expect(edge.sy).toBeGreaterThanOrEqual(0);
    expect(edge.width).toBe(edge.sw);
  });

  it('falls back to the full frame (≤ 1280 px) without a usable face box', () => {
    expect(faceCropRect(null, 640, 480)).toEqual({ sx: 0, sy: 0, sw: 640, sh: 480, width: 640, height: 480, face: false });
    const hd = faceCropRect({ x: 0.1, y: 0.1, w: 0, h: 0.2 }, 1920, 1080);
    expect(hd.face).toBe(false);
    expect(hd.width).toBe(1280);
    expect(hd.height).toBe(720);
  });
});

describe('analysis sizes', () => {
  it('MediaPipe analyses ≤ 640 px with the camera aspect ratio (normalised boxes map to the full frame)', () => {
    expect(analysisSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(analysisSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(analysisSize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it('the small gray frame is 160 px wide with the camera aspect ratio', () => {
    expect(graySize(640, 480)).toEqual({ width: 160, height: 120 });
    expect(graySize(1280, 720)).toEqual({ width: 160, height: 90 });
  });
});
