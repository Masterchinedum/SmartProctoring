import { LIVENESS_INSTRUCTIONS, QUALITY_GUIDANCE, type FaceObservation, type LivenessAction, type LivenessStep } from '@sp/shared';
import { clamp01 } from '../util/math';

/**
 * Client-side liveness GUIDANCE. The server verifies the challenge from the uploaded frames (YuNet
 * landmarks + the same five-point pose formula); this tracker only tells the candidate what to do and
 * tells the host when the pose is right to capture a frame for the current step.
 *
 * Poses are measured RELATIVE TO THE CANDIDATE'S CENTRE pose (so a camera mounted to the side works):
 *  - the host may set the centre from the frontal frames it captured (`setCentre`) — the same frames the
 *    server uses as its reference pose;
 *  - otherwise a 'center' step is satisfied by a steady pose (spread ≤ 5° over holdMs) inside a generous
 *    absolute window (|yaw| ≤ 25°, |pitch| ≤ 35°) and the frames captured for it define the centre; without a
 *    'center' step the centre is established implicitly before the first action ("Look straight at the
 *    screen");
 *  - once a centre is known, a later 'center' step must return within ±8° of it.
 *
 * Action steps are captured at the PEAK of the movement, not at the first threshold crossing: the offset
 * toward the requested direction (turn_left: yaw − centre, yaw+ = subject-left per POSE_CONVENTION;
 * turn_right: centre − yaw; look_up: pitch − centre; look_down: centre − pitch) must reach the target, the
 * head must have stopped (offset range ≤ 4° over the last 300 ms) close to the largest offset of the last
 * second (≥ peak − 3°), with the other axis roughly level, and be held for holdMs → readyToCapture.
 * `framesPerStep` frames are captured while the candidate holds.
 *
 * With `awaitVerdict` the tracker then waits for the host's `verdict(stepIndex, satisfied)` (from the
 * server's per-frame answer) before moving on — steps must reach the server in order, so a step the server
 * did not accept is re-prompted IN PLACE ("turn a little further and hold", a larger client target, one more
 * frame) up to `maxFramesPerStep` frames in total (the server only considers the first 3 frames of a step);
 * after that the tracker moves on and the server decides at completion.
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
  /**
   * centre: establishing the straight-ahead pose; move: turning toward the target; hold: at the target,
   * waiting for the head to stop / capturing; verify: frames sent, waiting for the server's verdict;
   * retry: the server wants a little more movement (re-prompt in place).
   */
  stage?: 'centre' | 'move' | 'hold' | 'verify' | 'retry';
  /** 0..1 of the hold before capture (for "hold still" feedback). */
  holdProgress?: number;
  /** Frames captured for the current step so far. */
  captured?: number;
}

export interface LivenessTracker {
  update(face: FaceObservation | null, faceCount: number, t: number): LivenessProgress;
  markCaptured(t: number): void;
  current(): LivenessProgress;
  reset(): void;
  /** Use this straight-ahead pose as the centre (e.g. median client pose of the frontal frames). */
  setCentre(pose: { yaw: number; pitch: number } | null): void;
  /** awaitVerdict: the server's answer for the frames of `stepIndex` (true = the step is satisfied). */
  verdict(stepIndex: number, satisfied: boolean): void;
}

/** Centre pose: steady (max − min over the hold window) within this many degrees … */
const CENTRE_STEADY_DEG = 5;
/**
 * … and inside a generous ABSOLUTE sanity window. Absolute pose from landmarks carries a per-person /
 * per-camera offset (camera above or beside the screen, face shape), so the centre is never required to
 * be (0, 0); the server verifies each step relative to the frontal frames anyway.
 */
const CENTRE_MAX_YAW = 25;
const CENTRE_MAX_PITCH = 35;
/** A later 'center' step (centre already known) must come back within this many degrees of it. */
const CENTER_TOL_KNOWN = 8;
/** Peak capture: the head has stopped (offset range over PLATEAU_MS) … */
const PLATEAU_MS = 300;
const PLATEAU_DEG = 4;
/** … close to the largest offset of the last PEAK_WINDOW_MS. */
const PEAK_WINDOW_MS = 1000;
const PEAK_TOL_DEG = 3;
/** Re-prompt: ask for this much more than the offset the server did not accept (client target). */
const RETRY_EXTRA_DEG = 6;
const MAX_CLIENT_TARGET_DEG = 45;

