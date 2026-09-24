import {
  compareEnvironment,
  createBrowserSignalTracker,
  createMonitoringEngine,
  createFrameMetricsTracker,
  facesFromMediapipe,
  objectsFromMediapipe,
  type ContinuityFire,
} from '@sp/detection';
import type {
  Baseline,
  CameraState,
  EngineOutput,
  EngineSignal,
  EpisodeUpdate,
  EventUpsert,
  FaceObservation,
  FrameObservation,
  HeartbeatRequest,
  IdentityCheckTrigger,
  IdentitySampleRequestDTO,
  IdentitySampleResponse,
  MonitoringStatus,
  ProctoringPolicy,
} from '@sp/shared';
import { classifyApiError, isServerBusy, uuid, type CandidateApi } from '../api';
import type { ClockSync } from '../clock';
import type { Outbox } from '../outbox';
import type { CameraManager, CameraSnapshot } from './camera';
import { AnalysisFrame, captureFaceCrop, captureJpeg, GraySampler, HeldFrame, sameFrame } from './frames';
import { BurstSampler, burstEligible, SUSPECT_INTERVAL_MS, type BurstResult } from './sampler';
import type { TraceRecorder } from './trace';
import { loadVision, type Vision } from './vision';

export { SAMPLE_PRIORITY, SampleTriggerQueue } from './sampler';

/**
 * Monitoring runtime — runs only while the session is active on a verified instance.
 *
 *   camera ─► 5 Hz loop ─► FrameObservation ─► engine.ingest ─► episodes ─► outbox (events + evidence)
 *                                                       └──► signals ─► identity samples / candidate prompts
 *   DOM (visibility, focus, fullscreen, clipboard, displays) ─► browser signal tracker ─► outbox
 *
 * Nothing here blocks the exam: model or camera failures degrade monitoring and are reported as
 * technical events.
 */

export const LOOP_INTERVAL_MS = 200; // ~5 Hz
export const OBJECT_INTERVAL_MS = 1000; // ~1 Hz object detection
/** The engine needs time to progress even when no new frame arrives (camera off / stalled). */
export const MIN_INGEST_INTERVAL_MS = 1000;
const FPS_WINDOW_MS = 5000;
const OBSERVATION_MAX = 500;

export interface RuntimeDeps {
  api: CandidateApi;
  outbox: Outbox;
  camera: CameraManager;
  clock: ClockSync;
  policy: ProctoringPolicy;
  instanceId: string;
  baseline: Baseline | null;
  /** Previous period's baseline to compare the environment with (after resume / reconnect). */
  previousBaseline?: Baseline | null;
  trace?: TraceRecorder | null;
  onSignal?: (s: Extract<EngineSignal, { kind: 'candidate_prompt' | 'candidate_prompt_clear' }>) => void;
  onStatus?: (s: MonitoringStatus) => void;
  /** The server put the session on hold (from an identity sample response). */
  onHold?: () => void;
  onFatal?: (kind: 'invalid_link' | 'superseded') => void;
  /** Diagnostics for the candidate debug overlay (?debug=1): a sample burst finished, a trigger fired. */
  onDebug?: (e: RuntimeDebugEvent) => void;
}

export type RuntimeDebugEvent =
  | { kind: 'burst'; result: BurstResult }
  | { kind: 'trigger'; at: number; trigger: IdentityCheckTrigger; source: 'engine' | 'host' | 'server'; reason?: string };

/** Live diagnostics of the monitoring runtime (debug overlay). */
export interface RuntimeDebug {
  cameraWidth: number;
  cameraHeight: number;
  analysisWidth: number;
  analysisHeight: number;
  fps: number;
  faces: number;
  /** ms until the next routine identity sample (null if unknown). */
  nextSampleInMs: number | null;
  /** Trigger waiting for a usable face / budget, or being captured. */
  pendingTrigger: IdentityCheckTrigger | null;
  burstActive: boolean;
  /** Appearance distance to the rolling baseline and the current threshold. */
  appearance: { distance: number; threshold: number; baselineFrames: number };
  /** Swap triggers the engine fired (with the reason: gap / count / jump / appearance). */
  swapTriggers: ContinuityFire[];
  lastBurst: BurstResult | null;
  budgetLeft: number;
}

