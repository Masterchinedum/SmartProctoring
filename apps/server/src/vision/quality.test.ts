import { QUALITY_GUIDANCE } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { syntheticLandmarks } from './fake';
import { assessQuality, guidanceForIssues, ID_PHOTO_QUALITY_GATE, isCutOff, poseWithinGate, QUALITY_GATE, regateQuality, resolveGate, type FaceRegionStats, type QualityInput } from './quality';
import type { DetectedFace, HeadPose } from './types';

function face(cx: number, cy: number, w: number, score = 0.93): DetectedFace {
  return { box: { x: cx - w / 2, y: cy - w * 0.6, w, h: w * 1.2 }, score, landmarks: syntheticLandmarks(0, 0, cx, cy, (w * 0.4) / 6.4) };
}
const GOOD_STATS: FaceRegionStats = { brightness: 130, contrast: 45, sharpness: 900, rawLaplacianVar: 700 };
const FRONTAL: HeadPose = { yawDeg: 2, pitchDeg: -8, rollDeg: 0 };

function input(over: Partial<QualityInput> = {}): QualityInput {
  return { width: 640, height: 480, faces: [face(320, 240, 200)], pose: FRONTAL, stats: GOOD_STATS, imageBrightness: 120, imageContrast: 50, ...over };
}

describe('assessQuality', () => {
  it('passes a good frontal face', () => {
    const q = assessQuality(input());
    expect(q.issues).toEqual([]);
    expect(q.usable).toBe(true);
    expect(q.faceCount).toBe(1);
    expect(q.interEyePx).toBeCloseTo(80, 0);
    expect(q.faceWidthRatio).toBeCloseTo(200 / 640, 3);
  });

  it('no face (and says why when the whole image is dark)', () => {
    expect(assessQuality(input({ faces: [], stats: null, pose: null })).issues).toEqual(['no_face']);
    const dark = assessQuality(input({ faces: [], stats: null, pose: null, imageBrightness: 12 }));
    expect(dark.issues).toEqual(['no_face', 'too_dark']);
    expect(dark.usable).toBe(false);
  });

  it('multiple faces only when the second face is significant', () => {
    const big = assessQuality(input({ faces: [face(200, 240, 200), face(480, 240, 150)] }));
    expect(big.issues).toContain('multiple_faces');
    expect(big.faceCount).toBe(2);
    const small = assessQuality(input({ faces: [face(200, 240, 200), face(560, 100, 40)] }));
    expect(small.issues).not.toContain('multiple_faces');
    expect(small.faceCount).toBe(1);
  });

  it('flags small, cut-off, turned, dark, bright, low-contrast, blurry and low-confidence faces', () => {
    expect(assessQuality(input({ faces: [face(320, 240, 60)] })).issues).toContain('face_too_small');
    expect(assessQuality(input({ faces: [face(20, 240, 200)] })).issues).toContain('face_cut_off');
    expect(assessQuality(input({ pose: { yawDeg: 31, pitchDeg: 0, rollDeg: 0 } })).issues).toContain('face_turned');
    expect(assessQuality(input({ pose: { yawDeg: 0, pitchDeg: -40, rollDeg: 0 } })).issues).toContain('face_turned');
    expect(assessQuality(input({ pose: { yawDeg: 0, pitchDeg: 30, rollDeg: 0 } })).issues).toContain('face_turned');
    expect(assessQuality(input({ stats: { ...GOOD_STATS, brightness: 30 } })).issues).toContain('too_dark');
    expect(assessQuality(input({ stats: { ...GOOD_STATS, brightness: 235 } })).issues).toContain('too_bright');
    expect(assessQuality(input({ stats: { ...GOOD_STATS, contrast: 10 } })).issues).toContain('low_contrast');
    expect(assessQuality(input({ stats: { ...GOOD_STATS, sharpness: 20 } })).issues).toEqual(['blurry']);
    expect(assessQuality(input({ faces: [face(320, 240, 200, 0.62)] })).issues).toEqual(['low_detection_confidence']);
  });

  it('does not add "blurry" on top of "too dark" (guidance stays actionable)', () => {
    const q = assessQuality(input({ stats: { brightness: 20, contrast: 8, sharpness: 5, rawLaplacianVar: 1 } }));
    expect(q.issues).toEqual(['too_dark', 'low_contrast']);
  });

  it('orders issues most-fundamental first', () => {
    const q = assessQuality(input({ faces: [face(20, 240, 60, 0.6), face(400, 240, 60)], stats: { ...GOOD_STATS, sharpness: 1 } }));
    expect(q.issues[0]).toBe('multiple_faces');
    expect(q.issues.at(-1)).toBe('low_detection_confidence');
  });
});

describe('gates', () => {
  it('pose window is asymmetric (frontal YuNet faces read slightly "down")', () => {
    expect(poseWithinGate(0, -30)).toBe(true);
    expect(poseWithinGate(0, 24)).toBe(true);
    expect(poseWithinGate(26, 0)).toBe(false);
    expect(poseWithinGate(0, -36)).toBe(false);
  });

  it('resolveGate overrides only finite numbers', () => {
    const g = resolveGate({ minInterEyePx: 10, maxAbsYawDeg: Number.NaN });
    expect(g.minInterEyePx).toBe(10);
    expect(g.maxAbsYawDeg).toBe(QUALITY_GATE.maxAbsYawDeg);
  });

  it('regateQuality re-evaluates stored measurements (ID-photo gate is more lenient)', () => {
    const faces = [face(320, 240, 60, 0.7)];
    const q = assessQuality(input({ faces, stats: { ...GOOD_STATS, sharpness: 60 } }));
    expect(q.usable).toBe(false);
    const relaxed = regateQuality(q, faces, 640, 480, resolveGate({}, ID_PHOTO_QUALITY_GATE));
    expect(relaxed.issues).toEqual([]);
    expect(relaxed.usable).toBe(true);
  });

  it('cut-off tolerance', () => {
    const f = face(320, 240, 200);
    expect(isCutOff(f, 640, 480, 0.08)).toBe(false);
    const edge = { ...f, box: { ...f.box, x: -10 } };
    expect(isCutOff(edge, 640, 480, 0.08)).toBe(false);
    expect(isCutOff(edge, 640, 480, 0)).toBe(true);
  });

  it('maps issues to the shared candidate guidance', () => {
    expect(guidanceForIssues(['too_dark', 'too_dark', 'blurry'])).toEqual([QUALITY_GUIDANCE.too_dark, QUALITY_GUIDANCE.blurry]);
  });
});
