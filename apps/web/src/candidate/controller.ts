import type {
  Baseline,
  CandidateCommand,
  CandidateSessionState,
  CheckPurpose,
  HeartbeatResponse,
  IdentitySampleRequestDTO,
  MonitoringStatus,
  PauseResponse,
  SessionStatus,
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
import { MonitoringRuntime, type RuntimeDebug } from './monitoring/runtime';
import { TraceRecorder, traceEnabled } from './monitoring/trace';
import { DebugStore, debugEnabled } from './debug';

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

/** A passed check whose "Check complete" screen waits for the candidate's click (see `setAwaitingContinue`). */
export interface AwaitingContinue {
  /** React key of the check flow that is kept mounted. */
  key: string;
  purpose: CheckPurpose;
  /** Status when the check passed (the flow stays while the state still shows it). */
  from: SessionStatus | undefined;
}

/** Calm, factual notice about answers that could not be saved because the exam had ended. */
export function unsavedAnswersNotice(afterEnd: number, unsent: number): string | null {
  const count = (n: number) => (n === 1 ? 'One answer' : `${n} answers`);
  const parts: string[] = [];
  if (afterEnd > 0) parts.push(`${count(afterEnd)} typed after the exam ended could not be saved.`);
  if (unsent > 0) parts.push(`${count(unsent)} kept on this device could not be sent before the exam ended.`);
  return parts.length ? parts.join(' ') : null;
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
  /** A passed check waits for the candidate's click: heartbeats run, monitoring starts with the click. */
  awaitingContinue: AwaitingContinue | null;
  /** Answers that could not be saved because the exam had ended (shown on the ended screen). */
  answerNotice: string | null;
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
  /** Diagnostics for the `?debug=1` overlay (collects nothing without the flag). */
  readonly debug = new DebugStore(debugEnabled());
  outbox: Outbox | null = null;
  answers: AnswerStore | null = null;
  private runtime: MonitoringRuntime | null = null;
  private runtimeStarting = false;
  /** A server identity-sample request that arrived before monitoring runs (e.g. exam_start with /start). */
  private pendingServerSample: IdentitySampleRequestDTO | null = null;
  private readonly listeners = new Set<Listener>();
  private snap: ControllerSnapshot;
  private toastSeq = 0;
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private hbSeq = 0;
  private hbInFlight = false;
  private hbSoon = false;
  private timeUpRunning = false;
  private timeUpLastAt = 0;
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
  private answersRefusedAfterEnd = 0;
  private answersUnsentAtEnd = 0;
  private answersSettledAfterEnd = false;

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
      awaitingContinue: null,
      answerNotice: null,
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

  /**
   * Live reporting is interrupted: offline, the heartbeat failing, or items waiting for delivery for more
   * than 10 s. The outbox's `oldestAt` only counts items waiting for the network — not answers parked while
   * the exam is paused / on hold, nor identity samples in the server's busy vision queue — and queued items
   * only count while this page may deliver them (before a resume / reconnect check it may not, by design).
   */
  private computeInterrupted(s: ControllerSnapshot): boolean {
    const status = s.state?.session.status;
    // Only meaningful while this page reports (active exam, or data still queued).
    const reporting = status === 'active' && isVerifiedInstance(s.state, this.instanceId);
    const queued = (s.outbox?.size ?? 0) > 0 && !s.fatal && s.state?.session.verifiedInstanceId === this.instanceId;
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
      await this.apply(data, timing);
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
   * Apply a server state returned by an action (check result, start, pause, submit, …). It is newer than
   * any state load still in flight, so those are discarded when they arrive (a stale "paused" state from a
   * poll must not undo a resume that just passed).
   */
  async applyState(state: CandidateSessionState, timing?: RequestTiming): Promise<void> {
    this.loadSeq++;
    await this.apply(state, timing);
    if (this.snap.loading || this.snap.loadError) this.patch({ loading: false, loadError: null });
  }

  /**
   * Apply a new server state. Starts/stops the heartbeat, polling and monitoring runtime to match.
   * `timing` (when available) refines the clock offset.
   */
  private async apply(state: CandidateSessionState, timing?: RequestTiming): Promise<void> {
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
    const timeUp = state.session.status === 'active' && this.countdown.running && this.remainingMs() <= 0;
    // "Check complete" waits for the click while the exam stays active (or still shows the pre-check status);
    // held again, ended, … meanwhile: that screen no longer applies.
    let awaitingContinue = this.snap.awaitingContinue;
    if (awaitingContinue && state.session.status !== 'active' && state.session.status !== awaitingContinue.from) awaitingContinue = null;
    this.patch({ state, pausedAtLocal, pauseReasonLocal, timeUp, awaitingContinue });
    if (state.session.status === 'active') this.serverSampleRequest(state.session.identitySample);

    await this.ensureOutbox(sid);
    if (state.questions && (state.session.status === 'active' || state.session.status === 'paused' || state.session.status === 'on_hold')) {
      await this.ensureAnswers(state, prev);
    }
    await this.settleParkedAnswers(state);
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
      // While a passed check waits for the candidate's click the browser reports as alive (heartbeat), but
      // monitoring starts only with the click — after it entered required fullscreen.
      if (!this.snap.awaitingContinue) void this.startMonitoring();
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
        onSampleResult: (rec, res) => this.onSampleResult(res, rec),
        onFatal: (kind) => this.setFatal(kind),
        onDropped: (kind, id, reason) => console.warn(`[outbox] dropped ${kind} ${id}: ${reason}`),
        onAnswerRefusedAfterEnd: () => this.noteUnsavedAnswers('after_end'),
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

  private async ensureAnswers(state: CandidateSessionState, prev: CandidateSessionState | null): Promise<void> {
    if (this.answers) {
      // The exam is active again in this page (resume / reverify / reconnect): the server did not serve its
      // answers meanwhile. Re-sync — local answers it has not taken yet (e.g. refused while the exam was
      // paused) win and stay queued; otherwise the server's value is shown.
      if (state.answers && !prev?.answers) await this.answers.reconcile(state.answers);
      return;
    }
    if (!this.outbox) return;
    if (!this.answersRestoring) {
      // answeredAt uses the server-synced clock: the server compares it with pause / hold start times.
      const store = new AnswerStore(this.outbox, { now: () => this.clock.now() });
      this.answersRestoring = store.restore(state.answers).then(() => {
        this.answers = store;
        this.currentQuestionIndex = state.session.currentQuestionIndex ?? 0;
        this.patch({ answersReady: true });
      });
    }
    await this.answersRestoring;
  }

  /**
   * Answers refused while the exam was paused / on hold (parked in the outbox) are re-sent as soon as the
   * exam is active again. Once it has ended they get the server's final answer (exam_ended → notice); a
   * page that can no longer deliver at all (another browser was the verified one) gives up on them here.
   */
  private async settleParkedAnswers(state: CandidateSessionState): Promise<void> {
    const box = this.outbox;
    if (!box) return;
    const st = state.session.status;
    if (st === 'active' && isVerifiedInstance(state, this.instanceId)) {
      void box.resumeAnswers();
    } else if (st === 'submitted' || st === 'terminated') {
      if (this.canDeliver()) {
        void box.resumeAnswers();
      } else if (!this.answersSettledAfterEnd && box.stats().pendingAnswers > 0) {
        this.answersSettledAfterEnd = true;
        const lost = await box.abandonPendingAnswers(state.answers);
        if (lost > 0) this.noteUnsavedAnswers('unsent', lost);
      }
    }
  }

  private noteUnsavedAnswers(kind: 'after_end' | 'unsent', n = 1): void {
    if (kind === 'after_end') this.answersRefusedAfterEnd += n;
    else this.answersUnsentAtEnd += n;
    this.patch({ answerNotice: unsavedAnswersNotice(this.answersRefusedAfterEnd, this.answersUnsentAtEnd) });
  }

  /**
   * A passed check (resume / reconnect / reverify) shows "Check complete" until the candidate clicks
   * Continue — which may also enter required fullscreen. The exam is already active on the server, so the
   * check flow applies that state right away (heartbeats start: no false "offline" / reporting outage while
   * the screen waits), but the monitoring runtime starts only when this is cleared (`null`) after the
   * click. Otherwise its browser tracker would record "left fullscreen" before the candidate could enter
   * it. If entering fullscreen then fails or is declined, that is recorded normally.
   */
  setAwaitingContinue(a: AwaitingContinue | null): void {
    if (a === this.snap.awaitingContinue) return;
    this.patch({ awaitingContinue: a });
    this.syncServices();
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

  /**
   * The server asks for an identity burst (exam start / resume / reconnect, or a faster sample while its
   * evidence is suspect): hand it to the running monitoring, or keep it until monitoring starts (the
   * "Check complete" screen waits for the candidate's click). The runtime also takes its own exam-start
   * burst, so an older server without this field is covered; duplicates are dropped there.
   */
  private serverSampleRequest(req: IdentitySampleRequestDTO | null | undefined): void {
    if (!req) return;
    if (this.runtime?.isRunning) this.runtime.serverSampleRequest(req);
    else this.pendingServerSample = req;
  }

  /** Live monitoring diagnostics (debug overlay). */
  runtimeDebug(): RuntimeDebug | null {
    return this.runtime?.isRunning ? this.runtime.debug() : null;
  }

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
        onStatus: (st) => {
          const prev = this.snap.monitoring;
          this.patch({ monitoring: st });
          // Let staff see a change of monitoring state (ok / attention / degraded) promptly.
          if (prev?.state !== st.state) this.heartbeatSoon();
        },
        onHold: () => void this.onHoldDetected(),
        onFatal: (kind) => this.setFatal(kind),
        onDebug: (e) => {
          if (e.kind === 'burst') this.debug.burst(e.result);
          else this.debug.trigger({ at: e.at, trigger: e.trigger, source: e.source, reason: e.reason });
        },
      });
      this.previousBaseline = null; // compared once per period
      this.runtime = rt;
      this.patch({ monitoringActive: true });
      await rt.start();
      const pending = this.pendingServerSample;
      this.pendingServerSample = null;
      if (pending && this.runtime === rt) rt.serverSampleRequest(pending);
    } catch (e) {
      console.error('[controller] monitoring failed to start', e);
    } finally {
      this.runtimeStarting = false;
    }
  }

  /**
   * Screens that do not use the camera (on hold, paused, ended) call this when shown: release a camera that no
   * monitoring run owns — the check's camera when the check ended in a hold (e.g. an ID-photo hold at check-in, a
   * different person at a resume check), a cancelled resume / re-verification check, or the ready screen's
   * preview when staff put the exam on hold or ended it. Running monitoring releases its own camera
   * (stopMonitoring), after closing its open episodes.
   */
  releaseIdleCamera(): void {
    if (this.runtime || this.runtimeStarting) return;
    if (this.camera.state.wanted || this.camera.state.stream) this.camera.stop();
  }

  /** Stop monitoring: close open episodes, queue them and try to deliver them (bounded wait). */
  async stopMonitoring(reason: string, opts: { flush: boolean; stopCamera: boolean }): Promise<void> {
    const rt = this.runtime;
    this.runtime = null;
    this.pendingServerSample = null;
    if (rt) await rt.stop(reason, { stopCamera: opts.stopCamera });
    else if (opts.stopCamera) this.camera.stop();
    this.patch({ monitoringActive: false, prompts: [] });
    if (opts.flush && this.outbox) await this.outbox.flushNow(FLUSH_BEFORE_TRANSITION_MS);
  }

  /** An identity sample delivered later from the outbox: holds apply at once; the running monitoring takes the cadence. */
  private onSampleResult(res: import('@sp/shared').IdentitySampleResponse, rec?: { burstId?: string; burstIndex?: number; burstSize?: number }): void {
    if (res.status === 'on_hold' || res.hold) {
      void this.onHoldDetected();
      return;
    }
    const final = !rec?.burstId || res.burst?.complete === true || (rec.burstIndex ?? 0) >= (rec.burstSize ?? 1) - 1;
    if (final) this.runtime?.handleSampleResult(res, true);
  }

  private async onHoldDetected(): Promise<void> {
    await this.stopMonitoring('hold', { flush: true, stopCamera: true });
    await this.load();
  }

  /* ================================================================ heartbeat */

  /** The server keeps the candidate's place (for resume on any device): report changes promptly. */
  setCurrentQuestionIndex(i: number): void {
    if (i === this.currentQuestionIndex) return;
    this.currentQuestionIndex = i;
    this.heartbeatSoon();
  }

  /** Send the next heartbeat shortly (debounced), e.g. after a status or place change. */
  private heartbeatSoon(delayMs = 800): void {
    if (this.hbInFlight) this.hbSoon = true;
    else if (this.hbTimer) this.scheduleHeartbeat(delayMs);
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

  /** Send a heartbeat now (e.g. before pausing) so the server has the latest place and status. */
  private async heartbeatNow(timeoutMs = 3000): Promise<void> {
    if (this.hbInFlight) return;
    this.stopHeartbeat();
    await Promise.race([this.heartbeatTick(), new Promise((r) => setTimeout(r, timeoutMs))]);
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
        monitoring: this.runtime?.heartbeatMonitoring() ?? {
          state: 'off',
          faces: 0,
          label: this.snap.awaitingContinue ? 'Check passed — waiting for the candidate to continue' : 'Monitoring not running',
          open: [],
          cameraState: this.camera.state.state,
        },
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
    const soon = this.hbSoon;
    this.hbSoon = false;
    this.scheduleHeartbeat(soon ? 800 : HEARTBEAT_INTERVAL_MS);
  }

  private async onHeartbeat(hb: HeartbeatResponse, timing: RequestTiming): Promise<void> {
    this.clock.addSample(hb.serverTime, timing.sentAt, timing.receivedAt);
    this.countdown.sync(hb.remainingMs, hb.timerRunning, hb.serverTime, this.clock.now());
    let needReload = false;
    for (const cmd of hb.commands ?? []) {
      if (await this.handleCommand(cmd, hb)) needReload = true;
    }
    // Active on the server: answers refused while it was paused / on hold can be saved now.
    if (hb.status === 'active' && !hb.requiredCheck) {
      void this.outbox?.resumeAnswers();
      this.serverSampleRequest(hb.identitySample);
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
    if (up && !this.timeUpRunning && Date.now() - this.timeUpLastAt > 5000) void this.onTimeUp();
    return up;
  }

  /**
   * The exam clock reached zero: deliver the last answers, then send a heartbeat — the server submits
   * an expired exam when it sees it, and the status change moves the page to the ended screen.
   */
  private async onTimeUp(): Promise<void> {
    if (this.timeUpRunning) return;
    this.timeUpRunning = true;
    this.timeUpLastAt = Date.now();
    try {
      await this.answers?.flushPending();
      await this.outbox?.flushNow(5000, 'answers');
      await this.heartbeatNow();
    } finally {
      this.timeUpRunning = false;
      this.timeUpLastAt = Date.now();
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
  /**
   * Request a pause. Monitoring keeps running until the server confirms the pause: a refused or
   * failed request (reason missing, limit reached, offline) leaves no unobserved gap, and with
   * approval required monitoring continues until `pause_approved` arrives via the heartbeat.
   */
  async requestPause(reason?: string): Promise<PauseResponse> {
    const s = this.snap.state;
    if (!s) throw new Error('No session');
    await this.answers?.flushPending();
    await this.heartbeatNow(); // the server records the current question before the pause
    await this.outbox?.flushNow(FLUSH_BEFORE_TRANSITION_MS, 'answers');
    const res = await this.api.pause(reason);
    if (res.outcome === 'paused') {
      lsSet(PAUSE_REASON_KEY(s.session.id), reason?.trim() || null);
      await this.stopMonitoring('pause', { flush: true, stopCamera: true });
    } else if (res.outcome === 'pending_approval') {
      lsSet(PAUSE_REASON_KEY(s.session.id), reason?.trim() || null);
    }
    await this.applyState(res.state);
    return res;
  }

  async cancelPause(): Promise<void> {
    const { data, timing } = await this.api.cancelPause();
    await this.applyState(data, timing);
  }

  /**
   * Submit the exam after delivering all answers. Monitoring is closed out only once the server has
   * accepted the submission. Throws with a candidate-facing message on failure.
   */
  async submit(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await this.answers?.flushPending();
      void this.outbox?.resumeAnswers(); // answers refused during a pause / hold get another try
      const delivered = await (this.outbox?.flushNow(ANSWER_FLUSH_BEFORE_SUBMIT_MS, 'answers') ?? Promise.resolve(true));
      if (!delivered && (this.outbox?.stats().parkedAnswers ?? 0) > 0) {
        // The server refuses answers because the exam is paused / on hold there: show that state.
        void this.load();
        throw new Error('Your exam is paused or on hold, so it cannot be submitted right now. Your answers are saved on this device.');
      }
      if (!delivered) {
        throw new Error(
          'Some of your answers have not reached the server yet because the connection is interrupted. They are saved on this device. Please check your connection and try submitting again.',
        );
      }
      const { data, timing } = await this.api.submit();
      await this.stopMonitoring('submit', { flush: true, stopCamera: true });
      await this.applyState(data, timing);
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
