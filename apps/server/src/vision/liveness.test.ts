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

  it('judges left and right turns alike (mirror-symmetric thresholds and feedback)', () => {
    // Mirrored pairs: turn_left at +d and turn_right at -d around the candidate's own frontal pose must give the same
    // outcome, measurement magnitude and progress, whichever side the challenge asks first. (The server's pose is
    // mirror-symmetric too: VisionEngineOptions.symmetricPose, tested on real images in service.test.ts.)
    const leftFirst: LivenessChallengeSpec = { ...SPEC, steps: [{ index: 0, action: 'turn_left' }, { index: 1, action: 'turn_right' }] };
    // Centre 0: exact mirror images, including turns right at the thresholds (12 deg single frame, 10 deg agreeing).
    // Centre 6 (candidate sits slightly turned): the 3-D pose -> five-point yaw mapping is not exactly linear, so
    // the two sides differ by < 1 deg; turns away from the thresholds.
    for (const [centre, ds, tol] of [
      [0, [6, 9, 10, 11, 12, 13, 16, 20, 28], 0.2],
      [6, [6, 9, 16, 20, 28], 1.5],
    ] as const) {
      const c = frontal(0, { yawDeg: centre }).analysis.pose!;
      for (const d of ds) {
        const frames = (spec: LivenessChallengeSpec, sign: 1 | -1) => [
          frontal(1000, { yawDeg: centre }),
          frontal(1300, { yawDeg: centre }),
          f(0, spec.steps[0].action, 5000, { yawDeg: centre + (spec.steps[0].action === 'turn_left' ? sign * d : -sign * d) }),
          f(1, spec.steps[1].action, 9000, { yawDeg: centre + (spec.steps[1].action === 'turn_left' ? sign * d : -sign * d) }),
        ];
        const a = verifyLiveness(SPEC, frames(SPEC, 1));
        const b = verifyLiveness(leftFirst, frames(leftFirst, 1));
        expect(a.passed).toBe(b.passed);
        const right = a.steps[0];
        const left = a.steps[1];
        expect(right.passed).toBe(left.passed);
        expect(Math.abs(right.measured! + left.measured!)).toBeLessThan(tol);
        const fl = checkStepFrame('turn_left', f(0, 'turn_left', 1, { yawDeg: centre + d }).analysis, SPEC, c);
        const fr = checkStepFrame('turn_right', f(0, 'turn_right', 1, { yawDeg: centre - d }).analysis, SPEC, c);
        expect(fl.satisfied).toBe(fr.satisfied);
        expect(Math.abs((fl.progress ?? 0) - (fr.progress ?? 0))).toBeLessThanOrEqual(tol / 10);
      }
    }
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

  it('judges the frontal frames on the usable ones: a dark or empty frontal frame among many does not fail the challenge', () => {
    const frames = passingFrames();
    frames.splice(2, 0, frontal(1700, { usable: false, issues: ['too_dark'] }), frontal(1800, { person: null }));
    const r = verifyLiveness(SPEC, frames, DEFAULT_IDENTITY_THRESHOLDS);
    expect(r.reasons).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('still fails with two faces in a frontal frame, and without any usable frontal frame', () => {
    const two = passingFrames();
    two[1] = frontal(1500, { faces: 2, issues: ['multiple_faces'] });
    expect(verifyLiveness(SPEC, two).reasons).toContain(LIVENESS_REASONS.faceCount);
    const none = passingFrames().map((fr) => (fr.step === 'frontal' ? frontal(fr.capturedAt - T0, { usable: false, issues: ['too_dark'] }) : fr));
    const r = verifyLiveness(SPEC, none);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(LIVENESS_REASONS.noFrontal);
  });

  it('a head-turn frame without a face still fails (the steps are verified on their own frames)', () => {
    const frames = passingFrames();
    frames[3] = f(0, 'turn_right', 5000, { person: null });
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(false);
    expect(r.reasons).toContain(LIVENESS_REASONS.faceCount);
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
    // Even inside a larger window a single outlier frame is not enough (webcam pose noise)...
    expect(verifyLiveness(SPEC, fished, undefined, { maxFramesPerStep: 5 }).steps[0].passed).toBe(false);
    // ...unless the (legacy) one-frame rule is configured.
    expect(verifyLiveness(SPEC, fished, undefined, { maxFramesPerStep: 5, minFramesAgreeing: 1 }).steps[0].passed).toBe(true);
  });

  it('needs two agreeing frames when a step has several (noise-tolerant, no single-outlier pass)', () => {
    const frames = passingFrames();
    const held = [f(0, 'turn_right', 4100, { yawDeg: -24 }), f(0, 'turn_right', 4300, { yawDeg: -15 }), f(0, 'turn_right', 4500, { yawDeg: -27 })];
    const ok = verifyLiveness(SPEC, [...frames.slice(0, 3), ...held, frames[4]]);
    expect(ok.passed).toBe(true);
    // Second-best frame is the step's measurement.
    const hs = held.map((h) => h.analysis.pose!.yawDeg - ok.steps[0].measured!);
    expect(Math.min(...hs.map(Math.abs))).toBeLessThan(0.2);
    const oneLucky = [f(0, 'turn_right', 4100, { yawDeg: -4 }), f(0, 'turn_right', 4300, { yawDeg: -26 }), f(0, 'turn_right', 4500, { yawDeg: 1 })];
    expect(verifyLiveness(SPEC, [...frames.slice(0, 3), ...oneLucky, frames[4]]).steps[0].passed).toBe(false);
  });

  it('a flat photo with webcam pose noise (dim room, ~6 deg per frame) still fails', () => {
    // Flat photo rotated +/-40 deg about the vertical axis; landmark noise adds up to +/-9 deg of apparent yaw.
    const noisyFlat = (step: LivenessFrame['step'], action: LivenessFrame['action'], at: number, rot: number, jitterPx: number): LivenessFrame => {
      const base = syntheticLandmarks(0, -8, 320, 240, 12.5);
      const lm = base.map((p, i) => ({ x: 320 + (p.x - 320) * Math.cos((rot * Math.PI) / 180) + (i === 2 ? jitterPx : 0), y: p.y })) as typeof base;
      const pose = poseFromFivePoints(lm);
      const analysis = fakeAnalysis({ person: 'cand', yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg }, { embed: true });
      if (analysis.primary) analysis.primary.landmarks = lm;
      analysis.dhash = (at * 7919).toString(16).padStart(16, '0').slice(-16);
      return { step, action, analysis, capturedAt: T0 + at };
    };
    const frames = [
      noisyFlat('frontal', 'center', 1000, 0, 0),
      noisyFlat('frontal', 'center', 1300, 0, 1),
      // one lucky noisy frame per step in the "right" direction, the others ordinary
      noisyFlat(0, 'turn_right', 4000, 40, -9),
      noisyFlat(0, 'turn_right', 4200, 40, 1),
      noisyFlat(0, 'turn_right', 4400, 40, 0),
      noisyFlat(1, 'turn_left', 8000, -40, 9),
      noisyFlat(1, 'turn_left', 8200, -40, -1),
      noisyFlat(1, 'turn_left', 8400, -40, 0),
    ];
    const lucky = frames.filter((x) => x.step !== 'frontal').map((x) => x.analysis.pose!.yawDeg);
    expect(Math.max(...lucky.map(Math.abs))).toBeGreaterThan(12); // the outlier alone would have passed a step
    const r = verifyLiveness(SPEC, frames);
    expect(r.passed).toBe(false);
    expect(r.steps.every((st) => !st.passed)).toBe(true);
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
  it('reports progress towards the required change', () => {
    const half = f(0, 'turn_right', 0, { yawDeg: -7 }).analysis;
    const fb = checkStepFrame('turn_right', half, SPEC, { yawDeg: 0, pitchDeg: -8 });
    expect(fb.satisfied).toBe(false);
    expect(fb.requiredDeg).toBe(12);
    expect(fb.progress!).toBeGreaterThan(0.3);
    expect(fb.progress!).toBeLessThan(1);
    const wrong = checkStepFrame('turn_left', half, SPEC, { yawDeg: 0, pitchDeg: -8 });
    expect(wrong.progress).toBe(0);
    expect(wrong.directionalDeg!).toBeLessThan(0);
  });

  it('gives immediate per-frame feedback', () => {
    const turned = f(0, 'turn_right', 0, { yawDeg: -28 }).analysis;
    expect(checkStepFrame('turn_right', turned, SPEC, { yawDeg: 0, pitchDeg: -8 }).satisfied).toBe(true);
    expect(checkStepFrame('turn_left', turned, SPEC, { yawDeg: 0, pitchDeg: -8 }).reason).toMatch(/wrong way/);
    expect(checkStepFrame('center', f('frontal', 'center', 0, {}).analysis, SPEC).satisfied).toBe(true);
    expect(checkStepFrame('turn_left', fakeAnalysis({ person: null }), SPEC).satisfied).toBe(false);
  });
});
