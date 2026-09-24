import { EVENT_CATALOG, type Baseline, type DetectionPolicy, type EngineOutput, type EngineSignal, type EpisodeUpdate, type EventType, type FrameObservation, type MonitoringStatus } from '@sp/shared';
import { createBaselineCalibrator, type BaselineCalibrator } from '../baseline/calibrator';
import { defaultIdFactory } from '../util/id';
import { isFiniteNumber } from '../util/math';
import { attentionAngles, awayThresholds, countPersons, DEFAULT_BASELINE, directionOf, isAway, K, plausibleFaces, type DetectorHost, type TickContext } from './context';
import { EpisodeBook } from './episodes';
import { IdentityScheduler, type IdentitySchedule } from './identity';
import { ContinuityDetector, type ContinuityState } from './detectors/continuity';
import { PromptManager } from './prompts';
import type { FlushReason } from './span';
import { CameraStateDetector, CoveredDetector, DegradedDetector, FrozenDetector, LightingDetector } from './detectors/camera';
import { FeedDetector } from './detectors/feed';
import { GazeDetector } from './detectors/gaze';
import { MovementDetector } from './detectors/movement';
import { ObjectDetector } from './detectors/objects';
import { MultiplePeopleDetector, ObstructionDetector } from './detectors/people';
import { PresenceDetector } from './detectors/presence';

export interface EngineOptions {
  policy: DetectionPolicy;
  /** policy.identity.periodicCheckIntervalSec */
  identityIntervalSec: number;
  /** policy.identity.startupIntervalSec: faster routine samples during the start-up window (default: identityIntervalSec). */
  identityStartupIntervalSec?: number;
  /** policy.identity.startupWindowSec: start-up window from the first tick after creation / flush (default 0 = none). */
  identityStartupWindowSec?: number;
  /** policy.evidence */
  evidence?: { maxScreenshotsPerEvent: number; periodicScreenshotSec: number };
  baseline?: Baseline | null;
  /** default: crypto.randomUUID() */
  idFactory?: () => string;
  /**
   * After a camera change (setCameraInfo with a new deviceIdHash) the old baseline no longer describes
   * the candidate's normal position. When true (default) the engine re-calibrates from the next steady
   * frames and adopts that baseline unless the host calls setBaseline first.
   */
  recalibrateOnCameraChange?: boolean;
}

export interface MonitoringEngine {
  ingest(obs: FrameObservation): EngineOutput;
  setBaseline(b: Baseline): void;
  getBaseline(): Baseline | null;
  /** Host tells the engine about the active camera (label used for virtual-camera detection; id change => camera_changed marker + identity sample). */
  setCameraInfo(info: { label: string; deviceIdHash: string }, t: number): EngineOutput;
  /** Close all open episodes at time t (pause, submit, hold, stop). Returns the closing updates. */
  flush(t: number, reason: 'pause' | 'submit' | 'hold' | 'stop'): EngineOutput;
  status(): MonitoringStatus;
  /**
   * Server-driven cadence: the next routine identity sample is due `inMs` after `t` (null: back to the
   * policy interval). A trigger that is already waiting still goes first.
   */
  scheduleIdentitySample(inMs: number | null, t: number): void;
  /** The host took an identity sample of its own (exam start, server request, follow-up): restart the routine timer. */
  noteIdentitySample(t: number): void;
  /** Identity sampling state (for diagnostics): pending trigger, next routine due time. */
  identitySchedule(): IdentitySchedule;
  /** Swap-trigger diagnostics: latest appearance distance / threshold and the triggers fired. */
  continuityState(): ContinuityState;
}

/** Window for the internal throughput estimate when the host does not report obs.fps. */
const FPS_WINDOW_MS = 5000;

/**
 * Create the in-browser monitoring engine. Feed one FrameObservation per analysis tick (5–10 Hz faces,
 * ~1 Hz objects). While the camera is not live, keep calling ingest at ≥ 1 Hz with the camera state so
 * time-based transitions (disconnect, identity sampling) progress. Time comes only from obs.t.
 */
