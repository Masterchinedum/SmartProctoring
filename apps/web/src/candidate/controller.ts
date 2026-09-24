import type {
  Baseline,
  CandidateCommand,
  CandidateSessionState,
  CheckPurpose,
  HeartbeatResponse,
  MonitoringStatus,
  PauseResponse,
} from '@sp/shared';
import {
  CandidateApiError,
  classifyApiError,
  createCandidateApi,
  getPageInstanceId,
  type CandidateApi,
  type RequestTiming,
} from './api';
import { AnswerStore } from './answers';
import { ClockSync, Countdown } from './clock';
import { Outbox, type OutboxStats } from './outbox';
import { CameraManager, type CameraSnapshot } from './monitoring/camera';
import { MonitoringRuntime } from './monitoring/runtime';
import { TraceRecorder, traceEnabled } from './monitoring/trace';

/**
 * CandidateController — long-lived, non-React state for one exam session in this page:
 * API client, clock sync, outbox, answers, camera, monitoring runtime and heartbeat.
 * React screens subscribe to its snapshot and call its actions.
 */

export const HEARTBEAT_INTERVAL_MS = 5000;
export const REPORTING_INTERRUPTED_AFTER_MS = 10_000;
const FLUSH_BEFORE_TRANSITION_MS = 3000;
const ANSWER_FLUSH_BEFORE_SUBMIT_MS = 10_000;

export type FatalKind = 'invalid_link' | 'superseded';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface CandidatePrompt {
  key: string;
  message: string;
  severity: 'info' | 'warning';
}

export interface ControllerSnapshot {
  loading: boolean;
  /** Error while loading the session state (network etc.) — retryable. */
  loadError: string | null;
  fatal: { kind: FatalKind; message: string } | null;
  state: CandidateSessionState | null;
  online: boolean;
  outbox: OutboxStats | null;
  /** Live reporting is interrupted (offline, heartbeat failing, or items undelivered > 10 s). */
  reportingInterrupted: boolean;
  heartbeatFailingSince: number | null;
  monitoring: MonitoringStatus | null;
  monitoringActive: boolean;
  camera: CameraSnapshot;
  prompts: CandidatePrompt[];
  toasts: Toast[];
  /** Set while the countdown has reached zero and we wait for the server to submit. */
  timeUp: boolean;
  /** Local time we observed the pause (for the paused screen). */
  pausedAtLocal: number | null;
  /** Reason the candidate gave for a pause requested from this browser. */
  pauseReasonLocal: string | null;
  answersReady: boolean;
}

type Listener = () => void;

const BASELINE_KEY = (sessionId: string) => `sp:baseline:${sessionId}`;
const PAUSED_AT_KEY = (sessionId: string) => `sp:pausedAt:${sessionId}`;
const PAUSE_REASON_KEY = (sessionId: string) => `sp:pauseReason:${sessionId}`;

function lsGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function isVerifiedInstance(state: CandidateSessionState | null, instanceId: string): boolean {
  return !!state && state.session.verifiedInstanceId === instanceId && state.session.requiredCheck == null;
}

export class CandidateController {
  readonly api: CandidateApi;
  readonly instanceId: string;
  readonly clock = new ClockSync();
  readonly countdown = new Countdown();
  readonly camera: CameraManager;
  readonly trace: TraceRecorder | null;
  outbox: Outbox | null = null;
  answers: AnswerStore | null = null;
  private runtime: MonitoringRuntime | null = null;
  private runtimeStarting = false;
  private readonly listeners = new Set<Listener>();
  private snap: ControllerSnapshot;
  private toastSeq = 0;
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private hbSeq = 0;
  private hbInFlight = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private outboxOpening: Promise<Outbox> | null = null;
  private answersRestoring: Promise<void> | null = null;
  private currentQuestionIndex = 0;
  private disposed = false;
  private loadSeq = 0;
  /** Baseline from the latest calibration in this page. */
  private baseline: Baseline | null = null;
  /** Baseline of the previous exam period (for environment comparison after resume/reconnect). */
  private previousBaseline: Baseline | null = null;
  private transitioning = false;