export function episodeToUpsert(ep: EpisodeUpdate, instanceId: string): EventUpsert {
  return {
    id: ep.episodeId,
    type: ep.type,
    phase: ep.phase,
    startedAt: Math.round(ep.startedAt),
    endedAt: ep.endedAt == null ? null : Math.round(ep.endedAt),
    confidence: Math.max(0, Math.min(1, Number.isFinite(ep.confidence) ? ep.confidence : 0)),
    observation: ep.observation ? ep.observation.slice(0, OBSERVATION_MAX) : undefined,
    details: ep.details ?? {},
    version: ep.version,
    clientInstanceId: instanceId,
  };
}

type Engine = ReturnType<typeof createMonitoringEngine>;

/** Identity-sample triggers that come from the host or the server rather than from the engine. */
const HOST_TRIGGERS: ReadonlySet<IdentityCheckTrigger> = new Set(['exam_start', 'follow_up', 'server_request']);

/** Maps a host stop reason onto the engine's flush reasons. */
export function toFlushReason(reason: string): 'pause' | 'submit' | 'hold' | 'stop' {
  if (reason === 'pause' || reason === 'paused') return 'pause';
  if (reason === 'submit' || reason === 'submitted' || reason === 'terminated') return 'submit';
  if (reason === 'hold' || reason === 'on_hold') return 'hold';
  return 'stop';
}
type Tracker = ReturnType<typeof createBrowserSignalTracker>;

export class MonitoringRuntime {
  private engine: Engine;
  private tracker: Tracker;
  private vision: Vision | null = null;
  private readonly gray = new GraySampler();
  private readonly analysis = new AnalysisFrame();
  private readonly held = new HeldFrame();
  private readonly metrics = createFrameMetricsTracker();
  private readonly bursts: BurstSampler;
  private lastFaces = 0;
  private running = false;
  private stopped = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastGray: Uint8Array | null = null;
  private lastIngestAt = 0;
  private lastObjectsAt = 0;
  private readonly frameTimes: number[] = [];
  private lastStatus: MonitoringStatus = { state: 'off', faces: 0, label: 'Monitoring starting', open: [] };
  private cameraGeneration = -1;
  private unsubCamera: (() => void) | null = null;
  private degraded: { id: string; version: number; startedAt: number; reason: string } | null = null;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  /** Label of the next routine burst: 'server_request' while the server's evidence is not clear yet. */
  private routineLabel: 'periodic' | 'server_request' = 'periodic';
  private readonly removers: (() => void)[] = [];
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(private readonly deps: RuntimeDeps) {
    const p = deps.policy;
    this.engine = createMonitoringEngine({
      policy: p.detection,
      identityIntervalSec: p.identity.periodicCheckIntervalSec,
      identityStartupIntervalSec: p.identity.startupIntervalSec,
      identityStartupWindowSec: p.identity.startupWindowSec,
      evidence: p.evidence,
      baseline: deps.baseline ?? undefined,
      idFactory: uuid,
    });
    this.tracker = createBrowserSignalTracker(p.browser);
    this.bursts = new BurstSampler({
      burstSize: p.identity.burstSize ?? 3,
      uuid,
      now: () => this.now(),
      mono: () => performance.now(),
      send: (f, q) => this.deps.api.identitySample(f.sampleId, f.jpeg, q),
      onSendFailed: (f, q, e) => this.sampleSendFailed(f, q, e),
      onResponse: (res, final) => this.handleSampleResult(res, final),
      onBurstStart: (trigger) => {
        // The engine restarts its routine timer for its own triggers; host / server ones restart it here.
        if (HOST_TRIGGERS.has(trigger)) this.engine.noteIdentitySample(this.now());
      },
      onBurstDone: (r) => this.deps.onDebug?.({ kind: 'burst', result: r }),
      onTrigger: (e) => this.deps.onDebug?.({ kind: 'trigger', ...e }),
    });
  }

  /**
   * A server request for an identity burst (exam start, faster sample while the evidence is suspect), from
   * the session state or a heartbeat. Deduplicated with the runtime's own triggers.
   */
  serverSampleRequest(req: IdentitySampleRequestDTO | null | undefined): void {
    if (!req) return;
    this.bursts.serverRequest(req);
    this.pumpSamples();
  }

