import { DEFAULT_IDENTITY_THRESHOLDS, poseFromFivePoints } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { fakeAnalysis, syntheticLandmarks, type FakeImageSpec } from './fake';
import { checkStepFrame, LIVENESS_REASONS, verifyLiveness } from './liveness';
import type { LivenessChallengeSpec, LivenessFrame } from './types';

const T0 = 1_700_000_000_000;
const SPEC: LivenessChallengeSpec = {
  steps: [
    { index: 0, action: 'turn_right' },
    { index: 1, action: 'turn_left' },
  ],
  issuedAt: T0,
  expiresAt: T0 + 60_000,
  targetYawDeg: 20,
  targetPitchDeg: 12,
};

/** A frame whose pose comes from real 3-D landmark geometry, like the server's YuNet analysis. */
function f(step: LivenessFrame['step'], action: LivenessFrame['action'], at: number, spec: FakeImageSpec, extra: Partial<LivenessFrame> = {}): LivenessFrame {
  const yaw = spec.yawDeg ?? 0;
  const pitch = spec.pitchDeg ?? -8;
  const lm = syntheticLandmarks(yaw, pitch, 320, 240, 12.5);
  const pose = poseFromFivePoints(lm);
  const analysis = fakeAnalysis({ person: 'cand', ...spec, yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg }, { embed: true });
  if (analysis.primary) analysis.primary.landmarks = lm;
  return { step, action, analysis, capturedAt: T0 + at, ...extra };
}

const frontal = (at: number, spec: FakeImageSpec = {}) => f('frontal', 'center', at, spec);

function passingFrames(): LivenessFrame[] {
  return [frontal(1000), frontal(1500), frontal(2000), f(0, 'turn_right', 5000, { yawDeg: -28 }), f(1, 'turn_left', 9000, { yawDeg: 27 })];
}