  constructor(readonly token: string) {
    this.instanceId = getPageInstanceId();
    this.api = createCandidateApi({ token, instanceId: this.instanceId, onFatal: (kind, err) => this.setFatal(kind, err) });
    this.camera = new CameraManager();
    this.trace = traceEnabled() ? new TraceRecorder({ instanceId: this.instanceId }) : null;
    this.snap = {
      loading: true,
      loadError: null,
      fatal: null,
      state: null,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      outbox: null,
      reportingInterrupted: false,
      heartbeatFailingSince: null,
      monitoring: null,
      monitoringActive: false,
      camera: this.camera.state,
      prompts: [],
      toasts: [],
      timeUp: false,
      pausedAtLocal: null,
      pauseReasonLocal: null,
      answersReady: false,
    };
    this.camera.subscribe((c) => this.patch({ camera: c }));
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.uiTimer = setInterval(() => this.recomputeDerived(), 1000);
  }

  /* ================================================================ store */

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ControllerSnapshot => this.snap;

  private patch(p: Partial<ControllerSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    this.snap = { ...this.snap, reportingInterrupted: this.computeInterrupted(this.snap) };
    for (const fn of this.listeners) fn();
  }

  private computeInterrupted(s: ControllerSnapshot): boolean {
    const status = s.state?.session.status;
    // Only meaningful while this page reports (active exam, or data still queued).
    const reporting = status === 'active' && isVerifiedInstance(s.state, this.instanceId);
    const queued = (s.outbox?.size ?? 0) > 0;
    if (!reporting && !queued) return false;
    const now = Date.now();
    if (!s.online) return true;
    if (reporting && s.heartbeatFailingSince != null && now - s.heartbeatFailingSince > REPORTING_INTERRUPTED_AFTER_MS) return true;
    if (queued && s.outbox?.oldestAt != null && now - s.outbox.oldestAt > REPORTING_INTERRUPTED_AFTER_MS) return true;
    return false;
  }

  private recomputeDerived(): void {
    const ri = this.computeInterrupted(this.snap);
    const timeUp = this.checkTimeUp();
    if (ri !== this.snap.reportingInterrupted || timeUp !== this.snap.timeUp) this.patch({ timeUp });
  }

  toast(message: string, kind: Toast['kind'] = 'info', ttlMs = 8000): void {
    const t: Toast = { id: ++this.toastSeq, kind, message };
    this.patch({ toasts: [...this.snap.toasts, t].slice(-4) });
    setTimeout(() => this.dismissToast(t.id), ttlMs);
  }

  dismissToast(id: number): void {
    if (!this.snap.toasts.some((t) => t.id === id)) return;
    this.patch({ toasts: this.snap.toasts.filter((t) => t.id !== id) });
  }

  /* ================================================================ state */

  private setFatal(kind: FatalKind, err?: CandidateApiError): void {
    if (this.snap.fatal) return;
    const message =
      kind === 'superseded'
        ? err?.message || 'This exam was opened in another browser window or on another device.'
        : 'This exam link is not valid. It may have expired or been replaced by a new link.';
    this.stopHeartbeat();
    this.stopPolling();
    void this.stopMonitoring('superseded', { flush: false, stopCamera: true });
    this.outbox?.stop();
    this.patch({ fatal: { kind, message }, loading: false });
  }

  /** Load (or refresh) the session state from the server. */
  async load(): Promise<CandidateSessionState | null> {
    const seq = ++this.loadSeq;
    try {
      const { data, timing } = await this.api.getState();
      if (seq !== this.loadSeq) return data;
      await this.applyState(data, timing);
      this.patch({ loading: false, loadError: null });
      return data;
    } catch (e) {
      if (seq !== this.loadSeq) return null;
      const kind = classifyApiError(e);
      if (kind === 'invalid_link' || kind === 'superseded') return null; // fatal handled via onFatal
      this.patch({
        loading: false,
        loadError: kind === 'network' ? 'We could not reach the exam server. Check your internet connection.' : (e as Error).message || 'Something went wrong.',
      });
      return null;
    }
  }