  /** Diagnostics for the debug overlay. */
  debug(): RuntimeDebug {
    const v = this.deps.camera.video;
    const sched = this.engine.identitySchedule();
    const cont = this.engine.continuityState();
    const now = this.now();
    const canvas = this.analysis.canvas;
    return {
      cameraWidth: v?.videoWidth ?? 0,
      cameraHeight: v?.videoHeight ?? 0,
      analysisWidth: canvas?.width ?? 0,
      analysisHeight: canvas?.height ?? 0,
      fps: Math.round(this.fps() * 10) / 10,
      faces: this.lastFaces,
      nextSampleInMs: sched.nextDueAt != null ? Math.max(0, sched.nextDueAt - now) : null,
      pendingTrigger: this.bursts.pendingTrigger() ?? sched.pending,
      burstActive: this.bursts.busy,
      appearance: { distance: cont.patchDistance, threshold: cont.patchThreshold, baselineFrames: cont.baselineFrames },
      swapTriggers: cont.fired,
      lastBurst: this.bursts.last,
      budgetLeft: this.bursts.budget.available(performance.now()),
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  now(): number {
    return this.deps.clock.now();
  }

  status(): MonitoringStatus {
    return this.lastStatus;
  }

  /** Heartbeat payload. */
  heartbeatMonitoring(): HeartbeatRequest['monitoring'] {
    const s = this.lastStatus;
    return {
      state: s.state,
      faces: Math.max(0, Math.round(s.faces)),
      label: (s.label ?? '').slice(0, 200),
      open: (s.open ?? []).slice(0, 50),
      fps: Math.round(this.fps() * 10) / 10,
      cameraState: this.deps.camera.state.state,
    };
  }

  async start(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const t = this.now();
    // Thresholds are relative to the candidate's normal position measured at this period's check.
    if (this.deps.baseline) {
      this.engine.setBaseline(this.deps.baseline);
      this.deps.trace?.baseline(this.deps.baseline);
    }
    this.deps.trace?.marker(t, 'monitoring_start');

    // Environment comparison after resume (neutral context — never evidence of a person change).
    if (this.deps.previousBaseline && this.deps.baseline) {
      try {
        const cmp = compareEnvironment(this.deps.previousBaseline, this.deps.baseline);
        if (cmp.changed) {
          await this.deps.outbox.putEvent({
            id: uuid(),
            type: 'environment_changed',
            phase: 'close',
            startedAt: Math.round(t),
            endedAt: Math.round(t),
            confidence: 1,
            observation: cmp.notes.length ? cmp.notes.join(' ').slice(0, OBSERVATION_MAX) : undefined,
            details: { notes: cmp.notes, ...(cmp.details ?? {}) },
            version: 1,
            clientInstanceId: this.deps.instanceId,
          });
        }
      } catch (e) {
        console.warn('[monitoring] environment comparison failed', e);
      }
    }

    this.attachBrowserSignals();
    // Identity continuity matters most right after the exam starts / resumes / reconnects: sample at once.
    // (The server may ask for the same via CandidateSessionState.session.identitySample — deduplicated.)
    this.bursts.request('exam_start', 'host');
    this.unsubCamera = this.deps.camera.subscribe((s) => this.onCamera(s));
    if (!this.deps.camera.state.wanted) void this.deps.camera.start();
    this.onCamera(this.deps.camera.state);

    try {
      this.vision = await loadVision();
    } catch (e) {
      this.vision = null;
      await this.reportDegraded(`vision models failed to load: ${(e as Error)?.message ?? e}`);
    }
    if (!this.running) return;
    if (this.vision && !this.vision.face) await this.reportDegraded(this.vision.faceError ?? 'face model unavailable');
    else if (this.vision && !this.vision.objects) await this.reportDegraded(this.vision.objectsError ?? 'object model unavailable', 'objects');
    this.scheduleLoop(0);
  }

  /* ------------------------------------------------------------------ camera */

  private onCamera(s: CameraSnapshot): void {
    if (!this.running) return;
    if (s.info && s.generation !== this.cameraGeneration && s.state === 'live') {
      this.cameraGeneration = s.generation;
      this.metrics.reset();
      this.lastGray = null;
      const t = this.now();
      this.deps.trace?.camera(t, s.info.label, s.info.deviceIdHash);
      try {
        void this.handleOutput(this.engine.setCameraInfo({ label: s.info.label, deviceIdHash: s.info.deviceIdHash }, t));
      } catch (e) {
        console.warn('[monitoring] setCameraInfo failed', e);
      }
    }
  }

  /* ------------------------------------------------------------------ loop */

  private scheduleLoop(delay: number): void {
    if (!this.running) return;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      const t0 = performance.now();
      try {
        this.step();
      } catch (e) {
        console.warn('[monitoring] tick failed', e);
      }
      const spent = performance.now() - t0;
      this.scheduleLoop(Math.max(10, LOOP_INTERVAL_MS - spent));
    }, delay);
  }

