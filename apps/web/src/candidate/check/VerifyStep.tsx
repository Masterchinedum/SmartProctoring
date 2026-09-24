import { useCallback, useEffect, useRef, useState } from 'react';
import { createLivenessTracker } from '@sp/detection';
import type { CheckFrameResponse, CheckPurpose, CompleteCheckResponse, DeviceInfo, FaceObservation, LivenessStep, StartCheckResponse } from '@sp/shared';
import { classifyApiError, type CandidateApi } from '../api';
import { errorMessage, useController, useSnapshot } from '../context';
import { CameraPreview, ScreenHeading, Spinner } from '../components/common';
import { captureJpeg } from '../monitoring/frames';
import { CheckProgress } from './progress';
import { plausibleFaces, useFrameAnalysis, type FrameAnalysis } from './useFrameAnalysis';

/**
 * Live-person + identity check. Sends un-mirrored JPEG frames to the server, which is authoritative:
 *  1. `frontalFramesRequired` frontal frames (identity reference / comparison),
 *  2. if the challenge has liveness steps: ~2 frames per step while the candidate follows the
 *     randomized head-movement instructions (verified server-side from facial-landmark parallax,
 *     which a flat photo cannot produce),
 *  3. POST complete → passed / retry / held / failed.
 */

export const FRAMES_PER_STEP = 2;
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