  /**
   * Apply a new server state. Starts/stops the heartbeat, polling and monitoring runtime to match.
   * `timing` (when available) refines the clock offset.
   */
  async applyState(state: CandidateSessionState, timing?: RequestTiming): Promise<void> {
    if (this.disposed) return;
    if (timing) this.clock.addSample(state.serverTime, timing.sentAt, timing.receivedAt);
    const serverNow = this.clock.synced ? this.clock.now() : state.serverTime;
    this.countdown.sync(state.session.remainingMs, state.session.timerRunning, state.serverTime, serverNow);
    const prev = this.snap.state;
    const sid = state.session.id;
    let pausedAtLocal = this.snap.pausedAtLocal;
    let pauseReasonLocal = this.snap.pauseReasonLocal;
    if (state.session.status === 'paused') {
      if (prev?.session.status === 'active' || pausedAtLocal == null) {
        pausedAtLocal = prev?.session.status === 'active' ? Date.now() : (lsGet<number>(PAUSED_AT_KEY(sid)) ?? null);
        if (pausedAtLocal) lsSet(PAUSED_AT_KEY(sid), pausedAtLocal);
      }
      pauseReasonLocal = lsGet<string>(PAUSE_REASON_KEY(sid));
    } else if (state.session.status === 'active' && state.session.pauseRequest?.status !== 'pending') {
      pausedAtLocal = null;
      pauseReasonLocal = null;
      if (prev?.session.status === 'paused') {
        lsSet(PAUSED_AT_KEY(sid), null);
        lsSet(PAUSE_REASON_KEY(sid), null);
      }
    }
    this.patch({ state, pausedAtLocal, pauseReasonLocal, timeUp: false });

    await this.ensureOutbox(sid);
    if (state.questions && (state.session.status === 'active' || state.session.status === 'paused' || state.session.status === 'on_hold')) {
      await this.ensureAnswers(state);
    }
    this.syncServices();
  }

  private syncServices(): void {
    const s = this.snap.state;
    if (!s || this.snap.fatal) return;
    const status = s.session.status;
    const verified = isVerifiedInstance(s, this.instanceId);
    const shouldMonitor = status === 'active' && verified;
    if (shouldMonitor) {
      this.stopPolling();
      this.startHeartbeat();
      void this.startMonitoring();
    } else {
      this.stopHeartbeat();
      if (this.runtime) void this.stopMonitoring(status === 'paused' ? 'pause' : status === 'on_hold' ? 'hold' : status, { flush: true, stopCamera: status !== 'active' && status !== 'ready' });
      if (status === 'on_hold') this.startPolling(5000);
      else if (status === 'paused') this.startPolling(15_000);
      else if (status === 'active' && s.session.pauseRequest?.status === 'pending') this.startPolling(5000);
      else this.stopPolling();
    }
    this.outbox?.kick();
  }

  private async ensureOutbox(sessionId: string): Promise<Outbox> {
    if (this.outbox) return this.outbox;
    if (!this.outboxOpening) {
      this.outboxOpening = Outbox.open({
        namespace: sessionId,
        onSampleResult: (_s, res) => this.onSampleResult(res),
        onFatal: (kind) => this.setFatal(kind),
        onDropped: (kind, id, reason) => console.warn(`[outbox] dropped ${kind} ${id}: ${reason}`),
      }).then((box) => {
        this.outbox = box;
        box.subscribe((stats) => this.patch({ outbox: stats }));
        box.start(this.api, () => this.canDeliver());
        this.patch({ outbox: box.stats() });
        return box;
      });
    }
    return this.outboxOpening;
  }

  /** Delivery is allowed once this instance is the verified one (the server rejects others). */
  private canDeliver(): boolean {
    const s = this.snap.state;
    if (!s || this.snap.fatal) return false;
    return s.session.verifiedInstanceId === this.instanceId;
  }

