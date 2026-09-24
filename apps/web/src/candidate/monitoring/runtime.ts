import {
  compareEnvironment,
  createBrowserSignalTracker,
  createMonitoringEngine,
  createFrameMetricsTracker,
  facesFromMediapipe,
  objectsFromMediapipe,
} from '@sp/detection';
import type {
  Baseline,
  CameraState,
  EngineOutput,
  EngineSignal,
  EpisodeUpdate,
  EventUpsert,
  FrameObservation,
  HeartbeatRequest,
  IdentityCheckTrigger,
  IdentitySampleResponse,
  MonitoringStatus,
  ProctoringPolicy,
} from '@sp/shared';
import { classifyApiError, uuid, type CandidateApi } from '../api';
import type { ClockSync } from '../clock';
import type { Outbox } from '../outbox';
import type { CameraManager, CameraSnapshot } from './camera';
import { captureJpeg, GraySampler } from './frames';
import type { TraceRecorder } from './trace';
import { loadVision, type Vision } from './vision';

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
export const OBJECT_EVERY_N_TICKS = 5; // ~1 Hz object detection
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
type Tracker = ReturnType<typeof createBrowserSignalTracker>;

export class MonitoringRuntime {
  private engine: Engine;
  private tracker: Tracker;
  private vision: Vision | null = null;
  private readonly sampler = new GraySampler();
  private readonly metrics = createFrameMetricsTracker();
  private running = false;
  private stopped = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private tickNo = 0;
  private readonly frameTimes: number[] = [];
  private lastStatus: MonitoringStatus = { state: 'off', faces: 0, label: 'Monitoring starting', open: [] };
  private cameraGeneration = -1;
  private unsubCamera: (() => void) | null = null;
  private degraded: { id: string; version: number; startedAt: number; reason: string } | null = null;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  private sampleInFlight = false;
  private readonly removers: (() => void)[] = [];
  private lastVideoTime = -1;
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(private readonly deps: RuntimeDeps) {
    const p = deps.policy;
    this.engine = createMonitoringEngine({
      policy: p.detection,
      identityIntervalSec: p.identity.periodicCheckIntervalSec,
      evidence: p.evidence,
      baseline: deps.baseline ?? undefined,
      idFactory: uuid,
    });
    this.tracker = createBrowserSignalTracker(p.browser);
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
    this.deps.trace?.marker(t, 'monitoring_start', { baseline: this.deps.baseline ?? null });

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
            observation: cmp.notes.length ? `Compared with the previous exam period: ${cmp.notes.join('; ')}.`.slice(0, OBSERVATION_MAX) : undefined,
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
      const t = this.now();
      this.deps.trace?.marker(t, 'camera', { label: s.info.label, deviceIdHash: s.info.deviceIdHash });
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
    const cam = this.deps.camera;
    const camState: CameraState = cam.state.state;
    const video = cam.video;

    // Browser signal tracker runs regardless of the camera.
    this.pushEpisodes(this.tracker.tick(t));

    let obs: FrameObservation;
    if (camState === 'live') {
      if (!cam.isVideoReady()) return; // frames not flowing yet: skip the tick
      if (!this.vision?.face) return; // without the face model we cannot observe; monitoring_degraded is open
      const gray = this.sampler.sample(video);
      if (!gray) return;
      const frame = this.metrics.next(gray.data, gray.width, gray.height);
      const size = { width: video.videoWidth, height: video.videoHeight };
      const faceRes = this.vision.detectFaces(video);
      if (!faceRes) return;
      const faces = facesFromMediapipe(faceRes, gray, size);
      let objects: FrameObservation['objects'] = null;
      if (this.tickNo % OBJECT_EVERY_N_TICKS === 0 && this.vision.objects) {
        const objRes = this.vision.detectObjects(video);
        if (objRes) objects = objectsFromMediapipe(objRes, size.width, size.height);
      }
      this.tickNo++;
      this.frameTimes.push(performance.now());
      this.lastVideoTime = video.currentTime;
      obs = { t, camera: 'live', frame, faces, objects, fps: Math.round(this.fps() * 10) / 10 };
    } else {
      obs = { t, camera: camState, frame: null, faces: [], objects: null, fps: 0 };
    }
    this.deps.trace?.observation(obs);
    let out: EngineOutput;
    try {
      out = this.engine.ingest(obs);
    } catch (e) {
      console.warn('[monitoring] engine.ingest failed', e);
      return;
    }
    void this.handleOutput(out);
  }

  private async handleOutput(out: EngineOutput | null | undefined): Promise<void> {
    if (!out) return;
    if (out.status) {
      this.lastStatus = this.vision && !this.vision.face ? { ...out.status, state: 'degraded', label: 'Camera analysis unavailable' } : out.status;
      this.deps.onStatus?.(this.lastStatus);
    }
    this.pushEpisodes(out.episodes ?? []);
    for (const s of out.signals ?? []) {
      if (s.kind === 'identity_sample') void this.takeIdentitySample(s.trigger);
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

  private async takeIdentitySample(trigger: IdentityCheckTrigger): Promise<void> {
    if (!this.running || this.sampleInFlight) return;
    if (!this.deps.camera.isVideoReady()) return;
    this.sampleInFlight = true;
    try {
      const capturedAt = this.now();
      const blob = await captureJpeg(this.deps.camera.video, 0.85);
      if (!blob) return;
      const sampleId = uuid();
      try {
        const res = await this.deps.api.identitySample(sampleId, blob, { trigger, capturedAt });
        this.handleSampleResult(res);
      } catch (e) {
        const kind = classifyApiError(e);
        if (kind === 'invalid_link' || kind === 'superseded') {
          this.deps.onFatal?.(kind);
          return;
        }
        if (kind === 'client') return; // rejected (e.g. unusable image) — nothing to retry
        // Offline or server trouble: keep it for later delivery with its original timestamp.
        await this.deps.outbox.putSample({ id: sampleId, trigger, capturedAt, jpeg: blob });
      }
    } finally {
      this.sampleInFlight = false;
    }
  }

  /** Server's answer to an identity sample (direct or delivered later from the outbox). */
  handleSampleResult(res: IdentitySampleResponse): void {
    if (res.status === 'on_hold' || res.hold) {
      this.deps.onHold?.();
      return;
    }
    if (res.followUpInMs != null && this.running) {
      if (this.followUpTimer) clearTimeout(this.followUpTimer);
      this.followUpTimer = setTimeout(() => {
        this.followUpTimer = null;
        void this.takeIdentitySample('follow_up');
      }, Math.max(500, res.followUpInMs));
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
    if ('onchange' in scr) on(scr, 'change', reportDisplays);

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
    for (const r of this.removers.splice(0)) r();
    this.unsubCamera?.();
    this.unsubCamera = null;
    if (wasRunning) {
      const t = this.now();
      try {
        const out = this.engine.flush(t, reason);
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