  private fps(): number {
    const now = performance.now();
    while (this.frameTimes.length && now - this.frameTimes[0] > FPS_WINDOW_MS) this.frameTimes.shift();
    if (this.frameTimes.length < 2) return this.frameTimes.length;
    const span = (now - this.frameTimes[0]) / 1000;
    return span > 0 ? this.frameTimes.length / Math.max(span, 1) : 0;
  }

  private step(): void {
    const t = this.now();
    const nowMs = performance.now();
    const cam = this.deps.camera;
    const camState: CameraState = cam.state.state;
    const video = cam.video;

    // Browser signal tracker runs regardless of the camera.
    this.pushEpisodes(this.tracker.tick(t));
    this.bursts.tick();

    const stale = nowMs - this.lastIngestAt >= MIN_INGEST_INTERVAL_MS;
    let obs: FrameObservation | null = null;
    // While a burst is collecting, hold the full-resolution frame so the analysed frame and the uploaded
    // face crop are the same camera frame.
    const bursting = this.bursts.busy || this.bursts.pendingTrigger() !== null;
    let source: HTMLVideoElement | HTMLCanvasElement | null = null;
    if (camState === 'live' && this.vision?.face) {
      source = cam.isVideoReady() ? (bursting ? this.held.capture(video) : video) : null;
      const gray = source ? this.gray.sample(source) : null;
      if (gray && source) {
        // Never analyse the same camera frame twice (it would look frozen) — unless no new frame has
        // arrived for a while, which genuinely is a frozen feed.
        if (sameFrame(gray.data, this.lastGray) && !stale) return;
        this.lastGray = gray.data;
        // MediaPipe runs on a downscaled copy (≤ 640 px, aspect kept: normalised boxes map to the full frame).
        const small = this.analysis.draw(source);
        const size = small ? { width: small.width, height: small.height } : { width: video.videoWidth, height: video.videoHeight };
        const faceRes = small ? this.vision.detectFaces(small) : null;
        if (faceRes && small) {
          const frame = this.metrics.next(gray.data, gray.width, gray.height);
          const faces = facesFromMediapipe(faceRes, gray, size, { descriptors: true });
          let objects: FrameObservation['objects'] = null;
          if (this.vision.objects && nowMs - this.lastObjectsAt >= OBJECT_INTERVAL_MS) {
            this.lastObjectsAt = nowMs;
            const objRes = this.vision.detectObjects(small);
            if (objRes) objects = objectsFromMediapipe(objRes, size.width, size.height);
          }
          this.frameTimes.push(nowMs);
          this.lastFaces = faces.length;
          obs = { t, camera: 'live', frame, faces, objects, fps: Math.round(this.fps() * 10) / 10 };
        }
      }
      // No decodable frame yet (or the detector hiccuped): keep time moving at >= 1 Hz without a frame.
      if (!obs && stale) obs = { t, camera: 'live', frame: null, faces: [], objects: null, fps: Math.round(this.fps() * 10) / 10 };
    } else if (camState !== 'live') {
      // Camera off / muted / no permission: report the state every tick so disconnects are timed.
      obs = { t, camera: camState, frame: null, faces: [], objects: null, fps: 0 };
    } else if (cam.isVideoReady()) {
      // Camera analysis unavailable in this browser (degraded monitoring): identity samples still go to the
      // server — full frames (no face box), at the routine interval and whenever the server asks.
      this.sampleWithoutVision(video, nowMs);
    }
    if (!obs) return;
    this.lastIngestAt = nowMs;
    this.deps.trace?.observation(stripDescriptors(obs));
    let out: EngineOutput;
    try {
      out = this.engine.ingest(obs);
    } catch (e) {
      console.warn('[monitoring] engine.ingest failed', e);
      return;
    }
    void this.handleOutput(out);
    // Identity bursts ride on analysed frames: each burst frame is a new camera frame with exactly one usable face.
    if (obs.frame && source) this.offerBurstFrame(source, obs.faces, t);
  }

  /** Routine timer for sampling without in-browser analysis (null until the first such tick). */
  private lastNoVisionRoutineAt: number | null = null;