  private async ensureAnswers(state: CandidateSessionState): Promise<void> {
    if (this.answers || !this.outbox) return;
    if (!this.answersRestoring) {
      const store = new AnswerStore(this.outbox);
      this.answersRestoring = store.restore(state.answers).then(() => {
        this.answers = store;
        this.currentQuestionIndex = state.session.currentQuestionIndex ?? 0;
        this.patch({ answersReady: true });
      });
    }
    await this.answersRestoring;
  }

  /* ================================================================ calibration & baseline */

  /** Called by the check flow after calibration: keeps the new baseline and remembers the previous. */
  setCalibration(baseline: Baseline | null, purpose: CheckPurpose): void {
    const sid = this.snap.state?.session.id;
    const stored = sid ? lsGet<Baseline>(BASELINE_KEY(sid)) : null;
    const prior = this.baseline ?? stored;
    this.previousBaseline = purpose !== 'initial' && prior ? prior : null;
    this.baseline = baseline;
    if (sid && baseline) lsSet(BASELINE_KEY(sid), baseline);
  }

  /** Baseline of the current period (latest calibration, else the one stored for this session). */
  currentBaseline(): Baseline | null {
    if (this.baseline) return this.baseline;
    const sid = this.snap.state?.session.id;
    return sid ? lsGet<Baseline>(BASELINE_KEY(sid)) : null;
  }

  /* ================================================================ monitoring */

  private async startMonitoring(): Promise<void> {
    if (this.runtime || this.runtimeStarting || !this.outbox) return;
    const s = this.snap.state;
    if (!s) return;
    this.runtimeStarting = true;
    try {
      const rt = new MonitoringRuntime({
        api: this.api,
        outbox: this.outbox,
        camera: this.camera,
        clock: this.clock,
        policy: s.exam.policy,
        instanceId: this.instanceId,
        baseline: this.currentBaseline(),
        previousBaseline: this.previousBaseline,
        trace: this.trace,
        onSignal: (sig) => {
          if (sig.kind === 'candidate_prompt') {
            const rest = this.snap.prompts.filter((p) => p.key !== sig.key);
            this.patch({ prompts: [...rest, { key: sig.key, message: sig.message, severity: sig.severity }] });
          } else if (sig.kind === 'candidate_prompt_clear') {
            this.patch({ prompts: this.snap.prompts.filter((p) => p.key !== sig.key) });
          }
        },
        onStatus: (st) => this.patch({ monitoring: st }),
        onHold: () => void this.onHoldDetected(),
        onFatal: (kind) => this.setFatal(kind),
      });
      this.previousBaseline = null; // compared once per period
      this.runtime = rt;
      this.patch({ monitoringActive: true });
      await rt.start();
    } catch (e) {
      console.error('[controller] monitoring failed to start', e);
    } finally {
      this.runtimeStarting = false;
    }
  }

