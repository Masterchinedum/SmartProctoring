import { LIVENESS_INSTRUCTIONS, QUALITY_GUIDANCE, type FaceObservation, type LivenessAction, type LivenessStep } from '@sp/shared';
import { clamp01 } from '../util/math';

/**
 * Client-side liveness GUIDANCE. The server verifies the challenge from the uploaded frames (YuNet
 * landmarks + the same five-point pose formula); this tracker only tells the candidate what to do and
 * tells the host when the pose is right to capture a frame for the current step.
 *
 * Poses are measured RELATIVE TO THE CANDIDATE'S CENTRE pose (so a camera mounted to the side works):
 *  - if the challenge starts with a 'center' step, the centre is taken from the frames captured for it;
 *  - otherwise the centre is established implicitly before the first action, from a steady (±2.5°) pose
 *    held for holdMs within ±25° of frontal ("Look straight at the screen").
 * For an action step the offset toward the requested direction (turn_left: yaw − centre, yaw+ =
 * subject-left per POSE_CONVENTION; turn_right: centre − yaw; look_up: pitch − centre; look_down:
 * centre − pitch) must reach the target and be held for holdMs (with the other axis roughly level) →
 * readyToCapture. After `framesPerStep` markCaptured() calls the tracker advances to the next step.
 * Exactly one visible, uncut face is required at all times; otherwise `problem` explains what to fix.
 */
export interface LivenessProgress {
  stepIndex: number;
  action: LivenessAction | 'center';
  message: string;
  /** 0..1 toward target */
  progress: number;
  readyToCapture: boolean;
  done: boolean;
  problem: string | null;
}

export interface LivenessTracker {
  update(face: FaceObservation | null, faceCount: number, t: number): LivenessProgress;
  markCaptured(t: number): void;
  current(): LivenessProgress;
  reset(): void;
}

/** Tolerance of the implicit centre: pose spread over the hold window. */
const CENTRE_STEADY_DEG = 5;
const CENTRE_MAX_DEG = 25;
/** 'center' step target tolerance (deg) relative to the known centre / to frontal when unknown. */
const CENTER_TOL_KNOWN = 8;
const CENTER_TOL_UNKNOWN = 15;

