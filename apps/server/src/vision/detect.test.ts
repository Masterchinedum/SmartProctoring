import { describe, expect, it } from 'vitest';
import { decodeToDetectedFaces, decodeYuNet, iou, nonMaxSuppression, packBgrPlanar, planDetectorInput, sortFaces, YUNET_INPUT_SIZE } from './detect';
import type { DetectedFace } from './types';

/** Build zeroed YuNet outputs and set one cell. */
function outputs(cells: { stride: 8 | 16 | 32; r: number; c: number; cls: number; obj: number; bbox: number[]; kps: number[] }[]) {
  const out: Record<string, { data: Float32Array }> = {};
  for (const s of [8, 16, 32]) {
    const n = (640 / s) ** 2;
    out[`cls_${s}`] = { data: new Float32Array(n) };
    out[`obj_${s}`] = { data: new Float32Array(n) };
    out[`bbox_${s}`] = { data: new Float32Array(4 * n) };
    out[`kps_${s}`] = { data: new Float32Array(10 * n) };
  }
  for (const cell of cells) {
    const cols = 640 / cell.stride;
    const i = cell.r * cols + cell.c;
    out[`cls_${cell.stride}`].data[i] = cell.cls;
    out[`obj_${cell.stride}`].data[i] = cell.obj;
    out[`bbox_${cell.stride}`].data.set(cell.bbox, 4 * i);
    out[`kps_${cell.stride}`].data.set(cell.kps, 10 * i);
  }
  return out;
}

describe('decodeYuNet', () => {
  it('decodes score, box and landmarks of an anchor cell', () => {
    const out = outputs([{ stride: 16, r: 10, c: 20, cls: 0.81, obj: 1.0, bbox: [0.5, 0.25, Math.log(4), Math.log(5)], kps: [-1, -1, 1, -1, 0, 0, -1, 1, 1, 1] }]);
    const dets = decodeYuNet(out, 0.6);
    expect(dets).toHaveLength(1);
    const d = dets[0];
    expect(d.score).toBeCloseTo(0.9, 6); // sqrt(0.81 * 1)
    // centre ((20 + 0.5) * 16, (10 + 0.25) * 16) = (328, 164); size (64, 80)
    expect(d.w).toBeCloseTo(64, 4);
    expect(d.h).toBeCloseTo(80, 4);
    expect(d.x).toBeCloseTo(328 - 32, 4);
    expect(d.y).toBeCloseTo(164 - 40, 4);
    expect(d.kps[0]).toBeCloseTo((20 - 1) * 16, 4);
    expect(d.kps[1]).toBeCloseTo((10 - 1) * 16, 4);
    expect(d.kps[4]).toBeCloseTo(20 * 16, 4);
  });

  it('clamps scores and applies the threshold', () => {
    const out = outputs([
      { stride: 8, r: 1, c: 1, cls: 1.7, obj: 1.2, bbox: [0, 0, 0, 0], kps: new Array(10).fill(0) },
      { stride: 32, r: 2, c: 2, cls: 0.3, obj: 0.9, bbox: [0, 0, 0, 0], kps: new Array(10).fill(0) },
    ]);
    const dets = decodeYuNet(out, 0.6);
    expect(dets).toHaveLength(1);
    expect(dets[0].score).toBe(1);
  });

  it('throws on missing outputs', () => {
    expect(() => decodeYuNet({ cls_8: { data: new Float32Array(1) } })).toThrow();
  });
});

describe('NMS, mapping and ordering', () => {
  it('computes IoU', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBeCloseTo(1);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(50 / 150);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
  });

  it('suppresses overlapping lower-scoring boxes only', () => {
    const kept = nonMaxSuppression([
      { x: 0, y: 0, w: 100, h: 100, score: 0.8 },
      { x: 5, y: 5, w: 100, h: 100, score: 0.9 },
      { x: 300, y: 300, w: 50, h: 50, score: 0.7 },
    ]);
    expect(kept.map((k) => k.score)).toEqual([0.9, 0.7]);
  });

  it('maps detector coordinates back to the original image and puts the main face first', () => {
    const out = outputs([
      { stride: 32, r: 5, c: 5, cls: 0.9, obj: 0.9, bbox: [0, 0, Math.log(4), Math.log(5)], kps: new Array(10).fill(0) }, // big
      { stride: 8, r: 70, c: 10, cls: 1, obj: 1, bbox: [0, 0, Math.log(3), Math.log(3)], kps: new Array(10).fill(0) }, // small, higher score
    ]);
    const faces = decodeToDetectedFaces(out, 0.6, 0.5); // detector image = original * 0.5
    expect(faces).toHaveLength(2);
    expect(faces[0].box.w).toBeCloseTo(4 * 32 * 2, 4);
    expect(faces[0].box.x).toBeCloseTo((5 * 32 - 64) * 2, 4);
    expect(faces[1].score).toBe(1);
  });

  it('sortFaces ranks by area x score', () => {
    const f = (w: number, score: number): DetectedFace => ({ box: { x: 0, y: 0, w, h: w }, score, landmarks: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] });
    expect(sortFaces([f(50, 0.99), f(120, 0.7), f(100, 0.9)]).map((x) => x.box.w)).toEqual([120, 100, 50]);
  });
});

describe('detector input', () => {
  it('plans the letterbox resize', () => {
    expect(planDetectorInput(640, 480)).toEqual({ resize: false, width: 640, height: 480 });
    expect(planDetectorInput(1280, 720)).toEqual({ resize: true, width: 640, height: 360 });
    expect(planDetectorInput(320, 240)).toEqual({ resize: true, width: 640, height: 480 });
    expect(planDetectorInput(480, 640)).toEqual({ resize: false, width: 480, height: 640 });
  });

  it('packs BGR planar with zero padding and overwrites reused buffers', () => {
    const img = { data: new Uint8Array([10, 20, 30, 40, 50, 60]), width: 2, height: 1 };
    const plane = YUNET_INPUT_SIZE * YUNET_INPUT_SIZE;
    const dirty = new Float32Array(3 * plane).fill(7);
    const t = packBgrPlanar(img, YUNET_INPUT_SIZE, dirty);
    expect(t).toBe(dirty);
    expect([t[0], t[plane], t[2 * plane]]).toEqual([30, 20, 10]); // B, G, R of pixel 0
    expect([t[1], t[plane + 1], t[2 * plane + 1]]).toEqual([60, 50, 40]);
    expect(t[2]).toBe(0);
    expect(t[YUNET_INPUT_SIZE]).toBe(0);
    expect(t[3 * plane - 1]).toBe(0);
    expect(t.some((v) => v === 7)).toBe(false);
  });
});
