/**
 * Server-side verification of the active liveness challenge (random head-turn sequence).
 *
 * Why it works: head pose is measured from YuNet landmarks with the shared `poseFromFivePoints`
 * (nose offset from the eye midpoint in inter-ocular units). A real head turning produces this
 * parallax because the nose sits ~2 cm in front of the eye plane; a flat photograph rotated in front
 * of the camera does not (see packages/shared/src/pose.test.ts). The challenge always contains both a
 * left and a right turn, which must produce opposite-signed yaw changes relative to the candidate's own
 * frontal pose, in the random order the server chose, inside the challenge time window, with one face
 * that stays the same person throughout.
 */
import { DEFAULT_IDENTITY_THRESHOLDS, LIVENESS_ACTIONS, type IdentityThresholds, type LivenessAction, type LivenessResultDTO } from '@sp/shared';
import type { ImageAnalysis, LivenessChallengeSpec, LivenessFrame, QualityGate } from './types';
import { hammingHex } from './image';
import { cosineSimilarity, maxSimilarity } from './identity';
import { QUALITY_GATE, poseWithinGate } from './quality';

export interface LivenessOptions {
  /** A step passes when the pose change reaches this fraction of the target (default 0.6). */
  minFractionOfTarget: number;
  /** Minimum similarity of a turned (step) frame to the frontal frames (default 0.30). */
  turnedMinSimilarity: number;
  /** Frames of different steps must differ by MORE than this many dHash bits (default 2). */
  minFrameHamming: number;
  /** Clock-skew tolerance around [issuedAt, expiresAt], ms (default 1000). */
  clockToleranceMs: number;
  /** Client-reported change opposite to the required direction by this fraction of target => contradiction (default 0.5). */
  clientContradictionFraction: number;
  /** A 'center' step frame must be within this many degrees of the frontal pose (default 12). */
  centerToleranceDeg: number;
  /** Frontal frames must be within the general quality gate's pose limits. */
  frontalPoseGate: Pick<QualityGate, 'maxAbsYawDeg' | 'minPitchDeg' | 'maxPitchDeg'>;
}

export const LIVENESS_DEFAULTS: Readonly<LivenessOptions> = Object.freeze({
  minFractionOfTarget: 0.6,
  turnedMinSimilarity: 0.3,
  minFrameHamming: 2,
  clockToleranceMs: 1000,
  clientContradictionFraction: 0.5,
  centerToleranceDeg: 12,
  frontalPoseGate: { maxAbsYawDeg: QUALITY_GATE.maxAbsYawDeg, minPitchDeg: QUALITY_GATE.minPitchDeg, maxPitchDeg: QUALITY_GATE.maxPitchDeg },
});

export const LIVENESS_REASONS = {
  noFrames: 'No challenge frames were received',
  badSpec: 'The challenge must include both a left and a right head turn',
  timeWindow: 'Frames were captured outside the challenge time window (the challenge expired or frames were reused)',
  noFrontal: 'No clear frontal frame was captured to compare the head turns with',
  frontalNotFrontal: 'Look straight at the screen for the frontal frames',
  faceCount: 'Exactly one face must be visible in every frame of the challenge',
  noEmbedding: 'Frames could not be analysed for identity',
  frontalInconsistent: 'The frontal frames appear to show different people',
  personChanged: 'The person in view appears to change during the challenge',
  identical: 'Submitted frames are identical — a live camera image is required',
  outOfOrder: 'The head turns were not performed in the requested order',
  noParallax: 'The left and right head turns did not show the depth change expected from a real face',
} as const;

type Pose2 = { yawDeg: number; pitchDeg: number };

const isAction = (a: string): a is LivenessAction => (LIVENESS_ACTIONS as readonly string[]).includes(a);
const isHorizontal = (a: LivenessAction) => a === 'turn_left' || a === 'turn_right';

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function singleFace(a: ImageAnalysis): boolean {
  return a.primary != null && a.pose != null && a.quality.faceCount <= 1 && !a.quality.issues.includes('multiple_faces');
}

/** Signed pose change for an action, and the same change mapped so that "+" is the required direction. */
export function stepDelta(action: LivenessAction, pose: Pose2, centre: Pose2): { measured: number; directional: number } {
  switch (action) {
    case 'turn_left': {
      const d = pose.yawDeg - centre.yawDeg;
      return { measured: d, directional: d };
    }
    case 'turn_right': {
      const d = pose.yawDeg - centre.yawDeg;
      return { measured: d, directional: -d };
    }
    case 'look_up': {
      const d = pose.pitchDeg - centre.pitchDeg;
      return { measured: d, directional: d };
    }
    case 'look_down': {
      const d = pose.pitchDeg - centre.pitchDeg;
      return { measured: d, directional: -d };
    }
  }
}

