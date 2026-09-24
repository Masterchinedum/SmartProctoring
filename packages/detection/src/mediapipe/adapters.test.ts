import { describe, expect, it } from 'vitest';
import { facesFromMediapipe, fivePointsFromMesh, gazeFromBlendshapes, objectsFromMediapipe, type MpLandmark } from './adapters';

/**
 * Synthetic 478-point mesh: a 3D head model (cm) with the landmarks the adapter uses, projected with a
 * given yaw (subject-left positive → nose toward image +x) and pitch (up positive → nose toward −y),
 * plus an outline ring (forehead/chin/cheeks) so the landmark box is face-sized. Un-mirrored image.
 */
const MODEL: Record<number, [number, number, number]> = {
  468: [-3.2, 0, 0], // subject's right iris → image left
  473: [3.2, 0, 0],
  33: [-4.4, 0, -0.5],
  133: [-2.0, 0, 0],
  362: [2.0, 0, 0],
  263: [4.4, 0, -0.5],
  1: [0, 3.5, 2.0],
  61: [-2.4, 6.5, 1.0],
  291: [2.4, 6.5, 1.0],
};

function mesh(yawDeg: number, pitchDeg: number, opts: { cx?: number; cy?: number; scale?: number; iris?: boolean } = {}): MpLandmark[] {
  const cx = opts.cx ?? 0.5;
  const cy = opts.cy ?? 0.4;
  const sc = opts.scale ?? 0.018; // normalized units per cm (x); y scaled for 4:3
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const proj = ([X, Y, Z]: [number, number, number]): MpLandmark => {
    const x1 = X * Math.cos(y) + Z * Math.sin(y);
    const z1 = -X * Math.sin(y) + Z * Math.cos(y);
    const y2 = Y * Math.cos(p) - z1 * Math.sin(p);
    return { x: cx + x1 * sc, y: cy + y2 * sc * (4 / 3), z: z1 };
  };
  const n = opts.iris === false ? 468 : 478;
  const out: MpLandmark[] = [];
  for (let i = 0; i < n; i++) {
    if (MODEL[i]) out.push(proj(MODEL[i]));
    else {
      // outline ring around the face
      const a = (i / n) * 2 * Math.PI;
      out.push(proj([7 * Math.cos(a), 3 + 9 * Math.sin(a), -2]));
    }
  }
  return out;
}

describe('fivePointsFromMesh', () => {
  it('uses iris centres, nose tip and mouth corners', () => {
    const m = mesh(0, 0);
    const five = fivePointsFromMesh(m);
    expect(five).toHaveLength(5);
    expect(five[0]).toEqual({ x: m[468].x, y: m[468].y });
    expect(five[1]).toEqual({ x: m[473].x, y: m[473].y });
    expect(five[2]).toEqual({ x: m[1].x, y: m[1].y });
    expect(five[3]).toEqual({ x: m[61].x, y: m[61].y });
    expect(five[4]).toEqual({ x: m[291].x, y: m[291].y });
  });

  it('falls back to eye-corner midpoints without iris landmarks', () => {
    const m = mesh(0, 0, { iris: false });
    const five = fivePointsFromMesh(m);
    expect(five[0].x).toBeCloseTo((m[33].x + m[133].x) / 2, 9);
    expect(five[1].x).toBeCloseTo((m[362].x + m[263].x) / 2, 9);
  });
});

