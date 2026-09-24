import type { FaceQuality } from '@sp/shared';
import { DEFAULT_IDENTITY_THRESHOLDS } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import {
  BUCKET_MODELS,
  bucketModel,
  CALIBRATION,
  continuousApplies,
  continuousLLR,
  posteriorSwap,
  qualityBucket,
  rawLLR,
  REFERENCE_MODELS,
  referenceBucket,
  referenceClass,
  sampleLLR,
  windowEvidence,
  type EvidenceContext,
  type QualityBucket,
} from './calibration';

const q = (over: Partial<FaceQuality> = {}): FaceQuality => ({
  faceCount: 1,
  detectionScore: 0.93,
  interEyePx: 60,
  faceWidthRatio: 0.25,
  brightness: 125,
  contrast: 35,
  sharpness: 500,
  yawDeg: 0,
  pitchDeg: -10,
  cutOff: false,
  issues: [],
  usable: true,
  ...over,
});

const BUCKETS: QualityBucket[] = ['good', 'fair', 'poor'];

describe('qualityBucket', () => {
  it('good light, frontal, sharp face => good; dim or flat => poor', () => {
    expect(qualityBucket(q())).toBe('good');
    expect(qualityBucket(q({ contrast: 8, brightness: 50 }))).toBe('poor');
    expect(qualityBucket(q({ detectionScore: 0.66 }))).toBe('poor');
    expect(qualityBucket(q({ interEyePx: 21 }))).toBe('poor');
  });

  it('in-between frames are fair', () => {
    expect(qualityBucket(q({ contrast: 14 }))).toBe('fair');
  });
});

describe('sampleLLR', () => {
  it('is monotone non-increasing in similarity for every bucket', () => {
    for (const b of BUCKETS) {
      let prev = Infinity;
      for (let s = -1; s <= 1.0001; s += 0.01) {
        const v = sampleLLR(s, b);
        expect(v).toBeLessThanOrEqual(prev + 1e-9);
        prev = v;
      }
    }
  });

  it('is clamped, positive for impostor-like scores and negative for genuine-like scores', () => {
    for (const b of BUCKETS) {
      const m = BUCKET_MODELS[b];
      expect(sampleLLR(m.impostor.mean, b)).toBeGreaterThan(0);
      expect(sampleLLR(m.genuine.mean, b)).toBeLessThan(0);
      expect(Math.abs(sampleLLR(-1, b))).toBeLessThanOrEqual(CALIBRATION.llrClamp);
      expect(Math.abs(sampleLLR(1, b))).toBeLessThanOrEqual(CALIBRATION.llrClamp);
    }
    expect(sampleLLR(Number.NaN, 'good')).toBe(0);
  });

  it('a poor-quality frame is weaker evidence than a good one at the same similarity', () => {
    expect(sampleLLR(0.1, 'poor')).toBeLessThanOrEqual(sampleLLR(0.1, 'good'));
    expect(sampleLLR(0.7, 'poor')).toBeGreaterThanOrEqual(sampleLLR(0.7, 'good'));
  });

  it('the uniform floor bounds the raw ratio (no exploding Gaussian tails)', () => {
    for (const b of BUCKETS) expect(Math.abs(rawLLR(-1, BUCKET_MODELS[b]))).toBeLessThan(12);
  });

  it('one sample can never confirm a swap on its own; two strong ones can', () => {
    expect(CALIBRATION.llrClamp).toBeLessThan(CALIBRATION.sprt.confirm);
    expect(2 * sampleLLR(0.05, 'good')).toBeGreaterThanOrEqual(CALIBRATION.sprt.confirm - 1e-9);
  });
});

