import { describe, expect, it } from 'vitest';
import type { Baseline, FrameObservation } from '@sp/shared';
import { createBaselineCalibrator } from './calibrator';
import { compareEnvironment } from './environment';
import { face, frame, ms, secondFace } from '../testing/fixtures';
import { Rng } from '../eval/prng';

function obs(sec: number, f: Partial<FrameObservation>): FrameObservation {
  return { t: ms(sec), camera: 'live', frame: frame(), faces: [face()], objects: null, ...f };
}

describe('BaselineCalibrator', () => {
  it('robust medians of pose / position / luma over single-face frames', () => {
    const cal = createBaselineCalibrator();
    const r = new Rng(3);
    expect(cal.progress()).toBe(0);
    for (let i = 0; i < 30; i++) {
      cal.add(obs(i * 0.2, { faces: [face({ yaw: 6 + r.normal(0, 2), pitch: -8 + r.normal(0, 2), box: { x: 0.4, y: 0.2, w: 0.25, h: 0.38 } })], frame: frame({ luma: 120 + r.normal(0, 1) }) }));
    }
    expect(cal.ready()).toBe(true);
    expect(cal.progress()).toBe(1);
    const b = cal.result()!;
    expect(b.yaw).toBeCloseTo(6, 0);
    expect(b.pitch).toBeCloseTo(-8, 0);
    expect(b.cx).toBeCloseTo(0.525, 3);
    expect(b.faceWidth).toBeCloseTo(0.25, 3);
    expect(b.luma).toBeCloseTo(120, 0);
    expect(b.dhash).toBe('0f0f0f0f0f0f0f0f');
    expect(b.samples).toBeGreaterThanOrEqual(10);
  });

  it('rejects frames without exactly one usable face, and frames while the candidate moves a lot', () => {
    const cal = createBaselineCalibrator({ minSamples: 10 });
    for (let i = 0; i < 10; i++) cal.add(obs(i, { faces: [face(), secondFace()] }));
    for (let i = 0; i < 10; i++) cal.add(obs(20 + i, { faces: [] }));
    for (let i = 0; i < 10; i++) cal.add(obs(40 + i, { faces: [face({ cutOff: true })] }));
    for (let i = 0; i < 10; i++) cal.add(obs(60 + i, { faces: [face({ yaw: 50 })] }));
    for (let i = 0; i < 10; i++) cal.add(obs(80 + i, { camera: 'ended', frame: null }));
    expect(cal.progress()).toBe(0);
    // Big swings back and forth are rejected as movement.
    for (let i = 0; i < 20; i++) cal.add(obs(100 + i, { faces: [face({ yaw: i % 2 ? 25 : -25 })] }));
    expect(cal.ready()).toBe(false);
    cal.reset();
    for (let i = 0; i < 12; i++) cal.add(obs(200 + i, {}));
    expect(cal.ready()).toBe(true);
  });

  it('accepts a steady but strongly pitched pose (camera below the eyes); rejects implausible poses', () => {
    const cal = createBaselineCalibrator();
    for (let i = 0; i < 15; i++) cal.add(obs(i * 0.2, { faces: [face({ pitch: -32 + (i % 3) - 1 })] }));
    expect(cal.ready()).toBe(true);
    expect(cal.result()!.pitch).toBeCloseTo(-32, 0);
    const bad = createBaselineCalibrator();
    for (let i = 0; i < 15; i++) bad.add(obs(i * 0.2, { faces: [face({ pitch: -55 })] }));
    expect(bad.progress()).toBe(0);
  });

  it('result() is null until enough samples', () => {
    const cal = createBaselineCalibrator({ minSamples: 5 });
    cal.add(obs(0, {}));
    expect(cal.result()).toBeNull();
    expect(cal.progress()).toBeCloseTo(0.2);
  });
});

describe('compareEnvironment', () => {
  const base: Baseline = { yaw: 2, pitch: -6, cx: 0.5, cy: 0.45, faceWidth: 0.28, luma: 90, dhash: '0f0f0f0f0f0f0f0f', capturedAt: 0, samples: 20 };

  it('no change → no notes', () => {
    const r = compareEnvironment(base, { ...base, luma: 95, cx: 0.52, dhash: '0f0f0f0f0f0f0f0e' });
    expect(r.changed).toBe(false);
    expect(r.notes).toEqual([]);
  });

  it('describes lighting, position, angle and background neutrally', () => {
    const r = compareEnvironment(base, { ...base, luma: 140, cx: 0.7, faceWidth: 0.4, yaw: 16, dhash: 'f0f0f0f0f0f0f0f0' });
    expect(r.changed).toBe(true);
    expect(r.notes).toContain('Lighting is brighter than in the previous exam period.');
    expect(r.notes.some((n) => n.startsWith('The candidate’s position in the camera image differs'))).toBe(true);
    expect(r.notes).toContain('The camera angle relative to the candidate differs from the previous exam period.');
    expect(r.notes).toContain('The background or surroundings differ from the previous exam period.');
    expect(r.details).toMatchObject({ lighting: 'brighter', backgroundDistance: 64 });
    expect(compareEnvironment(base, { ...base, luma: 50 }).notes).toEqual(['Lighting is darker than in the previous exam period.']);
    for (const n of r.notes) expect(n).not.toMatch(/different person|cheat|suspicious/i);
  });
});