export function createLivenessTracker(opts: {
  steps: LivenessStep[];
  targetYawDeg: number;
  targetPitchDeg: number;
  holdMs?: number;
  framesPerStep?: number;
}): LivenessTracker {
  const steps = opts.steps ?? [];
  const holdMs = Math.max(0, opts.holdMs ?? 400);
  const framesPerStep = Math.max(1, Math.floor(opts.framesPerStep ?? 2));
  const targetYaw = Math.max(1, opts.targetYawDeg);
  const targetPitch = Math.max(1, opts.targetPitchDeg);
  const minCaptureGap = Math.max(150, holdMs / 2);

  let idx = 0;
  let centre: { yaw: number; pitch: number } | null = null;
  let centreSamples: { yaw: number; pitch: number }[] = [];
  let buf: { t: number; yaw: number; pitch: number }[] = [];
  let holdStart: number | null = null;
  let captured = 0;
  let lastCaptureAt = -Infinity;
  let lastPose: { yaw: number; pitch: number } | null = null;
  let last: LivenessProgress = initial();

  function stepAt(i: number): LivenessStep | null {
    return i < steps.length ? steps[i] : null;
  }

  function stepNo(i: number): number {
    const s = stepAt(i);
    return s && Number.isFinite(s.index) ? s.index : i;
  }

  function initial(): LivenessProgress {
    if (steps.length === 0) return { stepIndex: 0, action: 'center', message: 'Done', progress: 1, readyToCapture: false, done: true, problem: null };
    const s = steps[0];
    return { stepIndex: stepNo(0), action: s.action, message: s.instruction || LIVENESS_INSTRUCTIONS[s.action], progress: 0, readyToCapture: false, done: false, problem: null };
  }

  function instruction(s: LivenessStep): string {
    return s.instruction || LIVENESS_INSTRUCTIONS[s.action];
  }

  function problemFor(face: FaceObservation | null, faceCount: number): string | null {
    if (!face || faceCount <= 0) return QUALITY_GUIDANCE.no_face;
    if (faceCount > 1) return QUALITY_GUIDANCE.multiple_faces;
    if (face.cutOff) return QUALITY_GUIDANCE.face_cut_off;
    if (Number.isFinite(face.visibility) && face.visibility < 0.5) return QUALITY_GUIDANCE.low_detection_confidence;
    if (!Number.isFinite(face.yaw) || !Number.isFinite(face.pitch)) return QUALITY_GUIDANCE.low_detection_confidence;
    return null;
  }

  function update(face: FaceObservation | null, faceCount: number, t: number): LivenessProgress {
    const s = stepAt(idx);
    if (!s) return (last = { stepIndex: stepNo(Math.max(0, steps.length - 1)), action: 'center', message: 'Done', progress: 1, readyToCapture: false, done: true, problem: null });
    const problem = problemFor(face, faceCount);
    if (problem || !face) {
      holdStart = null;
      buf = [];
      return (last = { stepIndex: stepNo(idx), action: last.action, message: problem ?? QUALITY_GUIDANCE.no_face, progress: 0, readyToCapture: false, done: false, problem });
    }
    const yaw = face.yaw;
    const pitch = face.pitch;
    lastPose = { yaw, pitch };

    if (s.action === 'center') {
      const ref = centre ?? { yaw: 0, pitch: 0 };
      const tol = centre ? CENTER_TOL_KNOWN : CENTER_TOL_UNKNOWN;
      const dev = Math.max(Math.abs(yaw - ref.yaw), Math.abs(pitch - ref.pitch));
      const ok = dev <= tol;
      const progress = ok ? 1 : clamp01(1 - (dev - tol) / (2 * tol));
      return (last = hold(ok, t, progress, s, ok ? '' : instruction(s)));
    }

    // Implicit centre before the first action step.
    if (!centre) {
      buf.push({ t, yaw, pitch });
      while (buf.length > 0 && buf[0].t < t - holdMs) buf.shift();
      const ys = buf.map((b) => b.yaw);
      const ps = buf.map((b) => b.pitch);
      const steady = Math.max(...ys) - Math.min(...ys) <= CENTRE_STEADY_DEG && Math.max(...ps) - Math.min(...ps) <= CENTRE_STEADY_DEG;
      const plausible = Math.abs(yaw) <= CENTRE_MAX_DEG && Math.abs(pitch) <= CENTRE_MAX_DEG;
      const spanMs = buf.length ? t - buf[0].t : 0;
      if (steady && plausible && spanMs >= holdMs * 0.9 && buf.length >= 2) {
        centre = { yaw: ys.reduce((a, b) => a + b, 0) / ys.length, pitch: ps.reduce((a, b) => a + b, 0) / ps.length };
        buf = [];
        holdStart = null;
      } else {
        if (!steady || !plausible) buf = plausible ? buf.slice(-1) : [];
        const progress = plausible ? clamp01(spanMs / Math.max(1, holdMs)) * 0.99 : 0;
        return (last = { stepIndex: stepNo(idx), action: 'center', message: `${LIVENESS_INSTRUCTIONS.center} and hold still`, progress, readyToCapture: false, done: false, problem: null });
      }
    }

    const c = centre;
    const horizontal = s.action === 'turn_left' || s.action === 'turn_right';
    const off =
      s.action === 'turn_left' ? yaw - c.yaw : s.action === 'turn_right' ? c.yaw - yaw : s.action === 'look_up' ? pitch - c.pitch : c.pitch - pitch;
    const target = horizontal ? targetYaw : targetPitch;
    const progress = clamp01(off / target);
    const crossOk = horizontal ? Math.abs(pitch - c.pitch) <= Math.max(15, 1.5 * targetPitch) : Math.abs(yaw - c.yaw) <= Math.max(15, 0.75 * targetYaw);
    const ok = off >= target && crossOk;
    let hint = '';
    if (!crossOk) hint = horizontal ? 'Keep your head level while turning' : 'Face the screen first, then tilt your head';
    else if (!ok && progress >= 0.6) hint = `${instruction(s)} — a little further`;
    else if (!ok && off < -target * 0.5) hint = `${instruction(s)} — the other way`;
    return (last = hold(ok, t, progress, s, hint));
  }

  function hold(ok: boolean, t: number, progress: number, s: LivenessStep, hint: string): LivenessProgress {
    let ready = false;
    let message = hint || instruction(s);
    if (ok) {
      holdStart ??= t;
      ready = t - holdStart >= holdMs && t - lastCaptureAt >= minCaptureGap;
      message = ready ? 'Hold still…' : 'Hold it there…';
    } else holdStart = null;
    return { stepIndex: stepNo(idx), action: s.action, message, progress, readyToCapture: ready, done: false, problem: null };
  }

  return {
    update,
    markCaptured(t: number) {
      const s = stepAt(idx);
      if (!s) return;
      captured++;
      lastCaptureAt = t;
      if (s.action === 'center' && lastPose) centreSamples.push(lastPose);
      if (captured >= framesPerStep) {
        if (s.action === 'center' && centreSamples.length) {
          centre = {
            yaw: centreSamples.reduce((a, b) => a + b.yaw, 0) / centreSamples.length,
            pitch: centreSamples.reduce((a, b) => a + b.pitch, 0) / centreSamples.length,
          };
          centreSamples = [];
        }
        idx++;
        captured = 0;
        holdStart = null;
        const next = stepAt(idx);
        last = next
          ? { stepIndex: stepNo(idx), action: next.action, message: instruction(next), progress: 0, readyToCapture: false, done: false, problem: null }
          : { stepIndex: stepNo(Math.max(0, steps.length - 1)), action: 'center', message: 'Done', progress: 1, readyToCapture: false, done: true, problem: null };
      } else {
        last = { ...last, readyToCapture: false };
      }
    },
    current: () => last,
    reset() {
      idx = 0;
      centre = null;
      centreSamples = [];
      buf = [];
      holdStart = null;
      captured = 0;
      lastCaptureAt = -Infinity;
      lastPose = null;
      last = initial();
    },
  };
}