describe('verifyLiveness', () => {
  it('passes a real head turning right then left', () => {
    const r = verifyLiveness(SPEC, passingFrames(), DEFAULT_IDENTITY_THRESHOLDS);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.steps.map((s) => s.passed)).toEqual([true, true]);
    expect(r.steps[0].measured!).toBeLessThan(-12); // turn_right => yaw decreases
    expect(r.steps[1].measured!).toBeGreaterThan(12);
  });

  it('measures relative to the candidate’s own frontal pose', () => {
    // Candidate sits slightly turned (measured ~+6 deg). A turn to ~-7 is a ~-13 deg change: passes (>= 12)
    // even though the absolute yaw alone would not.
    const frames = [frontal(1000, { yawDeg: 8 }), frontal(1200, { yawDeg: 8 }), f(0, 'turn_right', 3000, { yawDeg: -10 }), f(1, 'turn_left', 6000, { yawDeg: 30 })];
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(true);
    expect(Math.abs(frames[2].analysis.pose!.yawDeg)).toBeLessThan(12);
  });

  it('fails a flat photograph rotated in front of the camera (no parallax)', () => {
    // Flat photo: every frame keeps the frontal nose/eye geometry; rotation only foreshortens.
    const flat = (step: LivenessFrame['step'], action: LivenessFrame['action'], at: number, rot: number): LivenessFrame => {
      const base = syntheticLandmarks(0, -8, 320, 240, 12.5);
      const lm = base.map((p) => ({ x: 320 + (p.x - 320) * Math.cos((rot * Math.PI) / 180), y: p.y })) as typeof base;
      const pose = poseFromFivePoints(lm);
      const analysis = fakeAnalysis({ person: 'cand', yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg }, { embed: true });
      return { step, action, analysis, capturedAt: T0 + at };
    };
    const r = verifyLiveness(SPEC, [flat('frontal', 'center', 1000, 0), flat('frontal', 'center', 1300, 0), flat(0, 'turn_right', 4000, 40), flat(1, 'turn_left', 8000, -40)]);
    expect(r.passed).toBe(false);
    expect(r.steps.every((s) => !s.passed)).toBe(true);
    expect(r.reasons).toContain(LIVENESS_REASONS.noParallax);
    expect(Math.abs(r.steps[0].measured!)).toBeLessThan(3);
  });

  it('fails when the turns are done in the wrong order', () => {
    // Candidate turned left first: the step-0 (turn_right) frame shows a left turn.
    const wrongDirection = [frontal(1000), frontal(1500), f(0, 'turn_right', 5000, { yawDeg: 27 }), f(1, 'turn_left', 9000, { yawDeg: -28 })];
    const r = verifyLiveness(SPEC, wrongDirection);
    expect(r.passed).toBe(false);
    expect(r.steps[0].reason).toMatch(/wrong way/);
    // Correct directions, but the frames were captured in the opposite order.
    const swappedTimes = [frontal(1000), frontal(1500), f(0, 'turn_right', 9000, { yawDeg: -28 }), f(1, 'turn_left', 5000, { yawDeg: 27 })];
    const r2 = verifyLiveness(SPEC, swappedTimes);
    expect(r2.passed).toBe(false);
    expect(r2.reasons).toContain(LIVENESS_REASONS.outOfOrder);
  });

  it('fails when the challenge expired or frames predate it', () => {
    const late = passingFrames();
    late[4] = { ...late[4], capturedAt: SPEC.expiresAt + 5_000 };
    const r = verifyLiveness(SPEC, late);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(LIVENESS_REASONS.timeWindow);
    const early = passingFrames();
    early[0] = { ...early[0], capturedAt: SPEC.issuedAt - 60_000 };
    expect(verifyLiveness(SPEC, early).reasons).toContain(LIVENESS_REASONS.timeWindow);
  });

  it('fails when a different person appears mid-challenge', () => {
    const frames = passingFrames();
    frames[4] = f(1, 'turn_left', 9000, { yawDeg: 27, person: 'accomplice' });
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(LIVENESS_REASONS.personChanged);
    expect(r.steps[1].passed).toBe(false);
  });

  it('accepts a turned face that is less similar but still the same person', () => {
    const frames = passingFrames();
    frames[3] = f(0, 'turn_right', 5000, { yawDeg: -28, similarity: 0.45 });
    expect(verifyLiveness(SPEC, frames).passed).toBe(true);
    frames[3] = f(0, 'turn_right', 5000, { yawDeg: -28, similarity: 0.2 });
    expect(verifyLiveness(SPEC, frames).passed).toBe(false);
  });

  it('fails when frontal frames show different people', () => {
    const frames = passingFrames();
    frames[1] = frontal(1500, { person: 'other' });
    expect(verifyLiveness(SPEC, frames).reasons).toContain(LIVENESS_REASONS.frontalInconsistent);
  });

  it('fails when two faces are visible', () => {
    const frames = passingFrames();
    frames[3] = f(0, 'turn_right', 5000, { yawDeg: -28, faces: 2, issues: ['multiple_faces'] });
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(LIVENESS_REASONS.faceCount);
  });

  it('fails when step frames are identical images (replayed still)', () => {
    const frames = passingFrames();
    for (const fr of frames) fr.analysis.dhash = 'a5a5a5a5a5a5a5a5';
    expect(verifyLiveness(SPEC, frames).reasons).toContain(LIVENESS_REASONS.identical);
  });

  it('only considers the first frames of a step (no fishing for a noisy outlier)', () => {
    const frames = passingFrames();
    const tries = [1, 2, 3].map((k) => f(0, 'turn_right', 4000 + k, { yawDeg: -2 }));
    const fished = [...frames.slice(0, 3), ...tries, f(0, 'turn_right', 4900, { yawDeg: -28 }), frames[4]];
    expect(verifyLiveness(SPEC, fished).steps[0].passed).toBe(false);
    expect(verifyLiveness(SPEC, fished, undefined, { maxFramesPerStep: 5 }).steps[0].passed).toBe(true);
  });

  it('fails on a too-small turn and reports the measurement', () => {
    const frames = passingFrames();
    frames[3] = f(0, 'turn_right', 5000, { yawDeg: -7 });
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(false);
    expect(r.steps[0].reason).toMatch(/too small/);
  });

  it('cross-checks the browser-reported pose when provided', () => {
    const ok = passingFrames();
    ok[3] = { ...ok[3], clientYaw: -22 };
    expect(verifyLiveness(SPEC, ok).passed).toBe(true);
    const contradicting = passingFrames();
    contradicting[3] = { ...contradicting[3], clientYaw: 25 };
    const r = verifyLiveness(SPEC, contradicting);
    expect(r.passed).toBe(false);
    expect(r.steps[0].reason).toMatch(/contradicts/);
  });

  it('verifies look up / look down steps', () => {
    const spec: LivenessChallengeSpec = { ...SPEC, steps: [...SPEC.steps, { index: 2, action: 'look_up' }, { index: 3, action: 'look_down' }] };
    const frames = [...passingFrames(), f(2, 'look_up', 12000, { pitchDeg: 12 }), f(3, 'look_down', 15000, { pitchDeg: -28 })];
    const r = verifyLiveness(spec, frames);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.steps[2].measured!).toBeGreaterThan(7);
    expect(r.steps[3].measured!).toBeLessThan(-7);
  });

  it('rejects a challenge without both horizontal turns, missing frames, and mislabelled frames', () => {
    const oneSided: LivenessChallengeSpec = { ...SPEC, steps: [{ index: 0, action: 'turn_left' }] };
    expect(verifyLiveness(oneSided, [frontal(1000), f(0, 'turn_left', 3000, { yawDeg: 27 })]).reasons).toContain(LIVENESS_REASONS.badSpec);
    expect(verifyLiveness(SPEC, []).passed).toBe(false);
    const missing = verifyLiveness(SPEC, passingFrames().slice(0, 4));
    expect(missing.steps[1].reason).toMatch(/No frame/);
    const mislabelled = passingFrames();
    mislabelled[4] = { ...mislabelled[4], action: 'look_up' };
    expect(verifyLiveness(SPEC, mislabelled).steps[1].passed).toBe(false);
  });
});

describe('checkStepFrame', () => {
  it('gives immediate per-frame feedback', () => {
    const turned = f(0, 'turn_right', 0, { yawDeg: -28 }).analysis;
    expect(checkStepFrame('turn_right', turned, SPEC, { yawDeg: 0, pitchDeg: -8 }).satisfied).toBe(true);
    expect(checkStepFrame('turn_left', turned, SPEC, { yawDeg: 0, pitchDeg: -8 }).reason).toMatch(/wrong way/);
    expect(checkStepFrame('center', f('frontal', 'center', 0, {}).analysis, SPEC).satisfied).toBe(true);
    expect(checkStepFrame('turn_left', fakeAnalysis({ person: null }), SPEC).satisfied).toBe(false);
  });
});