export function createLivenessTracker(opts: {
  steps: LivenessStep[];
  targetYawDeg: number;
  targetPitchDeg: number;
  holdMs?: number;
  framesPerStep?: number;
  /** Wait for verdict() after the frames of a step (default false: advance after framesPerStep). */
  awaitVerdict?: boolean;
  /** Frames per step in total, including re-prompts (default 3 — the server considers the first 3). */
  maxFramesPerStep?: number;
}): LivenessTracker {
  const steps = opts.steps ?? [];
  const holdMs = Math.max(0, opts.holdMs ?? 400);
  const framesPerStep = Math.max(1, Math.floor(opts.framesPerStep ?? 2));
  const awaitVerdict = !!opts.awaitVerdict;
  const maxFrames = Math.max(framesPerStep, Math.floor(opts.maxFramesPerStep ?? 3));
  const baseYaw = Math.max(1, opts.targetYawDeg);
  const basePitch = Math.max(1, opts.targetPitchDeg);
  const minCaptureGap = Math.max(150, holdMs / 2);

  let idx = 0;
  let centre: { yaw: number; pitch: number } | null = null;
  let centreSamples: { yaw: number; pitch: number }[] = [];
  let buf: { t: number; yaw: number; pitch: number }[] = [];
  /** Directional offsets of the current action step (for plateau / peak). */
  let offs: { t: number; off: number }[] = [];
  let holdStart: number | null = null;
  /** Frames captured in the current round / for the step in total. */
  let captured = 0;
  let capturedTotal = 0;
  let lastCaptureAt = -Infinity;
  let lastPose: { yaw: number; pitch: number } | null = null;
  /** Largest offset captured for this step (for the retry target). */
  let capturedOff = -Infinity;
  let waiting = false;
  let retrying = false;
  let stepTarget: number | null = null;
  /** Offset of the frame the host is about to capture (for the retry target). */
  let capturedCandidateOff = -Infinity;
  let last: LivenessProgress = initial();

  function stepAt(i: number): LivenessStep | null {
    return i < steps.length ? steps[i] : null;
  }

  function stepNo(i: number): number {
    const s = stepAt(i);
    return s && Number.isFinite(s.index) ? s.index : i;
  }

  function initial(): LivenessProgress {
    if (steps.length === 0) return doneProgress();
    const s = steps[0];
    return { stepIndex: stepNo(0), action: s.action, message: instruction(s), progress: 0, readyToCapture: false, done: false, problem: null, stage: 'move', holdProgress: 0, captured: 0 };
  }

  function doneProgress(): LivenessProgress {
    return { stepIndex: stepNo(Math.max(0, steps.length - 1)), action: 'center', message: 'Done', progress: 1, readyToCapture: false, done: true, problem: null, stage: 'verify', holdProgress: 1, captured: 0 };
  }

  function instruction(s: LivenessStep): string {
    return s.instruction || LIVENESS_INSTRUCTIONS[s.action];
  }

  function horizontal(a: LivenessAction | 'center'): boolean {
    return a === 'turn_left' || a === 'turn_right';
  }

  function targetFor(s: LivenessStep): number {
    const base = horizontal(s.action) ? baseYaw : basePitch;
    return stepTarget ?? base;
  }

  function problemFor(face: FaceObservation | null, faceCount: number): string | null {
    if (!face || faceCount <= 0) return QUALITY_GUIDANCE.no_face;
    if (faceCount > 1) return QUALITY_GUIDANCE.multiple_faces;
    if (face.cutOff) return QUALITY_GUIDANCE.face_cut_off;
    if (Number.isFinite(face.visibility) && face.visibility < 0.5) return QUALITY_GUIDANCE.low_detection_confidence;
    if (!Number.isFinite(face.yaw) || !Number.isFinite(face.pitch)) return QUALITY_GUIDANCE.low_detection_confidence;
    return null;
  }

  function base(s: LivenessStep, over: Partial<LivenessProgress>): LivenessProgress {
    return { stepIndex: stepNo(idx), action: s.action, message: instruction(s), progress: 0, readyToCapture: false, done: false, problem: null, captured: capturedTotal, ...over };
  }

  function update(face: FaceObservation | null, faceCount: number, t: number): LivenessProgress {
    const s = stepAt(idx);
    if (!s) return (last = doneProgress());
    if (waiting) {
      // Frames are on their way to the server: relax, the next instruction follows its answer.
      return (last = base(s, { message: 'Good — now look back at the screen', progress: 1, stage: 'verify', holdProgress: 1 }));
    }
    const problem = problemFor(face, faceCount);
    if (problem || !face) {
      holdStart = null;
      buf = [];
      offs = [];
      return (last = { stepIndex: stepNo(idx), action: last.action, message: problem ?? QUALITY_GUIDANCE.no_face, progress: 0, readyToCapture: false, done: false, problem, stage: last.stage, holdProgress: 0, captured: capturedTotal });
    }
    const yaw = face.yaw;
    const pitch = face.pitch;
    lastPose = { yaw, pitch };

    if (s.action === 'center') {
      if (centre) {
        const dev = Math.max(Math.abs(yaw - centre.yaw), Math.abs(pitch - centre.pitch));
        const ok = dev <= CENTER_TOL_KNOWN;
        const progress = ok ? 1 : clamp01(1 - (dev - CENTER_TOL_KNOWN) / (2 * CENTER_TOL_KNOWN));
        return (last = hold(ok, t, progress, s, ok ? '' : instruction(s), 'centre'));
      }
      // No centre yet: any steady pose inside the absolute sanity window (hold() enforces holdMs).
      const st = steadiness(t, yaw, pitch);
      const plausible = Math.abs(yaw) <= CENTRE_MAX_YAW && Math.abs(pitch) <= CENTRE_MAX_PITCH;
      const ok = plausible && st.steadyNow;
      return (last = hold(ok, t, ok ? 1 : 0, s, `${instruction(s)} and hold still`, 'centre'));
    }

    // Implicit centre before the first action step.
    if (!centre) {
      const st = steadiness(t, yaw, pitch);
      const plausible = Math.abs(yaw) <= CENTRE_MAX_YAW && Math.abs(pitch) <= CENTRE_MAX_PITCH;
      if (plausible && st.steady) {
        centre = st.mean;
        buf = [];
        holdStart = null;
      } else {
        const progress = plausible ? clamp01(st.spanMs / Math.max(1, holdMs)) * 0.99 : 0;
        return (last = { stepIndex: stepNo(idx), action: 'center', message: `${LIVENESS_INSTRUCTIONS.center} and hold still`, progress, readyToCapture: false, done: false, problem: null, stage: 'centre', holdProgress: progress, captured: capturedTotal });
      }
    }

    const c = centre;
    const isH = horizontal(s.action);
    const off =
      s.action === 'turn_left' ? yaw - c.yaw : s.action === 'turn_right' ? c.yaw - yaw : s.action === 'look_up' ? pitch - c.pitch : c.pitch - pitch;
    const target = targetFor(s);
    const progress = clamp01(off / target);
    const baseTarget = isH ? baseYaw : basePitch;
    const crossOk = isH ? Math.abs(pitch - c.pitch) <= Math.max(15, 1.5 * basePitch) : Math.abs(yaw - c.yaw) <= Math.max(15, 0.75 * baseYaw);
    offs.push({ t, off });
    while (offs.length > 0 && offs[0].t < t - PEAK_WINDOW_MS) offs.shift();
    const recent = offs.filter((o) => o.t >= t - PLATEAU_MS);
    const span = recent.length ? t - recent[0].t : 0;
    const range = recent.length ? Math.max(...recent.map((o) => o.off)) - Math.min(...recent.map((o) => o.off)) : Infinity;
    const peak = Math.max(...offs.map((o) => o.off));
    const stopped = range <= PLATEAU_DEG && (span >= PLATEAU_MS * 0.6 || holdStart !== null);
    const atPeak = off >= peak - PEAK_TOL_DEG;
    const reached = off >= target && crossOk;
    const ok = reached && stopped && atPeak;
    let hint = '';
    if (!crossOk) hint = isH ? 'Keep your head level while turning' : 'Face the screen first, then tilt your head';
    else if (reached && !ok) hint = 'Hold it there…';
    else if (!reached && retrying) hint = `${instruction(s)} — a little further than before, and hold`;
    else if (!reached && progress >= 0.6) hint = `${instruction(s)} — a little further`;
    else if (!reached && off < -baseTarget * 0.5) hint = `${instruction(s)} — the other way`;
    // The hold counts from when the head stopped (the plateau), not from this frame.
    const out = hold(ok, t, progress, s, hint, reached ? 'hold' : retrying ? 'retry' : 'move', recent.length ? recent[0].t : t);
    if (out.readyToCapture) capturedCandidateOff = off;
    return (last = out);
  }

  /**
   * Recent pose window (last holdMs). steadyNow: the spread within the window is ≤ CENTRE_STEADY_DEG
   * (a larger movement restarts the window). steady: steadyNow for (almost) the whole hold time.
   */
  function steadiness(t: number, yaw: number, pitch: number): { steadyNow: boolean; steady: boolean; spanMs: number; mean: { yaw: number; pitch: number } } {
    buf.push({ t, yaw, pitch });
    while (buf.length > 0 && buf[0].t < t - holdMs) buf.shift();
    const ys = buf.map((b) => b.yaw);
    const ps = buf.map((b) => b.pitch);
    const steadyNow = Math.max(...ys) - Math.min(...ys) <= CENTRE_STEADY_DEG && Math.max(...ps) - Math.min(...ps) <= CENTRE_STEADY_DEG;
    if (!steadyNow) buf = buf.slice(-1);
    const spanMs = buf.length ? t - buf[0].t : 0;
    const mean = { yaw: buf.reduce((a, b) => a + b.yaw, 0) / buf.length, pitch: buf.reduce((a, b) => a + b.pitch, 0) / buf.length };
    return { steadyNow, steady: steadyNow && spanMs >= holdMs * 0.9 && buf.length >= 2, spanMs, mean };
  }

  function hold(ok: boolean, t: number, progress: number, s: LivenessStep, hint: string, stage: LivenessProgress['stage'], since = t): LivenessProgress {
    let ready = false;
    let message = hint || instruction(s);
    let holdProgress = 0;
    if (ok) {
      holdStart ??= since;
      holdProgress = clamp01((t - holdStart) / Math.max(1, holdMs));
      ready = t - holdStart >= holdMs && t - lastCaptureAt >= minCaptureGap;
      message = ready || captured > 0 ? 'Hold still…' : 'Hold it there…';
    } else holdStart = null;
    return { stepIndex: stepNo(idx), action: s.action, message, progress, readyToCapture: ready, done: false, problem: null, stage: ok ? 'hold' : stage, holdProgress, captured: capturedTotal };
  }

  function advance(): void {
    idx++;
    captured = 0;
    capturedTotal = 0;
    capturedOff = -Infinity;
    holdStart = null;
    offs = [];
    waiting = false;
    retrying = false;
    stepTarget = null;
    const next = stepAt(idx);
    last = next
      ? { stepIndex: stepNo(idx), action: next.action, message: instruction(next), progress: 0, readyToCapture: false, done: false, problem: null, stage: 'move', holdProgress: 0, captured: 0 }
      : doneProgress();
  }

  return {
    update,
    markCaptured(t: number) {
      const s = stepAt(idx);
      if (!s || waiting) return;
      captured++;
      capturedTotal++;
      lastCaptureAt = t;
      capturedOff = Math.max(capturedOff, capturedCandidateOff);
      if (s.action === 'center' && lastPose) centreSamples.push(lastPose);
      const roundSize = retrying ? 1 : framesPerStep;
      if (captured >= roundSize) {
        if (s.action === 'center' && centreSamples.length && !centre) {
          centre = {
            yaw: centreSamples.reduce((a, b) => a + b.yaw, 0) / centreSamples.length,
            pitch: centreSamples.reduce((a, b) => a + b.pitch, 0) / centreSamples.length,
          };
        }
        centreSamples = [];
        if (awaitVerdict) {
          waiting = true;
          holdStart = null;
          last = { ...last, readyToCapture: false, stage: 'verify', message: 'Good — now look back at the screen' };
        } else advance();
      } else {
        last = { ...last, readyToCapture: false };
      }
    },
    verdict(stepIndex: number, satisfied: boolean) {
      const s = stepAt(idx);
      if (!s || stepNo(idx) !== stepIndex || !waiting) return;
      if (satisfied || capturedTotal >= maxFrames) {
        advance();
        return;
      }
      // Re-prompt this step in place: one more frame at a larger offset.
      waiting = false;
      retrying = true;
      captured = 0;
      holdStart = null;
      offs = [];
      if (s.action !== 'center') {
        const base = horizontal(s.action) ? baseYaw : basePitch;
        const prev = Number.isFinite(capturedOff) ? capturedOff : base;
        stepTarget = Math.min(MAX_CLIENT_TARGET_DEG, Math.max(base, prev + RETRY_EXTRA_DEG));
      }
      last = {
        stepIndex: stepNo(idx),
        action: s.action,
        message: s.action === 'center' ? `${instruction(s)} and hold still` : `${instruction(s)} — a little further than before, and hold`,
        progress: 0,
        readyToCapture: false,
        done: false,
        problem: null,
        stage: 'retry',
        holdProgress: 0,
        captured: capturedTotal,
      };
    },
    setCentre(pose) {
      centre = pose && Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch) ? { yaw: pose.yaw, pitch: pose.pitch } : null;
    },
    current: () => last,
    reset() {
      idx = 0;
      centre = null;
      centreSamples = [];
      buf = [];
      offs = [];
      holdStart = null;
      captured = 0;
      capturedTotal = 0;
      capturedOff = -Infinity;
      lastCaptureAt = -Infinity;
      lastPose = null;
      waiting = false;
      retrying = false;
      stepTarget = null;
      last = initial();
    },
  };
}