  private sampleWithoutVision(video: HTMLVideoElement, nowMs: number): void {
    const iv = Math.max(5, this.deps.policy.identity.periodicCheckIntervalSec) * 1000;
    if (this.lastNoVisionRoutineAt === null) this.lastNoVisionRoutineAt = nowMs; // the exam-start burst comes first
    else if (nowMs - this.lastNoVisionRoutineAt >= iv) {
      this.lastNoVisionRoutineAt = nowMs;
      this.requestSample('periodic', 'host');
    }
    if (this.bursts.wantsFrame(true)) void this.bursts.addFrame(captureFaceCrop(video, null).then((c) => c?.blob ?? null), this.now());
  }

  private offerBurstFrame(source: HTMLVideoElement | HTMLCanvasElement, faces: FaceObservation[], t: number): void {
    const one = burstEligible(faces);
    if (!this.bursts.wantsFrame(!!one && this.deps.camera.isVideoReady())) return;
    const crop = captureFaceCrop(source, one!.box).then((c) => c?.blob ?? null);
    void this.bursts.addFrame(crop, t);
  }

  private async handleOutput(out: EngineOutput | null | undefined): Promise<void> {
    if (!out) return;
    if (out.status) {
      this.lastStatus = this.vision && !this.vision.face ? { ...out.status, state: 'degraded', label: 'Camera analysis unavailable' } : out.status;
      this.deps.onStatus?.(this.lastStatus);
    }
    this.pushEpisodes(out.episodes ?? []);
    for (const s of out.signals ?? []) {
      // A routine sample due on the server's schedule is its request while the evidence is not clear yet.
      if (s.kind === 'identity_sample') this.requestSample(s.trigger === 'periodic' ? this.routineLabel : s.trigger, 'engine');
      else this.deps.onSignal?.(s);
    }
  }

  private pushEpisodes(eps: EpisodeUpdate[]): void {
    for (const ep of eps) {
      this.deps.trace?.episode(ep);
      // Start the snapshot synchronously so it shows the moment of the observation.
      const wantShot = !!ep.captureSnapshot && this.deps.policy.evidence.screenshots && this.deps.camera.isVideoReady();
      const shot = wantShot ? captureJpeg(this.deps.camera.video, 0.7) : null;
      const capturedAt = this.now();
      const write = (async () => {
        try {
          await this.deps.outbox.putEvent(episodeToUpsert(ep, this.deps.instanceId));
          const blob = shot ? await shot : null;
          if (blob) await this.deps.outbox.putEvidence({ id: uuid(), eventId: ep.episodeId, capturedAt, reason: ep.captureSnapshot ?? 'onset', jpeg: blob });
        } catch (e) {
          console.warn('[monitoring] failed to queue episode', e);
        }
      })();
      this.pendingWrites.add(write);
      void write.finally(() => this.pendingWrites.delete(write));
    }
  }

  /* ------------------------------------------------------------------ identity samples */

  /** Queue an identity sample; the burst is captured on the next analysed frames with one usable face. */
  private requestSample(trigger: IdentityCheckTrigger, source: 'engine' | 'host' | 'server' = 'engine'): void {
    this.bursts.request(trigger, source);
  }

  /** Nothing to pump: bursts start on analysed frames (kept for callers). */
  private pumpSamples(): void {
    /* bursts are driven by the analysis loop (offerBurstFrame) */
  }

  /** A burst frame could not be sent directly: keep it for later delivery with its original timestamp. */
  private async sampleSendFailed(
    f: { sampleId: string; capturedAt: number; jpeg: Blob },
    q: { trigger: IdentityCheckTrigger; burstId?: string; burstIndex?: number; burstSize?: number },
    e: unknown,
  ): Promise<'queued' | 'dropped' | 'fatal'> {
    const kind = classifyApiError(e);
    if (kind === 'invalid_link' || kind === 'superseded') {
      this.deps.onFatal?.(kind);
      return 'fatal';
    }
    if (kind === 'client' || kind === 'invalid_state') return 'dropped'; // refused in this state / unusable — nothing to retry
    // Offline or server trouble: keep it for later delivery. A busy server (vision queue full) is told apart:
    // the sample waits, and that is not a reporting outage.
    try {
      await this.deps.outbox.putSample({ id: f.sampleId, trigger: q.trigger, capturedAt: f.capturedAt, jpeg: f.jpeg, busy: isServerBusy(e), burstId: q.burstId, burstIndex: q.burstIndex, burstSize: q.burstSize });
    } catch (err) {
      console.warn('[monitoring] failed to queue identity sample', err);
    }
    return 'queued';
  }