describe('reference-conditional evidence (v2.1)', () => {
  const POOR = q({ brightness: 45, contrast: 9 });
  const FAIR = q({ contrast: 15 });
  it('referenceBucket: the majority of the gallery frames (unusable frames ignored); referenceClass maps fair to good', () => {
    expect(referenceBucket([q(), q(), POOR])).toBe('good');
    expect(referenceBucket([q(), POOR, POOR])).toBe('poor');
    expect(referenceBucket([q(), POOR, FAIR, q()])).toBe('fair');
    expect(referenceBucket([POOR, { ...q(), usable: false }, { ...q(), usable: false }])).toBe('poor');
    expect(referenceBucket([])).toBe('good');
    expect(referenceClass('fair')).toBe('good');
    expect(referenceClass(undefined)).toBe('good');
    expect(referenceClass('poor')).toBe('poor');
  });

  it('a good / fair / unknown reference keeps the v2.0 models exactly', () => {
    for (const b of BUCKETS) {
      expect(bucketModel(b)).toBe(BUCKET_MODELS[b]);
      expect(bucketModel(b, 'fair')).toBe(BUCKET_MODELS[b]);
      for (const s of [-0.1, 0.2, 0.35, 0.5, 0.8]) {
        expect(sampleLLR(s, b, { reference: 'good' })).toBeCloseTo(sampleLLR(s, b), 12);
        expect(sampleLLR(s, b, { reference: null, context: 'continuous', baseline: { mean: 0.8, sd: 0.05, n: 6 } })).toBeCloseTo(sampleLLR(s, b), 12);
      }
    }
    expect(bucketModel('poor', 'poor')).toBe(REFERENCE_MODELS.poor.poor);
  });

  const BASE = { mean: 0.72, sd: 0.06, n: 7 };
  const cont = (frames = 1, baseline: EvidenceContext['baseline'] = BASE): EvidenceContext => ({ reference: 'poor', baseline, context: 'continuous', frames });

  it('the same-session model applies only mid-exam, to a poor probe against a poor-light reference with a usable baseline', () => {
    expect(continuousApplies('poor', cont())).toBe(true);
    expect(continuousApplies('fair', cont())).toBe(false);
    expect(continuousApplies('good', cont())).toBe(false);
    expect(continuousApplies('poor', { ...cont(), context: 'relaxed' })).toBe(false);
    expect(continuousApplies('poor', { ...cont(), context: undefined })).toBe(false);
    expect(continuousApplies('poor', { ...cont(), reference: 'fair' })).toBe(false);
    expect(continuousApplies('poor', cont(1, { mean: 0.72, sd: 0.06, n: 2 }))).toBe(false);
    expect(continuousApplies('poor', cont(1, { mean: Number.NaN, sd: 0.06, n: 7 }))).toBe(false);
    expect(continuousApplies('poor', cont(1, null))).toBe(false);
    expect(continuousApplies('poor', undefined)).toBe(false);
  });

  it('the same-session model is monotone, clamped and bounded on the genuine side', () => {
    for (const frames of [1, 3]) {
      let prev = Infinity;
      for (let s = -1; s <= 1; s += 0.01) {
        const v = sampleLLR(s, 'poor', cont(frames));
        expect(v).toBeLessThanOrEqual(prev + 1e-9);
        expect(Math.abs(v)).toBeLessThanOrEqual(CALIBRATION.llrClamp);
        prev = v;
      }
      expect(continuousLLR(0.9, BASE, frames)).toBeLessThan(-2);
      expect(continuousLLR(0.1, BASE, frames)).toBeGreaterThan(CALIBRATION.llrClamp);
    }
  });

  it('realistic e2e: a look-alike in the candidate\'s dim room is evidence of another person; the candidate is not', () => {
    // Candidate enrolled in a dim room at 640x480 (leave-one-out baseline ~0.72); person B's frames score 0.32-0.51,
    // burst templates 0.52-0.59 against that gallery — "match" for the v2.0 calibration.
    expect(sampleLLR(0.55, 'poor')).toBeLessThan(-3);
    expect(sampleLLR(0.55, 'poor', { reference: 'poor' })).toBeLessThan(-3);
    expect(sampleLLR(0.42, 'poor', cont(1))).toBeGreaterThan(1.5);
    expect(sampleLLR(0.55, 'poor', cont(3))).toBeGreaterThan(0.5);
    expect(sampleLLR(0.5, 'poor', cont(3))).toBeGreaterThan(2.5);
    // A higher-resolution gallery (baseline 0.87): B's templates 0.35-0.45 are strong evidence at once.
    expect(sampleLLR(0.45, 'poor', cont(3, { mean: 0.87, sd: 0.03, n: 8 }))).toBeGreaterThan(CALIBRATION.sprt.suspect);
    // The candidate: frames 0.67-0.82 and templates 0.74-0.90 in the same room (dim or backlit) favour the same person.
    for (const s of [0.67, 0.72, 0.8]) expect(sampleLLR(s, 'poor', cont(1))).toBeLessThan(-2);
    for (const s of [0.74, 0.8, 0.9]) expect(sampleLLR(s, 'poor', cont(3))).toBeLessThan(-2);
  });

  it('poor-light evidence alone never confirms, however strong the same-session evidence', () => {
    const win = Array.from({ length: CALIBRATION.sprt.maxSamples }, () => ({ llr: sampleLLR(0.1, 'poor', cont(3)), bucket: 'poor' as const }));
    expect(win[0].llr).toBe(CALIBRATION.llrClamp);
    expect(windowEvidence(win)).toBeLessThan(CALIBRATION.sprt.confirm);
    expect(windowEvidence(win)).toBeGreaterThanOrEqual(CALIBRATION.sprt.suspect);
  });
});

describe('posteriorSwap', () => {
  it('maps accumulated evidence to a probability using the prior', () => {
    expect(posteriorSwap(0, 0.01)).toBeCloseTo(0.01, 6);
    expect(posteriorSwap(Math.log(99), 0.01)).toBeCloseTo(0.5, 6);
    expect(posteriorSwap(100)).toBe(1);
    expect(posteriorSwap(-100)).toBe(0);
    expect(posteriorSwap(Number.NaN)).toBeCloseTo(CALIBRATION.prior, 6);
  });
});

describe('CALIBRATION', () => {
  it('is consistent with the shared default thresholds', () => {
    expect(DEFAULT_IDENTITY_THRESHOLDS.match).toBe(CALIBRATION.match);
    expect(DEFAULT_IDENTITY_THRESHOLDS.mismatch).toBe(CALIBRATION.mismatch);
    expect(DEFAULT_IDENTITY_THRESHOLDS.idPhotoMatch).toBe(CALIBRATION.idPhotoMatch);
    expect(DEFAULT_IDENTITY_THRESHOLDS.idPhotoMismatch).toBe(CALIBRATION.idPhotoMismatch);
    expect(CALIBRATION.mismatch).toBeLessThan(CALIBRATION.match);
    expect(CALIBRATION.sprt.clear).toBeLessThan(0);
    expect(CALIBRATION.sprt.suspect).toBeLessThan(CALIBRATION.sprt.confirm);
  });
});
