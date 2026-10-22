import { poseFromFivePoints } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { flopRgb, matchMirrored, symmetricLandmarks } from './engine';
import { syntheticLandmarks } from './fake';
import type { DetectedFace } from './types';

const W = 640;
const mirrorFace = (f: DetectedFace): DetectedFace => ({
  ...f,
  box: { ...f.box, x: W - f.box.x - f.box.w },
  // What a detector reports on the mirror image: points in mirrored coordinates, image-left first.
  landmarks: [f.landmarks[1], f.landmarks[0], f.landmarks[2], f.landmarks[4], f.landmarks[3]].map((p) => ({ x: W - p.x, y: p.y })) as DetectedFace['landmarks'],
});
const face = (yaw: number, cx = 300): DetectedFace => {
  const landmarks = syntheticLandmarks(yaw, -8, cx, 240, 12.5);
  return { box: { x: cx - 60, y: 160, w: 120, h: 150 }, score: 0.93, landmarks };
};

describe('mirror-symmetric head pose (VisionEngineOptions.symmetricPose)', () => {
  it('flopRgb mirrors rows', () => {
    const img = { width: 3, height: 2, data: Uint8Array.from([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6]) };
    expect(Array.from(flopRgb(img).data)).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1, 6, 6, 6, 5, 5, 5, 4, 4, 4]);
    expect(Array.from(flopRgb(flopRgb(img)).data)).toEqual(Array.from(img.data));
  });

  it('finds the primary face in the mirrored detections and maps its landmarks back', () => {
    const primary = face(20);
    const other = mirrorFace(face(0, 520));
    const m = matchMirrored(primary, [other, mirrorFace(primary)], W)!;
    for (let i = 0; i < 5; i++) expect(m.landmarks.some((p) => Math.abs(p.x - primary.landmarks[i].x) < 1e-9 && Math.abs(p.y - primary.landmarks[i].y) < 1e-9)).toBe(true);
    expect(matchMirrored(primary, [other], W)).toBeNull();
    expect(matchMirrored(primary, [], W)).toBeNull();
  });

  it('keeps an unbiased pose and cancels a detector bias that is not mirror-symmetric', () => {
    for (const yaw of [-30, -18, -5, 0, 7, 22, 30]) {
      const truth = face(yaw);
      const own = symmetricLandmarks(truth.landmarks, matchMirrored(truth, [mirrorFace(truth)], W)!.landmarks);
      expect(poseFromFivePoints(own).yawDeg).toBeCloseTo(poseFromFivePoints(truth.landmarks).yawDeg, 6);
      // A detector that always places the nose 3 px to the image-right of where it is (+~6-9 deg of yaw).
      const biased = (f: DetectedFace): DetectedFace => ({ ...f, landmarks: f.landmarks.map((p, i) => (i === 2 ? { x: p.x + 3, y: p.y } : p)) as DetectedFace['landmarks'] });
      const seen = biased(truth);
      const seenMirror = biased(mirrorFace(truth));
      const raw = poseFromFivePoints(seen.landmarks).yawDeg;
      const rawMirror = poseFromFivePoints(seenMirror.landmarks).yawDeg;
      expect(Math.abs(raw + rawMirror)).toBeGreaterThan(8);
      const sym = poseFromFivePoints(symmetricLandmarks(seen.landmarks, matchMirrored(seen, [seenMirror], W)!.landmarks)).yawDeg;
      const symMirror = poseFromFivePoints(symmetricLandmarks(seenMirror.landmarks, matchMirrored(seenMirror, [seen], W)!.landmarks)).yawDeg;
      expect(sym + symMirror).toBeCloseTo(0, 6);
      expect(sym).toBeCloseTo(poseFromFivePoints(truth.landmarks).yawDeg, 6);
    }
  });
});