  /**
   * Server's answer to an identity sample (direct or delivered later from the outbox). Only the final frame of
   * a burst carries the burst decision and the cadence (`final`); any frame may report a hold.
   */
  handleSampleResult(res: IdentitySampleResponse, final = true): void {
    if (res.status === 'on_hold' || res.hold) {
      this.deps.onHold?.();
      return;
    }
    if (!final) return;
    const r = res.result;
    if (r?.decision === 'unable_to_verify' && r.guidance?.length) {
      // Non-blocking guidance: the image was not usable for a dependable comparison.
      this.deps.onSignal?.({
        kind: 'candidate_prompt',
        key: 'identity_guidance',
        severity: 'info',
        message: `We couldn’t confirm your identity from the camera image. ${r.guidance.join(' ')}`,
      });
    } else if (r?.decision === 'match') {
      this.deps.onSignal?.({ kind: 'candidate_prompt_clear', key: 'identity_guidance' });
    }
    if (!this.running) return;
    const c = routineCadence(res);
    this.routineLabel = c.label;
    // A routine sample requested while this answer was on its way is superseded by the server's new schedule.
    if (c.inMs != null) this.bursts.dropPending('periodic');
    try {
      this.engine.scheduleIdentitySample(c.inMs, this.now());
    } catch (e) {
      console.warn('[monitoring] scheduleIdentitySample failed', e);
    }
    if (c.followUpInMs != null) {
      // An older server (no nextSampleInMs): its follow-up sample, as before.
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = null;
        this.requestSample('follow_up', 'server');
      }, Math.max(500, c.followUpInMs));
    }
  }

  /* ------------------------------------------------------------------ degraded */

  private async reportDegraded(reason: string, component: 'faces' | 'objects' = 'faces'): Promise<void> {
    if (this.degraded) return;
    const t = this.now();
    this.degraded = { id: uuid(), version: 1, startedAt: t, reason };
    console.warn('[monitoring] degraded:', reason);
    await this.deps.outbox.putEvent({
      id: this.degraded.id,
      type: 'monitoring_degraded',
      phase: 'open',
      startedAt: Math.round(t),
      endedAt: null,
      confidence: 1,
      observation: component === 'faces' ? 'Camera analysis could not start in the candidate’s browser.' : 'Object detection could not start in the candidate’s browser.',
      details: { reason, component },
      version: 1,
      clientInstanceId: this.deps.instanceId,
    });
    if (component === 'faces') {
      this.lastStatus = { state: 'degraded', faces: 0, label: 'Camera analysis unavailable', open: ['monitoring_degraded'] };
      this.deps.onStatus?.(this.lastStatus);
    }
  }

  private async closeDegraded(t: number): Promise<void> {
    if (!this.degraded) return;
    const d = this.degraded;
    this.degraded = null;
    await this.deps.outbox.putEvent({
      id: d.id,
      type: 'monitoring_degraded',
      phase: 'close',
      startedAt: Math.round(d.startedAt),
      endedAt: Math.round(Math.max(t, d.startedAt)),
      confidence: 1,
      details: { reason: d.reason },
      version: d.version + 1,
      clientInstanceId: this.deps.instanceId,
    });
  }

  /* ------------------------------------------------------------------ browser signals */

  private attachBrowserSignals(): void {
    const on = <K extends string>(target: EventTarget, type: K, fn: (e: Event) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.removers.push(() => target.removeEventListener(type, fn, opts));
    };
    const tr = this.tracker;
    const block = this.deps.policy.browser.blockClipboard;
    on(document, 'visibilitychange', () => this.pushEpisodes(tr.visibility(document.visibilityState === 'hidden', this.now())));
    on(window, 'blur', () => this.pushEpisodes(tr.focus(false, this.now())));
    on(window, 'focus', () => this.pushEpisodes(tr.focus(true, this.now())));
    on(document, 'fullscreenchange', () => this.pushEpisodes(tr.fullscreen(!!document.fullscreenElement, this.now())));
    for (const action of ['copy', 'cut', 'paste'] as const) {
      on(
        document,
        action,
        (e) => {
          if (block) e.preventDefault();
          this.pushEpisodes(tr.clipboard(action, this.now()));
        },
        { capture: true },
      );
    }
    if (block) on(document, 'contextmenu', (e) => e.preventDefault(), { capture: true });
    const scr = window.screen as Screen & { isExtended?: boolean };
    const reportDisplays = () => {
      if (typeof scr.isExtended === 'boolean') this.pushEpisodes(tr.displays(scr.isExtended, this.now()));
    };
    if ('onchange' in scr) on(scr as unknown as EventTarget, 'change', reportDisplays);

    // Initial state.
    const t = this.now();
    this.pushEpisodes(tr.visibility(document.visibilityState === 'hidden', t));
    this.pushEpisodes(tr.focus(document.hasFocus(), t));
    this.pushEpisodes(tr.fullscreen(!!document.fullscreenElement, t));
    reportDisplays();
  }

  /* ------------------------------------------------------------------ stop */

  /**
   * Close open episodes (with end time `t`), queue them, stop the loop and the camera listeners.
   * Returns once everything is queued in the outbox (delivery is up to the caller).
   */
  async stop(reason: string, opts: { stopCamera?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const wasRunning = this.running;
    this.running = false;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    this.bursts.stop();
    for (const r of this.removers.splice(0)) r();
    this.unsubCamera?.();
    this.unsubCamera = null;
    if (wasRunning) {
      const t = this.now();
      try {
        this.deps.trace?.flush(t, toFlushReason(reason));
        const out = this.engine.flush(t, toFlushReason(reason));
        this.pushEpisodes(out.episodes ?? []);
        for (const s of out.signals ?? []) if (s.kind !== 'identity_sample') this.deps.onSignal?.(s);
      } catch (e) {
        console.warn('[monitoring] engine.flush failed', e);
      }
      try {
        this.pushEpisodes(this.tracker.flush(t));
      } catch (e) {
        console.warn('[monitoring] tracker.flush failed', e);
      }
      await this.closeDegraded(t);
      this.deps.trace?.marker(t, 'monitoring_stop', { reason });
      // Make sure everything produced so far has landed in the outbox.
      await Promise.allSettled([...this.pendingWrites]);
    }
    this.lastStatus = { state: 'off', faces: 0, label: 'Monitoring stopped', open: [] };
    this.deps.onStatus?.(this.lastStatus);
    if (opts.stopCamera) this.deps.camera.stop();
  }
}

