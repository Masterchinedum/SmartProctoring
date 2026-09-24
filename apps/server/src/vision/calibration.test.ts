import type { FaceQuality } from '@sp/shared';
import { DEFAULT_IDENTITY_THRESHOLDS } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { BUCKET_MODELS, CALIBRATION, posteriorSwap, qualityBucket, rawLLR, sampleLLR, type QualityBucket } from './calibration';

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
