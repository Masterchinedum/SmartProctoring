import { useCallback, useEffect, useRef, useState } from 'react';
import { createLivenessTracker, type LivenessProgress } from '@sp/detection';
import type { CheckFrameResponse, CheckPurpose, CompleteCheckResponse, DeviceInfo, FaceObservation, LivenessStep, StartCheckResponse } from '@sp/shared';
import { classifyApiError, type CandidateApi } from '../api';
import { errorMessage, useController, useSnapshot } from '../context';
import { CameraPreview, ScreenHeading, Spinner } from '../components/common';
import { captureFaceCrop } from '../monitoring/frames';
import { AdaptiveCheck } from './adaptive';
import { PoseSmoother } from './poseFilter';
import { CheckProgress } from './progress';
import { plausibleFaces, useFrameAnalysis, type FrameAnalysis } from './useFrameAnalysis';

/**
 * Live-person + identity check. Sends un-mirrored, face-centred JPEG crops at the camera's native resolution
 * to the server, which is authoritative. Adaptive (AdaptiveCheck):
 *  1. frontal frames while the server wants more (CheckFrameResponse.progress.frontalNeeded; v1 servers:
 *     frontalFramesRequired), with the server's guidance shown live;
 *  2. if the challenge has liveness steps: frames at the PEAK of each head movement (liveness tracker),
 *     the server's per-step verdict before moving on, and an in-place re-prompt ("a little further") for a
 *     step it did not accept — never a restart of the whole check;
 *  3. POST complete as soon as the server can decide (progress.canComplete) → passed / retry / held / failed.
 */

/**
 * Frames captured at the peak of each head movement, per prompt; a step the server has not accepted is
 * re-prompted in place with another round, up to 6 frames per step (the server judges windows of 3 frames and
 * refuses a 7th frame with 429).
 */
export const FRAMES_PER_STEP = 3;
export const MAX_FRAMES_PER_STEP = 6;
/**
 * Client-side "frontal" gate: relative to the candidate's calibrated centre pose when known (camera
 * placement varies), otherwise a margin inside the server's quality gate (|yaw| ≤ 25°,
 * −35° ≤ pitch ≤ 25°), which is authoritative.
 */
const FRONTAL_MAX_YAW = 18;
const FRONTAL_REL_DEG = 15;
const FRONTAL_PITCH_RANGE_ABS = [-28, 18] as const;

type Pose = { yaw: number; pitch: number };

export function isFrontal(face: Pose, centre: Pose | null): boolean {
  if (Math.abs(face.yaw) > 25) return false;
  if (centre) return Math.abs(face.yaw - centre.yaw) <= FRONTAL_REL_DEG && Math.abs(face.pitch - centre.pitch) <= FRONTAL_REL_DEG;
  return Math.abs(face.yaw) <= FRONTAL_MAX_YAW && face.pitch >= FRONTAL_PITCH_RANGE_ABS[0] && face.pitch <= FRONTAL_PITCH_RANGE_ABS[1];
}

const MIN_CAPTURE_SPACING_MS = 300;

type Phase = 'starting' | 'frontal' | 'liveness' | 'completing' | 'expired' | 'error';

export async function deviceInfo(ctrl: { camera: { state: { info: { label: string; deviceIdHash: string; width: number; height: number } | null } }; }): Promise<DeviceInfo> {
  const info = ctrl.camera.state.info;
  const scr = window.screen as Screen & { isExtended?: boolean };
  return {
    cameraLabel: (info?.label ?? '').slice(0, 300),
    cameraIdHash: info?.deviceIdHash ?? '',
    userAgent: navigator.userAgent.slice(0, 1000),
    screen: { width: scr.width, height: scr.height, isExtended: typeof scr.isExtended === 'boolean' ? scr.isExtended : null },
    videoWidth: info?.width || undefined,
    videoHeight: info?.height || undefined,
  };
}

const ARROWS: Record<string, string> = { turn_left: '←', turn_right: '→', look_up: '↑', look_down: '↓', center: '●' };

interface StepView {
  index: number;
  action: string;
  message: string;
  progress: number;
  problem: string | null;
  stage: NonNullable<LivenessProgress['stage']>;
  holdProgress: number;
}

type Tracker = ReturnType<typeof createLivenessTracker>;