describe('facesFromMediapipe', () => {
  it('pose follows POSE_CONVENTION: turning to the subject’s left → yaw > 0; up → pitch > 0', () => {
    const [front] = facesFromMediapipe({ faceLandmarks: [mesh(0, 0)] }, null, { width: 640, height: 480 });
    expect(Math.abs(front.yaw)).toBeLessThan(3);
    expect(Math.abs(front.pitch)).toBeLessThan(4);
    const [left] = facesFromMediapipe({ faceLandmarks: [mesh(30, 0)] }, null, { width: 640, height: 480 });
    expect(left.yaw).toBeGreaterThan(20);
    const [right] = facesFromMediapipe({ faceLandmarks: [mesh(-30, 0)] }, null, { width: 640, height: 480 });
    expect(right.yaw).toBeLessThan(-20);
    const [up] = facesFromMediapipe({ faceLandmarks: [mesh(0, 20)] }, null, { width: 640, height: 480 });
    expect(up.pitch).toBeGreaterThan(8);
    const [down] = facesFromMediapipe({ faceLandmarks: [mesh(0, -20)] }, null, { width: 640, height: 480 });
    expect(down.pitch).toBeLessThan(-8);
  });

  it('box, score, visibility and cut-off', () => {
    const [f] = facesFromMediapipe({ faceLandmarks: [mesh(0, 0)] });
    expect(f.box.w).toBeGreaterThan(0.15);
    expect(f.box.w).toBeLessThan(0.4);
    expect(f.cutOff).toBe(false);
    expect(f.visibility).toBe(1);
    expect(f.score).toBeGreaterThan(0.9);
    const [cut] = facesFromMediapipe({ faceLandmarks: [mesh(0, 0, { cx: 0.95 })] });
    expect(cut.cutOff).toBe(true);
    expect(cut.visibility).toBeLessThan(0.9);
    expect(cut.box.x + cut.box.w).toBeLessThanOrEqual(1);
  });

  it('face-region quality from the gray frame lowers visibility and reports brightness', () => {
    const W = 160;
    const H = 120;
    const bright = new Uint8Array(W * H);
    for (let i = 0; i < bright.length; i++) bright[i] = 90 + ((i * 37) % 80); // textured
    const dark = new Uint8Array(W * H).fill(12);
    const [ok] = facesFromMediapipe({ faceLandmarks: [mesh(0, 0)] }, { data: bright, width: W, height: H });
    const [bad] = facesFromMediapipe({ faceLandmarks: [mesh(0, 0)] }, { data: dark, width: W, height: H });
    expect(ok.visibility).toBeGreaterThan(0.9);
    expect(bad.visibility).toBeLessThan(0.3);
    expect(bad.brightness).toBe(12);
    expect(ok.brightness).toBeGreaterThan(90);
  });

  it('gaze from blendshapes; skips malformed meshes', () => {
    const faces = facesFromMediapipe({
      faceLandmarks: [mesh(0, 0), [{ x: 0.5, y: 0.5 }]],
      faceBlendshapes: [{ categories: [{ categoryName: 'eyeLookOutLeft', score: 0.6 }, { categoryName: 'eyeLookInRight', score: 0.6 }] }],
    });
    expect(faces).toHaveLength(1);
    expect(faces[0].gazeX).toBeCloseTo(0.6, 5);
  });
});

describe('gazeFromBlendshapes', () => {
  const c = (o: Record<string, number>) => Object.entries(o).map(([categoryName, score]) => ({ categoryName, score }));
  it('signs: + toward subject-left, + up', () => {
    expect(gazeFromBlendshapes(c({ eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 })).gazeX).toBeCloseTo(0.8);
    expect(gazeFromBlendshapes(c({ eyeLookInLeft: 0.7, eyeLookOutRight: 0.7 })).gazeX).toBeCloseTo(-0.7);
    expect(gazeFromBlendshapes(c({ eyeLookUpLeft: 0.5, eyeLookUpRight: 0.5 })).gazeY).toBeCloseTo(0.5);
    expect(gazeFromBlendshapes(c({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.4 })).gazeY).toBeCloseTo(-0.5);
    expect(gazeFromBlendshapes([])).toEqual({ gazeX: 0, gazeY: 0 });
  });
});

describe('objectsFromMediapipe', () => {
  it('normalizes pixel boxes, takes the best category, lower-cases labels', () => {
    const objs = objectsFromMediapipe(
      {
        detections: [
          { categories: [{ categoryName: 'Cell Phone', score: 0.4 }, { categoryName: 'remote', score: 0.3 }], boundingBox: { originX: 64, originY: 48, width: 64, height: 96 } },
          { categories: [{ categoryName: 'person', score: 0.9 }], boundingBox: { originX: 600, originY: 0, width: 100, height: 480 } },
          { categories: [] },
        ],
      },
      640,
      480,
    );
    expect(objs).toHaveLength(2);
    expect(objs[0]).toEqual({ label: 'cell phone', score: 0.4, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.2 } });
    expect(objs[1].box.x + objs[1].box.w).toBeLessThanOrEqual(1);
  });
});