export function createMonitoringEngine(opts: EngineOptions): MonitoringEngine {
  const policy = opts.policy;
  const th = awayThresholds(policy);
  const evidence = opts.evidence ?? { maxScreenshotsPerEvent: 4, periodicScreenshotSec: 30 };
  const book = new EpisodeBook({
    idFactory: opts.idFactory ?? defaultIdFactory,
    mergeGapMs: policy.mergeGapSec * 1000,
    maxShots: Math.max(1, evidence.maxScreenshotsPerEvent),
    periodicShotMs: Math.max(1, evidence.periodicScreenshotSec) * 1000,
    minUpdateMs: K.minUpdateMs,
    peakSpacingMs: K.peakSpacingMs,
  });
  const host: DetectorHost = {
    policy,
    book,
    prompts: new PromptManager(),
    identity: new IdentityScheduler({
      intervalMs: Math.max(0, opts.identityIntervalSec) * 1000,
      startupIntervalMs: opts.identityStartupIntervalSec != null ? Math.max(0, opts.identityStartupIntervalSec) * 1000 : undefined,
      startupWindowMs: Math.max(0, opts.identityStartupWindowSec ?? 0) * 1000,
    }),
    episodes: [],
    signals: [],
  };
  const cameraState = new CameraStateDetector(host);
  const covered = new CoveredDetector(host);
  const frozen = new FrozenDetector(host);
  const lighting = new LightingDetector(host);
  const degraded = new DegradedDetector(host);
  const feed = new FeedDetector(host);
  const movement = new MovementDetector(host);
  const presence = new PresenceDetector(host, movement);
  const people = new MultiplePeopleDetector(host);
  const obstruction = new ObstructionDetector(host);
  const gaze = new GazeDetector(host);
  const objects = new ObjectDetector(host);
  const continuity = new ContinuityDetector(host);

  let baseline: Baseline | null = opts.baseline ?? null;
  let recalibrator: BaselineCalibrator | null = null;
  const recalibrate = opts.recalibrateOnCameraChange !== false;

  let lastT = -Infinity;
  let prevHash: string | null = null;
  let lastObjectsAt = -Infinity;
  let lastPersons: number | null = null;
  let lastPersonSeenAt = -Infinity;
  const tickTimes: number[] = [];
  let lastCtx: TickContext | null = null;
  let hasTicked = false;

  const integrityOn = () => policy.enabled.cameraIntegrity;

  function begin(): void {
    host.episodes = [];
    host.signals = [];
  }

  function output(): EngineOutput {
    return { episodes: host.episodes, signals: host.signals, status: status() };
  }

  function estimateFps(t: number, reported: number | undefined): number {
    tickTimes.push(t);
    while (tickTimes.length > 0 && tickTimes[0] < t - FPS_WINDOW_MS) tickTimes.shift();
    if (isFiniteNumber(reported) && reported >= 0) return reported;
    if (tickTimes.length < 2) return Infinity;
    const span = tickTimes[tickTimes.length - 1] - tickTimes[0];
    // Also account for a long silence before this tick (throttled tab).
    const gap = tickTimes.length >= 2 ? t - tickTimes[tickTimes.length - 2] : 0;
    const est = span > 0 ? ((tickTimes.length - 1) * 1000) / span : Infinity;
    return gap > 0 ? Math.min(est, 1000 / gap) : est;
  }

  function buildContext(obs: FrameObservation): TickContext {
    const t = obs.t;
    const live = obs.camera === 'live';
    const frame = live && obs.frame && isFiniteNumber(obs.frame.luma) ? obs.frame : null;
    const faces = live ? plausibleFaces(obs.faces) : [];
    const primary = faces[0] ?? null;
    const b = baseline ?? DEFAULT_BASELINE;
    const covered = !!frame && ((frame.luma < K.coveredLuma && frame.contrast < K.coveredContrast) || frame.contrast < K.uniformContrast);
    const frameDark = !!frame && !covered && frame.luma < K.darkLuma;
    const frameBright = !!frame && !covered && frame.luma > K.brightLuma;
    const fb = primary?.brightness;
    const faceDark = !!frame && !covered && isFiniteNumber(fb) && fb < K.faceDark;
    const faceBright = !!frame && !covered && isFiniteNumber(fb) && fb > K.faceBright;
    const frozenRaw = !!frame && frame.diffFromPrev != null && frame.diffFromPrev < K.frozenDiff && prevHash !== null && frame.dhash === prevHash;
    const objectsRan = live && Array.isArray(obs.objects);
    let persons: number | null = null;
    if (objectsRan && obs.objects) {
      persons = countPersons(obs.objects, policy.objectMinConfidence);
      lastObjectsAt = t;
      lastPersons = persons;
      if (persons > 0) lastPersonSeenAt = t;
    }
    const personsFresh = t - lastObjectsAt <= K.personCountFreshMs ? lastPersons : null;
    const personVisible = t - lastPersonSeenAt <= K.personVisibleFreshMs;
    const primaryAssessable = !!primary && !primary.cutOff && (isFiniteNumber(primary.visibility) ? primary.visibility : 1) >= K.assessableVisibility;
    let h = 0;
    let v = 0;
    let yawOff = 0;
    let pitchOff = 0;
    let away: boolean | null = null;
    let direction = null as TickContext['direction'];
    if (primary) {
      ({ h, v, yawOff, pitchOff } = attentionAngles(primary, b));
      away = isAway(h, v, th);
      if (away) direction = directionOf(h, v, th);
    }
    return {
      t,
      obs,
      camera: obs.camera,
      live,
      frame,
      covered,
      frameDark,
      frameBright,
      faceDark,
      faceBright,
      lightingBad: frameDark || frameBright || faceDark || faceBright,
      frozenRaw,
      frozenActive: false,
      visionOk: false,
      faces,
      faceCount: faces.length,
      primary,
      primaryAssessable,
      objectsRan,
      objects: objectsRan ? obs.objects : null,
      persons,
      personsFresh,
      personVisible,
      h,
      v,
      yawOff,
      pitchOff,
      away,
      direction,
      baseline: b,
      fps: estimateFps(t, obs.fps),
    };
  }

  function ingest(obs: FrameObservation): EngineOutput {
    begin();
    if (!obs || !isFiniteNumber(obs.t) || obs.t <= lastT) return output();
    const t = obs.t;
    lastT = t;
    hasTicked = true;
    const ctx = buildContext(obs);

    // Camera availability first: a restart invalidates frame-to-frame state.
    const restarted = integrityOn() ? cameraState.step(ctx) : false;
    if (restarted) {
      prevHash = null;
      ctx.frozenRaw = false;
      frozen.reset();
      feed.clearHistory(t);
    }
    if (integrityOn()) {
      covered.step(ctx);
      frozen.step(ctx);
      lighting.step(ctx);
    }
    ctx.frozenActive = frozen.active;
    ctx.visionOk = ctx.live && ctx.frame !== null && !ctx.covered && !ctx.frozenActive;

    if (recalibrator) {
      recalibrator.add(obs);
      if (recalibrator.ready()) {
        const r = recalibrator.result();
        if (r) baseline = r;
        recalibrator = null;
      }
    }

    presence.step(ctx);
    people.step(ctx);
    obstruction.step(ctx);
    gaze.step(ctx);
    movement.step(ctx);
    objects.step(ctx);
    if (integrityOn()) {
      feed.step(ctx);
      degraded.step(ctx);
    }

    continuity.step(ctx);
    host.identity.step(t, identitySampleable(ctx), host.signals);

    if (ctx.frame) prevHash = ctx.frame.dhash;
    else if (!ctx.live) prevHash = null;
    lastCtx = ctx;
    return output();
  }

  function setCameraInfo(info: { label: string; deviceIdHash: string }, t: number): EngineOutput {
    begin();
    const prev = feed.camera;
    const changed = feed.setCamera({ label: String(info?.label ?? ''), deviceIdHash: String(info?.deviceIdHash ?? '') }, t);
    if (changed) {
      host.episodes.push(
        book.marker('camera_changed', t, {
          confidence: 1,
          details: { previousLabel: prev.label.slice(0, 120), label: String(info.label ?? '').slice(0, 120), previousDeviceIdHash: prev.deviceIdHash, deviceIdHash: info.deviceIdHash },
          observation: `The camera changed from “${prev.label.slice(0, 80) || 'unknown camera'}” to “${String(info.label ?? '').slice(0, 80) || 'unknown camera'}”.`,
        }),
      );
      host.identity.arm('camera_reconnect');
      // A different camera looks different: start a fresh track / appearance baseline (camera_reconnect covers it).
      continuity.reset();
      prevHash = null;
      frozen.reset();
      if (recalibrate) recalibrator = createBaselineCalibrator();
    }
    return output();
  }

  function flush(t: number, reason: FlushReason): EngineOutput {
    begin();
    const at = isFiniteNumber(t) ? Math.max(t, Number.isFinite(lastT) ? lastT : t) : lastT;
    presence.flush(at, reason);
    people.flush(at, reason);
    obstruction.flush(at, reason);
    gaze.flush(at, reason);
    movement.flush(at, reason);
    objects.flush(at, reason);
    covered.flush(at, reason);
    frozen.flush(at, reason);
    lighting.flush(at, reason);
    degraded.flush(at, reason);
    cameraState.flush(at, reason);
    feed.flush(at, reason);
    host.prompts.clearAll(host.signals);
    host.identity.reset();
    continuity.reset();
    book.forgetClosed();
    prevHash = null;
    lastObjectsAt = -Infinity;
    lastPersons = null;
    lastPersonSeenAt = -Infinity;
    tickTimes.length = 0;
    lastCtx = null;
    hasTicked = false;
    return output();
  }

  function status(): MonitoringStatus {
    const open = book.openTypes();
    const ctx = lastCtx;
    const faces = ctx ? ctx.faceCount : 0;
    const lookDirection = ctx && ctx.visionOk && ctx.primaryAssessable && ctx.away ? ctx.direction : null;
    if (!ctx || !hasTicked) return { state: 'off', faces: 0, label: 'Monitoring not running', open, lookDirection: null };
    const t = ctx.t;
    if (!ctx.live) return { state: 'off', faces: 0, label: cameraState.label(t) ?? 'Camera not available', open, lookDirection: null };
    const integrityOpen = open.some((type) => EVENT_CATALOG[type].category === 'integrity');
    const label = describeStatus(ctx, open);
    if (integrityOpen) return { state: 'attention', faces, label, open, lookDirection };
    const degradedNow = open.includes('monitoring_degraded') || open.includes('lighting_unusable') || open.includes('camera_frozen') || ctx.fps < K.lowFps;
    if (degradedNow) return { state: 'degraded', faces, label, open, lookDirection };
    return { state: 'ok', faces, label, open, lookDirection };
  }

  function describeStatus(ctx: TickContext, open: EventType[]): string {
    const has = (x: EventType) => open.includes(x);
    if (has('camera_covered') || (ctx.covered && covered.span.deb.runDuration(ctx.t) >= 2000)) return 'Camera view blocked';
    if (has('camera_frozen')) return 'Camera image frozen';
    if (has('camera_feed_suspect')) return 'Camera feed may be substituted';
    if (ctx.faceCount >= 2 || has('multiple_people')) return `${Math.max(2, ctx.faceCount, ctx.personsFresh ?? 0)} people in view`;
    if (presence.isAbsent && presence.absentFor >= 2000) return `No face visible (${Math.round(presence.absentFor / 1000)} s)`;
    if (has('phone_detected')) return 'Phone visible';
    if (has('unauthorized_object')) return `Object in view (${objects.openLabels().join(', ') || 'device'})`;
    if (has('face_obstructed')) return 'Face partly hidden or cut off';
    if (has('lighting_unusable')) return lighting.condition() === 'too_bright' ? 'Image too bright to monitor' : 'Image too dark to monitor';
    if (has('looking_away')) return `Looking away${ctx.direction ? ` (${ctx.direction.replace('_', '-')})` : ''}`;
    if (has('offscreen_attention_pattern') || has('repeated_looking_away')) return 'Repeatedly looking away';
    if (has('unusual_movement')) return 'Unusual movement';
    if (has('monitoring_degraded') || ctx.fps < K.lowFps) return `Monitoring slow (${Number.isFinite(ctx.fps) ? ctx.fps.toFixed(1) : '?'} fps)`;
    if (ctx.faceCount === 1) return 'Candidate in view';
    return 'No face visible';
  }

  return {
    ingest,
    setBaseline(b: Baseline) {
      if (!b || ![b.yaw, b.pitch, b.cx, b.cy, b.faceWidth].every(isFiniteNumber)) return;
      baseline = { ...b };
      recalibrator = null;
    },
    getBaseline: () => (baseline ? { ...baseline } : null),
    setCameraInfo,
    flush,
    status,
    scheduleIdentitySample(inMs: number | null, t: number) {
      host.identity.scheduleNext(inMs != null && isFiniteNumber(inMs) && isFiniteNumber(t) ? t + Math.max(0, inMs) : null);
    },
    noteIdentitySample(t: number) {
      if (isFiniteNumber(t)) host.identity.noteSample(t);
    },
    identitySchedule: () => host.identity.schedule(),
    continuityState: () => continuity.state(),
  };
}

/**
 * A frame the host may capture for a server-side identity comparison: exactly one face, not cut off, not
 * badly obstructed, roughly frontal relative to the candidate's baseline. Deliberately NOT gated on
 * lighting, contrast, sharpness or an open lighting_unusable / camera_frozen episode: the server judges
 * image usability ("unable to verify" with guidance), and a dim room must never silence identity sampling.
 */
export function identitySampleable(ctx: TickContext): boolean {
  const f = ctx.primary;
  if (!ctx.live || !ctx.frame || ctx.covered || ctx.faceCount !== 1 || !f) return false;
  if (f.cutOff) return false;
  if (isFiniteNumber(f.visibility) && f.visibility < K.identityMinVisibility) return false;
  return Math.abs(ctx.yawOff) <= K.identityMaxYawOffset && Math.abs(ctx.pitchOff) <= K.identityMaxPitchOffset;
}

export type { EngineSignal, EpisodeUpdate };