export function VerifyStep({
  purpose,
  onResult,
  onBackToSetup,
}: {
  purpose: CheckPurpose;
  onResult: (res: CompleteCheckResponse, check: StartCheckResponse) => void;
  onBackToSetup: () => void;
}) {
  const ctrl = useController();
  const { camera } = useSnapshot();
  const [phase, setPhase] = useState<Phase>('starting');
  const [check, setCheck] = useState<StartCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string[]>([]);
  const [frontal, setFrontal] = useState<{ accepted: number; wanted: number }>({ accepted: 0, wanted: 0 });
  const [stepView, setStepView] = useState<StepView | null>(null);
  const [stepsDone, setStepsDone] = useState<number[]>([]);
  const [overall, setOverall] = useState(0);
  const [attempt, setAttempt] = useState(0);

  // Mutable run state (read inside the analysis callback).
  const run = useRef({
    check: null as StartCheckResponse | null,
    adaptive: null as AdaptiveCheck | null,
    phase: 'starting' as Phase,
    inflight: 0,
    uploads: [] as Promise<unknown>[],
    lastCaptureAt: 0,
    tracker: null as Tracker | null,
    trackerCentred: false,
    completing: false,
    cancelled: false,
    /** The candidate's own straight-ahead pose from calibration (for the frontal-frame gate). */
    centre: null as Pose | null,
    /** When to hand the attempt to the server although the guided capture did not finish. */
    progress: new CheckProgress(),
    /** Noise-adaptive pose smoothing for the liveness tracker (dim-light pose jitter, poseFilter.ts). */
    pose: new PoseSmoother(),
  });

  const setPhaseBoth = (p: Phase) => {
    if (run.current.phase === p) return;
    run.current.phase = p;
    setPhase(p);
  };

  const refreshProgress = useCallback(() => {
    const r = run.current;
    const a = r.adaptive;
    if (!a) return;
    const p = a.progress;
    setFrontal({ accepted: a.acceptedFrontal(), wanted: p ? p.frontalAccepted + p.frontalNeeded : a.required });
    const done = (r.check?.liveness?.steps ?? []).filter((s) => a.isStepSatisfied(s.index)).map((s) => s.index);
    const trackerDone = r.tracker?.current().done ?? false;
    setStepsDone(done);
    setOverall(trackerDone && !a.wantsFrontal() ? 1 : a.overall(done.length));
  }, []);

  /* ---------------------------------------------------------------- start */
  // Stop uploads when the step really unmounts (StrictMode's simulated remount re-arms it).
  useEffect(() => {
    run.current.cancelled = false;
    return () => {
      run.current.cancelled = true;
    };
  }, []);

  // One server check per attempt — idempotent across StrictMode's double effect invocation.
  const startRef = useRef<{ key: string; promise: Promise<StartCheckResponse> } | null>(null);
  useEffect(() => {
    const r = run.current;
    const key = `${purpose}:${attempt}`;
    let alive = true;
    if (startRef.current?.key !== key) {
      r.cancelled = false;
      r.check = null;
      r.adaptive = null;
      r.inflight = 0;
      r.uploads = [];
      r.lastCaptureAt = 0;
      r.tracker = null;
      r.trackerCentred = false;
      r.completing = false;
      r.pose = new PoseSmoother();
      const b = ctrl.currentBaseline();
      r.centre = b && b.samples > 0 ? { yaw: b.yaw, pitch: b.pitch } : null;
      r.progress.start(performance.now());
      setFrontal({ accepted: 0, wanted: 0 });
      setStepsDone([]);
      setStepView(null);
      setGuidance([]);
      setOverall(0);
      setError(null);
      r.phase = 'starting';
      setPhase('starting');
      startRef.current = {
        key,
        promise: (async () => ctrl.api.startCheck({ purpose, clientInstanceId: ctrl.instanceId, device: await deviceInfo(ctrl) }))(),
      };
    }
    startRef.current.promise.then(
      (res) => {
        if (!alive || r.check) return;
        r.check = res;
        r.adaptive = new AdaptiveCheck(res);
        r.progress.start(performance.now());
        setCheck(res);
        if (res.liveness) {
          r.tracker = createLivenessTracker({
            steps: res.liveness.steps,
            targetYawDeg: res.liveness.targetYawDeg,
            targetPitchDeg: res.liveness.targetPitchDeg,
            framesPerStep: FRAMES_PER_STEP,
            maxFramesPerStep: MAX_FRAMES_PER_STEP,
            awaitVerdict: true,
          });
        }
        refreshProgress();
        const next = r.adaptive.phase(!r.tracker, 0);
        if (next === 'complete') void completeRef.current();
        else setPhaseBoth(next);
      },
      async (e: unknown) => {
        if (!alive) return;
        const kind = classifyApiError(e);
        if (kind === 'invalid_state') {
          // The session moved on (e.g. already verified, or on hold): refresh and let the app route.
          await ctrl.load();
        }
        setError(errorMessage(e));
        setPhaseBoth('error');
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, purpose]);

  /* ---------------------------------------------------------------- expiry */
  useEffect(() => {
    if (!check?.liveness) return;
    const id = setInterval(() => {
      const r = run.current;
      if (r.completing || r.phase === 'expired' || r.phase === 'error') return;
      if (ctrl.clock.now() > check.liveness!.expiresAt - 750) {
        r.cancelled = true;
        setPhaseBoth('expired');
      }
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check, ctrl]);

  /* ---------------------------------------------------------------- upload */
  const upload = useCallback(
    (step: number | 'frontal', face: Pick<FaceObservation, 'yaw' | 'pitch' | 'box'> | null, api: CandidateApi, onDone: (res: CheckFrameResponse) => void, onFail?: () => void) => {
      const r = run.current;
      const c = r.check;
      if (!c) return;
      const capturedAt = ctrl.clock.now();
      r.lastCaptureAt = performance.now();
      r.inflight++;
      // Crop at once (the face box belongs to the frame just analysed); encoding / sending happen after.
      const cropping = captureFaceCrop(ctrl.camera.video, face?.box ?? null);
      const p = (async () => {
        try {
          const crop = await cropping;
          if (!crop || r.cancelled) {
            onFail?.();
            return;
          }
          // Transient failures (network, server busy) are retried with the same image and timestamp.
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await api.uploadCheckFrame(c.checkId, crop.blob, {
                step,
                capturedAt,
                nonce: c.liveness?.nonce ?? null,
                clientYaw: face && Number.isFinite(face.yaw) ? face.yaw : null,
                clientPitch: face && Number.isFinite(face.pitch) ? face.pitch : null,
              });
              ctrl.debug.checkFrame({
                at: Date.now(),
                step,
                accepted: res.accepted,
                guidance: res.guidance ?? [],
                quality: res.quality ?? null,
                stepSatisfied: res.stepSatisfied,
                measured: res.measured,
                progress: res.progress,
                crop: { width: crop.rect.width, height: crop.rect.height, face: crop.rect.face },
              });
              if (!r.cancelled) onDone(res);
              return;
            } catch (e) {
              if (r.cancelled) return;
              const kind = classifyApiError(e);
              const code = (e as { code?: string }).code;
              if (code === 'check_expired') {
                r.cancelled = true;
                setPhaseBoth('expired');
                return;
              }
              if (code === 'too_many_frames') {
                // The server has all the frames it will take: let it decide on what it has.
                if (r.adaptive) r.adaptive.framesExhausted = true;
                onFail?.();
                return;
              }
              if (kind === 'invalid_state' || kind === 'client' || kind === 'invalid_link' || kind === 'superseded') {
                // Challenge closed or frame refused: stop this attempt.
                r.cancelled = true;
                setError(errorMessage(e));
                setPhaseBoth('error');
                return;
              }
              if (attempt >= 3) {
                setGuidance(['We could not send the picture. Check your internet connection.']);
                onFail?.();
                return;
              }
              setGuidance(['Connection problem while sending the picture — retrying…']);
              await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
              if (r.cancelled) return;
            }
          }
        } finally {
          r.inflight--;
          // The last answer may be what allows completion.
          if (r.inflight === 0 && !r.cancelled && !r.completing) advance();
        }
      })();
      r.uploads.push(p);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctrl],
  );

  const completeRef = useRef<() => Promise<void>>(async () => undefined);
  const complete = useCallback(async () => {
    const r = run.current;
    if (r.completing || !r.check) return;
    r.completing = true;
    setPhaseBoth('completing');
    await Promise.allSettled(r.uploads);
    if (r.cancelled) return;
    try {
      const res = await ctrl.api.completeCheck(r.check.checkId);
      ctrl.debug.checkOutcome(res);
      if (r.cancelled) return;
      onResult(res, r.check);
    } catch (e) {
      if (r.cancelled) return;
      r.completing = false;
      const kind = classifyApiError(e);
      if (kind === 'invalid_state') await ctrl.load();
      setError(errorMessage(e));
      setPhaseBoth('error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl, onResult]);
  completeRef.current = complete;

  /** Re-evaluate what comes next (after an answer or a tracker change). */
  const advance = useCallback(() => {
    const r = run.current;
    const a = r.adaptive;
    if (!a || r.cancelled || r.completing) return;
    // A step whose frames are all answered gets the server's verdict (re-prompt in place if not accepted).
    const tr = r.tracker;
    const cur = tr?.current();
    if (tr && cur && cur.stage === 'verify' && !cur.done && a.stepSettled(cur.stepIndex)) {
      tr.verdict(cur.stepIndex, a.isStepSatisfied(cur.stepIndex));
    }
    refreshProgress();
    const next = a.phase(tr ? tr.current().done : true, r.inflight);
    if (next === 'complete') {
      if (r.inflight === 0) void completeRef.current();
      return;
    }
    if (next === 'liveness' && tr && !r.trackerCentred) {
      // The server measures the head turns relative to the frontal frames: use the same centre.
      r.trackerCentred = true;
      const c = a.frontalCentre();
      if (c) tr.setCentre(c);
    }
    setPhaseBoth(next);
  }, [refreshProgress]);

  /* ---------------------------------------------------------------- give up gracefully */
  // Hand the attempt to the server when nothing progresses (e.g. a photo cannot turn its head, or the
  // face is never usable): the server records it, counts it toward the attempt limit and explains why.
  useEffect(() => {
    if (phase !== 'frontal' && phase !== 'liveness') return;
    const id = setInterval(() => {
      const r = run.current;
      if (!r.check || r.cancelled || r.completing || r.inflight > 0) return;
      if (r.progress.stalled(performance.now())) void completeRef.current();
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  /* ---------------------------------------------------------------- per frame */
  const onFrame = useCallback(
    (fa: FrameAnalysis) => {
      const r = run.current;
      const a = r.adaptive;
      if (!r.check || !a || r.cancelled || r.completing) return;
      const faces = plausibleFaces(fa.faces);
      const face = faces.length === 1 ? faces[0] : null;
      // The liveness tracker sees the smoothed pose (warmed up during the frontal phase, so its noise estimate is
      // ready when the head turns start); frontal frames are gated on the raw pose.
      const sm = face ? r.pose.push(fa.t, face.yaw, face.pitch) : null;
      if (!face) r.pose.reset();
      const turnFace = face && sm ? { ...face, yaw: sm.yaw, pitch: sm.pitch } : null;
      const spacedOk = performance.now() - r.lastCaptureAt >= MIN_CAPTURE_SPACING_MS;
      advance();
      if (r.completing) return;

      if (r.phase === 'frontal') {
        if (!face) {
          setGuidance([faces.length > 1 ? 'Make sure only you are in view of the camera.' : 'We can’t see your face. Sit in front of the camera.']);
          return;
        }
        if (!isFrontal(face, r.centre)) {
          setGuidance(['Look straight at the screen.']);
          return;
        }
        if (r.inflight === 0 && spacedOk && a.wantsFrontal()) {
          a.frontalSentOne();
          const pose = { yaw: face.yaw, pitch: face.pitch };
          upload(
            'frontal',
            face,
            ctrl.api,
            (res) => {
              a.frontalResult(res, pose);
              if (res.accepted) r.progress.accepted(performance.now());
              // The server's guidance while it wants more frames (e.g. "Add light in front of you").
              setGuidance(res.accepted ? [] : res.guidance.length ? res.guidance : ['Please look straight at the camera and hold still.']);
            },
            () => a.frontalFailed(),
          );
        }
        return;
      }

      if (r.phase === 'liveness' && r.tracker) {
        const tr = r.tracker;
        const prog = tr.update(turnFace, faces.length, fa.t);
        r.progress.liveness(prog.stepIndex, prog.stage === 'verify' ? 1 : (prog.progress ?? 0), performance.now());
        const steps: LivenessStep[] = r.check.liveness?.steps ?? [];
        const step = steps.find((s) => s.index === prog.stepIndex) ?? steps[Math.min(steps.length - 1, Math.max(0, prog.stepIndex))];
        setStepView({
          index: prog.stepIndex,
          action: String(prog.action ?? step?.action ?? 'center'),
          message: prog.message || step?.instruction || '',
          progress: prog.progress ?? 0,
          problem: prog.problem ?? null,
          stage: prog.stage ?? 'move',
          holdProgress: prog.holdProgress ?? 0,
        });
        if (prog.done) {
          advance();
          return;
        }
        if (turnFace && prog.readyToCapture && spacedOk && r.inflight < 2) {
          const idx = prog.stepIndex;
          tr.markCaptured(fa.t);
          r.progress.captured(performance.now());
          a.stepSentOne(idx);
          upload(
            idx,
            turnFace,
            ctrl.api,
            (res) => {
              a.stepResult(idx, res);
              const g = res.accepted ? [] : res.guidance;
              setGuidance(g);
              advance();
            },
            () => {
              a.stepFailed(idx);
              advance();
            },
          );
        }
      }
    },
    [ctrl, upload, advance],
  );

  const vs = useFrameAnalysis(phase === 'frontal' || phase === 'liveness', onFrame, 120);

  /* ---------------------------------------------------------------- fallback without in-browser analysis */
  // If the face model cannot run in this browser, pace the candidate with timed instructions and let
  // the server (which is authoritative anyway) verify the full frames.
  const noVision = !vs.loading && !vs.vision?.face;
  useEffect(() => {
    if (!noVision || (phase !== 'frontal' && phase !== 'liveness')) return;
    const r = run.current;
    const steps = r.check?.liveness?.steps ?? [];
    let stepPos = 0;
    let stepStartedAt = performance.now();
    let shotsThisStep = 0;
    const id = setInterval(() => {
      const a = r.adaptive;
      if (!r.check || !a || r.cancelled || r.completing) return;
      if (r.phase === 'frontal') {
        setGuidance(['Look straight at the screen and hold still.']);
        if (r.inflight === 0 && a.wantsFrontal()) {
          a.frontalSentOne();
          upload(
            'frontal',
            null,
            ctrl.api,
            (res) => {
              a.frontalResult(res);
              if (res.accepted) r.progress.accepted(performance.now());
              else setGuidance(res.guidance.length ? res.guidance : ['Please look straight at the camera and hold still.']);
              stepStartedAt = performance.now();
            },
            () => a.frontalFailed(),
          );
        } else if (r.inflight === 0) advanceNoVision();
        return;
      }
      const step = steps[stepPos];
      if (!step) {
        if (r.inflight === 0) void completeRef.current();
        return;
      }
      const elapsed = performance.now() - stepStartedAt;
      setStepView({ index: step.index, action: step.action, message: step.instruction, progress: Math.min(1, elapsed / 3000), problem: null, stage: 'move', holdProgress: 0 });
      if (elapsed > 1800 + shotsThisStep * 900 && shotsThisStep < FRAMES_PER_STEP) {
        shotsThisStep++;
        r.progress.captured(performance.now());
        a.stepSentOne(step.index);
        upload(step.index, null, ctrl.api, (res) => a.stepResult(step.index, res), () => a.stepFailed(step.index));
      }
      if (shotsThisStep >= FRAMES_PER_STEP && elapsed > 3200) {
        stepPos++;
        shotsThisStep = 0;
        stepStartedAt = performance.now();
        refreshProgress();
      }
    }, 300);
    const advanceNoVision = () => {
      const a = r.adaptive;
      if (!a) return;
      const next = a.phase(stepPos >= steps.length, r.inflight);
      if (next === 'complete') void completeRef.current();
      else setPhaseBoth(next);
    };
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noVision, phase, upload, ctrl, refreshProgress]);

  /* ---------------------------------------------------------------- render */
  const steps = check?.liveness?.steps ?? [];
  let headline = 'Preparing the check…';
  let arrow: string | null = null;
  if (phase === 'frontal') headline = 'Look straight at the screen and hold still';
  if (phase === 'liveness' && stepView) {
    headline = stepView.message;
    arrow = stepView.stage === 'verify' ? null : (ARROWS[stepView.action] ?? null);
  }
  if (phase === 'completing') headline = 'Checking…';
  const holding = phase === 'liveness' && stepView?.stage === 'hold';
  const reprompt = phase === 'liveness' && stepView?.stage === 'retry';

  if (phase === 'expired' || phase === 'error') {
    return (
      <div className="stack" data-testid="verify-problem">
        <ScreenHeading>{phase === 'expired' ? 'The check took too long' : 'The check could not be completed'}</ScreenHeading>
        <p>{phase === 'expired' ? 'For security, each check must be completed within a short time. Let’s try again.' : (error ?? 'Something went wrong.')}</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setAttempt((x) => x + 1)} data-testid="verify-retry">
            Try again
          </button>
          <button type="button" className="btn" onClick={onBackToSetup}>
            Check my camera setup
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="verify-step" data-phase={phase} data-stage={phase === 'liveness' ? (stepView?.stage ?? 'move') : undefined}>
      <ScreenHeading title="Identity check">{check?.liveness ? 'Live-person and identity check' : 'Identity check'}</ScreenHeading>
      <p className="muted">
        {check?.liveness
          ? 'Follow the instructions below. We take a few pictures to confirm that a live person is in front of the camera and to compare your face with the identity reference.'
          : 'Look at the screen while we take a few pictures to confirm your identity.'}{' '}
        Only these pictures are sent; there is no video recording.
      </p>
      <div className="cand-setup">
        <CameraPreview
          stream={camera.stream}
          className="cand-preview-large"
          label="Your camera preview (mirrored)"
          overlay={
            arrow ? (
              <div className={`cand-arrow cand-arrow-${stepView?.action}${holding ? ' cand-arrow-hold' : ''}`} aria-hidden="true">
                {arrow}
              </div>
            ) : null
          }
        />
        <div className="stack">
          {/* The current instruction as text, announced politely when it changes (the arrows are decorative). */}
          <div className={`cand-instruction${holding ? ' cand-instruction-hold' : ''}`} role="status" aria-live="polite" aria-atomic="true" data-testid="verify-instruction">
            {arrow && <span className="cand-instruction-arrow" aria-hidden="true">{arrow}</span>}
            <span>{headline}</span>
          </div>
          {reprompt && (
            <p className="cand-guidance" data-testid="verify-reprompt">
              Almost there — turn your head a little further in the same direction and hold it for a moment.
            </p>
          )}
          {phase === 'liveness' && stepView && stepView.stage !== 'verify' && (
            <div className="cand-progress cand-progress-step" role="progressbar" aria-label="Head movement" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stepView.progress * 100)} data-testid="verify-step-progress">
              <div className="cand-progress-bar" style={{ width: `${Math.round(Math.min(1, stepView.progress) * 100)}%` }} />
            </div>
          )}
          {holding && stepView && (
            <div className="cand-hold" data-testid="verify-hold">
              <span>Hold still</span>
              <div className="cand-progress cand-progress-hold" role="progressbar" aria-label="Hold still" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stepView.holdProgress * 100)}>
                <div className="cand-progress-bar" style={{ width: `${Math.round(stepView.holdProgress * 100)}%` }} />
              </div>
            </div>
          )}
          <div className="cand-progress" role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
            <div className="cand-progress-bar" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          {phase === 'frontal' && frontal.wanted > 0 && (
            <p className="muted small" data-testid="verify-frontal-progress">
              Pictures of your face: {Math.min(frontal.accepted, frontal.wanted)} of {frontal.wanted}
            </p>
          )}
          {steps.length > 0 && (
            <ol className="cand-steps">
              <StepItem state={frontal.accepted >= Math.max(1, check?.frontalFramesRequired ?? 0) ? 'done' : phase === 'frontal' ? 'current' : ''}>Pictures of your face for the identity check</StepItem>
              {steps.map((s) => (
                <StepItem key={s.index} state={stepsDone.includes(s.index) ? 'done' : stepView?.index === s.index && phase === 'liveness' ? 'current' : ''}>
                  {s.instruction}
                </StepItem>
              ))}
            </ol>
          )}
          {/* Persistent live region for problems and guidance (announced politely when they change). */}
          <div aria-live="polite" className="stack cand-live-slot" style={{ gap: 8 }}>
            {stepView?.problem && phase === 'liveness' && <p className="cand-guidance">{stepView.problem}</p>}
            {guidance.length > 0 && (
              <ul className="cand-guidance-list" data-testid="verify-guidance">
                {guidance.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            )}
          </div>
          {(phase === 'starting' || phase === 'completing' || vs.loading) && <Spinner label={phase === 'completing' ? 'Verifying…' : 'Please wait…'} />}
          {noVision && <p className="muted small">Automatic guidance is unavailable in this browser; follow the instructions and the pictures are checked on the server.</p>}
          {check && <p className="muted small">Attempts remaining after this one: {Math.max(0, check.attemptsRemaining - 1)}</p>}
        </div>
      </div>
    </div>
  );
}

/** A step of the check: the state is shown by colour and a ✓ marker, and spelled out for screen readers. */
function StepItem({ state, children }: { state: 'done' | 'current' | ''; children: React.ReactNode }) {
  return (
    <li className={state} aria-current={state === 'current' ? 'step' : undefined}>
      {children}
      {state === 'done' && <span className="sr-only"> (done)</span>}
      {state === 'current' && <span className="sr-only"> (current step)</span>}
    </li>
  );
}