const MIN_CAPTURE_SPACING_MS = 350;
const JPEG_QUALITY = 0.85;

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
}

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
  const [frontalCount, setFrontalCount] = useState(0);
  const [stepView, setStepView] = useState<StepView | null>(null);
  const [stepsDone, setStepsDone] = useState(0);
  const [attempt, setAttempt] = useState(0);

  // Mutable run state (read inside the analysis callback).
  const run = useRef({
    check: null as StartCheckResponse | null,
    phase: 'starting' as Phase,
    inflight: 0,
    uploads: [] as Promise<unknown>[],
    lastCaptureAt: 0,
    frontalAccepted: 0,
    frontalSent: 0,
    perStep: new Map<number, number>(),
    tracker: null as ReturnType<typeof createLivenessTracker> | null,
    completing: false,
    cancelled: false,
    /** The candidate's own straight-ahead pose from calibration (for the frontal-frame gate). */
    centre: null as Pose | null,
    /** When to hand the attempt to the server although the guided capture did not finish. */
    progress: new CheckProgress(),
  });

  const setPhaseBoth = (p: Phase) => {
    run.current.phase = p;
    setPhase(p);
  };

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
      r.inflight = 0;
      r.uploads = [];
      r.lastCaptureAt = 0;
      r.frontalAccepted = 0;
      r.frontalSent = 0;
      r.perStep = new Map();
      r.tracker = null;
      r.completing = false;
      const b = ctrl.currentBaseline();
      r.centre = b && b.samples > 0 ? { yaw: b.yaw, pitch: b.pitch } : null;
      r.progress.start(performance.now());
      setFrontalCount(0);
      setStepsDone(0);
      setStepView(null);
      setGuidance([]);
      setError(null);
      setPhaseBoth('starting');
      startRef.current = {
        key,
        promise: (async () => ctrl.api.startCheck({ purpose, clientInstanceId: ctrl.instanceId, device: await deviceInfo(ctrl) }))(),
      };
    }
    startRef.current.promise.then(
      (res) => {
        if (!alive || r.check) return;
        r.check = res;
        r.progress.start(performance.now());
        setCheck(res);
        if (res.liveness) {
          r.tracker = createLivenessTracker({ steps: res.liveness.steps, targetYawDeg: res.liveness.targetYawDeg, targetPitchDeg: res.liveness.targetPitchDeg });
        }
        setPhaseBoth(res.frontalFramesRequired > 0 ? 'frontal' : res.liveness ? 'liveness' : 'completing');
        if (res.frontalFramesRequired <= 0 && !res.liveness) void complete();
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
  }, [check, ctrl]);

  /* ---------------------------------------------------------------- upload */
  const upload = useCallback(
    (
      step: number | 'frontal',
      face: Pick<FaceObservation, 'yaw' | 'pitch'> | null,
      api: CandidateApi,
      onDone: (res: CheckFrameResponse) => void,
      onFail?: () => void,
    ) => {
      const r = run.current;
      const c = r.check;
      if (!c) return;
      const capturedAt = ctrl.clock.now();
      r.lastCaptureAt = performance.now();
      r.inflight++;
      const p = (async () => {
        try {
          const jpeg = await captureJpeg(ctrl.camera.video, JPEG_QUALITY);
          if (!jpeg || r.cancelled) {
            onFail?.();
            return;
          }
          // Transient failures (network, server busy) are retried with the same image and timestamp.
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await api.uploadCheckFrame(c.checkId, jpeg, {
                step,
                capturedAt,
                nonce: c.liveness?.nonce ?? null,
                clientYaw: face && Number.isFinite(face.yaw) ? face.yaw : null,
                clientPitch: face && Number.isFinite(face.pitch) ? face.pitch : null,
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
                void completeRef.current();
                return;
              }
              if (kind === 'invalid_state' || kind === 'client' || kind === 'invalid_link' || kind === 'superseded') {
                // Challenge closed, too many frames, or frame refused: stop this attempt.
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
        }
      })();
      r.uploads.push(p);
    },
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
  }, [ctrl, onResult]);
  completeRef.current = complete;

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
    (a: FrameAnalysis) => {
      const r = run.current;
      const c = r.check;
      if (!c || r.cancelled || r.completing) return;
      const faces = plausibleFaces(a.faces);
      const face = faces.length === 1 ? faces[0] : null;
      const spacedOk = performance.now() - r.lastCaptureAt >= MIN_CAPTURE_SPACING_MS;

      if (r.phase === 'frontal') {
        if (!face) {
          setGuidance([faces.length > 1 ? 'Make sure only you are in view of the camera.' : 'We can’t see your face. Sit in front of the camera.']);
          return;
        }
        if (!isFrontal(face, r.centre)) {
          setGuidance(['Look straight at the screen.']);
          return;
        }
        if (r.inflight === 0 && spacedOk && r.frontalSent - r.frontalAccepted < 1 && r.frontalAccepted < c.frontalFramesRequired) {
          r.frontalSent++;
          upload('frontal', face, ctrl.api, (res) => {
            if (res.accepted) {
              r.frontalAccepted++;
              r.progress.accepted(performance.now());
              setFrontalCount(r.frontalAccepted);
              setGuidance([]);
              if (r.frontalAccepted >= c.frontalFramesRequired) {
                if (r.tracker) setPhaseBoth('liveness');
                else void complete();
              }
            } else {
              r.frontalSent = r.frontalAccepted; // allow another attempt
              setGuidance(res.guidance.length ? res.guidance : ['Please look straight at the camera and hold still.']);
              // The image keeps failing the quality gate (e.g. too dark): let the server record
              // "unable to verify" and return its guidance rather than retrying endlessly.
              if (r.progress.frontalRejected()) void complete();
            }
          }, () => {
            r.frontalSent = r.frontalAccepted;
          });
        }
        return;
      }

      if (r.phase === 'liveness' && r.tracker) {
        // The tracker measures each step relative to the centre pose it captures itself.
        const prog = r.tracker.update(face, faces.length, a.t);
        r.progress.liveness(prog.stepIndex, prog.progress ?? 0, performance.now());
        const steps: LivenessStep[] = c.liveness?.steps ?? [];
        const step = steps.find((s) => s.index === prog.stepIndex) ?? steps[Math.min(steps.length - 1, Math.max(0, prog.stepIndex))];
        setStepView({ index: prog.stepIndex, action: String(prog.action ?? step?.action ?? 'center'), message: prog.message || step?.instruction || '', progress: prog.progress ?? 0, problem: prog.problem ?? null });
        const doneSteps = steps.filter((s) => (r.perStep.get(s.index) ?? 0) >= FRAMES_PER_STEP).length;
        setStepsDone(doneSteps);
        if (prog.done) {
          if (r.inflight === 0) void complete();
          return;
        }
        if (face && prog.readyToCapture && spacedOk && r.inflight < 2) {
          const idx = prog.stepIndex;
          r.perStep.set(idx, (r.perStep.get(idx) ?? 0) + 1);
          r.tracker.markCaptured(a.t);
          r.progress.captured(performance.now());
          upload(idx, face, ctrl.api, (res) => {
            if (!res.accepted && res.guidance.length) setGuidance(res.guidance);
            else setGuidance([]);
          });
        }
      }
    },
    [ctrl, upload, complete],
  );

  const vs = useFrameAnalysis(phase === 'frontal' || phase === 'liveness', onFrame, 120);

  /* ---------------------------------------------------------------- fallback without in-browser analysis */
  // If the face model cannot run in this browser, pace the candidate with timed instructions and let
  // the server (which is authoritative anyway) verify the frames.
  const noVision = !vs.loading && !vs.vision?.face;
  useEffect(() => {
    if (!noVision || (phase !== 'frontal' && phase !== 'liveness')) return;
    const r = run.current;
    const steps = r.check?.liveness?.steps ?? [];
    let stepPos = 0;
    let stepStartedAt = performance.now();
    let shotsThisStep = 0;
    const id = setInterval(() => {
      const c = r.check;
      if (!c || r.cancelled || r.completing) return;
      if (r.phase === 'frontal') {
        setGuidance(['Look straight at the screen and hold still.']);
        if (r.inflight === 0 && r.frontalAccepted < c.frontalFramesRequired) {
          upload('frontal', null, ctrl.api, (res) => {
            if (res.accepted) {
              r.frontalAccepted++;
              r.progress.accepted(performance.now());
              setFrontalCount(r.frontalAccepted);
              if (r.frontalAccepted >= c.frontalFramesRequired) {
                stepStartedAt = performance.now();
                if (steps.length) setPhaseBoth('liveness');
                else void complete();
              }
            } else {
              setGuidance(res.guidance.length ? res.guidance : ['Please look straight at the camera and hold still.']);
              if (r.progress.frontalRejected()) void complete();
            }
          });
        }
        return;
      }
      const step = steps[stepPos];
      if (!step) {
        if (r.inflight === 0) void complete();
        return;
      }
      const elapsed = performance.now() - stepStartedAt;
      setStepView({ index: step.index, action: step.action, message: step.instruction, progress: Math.min(1, elapsed / 3000), problem: null });
      if (elapsed > 1800 + shotsThisStep * 900 && shotsThisStep < FRAMES_PER_STEP) {
        shotsThisStep++;
        r.perStep.set(step.index, shotsThisStep);
        r.progress.captured(performance.now());
        upload(step.index, null, ctrl.api, () => undefined);
      }
      if (shotsThisStep >= FRAMES_PER_STEP && elapsed > 3200) {
        stepPos++;
        shotsThisStep = 0;
        stepStartedAt = performance.now();
        setStepsDone(stepPos);
      }
    }, 300);
    return () => clearInterval(id);
  }, [noVision, phase, upload, complete, ctrl]);

  /* ---------------------------------------------------------------- render */
  const steps = check?.liveness?.steps ?? [];
  const totalUnits = (check?.frontalFramesRequired ?? 0) + steps.length;
  const doneUnits = Math.min(frontalCount, check?.frontalFramesRequired ?? 0) + stepsDone;
  const overall = totalUnits > 0 ? doneUnits / totalUnits : 0;

  let headline = 'Preparing the check…';
  let arrow: string | null = null;
  if (phase === 'frontal') headline = 'Look straight at the screen and hold still';
  if (phase === 'liveness' && stepView) {
    headline = stepView.message;
    arrow = ARROWS[stepView.action] ?? null;
  }
  if (phase === 'completing') headline = 'Checking…';

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
    <div className="stack" data-testid="verify-step" data-phase={phase}>
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
              <div className={`cand-arrow cand-arrow-${stepView?.action}`} aria-hidden="true">
                {arrow}
              </div>
            ) : null
          }
        />
        <div className="stack">
          {/* The current instruction as text, announced politely when it changes (the arrows are decorative). */}
          <div className="cand-instruction" role="status" aria-live="polite" aria-atomic="true" data-testid="verify-instruction">
            {arrow && <span className="cand-instruction-arrow" aria-hidden="true">{arrow}</span>}
            <span>{headline}</span>
          </div>
          {phase === 'liveness' && stepView && (
            <div className="cand-progress cand-progress-step" role="progressbar" aria-label="Current step" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(stepView.progress * 100)}>
              <div className="cand-progress-bar" style={{ width: `${Math.round(Math.min(1, stepView.progress) * 100)}%` }} />
            </div>
          )}
          <div className="cand-progress" role="progressbar" aria-label="Overall progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
            <div className="cand-progress-bar" style={{ width: `${Math.round(overall * 100)}%` }} />
          </div>
          {steps.length > 0 && (
            <ol className="cand-steps">
              <StepItem state={frontalCount >= (check?.frontalFramesRequired ?? 0) ? 'done' : phase === 'frontal' ? 'current' : ''}>Pictures of your face for the identity check</StepItem>
              {steps.map((s) => (
                <StepItem key={s.index} state={(run.current.perStep.get(s.index) ?? 0) >= FRAMES_PER_STEP ? 'done' : stepView?.index === s.index && phase === 'liveness' ? 'current' : ''}>
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