/** Traces record what the engine saw, minus the appearance descriptors (bulky, and not replayable data). */
export function stripDescriptors(obs: FrameObservation): FrameObservation {
  if (!obs.faces.some((f) => 'descriptor' in f)) return obs;
  return {
    ...obs,
    faces: obs.faces.map((f) => {
      if (!('descriptor' in f)) return f;
      const { descriptor: _d, ...rest } = f as FaceObservation & { descriptor?: unknown };
      return rest;
    }),
  };
}

/**
 * Cadence after the final answer of a burst (identity engine v2): the next routine burst after
 * `nextSampleInMs`, labelled 'server_request' while the server wants a faster look (a follow-up was asked for,
 * or the evidence is 'monitoring' / 'suspect'), else 'periodic'. Without nextSampleInMs: 3 s while suspect, else
 * the policy interval. An older server (no nextSampleInMs field at all) gets its follow-up sample as before.
 */
export function routineCadence(res: IdentitySampleResponse): { inMs: number | null; label: 'periodic' | 'server_request'; followUpInMs: number | null } {
  const state = res.evidence?.state;
  const v2 = res.nextSampleInMs !== undefined || res.evidence !== undefined || res.burst !== undefined;
  const label: 'periodic' | 'server_request' = v2 && (res.followUpInMs != null || state === 'suspect' || state === 'monitoring' || state === 'confirmed_mismatch') ? 'server_request' : 'periodic';
  const suspect = state === 'suspect' || state === 'confirmed_mismatch';
  let inMs: number | null = null;
  if (res.nextSampleInMs != null && Number.isFinite(res.nextSampleInMs)) inMs = Math.max(0, res.nextSampleInMs);
  else if (v2 && res.followUpInMs != null) inMs = Math.max(0, res.followUpInMs);
  else if (suspect) inMs = SUSPECT_INTERVAL_MS;
  return { inMs, label, followUpInMs: !v2 && res.followUpInMs != null ? res.followUpInMs : null };
}