function requiredChange(action: LivenessAction, spec: Pick<LivenessChallengeSpec, 'targetYawDeg' | 'targetPitchDeg'>, o: LivenessOptions): number {
  return o.minFractionOfTarget * (isHorizontal(action) ? spec.targetYawDeg : spec.targetPitchDeg);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Immediate feedback for one uploaded step frame (CheckFrameResponse.stepSatisfied / measured).
 * `centre` is the candidate's frontal pose if already known (else the absolute pose is used).
 */
export function checkStepFrame(
  action: LivenessAction | 'center',
  analysis: ImageAnalysis,
  spec: Pick<LivenessChallengeSpec, 'targetYawDeg' | 'targetPitchDeg'>,
  centre: Pose2 | null = null,
  options: Partial<LivenessOptions> = {},
): { satisfied: boolean; measured: { yawDeg: number; pitchDeg: number } | null; reason?: string } {
  const o = { ...LIVENESS_DEFAULTS, ...options };
  if (!analysis.pose || !analysis.primary) return { satisfied: false, measured: null, reason: 'No face detected' };
  if (!singleFace(analysis)) return { satisfied: false, measured: null, reason: LIVENESS_REASONS.faceCount };
  const c = centre ?? { yawDeg: 0, pitchDeg: 0 };
  const measured = { yawDeg: r1(analysis.pose.yawDeg - c.yawDeg), pitchDeg: r1(analysis.pose.pitchDeg - c.pitchDeg) };
  if (action === 'center') {
    const ok = Math.abs(measured.yawDeg) <= o.centerToleranceDeg && Math.abs(measured.pitchDeg) <= o.centerToleranceDeg;
    return ok ? { satisfied: true, measured } : { satisfied: false, measured, reason: 'Look straight at the screen' };
  }
  const { directional } = stepDelta(action, analysis.pose, c);
  const need = requiredChange(action, spec, o);
  return directional >= need ? { satisfied: true, measured } : { satisfied: false, measured, reason: directional < 0 ? 'Head moved the wrong way' : 'Turn a little further' };
}

/** Verify a completed liveness challenge. Pure function; all inputs come from server-side analyses. */
export function verifyLiveness(
  spec: LivenessChallengeSpec,
  frames: readonly LivenessFrame[],
  thresholds: IdentityThresholds = DEFAULT_IDENTITY_THRESHOLDS,
  options: Partial<LivenessOptions> = {},
): LivenessResultDTO {
  const o: LivenessOptions = { ...LIVENESS_DEFAULTS, ...options };
  const reasons = new Set<string>();
  const specSteps = [...spec.steps].sort((a, b) => a.index - b.index);
  const stepResults: LivenessResultDTO['steps'] = specSteps.map((s) => ({ index: s.index, action: s.action, passed: false, measured: null }));
  const setStep = (index: number, passed: boolean, measured: number | null, reason?: string) => {
    const r = stepResults.find((x) => x.index === index);
    if (!r) return;
    r.passed = passed;
    r.measured = measured == null ? null : r1(measured);
    if (reason) r.reason = reason;
    else delete r.reason;
  };
  const finish = (): LivenessResultDTO => {
    const list = [...reasons];
    return { passed: list.length === 0 && stepResults.every((s) => s.passed), steps: stepResults, reasons: list };
  };

  if (frames.length === 0) {
    reasons.add(LIVENESS_REASONS.noFrames);
    for (const s of stepResults) s.reason = 'No frame was captured for this step';
    return finish();
  }
  const actions = specSteps.map((s) => s.action).filter((a): a is LivenessAction => a !== 'center');
  if (!actions.includes('turn_left') || !actions.includes('turn_right') || !(spec.targetYawDeg > 0)) reasons.add(LIVENESS_REASONS.badSpec);

  // Time window.
  const lo = spec.issuedAt - o.clockToleranceMs;
  const hi = spec.expiresAt + o.clockToleranceMs;
  const inWindow = (f: LivenessFrame) => Number.isFinite(f.capturedAt) && f.capturedAt >= lo && f.capturedAt <= hi;
  if (frames.some((f) => !inWindow(f))) reasons.add(LIVENESS_REASONS.timeWindow);

  // Exactly one face in every frame.
  if (frames.some((f) => !singleFace(f.analysis))) reasons.add(LIVENESS_REASONS.faceCount);

  // Frontal frames define the candidate's own centre pose and identity.
  const frontal = frames.filter((f) => (f.step === 'frontal' || f.action === 'center') && singleFace(f.analysis));
  const frontalPoses = frontal.map((f) => f.analysis.pose!).filter((p) => poseWithinGate(p.yawDeg, p.pitchDeg, o.frontalPoseGate));
  if (frontal.length === 0) {
    reasons.add(LIVENESS_REASONS.noFrontal);
  } else if (frontalPoses.length === 0) {
    reasons.add(LIVENESS_REASONS.frontalNotFrontal);
  }
  const centre: Pose2 | null = frontalPoses.length
    ? { yawDeg: median(frontalPoses.map((p) => p.yawDeg)), pitchDeg: median(frontalPoses.map((p) => p.pitchDeg)) }
    : null;

  const frontalEmb = frontal.map((f) => f.analysis.embedding).filter((e): e is Float32Array => e != null);
  if (frontal.length > 0 && frontalEmb.length < frontal.length) reasons.add(LIVENESS_REASONS.noEmbedding);
  for (let i = 0; i < frontalEmb.length; i++) {
    for (let j = i + 1; j < frontalEmb.length; j++) {
      if (cosineSimilarity(frontalEmb[i], frontalEmb[j]) < thresholds.match) reasons.add(LIVENESS_REASONS.frontalInconsistent);
    }
  }
  // Client-reported frontal pose (for the optional cross-check).
  const clientCentreYaw = medianOrZero(frontal.map((f) => f.clientYaw));
  const clientCentrePitch = medianOrZero(frontal.map((f) => f.clientPitch));

  // Representative frontal frame (closest to the centre) for the identical-frame check.
  const frontalRep = centre
    ? frontal.reduce<LivenessFrame | null>((best, f) => {
        const d = Math.abs(f.analysis.pose!.yawDeg - centre.yawDeg) + Math.abs(f.analysis.pose!.pitchDeg - centre.pitchDeg);
        const bd = best ? Math.abs(best.analysis.pose!.yawDeg - centre.yawDeg) + Math.abs(best.analysis.pose!.pitchDeg - centre.pitchDeg) : Infinity;
        return d < bd ? f : best;
      }, null)
    : null;

  // Every non-frontal frame must be the same person as the frontal frames.
  const identityOk = (f: LivenessFrame): boolean => {
    if (!f.analysis.embedding || frontalEmb.length === 0) return false;
    return maxSimilarity(f.analysis.embedding, frontalEmb) >= o.turnedMinSimilarity;
  };

  const qualifying = new Map<number, LivenessFrame>();
  for (const step of specSteps) {
    const stepFrames = frames.filter((f) => f.step === step.index);
    if (stepFrames.length === 0) {
      setStep(step.index, false, null, 'No frame was captured for this step');
      continue;
    }
    if (stepFrames.some((f) => f.action !== step.action)) {
      setStep(step.index, false, null, 'Frame was submitted for a different action than requested');
      continue;
    }
    const usable = stepFrames.filter((f) => singleFace(f.analysis) && inWindow(f));
    if (usable.length === 0) {
      setStep(step.index, false, null, 'No single face was visible in this step');
      continue;
    }
    for (const f of usable) {
      if (!f.analysis.embedding) reasons.add(LIVENESS_REASONS.noEmbedding);
      else if (frontalEmb.length > 0 && !identityOk(f)) reasons.add(LIVENESS_REASONS.personChanged);
    }
    if (!centre) {
      setStep(step.index, false, null, 'No frontal reference pose');
      continue;
    }
    if (step.action === 'center' || !isAction(step.action)) {
      let best: { f: LivenessFrame; dev: number } | null = null;
      for (const f of usable) {
        const dev = Math.max(Math.abs(f.analysis.pose!.yawDeg - centre.yawDeg), Math.abs(f.analysis.pose!.pitchDeg - centre.pitchDeg));
        if (!best || dev < best.dev) best = { f, dev };
      }
      const ok = best != null && best.dev <= o.centerToleranceDeg && identityOk(best.f);
      setStep(step.index, ok, best ? best.f.analysis.pose!.yawDeg - centre.yawDeg : null, ok ? undefined : 'Look straight at the screen');
      if (ok && best) qualifying.set(step.index, best.f);
      continue;
    }
    const action = step.action;
    const need = requiredChange(action, spec, o);
    let best: { f: LivenessFrame; measured: number; directional: number } | null = null;
    for (const f of usable) {
      if (!identityOk(f)) continue;
      const d = stepDelta(action, f.analysis.pose!, centre);
      if (!best || d.directional > best.directional) best = { f, ...d };
    }
    if (!best) {
      setStep(step.index, false, null, 'The face in this step does not match the frontal frames');
      continue;
    }
    if (best.directional < need) {
      const why =
        best.directional < -need / 2
          ? `Head moved the wrong way (${r1(best.measured)}°)`
          : `Head movement too small: ${r1(Math.abs(best.directional))}° of the required ${r1(need)}°`;
      setStep(step.index, false, best.measured, why);
      continue;
    }
    // Optional cross-check against the client's own pose estimate for the same frame.
    const clientValue = isHorizontal(action) ? best.f.clientYaw : best.f.clientPitch;
    if (clientValue != null && Number.isFinite(clientValue)) {
      const clientCentre = isHorizontal(action) ? clientCentreYaw : clientCentrePitch;
      const clientPose = isHorizontal(action) ? { yawDeg: clientValue, pitchDeg: 0 } : { yawDeg: 0, pitchDeg: clientValue };
      const clientRef = isHorizontal(action) ? { yawDeg: clientCentre, pitchDeg: 0 } : { yawDeg: 0, pitchDeg: clientCentre };
      const clientDir = stepDelta(action, clientPose, clientRef).directional;
      const target = isHorizontal(action) ? spec.targetYawDeg : spec.targetPitchDeg;
      if (clientDir <= -o.clientContradictionFraction * target) {
        setStep(step.index, false, best.measured, 'The browser-reported head movement contradicts the submitted image');
        continue;
      }
    }
    setStep(step.index, true, best.measured);
    qualifying.set(step.index, best.f);
  }

  // Horizontal turns must show opposite-signed yaw changes (a flat photo shows ~none).
  const leftSteps = specSteps.filter((s) => s.action === 'turn_left').map((s) => stepResults.find((r) => r.index === s.index)!);
  const rightSteps = specSteps.filter((s) => s.action === 'turn_right').map((s) => stepResults.find((r) => r.index === s.index)!);
  const leftOk = leftSteps.some((r) => r.passed && (r.measured ?? 0) > 0);
  const rightOk = rightSteps.some((r) => r.passed && (r.measured ?? 0) < 0);
  if (!leftOk || !rightOk) {
    const anyHorizontalMeasured = [...leftSteps, ...rightSteps].some((r) => r.measured != null);
    const allTiny = [...leftSteps, ...rightSteps].every((r) => r.measured == null || Math.abs(r.measured) < requiredChange('turn_left', spec, o));
    if (anyHorizontalMeasured && allTiny) reasons.add(LIVENESS_REASONS.noParallax);
  }

  // Steps must have been performed in the requested order.
  let lastTime = -Infinity;
  for (const step of specSteps) {
    const f = qualifying.get(step.index);
    if (!f) continue;
    if (f.capturedAt < lastTime) {
      setStep(step.index, false, stepResults.find((r) => r.index === step.index)!.measured, 'Performed out of order');
      reasons.add(LIVENESS_REASONS.outOfOrder);
    }
    lastTime = Math.max(lastTime, f.capturedAt);
  }

  // Frames of different steps (and the frontal frame) must not be identical images.
  const compared: LivenessFrame[] = [...qualifying.entries()]
    .filter(([idx]) => specSteps.find((s) => s.index === idx)?.action !== 'center')
    .map(([, f]) => f);
  const pool = frontalRep ? [frontalRep, ...compared] : compared;
  outer: for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (safeHamming(pool[i].analysis.dhash, pool[j].analysis.dhash) <= o.minFrameHamming) {
        reasons.add(LIVENESS_REASONS.identical);
        break outer;
      }
    }
  }

  return finish();
}

function medianOrZero(values: (number | null | undefined)[]): number {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? median(v) : 0;
}

function safeHamming(a: string, b: string): number {
  try {
    return hammingHex(a, b);
  } catch {
    return 0; // malformed hashes are treated as identical (fail closed)
  }
}