  /** Stop monitoring: close open episodes, queue them and try to deliver them (bounded wait). */
  async stopMonitoring(reason: string, opts: { flush: boolean; stopCamera: boolean }): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    if (rt) await rt.stop(reason, { stopCamera: opts.stopCamera });
    else if (opts.stopCamera) this.camera.stop();
    this.patch({ monitoringActive: false, prompts: [] });
    if (opts.flush && this.outbox) await this.outbox.flushNow(FLUSH_BEFORE_TRANSITION_MS);
  }

  private onSampleResult(res: import('@sp/shared').IdentitySampleResponse): void {
    if (res.status === 'on_hold' || res.hold) void this.onHoldDetected();
  }

  private async onHoldDetected(): Promise<void> {
    await this.stopMonitoring('hold', { flush: true, stopCamera: true });
    await this.load();
  }

  /* ================================================================ heartbeat */

  setCurrentQuestionIndex(i: number): void {
    this.currentQuestionIndex = i;
  }

  getCurrentQuestionIndex(): number {
    return this.currentQuestionIndex;
  }

  private startHeartbeat(): void {
    if (this.hbTimer || this.hbInFlight) return;
    void this.heartbeatTick();
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = null;
  }

  private scheduleHeartbeat(delay = HEARTBEAT_INTERVAL_MS): void {
    this.stopHeartbeat();
    const s = this.snap.state;
    if (!s || this.snap.fatal || this.disposed) return;
    if (!(s.session.status === 'active' && isVerifiedInstance(s, this.instanceId))) return;
    this.hbTimer = setTimeout(() => {
      this.hbTimer = null;
      void this.heartbeatTick();
    }, delay);
  }

  private async heartbeatTick(): Promise<void> {
    if (this.hbInFlight) return;
    this.hbInFlight = true;
    const stats = this.outbox?.stats();
    try {
      const { data, timing } = await this.api.heartbeat({
        clientInstanceId: this.instanceId,
        clientTime: Date.now(),
        seq: ++this.hbSeq,
        monitoring: this.runtime?.heartbeatMonitoring() ?? { state: 'off', faces: 0, label: 'Monitoring not running', open: [], cameraState: this.camera.state.state },
        outboxSize: stats?.size ?? 0,
        outboxOldestAt: stats?.oldestAt ?? null,
        currentQuestionIndex: this.currentQuestionIndex,
        visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
        fullscreen: !!document.fullscreenElement,
      });
      this.patch({ heartbeatFailingSince: null });
      await this.onHeartbeat(data, timing);
    } catch (e) {
      const kind = classifyApiError(e);
      if (kind === 'invalid_link' || kind === 'superseded') return;
      if (kind === 'invalid_state' || kind === 'not_verified') {
        await this.load();
      } else if (this.snap.heartbeatFailingSince == null) {
        this.patch({ heartbeatFailingSince: Date.now() });
      }
    } finally {
      this.hbInFlight = false;
    }
    this.scheduleHeartbeat();
  }

  private async onHeartbeat(hb: HeartbeatResponse, timing: RequestTiming): Promise<void> {
    this.clock.addSample(hb.serverTime, timing.sentAt, timing.receivedAt);
    this.countdown.sync(hb.remainingMs, hb.timerRunning, hb.serverTime, this.clock.now());
    let needReload = false;
    for (const cmd of hb.commands ?? []) {
      if (await this.handleCommand(cmd, hb)) needReload = true;
    }
    const s = this.snap.state;
    if (s && (hb.status !== s.session.status || hb.requiredCheck !== s.session.requiredCheck)) {
      needReload = true;
      // Leaving 'active' (or a check is now required): close out monitoring before the screen changes.
      if (hb.status !== 'active' || hb.requiredCheck) {
        const terminal = hb.status === 'submitted' || hb.status === 'terminated';
        await this.stopMonitoring(hb.status === 'active' ? 'check_required' : hb.status, { flush: true, stopCamera: hb.status !== 'active' || terminal });
      }
    }
    if (needReload) await this.load();
  }

  /**
   * Handle a server command. Commands are interpreted against the status reported in the same
   * heartbeat, so a stale queued command can never stop an exam that is running normally.
   * Returns true when the session state should be reloaded.
   */
  private async handleCommand(cmd: CandidateCommand, hb: HeartbeatResponse): Promise<boolean> {
    switch (cmd.kind) {
      case 'pause_approved':
        if (hb.status === 'paused') this.toast('Your pause was approved. The exam is now paused.', 'info');
        return true;
      case 'pause_denied':
        this.toast(cmd.note ? `Your pause request was not approved: ${cmd.note}` : 'Your pause request was not approved. Please continue your exam.', 'warning', 12_000);
        return true;
      case 'hold':
      case 'hold_released':
      case 'terminated':
      case 'submitted':
        return true;
      case 'require_check':
        if (hb.requiredCheck) this.toast(cmd.message || 'Please complete a quick camera and identity check to continue.', 'info', 12_000);
        return true;
      case 'superseded':
        this.setFatal('superseded', new CandidateApiError(409, 'superseded', cmd.message));
        return false;
      default:
        return false;
    }
  }

  /* ================================================================ polling (paused / hold / pending approval) */

  private startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      await this.load();
    }, intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /* ================================================================ countdown */

  remainingMs(): number {
    return this.countdown.remaining(this.clock.now());
  }

  private checkTimeUp(): boolean {
    const s = this.snap.state;
    if (!s || s.session.status !== 'active' || !this.countdown.running) return false;
    const up = this.remainingMs() <= 0;
    if (up && !this.snap.timeUp) void this.onTimeUp();
    return up;
  }

  private async onTimeUp(): Promise<void> {
    // The server auto-submits when the clock reaches zero; make sure our answers get there first.
    await this.answers?.flushPending();
    await this.outbox?.flushNow(5000, 'answers');
    for (let i = 0; i < 10 && !this.disposed; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await this.load();
      if (st && st.session.status !== 'active') return;
    }
  }

  /* ================================================================ actions */

  async acceptConsent(): Promise<void> {
    const s = this.snap.state;
    if (!s) return;
    const next = await this.api.consent({ noticeVersion: s.consent.notice.version, accepted: true });
    await this.applyState(next);
  }

  async startExam(): Promise<void> {
    const { data, timing } = await this.api.start();
    await this.applyState(data, timing);
  }

  /**
   * Request a pause. Without approval: monitoring is closed out and delivered first, then the pause
   * is requested. With approval: the request is sent and monitoring continues until approval.
   */
  async requestPause(reason?: string): Promise<PauseResponse> {
    const s = this.snap.state;
    if (!s) throw new Error('No session');
    const needsApproval = s.exam.policy.pause.requireApproval;
    await this.answers?.flushPending();
    lsSet(PAUSE_REASON_KEY(s.session.id), reason?.trim() || null);
    if (!needsApproval) {
      await this.stopMonitoring('pause', { flush: true, stopCamera: false });
    } else {
      await this.outbox?.flushNow(FLUSH_BEFORE_TRANSITION_MS, 'answers');
    }
    try {
      const res = await this.api.pause(reason);
      if (res.outcome === 'paused') this.camera.stop();
      await this.applyState(res.state);
      return res;
    } catch (e) {
      // Pause failed (e.g. offline): keep monitoring.
      this.syncServices();
      throw e;
    }
  }

  async cancelPause(): Promise<void> {
    const { data, timing } = await this.api.cancelPause();
    await this.applyState(data, timing);
  }

  /** Submit the exam after delivering all answers. Throws with a candidate-facing message on failure. */
  async submit(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await this.answers?.flushPending();
      const delivered = await (this.outbox?.flushNow(ANSWER_FLUSH_BEFORE_SUBMIT_MS, 'answers') ?? Promise.resolve(true));
      if (!delivered) {
        throw new Error(
          'Some of your answers have not reached the server yet because the connection is interrupted. They are saved on this device. Please check your connection and try submitting again.',
        );
      }
      await this.stopMonitoring('submit', { flush: true, stopCamera: true });
      try {
        const { data, timing } = await this.api.submit();
        await this.applyState(data, timing);
      } catch (e) {
        this.syncServices(); // resume monitoring if the submit did not go through
        throw e;
      }
    } finally {
      this.transitioning = false;
    }
  }

  /* ================================================================ window events */

  private readonly onOnline = () => {
    this.patch({ online: true });
    if (this.snap.state?.session.status === 'active' && this.hbTimer) this.scheduleHeartbeat(0);
    if (this.snap.loadError) void this.load();
  };

  private readonly onOffline = () => this.patch({ online: false });

  private readonly onPageHide = () => {
    void this.answers?.flushPending();
  };

  private readonly onBeforeUnload = (e: BeforeUnloadEvent) => {
    void this.answers?.flushPending();
    const unsaved = (this.outbox?.stats().pendingAnswers ?? 0) > 0 || this.answers?.hasUnsavedEdits();
    if (unsaved && this.snap.state?.session.status === 'active') {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  dispose(): void {
    this.disposed = true;
    this.stopHeartbeat();
    this.stopPolling();
    if (this.uiTimer) clearInterval(this.uiTimer);
    void this.runtime?.stop('dispose', { stopCamera: true });
    this.runtime = null;
    this.camera.dispose();
    this.answers?.dispose();
    this.outbox?.close();
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.listeners.clear();
  }
}
