import { plausibleFaces } from '@sp/detection';
import { burstSizeFor, type FaceObservation, type IdentityCheckTrigger, type IdentitySampleRequestDTO, type IdentitySampleResponse, type NormBox } from '@sp/shared';

/**
 * Identity-sample bursts (distinct camera frames ~200 ms apart, decided together by the server: policy.identity
 * routineBurstSize frames for routine samples, burstSize for triggered ones — exam start, face changes, server
 * requests) and the triggers that start them.
 *
 *   engine signals (track_break, appearance_change, face_return, …, periodic) ─┐
 *   host: exam_start at every (re)start, server requests (state / heartbeat), ─┼─► queue (one pending, highest
 *   follow-ups (followUpInMs)                                                   ┘    priority, stale ones expire)
 *        └─► burst: on each ANALYSED frame with exactly one usable face, ≥ 150 ms after the previous burst
 *            frame, crop the face at native resolution ─► burstSize frames (or what was collected within
 *            2.5 s) ─► sent concurrently as separate requests sharing burstId (burstIndex / burstSize).
 *
 * A request from the SERVER (heartbeat / state identitySample: exam start, a faster look, or its watchdog when
 * samples stopped arriving) is honoured even when no frame qualifies: after SERVER_REQUEST_FORCE_MS the burst is
 * taken from whatever the camera shows (no face, several faces, a covered face — the server records what it sees).
 *
 * Every frame of a burst is a different camera frame (the runtime only analyses new frames). The server's
 * answer to the last frame carries the burst's receipt and the next routine sample time (nextSampleInMs);
 * intermediate answers only matter when they put the exam on hold.
 *
 * A request budget keeps the page under the server's per-link rate limit (identity/sample: 240 per minute):
 * a burst starts only when all its frames fit in the last minute's budget.
 */

/** Importance of identity-sample triggers when several are waiting (only the most important is kept). */
export const SAMPLE_PRIORITY: Record<IdentityCheckTrigger, number> = {
  track_break: 9,
  appearance_change: 8,
  exam_start: 7,
  server_request: 6,
  follow_up: 6,
  camera_reconnect: 5,
  after_multiple_people: 4,
  face_return: 3,
  after_obstruction: 2,
  periodic: 1,
  check_in: 0,
  resume: 0,
  reconnect: 0,
  reverify: 0,
  id_photo: 0,
};

/** Triggers that are never dropped as stale (the server or the exam start asked for them). */
const PERSISTENT: ReadonlySet<IdentityCheckTrigger> = new Set(['follow_up', 'exam_start', 'server_request']);

/**
 * Holds an identity-sample request until it can be captured (another burst in progress, no usable face yet,
 * request budget). The engine has already consumed its trigger, so it must not be lost; stale requests
 * expire because the situation they describe has passed.
 */
export class SampleTriggerQueue {
  private pending: { trigger: IdentityCheckTrigger; at: number; server: boolean } | null = null;

  constructor(private readonly maxAgeMs = 20_000) {}

  /** `server`: the server asked for this sample (it is then taken even without a qualifying frame, see wantsFrame). */
  push(trigger: IdentityCheckTrigger, now: number, server = false): void {
    if (!this.pending || SAMPLE_PRIORITY[trigger] > SAMPLE_PRIORITY[this.pending.trigger]) this.pending = { trigger, at: now, server };
    else if (server && !this.pending.server) this.pending = { ...this.pending, server: true, at: Math.min(this.pending.at, now) };
  }

  /** How long a server-requested sample has been waiting (null: nothing waiting, or not requested by the server). */
  serverWaitMs(now: number): number | null {
    const p = this.peek(now) ? this.pending : null;
    return p?.server ? now - p.at : null;
  }

  /** The waiting trigger without removing it (null if none / expired). */
  peek(now: number): IdentityCheckTrigger | null {
    const p = this.pending;
    if (!p) return null;
    if (!PERSISTENT.has(p.trigger) && now - p.at > this.maxAgeMs) {
      this.pending = null;
      return null;
    }
    return p.trigger;
  }

  /** The waiting trigger (removed from the queue), or null if none / expired. */
  take(now: number): IdentityCheckTrigger | null {
    const t = this.peek(now);
    this.pending = null;
    return t;
  }

  get size(): number {
    return this.pending ? 1 : 0;
  }

  clear(): void {
    this.pending = null;
  }
}

/**
 * Sliding one-minute request budget, below the server's identity/sample rate limit (240 per minute per link)
 * with room for samples the outbox delivers later.
 */
export class RequestBudget {
  private readonly times: number[] = [];

  constructor(
    readonly maxPerWindow = 180,
    readonly windowMs = 60_000,
  ) {}

  private prune(now: number): void {
    while (this.times.length && now - this.times[0] >= this.windowMs) this.times.shift();
  }

  available(now: number): number {
    this.prune(now);
    return Math.max(0, this.maxPerWindow - this.times.length);
  }

  spend(now: number, n = 1): void {
    for (let i = 0; i < n; i++) this.times.push(now);
  }
}

export interface BurstFrame {
  sampleId: string;
  capturedAt: number;
  jpeg: Blob;
}

export interface BurstResult {
  burstId: string;
  trigger: IdentityCheckTrigger;
  frames: number;
  /** The aggregated answer (last frame), or null when nothing was delivered directly (queued offline). */
  response: IdentitySampleResponse | null;
  at: number;
}

export interface SamplerDeps {
  /** Frames of a triggered burst (policy.identity.burstSize, 1–5). */
  burstSize: number;
  /** Frames of a routine (periodic) burst (policy.identity.routineBurstSize, 1–5); default burstSize. */
  routineBurstSize?: number;
  uuid: () => string;
  /** Server-corrected clock (capturedAt) and a monotonic clock for spacing / timeouts. */
  now: () => number;
  mono: () => number;
  /** Send one frame directly; throw on failure. */
  send: (frame: BurstFrame, q: { trigger: IdentityCheckTrigger; capturedAt: number; burstId?: string; burstIndex?: number; burstSize?: number }) => Promise<IdentitySampleResponse>;
  /** A frame could not be sent: keep it for later delivery (outbox) — or drop it (permanent refusal). */
  onSendFailed: (frame: BurstFrame, q: { trigger: IdentityCheckTrigger; burstId?: string; burstIndex?: number; burstSize?: number }, err: unknown) => Promise<'queued' | 'dropped' | 'fatal'>;
  /** Every direct answer (hold detection: any frame may put the exam on hold). */
  onResponse: (res: IdentitySampleResponse, final: boolean) => void;
  /** A burst started collecting frames for `trigger`. */
  onBurstStart?: (trigger: IdentityCheckTrigger) => void;
  onBurstDone?: (r: BurstResult) => void;
  onTrigger?: (e: { at: number; trigger: IdentityCheckTrigger; source: 'engine' | 'host' | 'server' }) => void;
}

/** Spacing of burst frames (the runtime analyses ~5 frames/s, so consecutive analysed frames qualify). */
export const BURST_MIN_SPACING_MS = 150;
/** A burst sends what it has after this long (the face may have left); nothing at all → the trigger waits again. */
export const BURST_TIMEOUT_MS = 2500;
/**
 * A server-requested sample waits this long for a frame with exactly one usable face; then it is taken from whatever
 * the camera shows (the server's watchdog asks when samples stopped arriving — e.g. the face is hidden).
 */
export const SERVER_REQUEST_FORCE_MS = 3000;

interface ActiveBurst {
  id: string;
  trigger: IdentityCheckTrigger;
  startedAt: number;
  lastFrameAt: number;
  frames: BurstFrame[];
  pendingCaptures: number;
  /** A server request taken without a qualifying frame: any capturable frame is used. */
  forced: boolean;
  /** Frames this burst takes (burstSizeFor its trigger). */
  size: number;
}

export class BurstSampler {
  readonly queue = new SampleTriggerQueue();
  readonly budget: RequestBudget;
  private burst: ActiveBurst | null = null;
  private sending = false;
  private examStartTaken = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  last: BurstResult | null = null;

  constructor(
    private readonly deps: SamplerDeps,
    budget?: RequestBudget,
  ) {
    this.budget = budget ?? new RequestBudget();
  }

  /** Frames of a triggered burst. */
  get size(): number {
    return this.sizeFor('exam_start');
  }

  /** Frames of a burst for this trigger: routineBurstSize for routine samples, burstSize for triggered ones. */
  sizeFor(trigger: IdentityCheckTrigger): number {
    const n = burstSizeFor(trigger, { burstSize: this.deps.burstSize, routineBurstSize: this.deps.routineBurstSize ?? null });
    return Math.max(1, Math.min(5, Math.round(n) || 1));
  }

  /** A burst is collecting frames or being sent. */
  get busy(): boolean {
    return this.burst !== null || this.sending;
  }

  pendingTrigger(): IdentityCheckTrigger | null {
    return this.burst?.trigger ?? this.queue.peek(this.deps.mono());
  }

  request(trigger: IdentityCheckTrigger, source: 'engine' | 'host' | 'server' = 'engine'): void {
    if (this.stopped) return;
    if (trigger === 'exam_start' && (this.examStartTaken || this.burst?.trigger === 'exam_start' || this.queue.peek(this.deps.mono()) === 'exam_start')) return;
    this.deps.onTrigger?.({ at: this.deps.now(), trigger, source });
    this.queue.push(trigger, this.deps.mono(), source === 'server');
  }

  /** A server request (CandidateSessionState.session.identitySample / HeartbeatResponse.identitySample). */
  serverRequest(req: IdentitySampleRequestDTO | null | undefined): void {
    if (!req || this.stopped) return;
    const trigger = req.trigger;
    if (trigger === 'exam_start' && this.examStartTaken) return; // already captured (delivery may be pending)
    if (trigger !== 'exam_start' && (this.busy || this.queue.peek(this.deps.mono()) === trigger)) return; // one is on its way
    const inMs = Number.isFinite(req.inMs) ? Math.max(0, req.inMs) : 0;
    if (inMs <= 0) this.request(trigger, 'server');
    else this.later(inMs, () => this.request(trigger, 'server'));
  }

  /** Run `fn` after `ms` unless stopped. */
  later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(id);
  }

  /**
   * Called by the runtime for every analysed frame. Returns true when the runtime should capture this frame
   * for the current burst (call `addFrame`), false otherwise. Starts a burst when a trigger waits and the
   * budget allows; finishes a burst on size or timeout. `eligible`: the frame shows exactly one usable face;
   * `capturable`: the camera can be captured at all (a server request waiting SERVER_REQUEST_FORCE_MS takes such
   * frames too).
   */
  wantsFrame(eligible: boolean, capturable: boolean = eligible): boolean {
    if (this.stopped || this.sending) return false;
    const m = this.deps.mono();
    if (!this.burst) {
      const trigger = this.queue.peek(m);
      if (!trigger) return false;
      // Start only on a usable frame (the trigger keeps waiting) — unless the server asked and has waited long enough.
      const forced = !eligible && capturable && (this.queue.serverWaitMs(m) ?? -1) >= SERVER_REQUEST_FORCE_MS;
      if (!eligible && !forced) return false;
      const size = this.sizeFor(trigger);
      if (this.budget.available(m) < size) return false;
      this.queue.take(m);
      this.burst = { id: this.deps.uuid(), trigger, startedAt: m, lastFrameAt: -Infinity, frames: [], pendingCaptures: 0, forced, size };
      if (trigger === 'exam_start') this.examStartTaken = true;
      this.deps.onBurstStart?.(trigger);
    }
    const b = this.burst;
    if (m - b.startedAt > BURST_TIMEOUT_MS) {
      void this.finish();
      return false;
    }
    if (!(eligible || (b.forced && capturable)) || b.frames.length + b.pendingCaptures >= b.size) return false;
    return m - b.lastFrameAt >= BURST_MIN_SPACING_MS;
  }

  /** Add a captured frame (the promise resolves to the JPEG, or null if the capture failed). */
  async addFrame(capture: Promise<Blob | null>, capturedAt: number): Promise<void> {
    const b = this.burst;
    if (!b) return;
    b.lastFrameAt = this.deps.mono();
    b.pendingCaptures++;
    let jpeg: Blob | null = null;
    try {
      jpeg = await capture;
    } catch {
      jpeg = null;
    }
    b.pendingCaptures--;
    if (this.burst !== b) return;
    if (jpeg) b.frames.push({ sampleId: this.deps.uuid(), capturedAt, jpeg });
    if (b.frames.length >= b.size) await this.finish();
  }

  /** Called when the loop runs without a usable frame, so a burst can still time out. */
  tick(): void {
    const b = this.burst;
    if (b && !this.sending && this.deps.mono() - b.startedAt > BURST_TIMEOUT_MS && b.pendingCaptures === 0) void this.finish();
  }

  private async finish(): Promise<void> {
    const b = this.burst;
    if (!b || this.sending) return;
    if (b.pendingCaptures > 0) return; // the capture in flight finishes it
    this.burst = null;
    if (b.frames.length === 0) {
      // Nothing usable was captured: the request waits for the next opportunity.
      if (b.trigger === 'exam_start') this.examStartTaken = false;
      this.queue.push(b.trigger, this.deps.mono());
      return;
    }
    this.sending = true;
    try {
      await this.sendBurst(b);
    } finally {
      this.sending = false;
    }
  }

  /**
   * Send the burst's frames concurrently (the server takes them in any order and decides the burst when the last
   * one arrives — one round trip instead of three). The answer carrying `burst.complete` is the decision (an older
   * server without burst bookkeeping: the last frame's answer). A hold reported by any frame wins. Frames that
   * could not be sent go to the outbox, in index order, with their burst metadata.
   */
  private async sendBurst(b: ActiveBurst): Promise<void> {
    const frames = [...b.frames].sort((x, y) => x.capturedAt - y.capturedAt);
    const size = frames.length;
    const multi = b.size > 1;
    this.budget.spend(this.deps.mono(), size);
    let last: IdentitySampleResponse | null = null;
    let decided = false;
    let held = false;
    const failed: { i: number; f: BurstFrame; q: { trigger: IdentityCheckTrigger; capturedAt: number; burstId?: string; burstIndex?: number; burstSize?: number }; e: unknown }[] = [];
    await Promise.all(
      frames.map(async (f, i) => {
        const q = { trigger: b.trigger, capturedAt: f.capturedAt, ...(multi ? { burstId: b.id, burstIndex: i, burstSize: size } : {}) };
        try {
          const res = await this.deps.send(f, q);
          if (this.stopped || held) return;
          const final = !decided && (res.burst ? res.burst.complete === true : i === size - 1);
          if (final) decided = true;
          this.deps.onResponse(res, final);
          if (res.status === 'on_hold' || res.hold) held = true;
          else if (final) last = res;
        } catch (e) {
          failed.push({ i, f, q, e });
        }
      }),
    );
    if (this.stopped) return;
    failed.sort((x, y) => x.i - y.i);
    for (const x of failed) {
      if ((await this.deps.onSendFailed(x.f, x.q, x.e)) === 'fatal') return;
    }
    if (held) return;
    const final = last as IdentitySampleResponse | null;
    this.last = { burstId: b.id, trigger: b.trigger, frames: size, response: final, at: this.deps.now() };
    this.deps.onBurstDone?.(this.last);
  }

  /** Forget a waiting trigger of this kind (e.g. a routine sample the server's new schedule replaces). */
  dropPending(trigger: IdentityCheckTrigger): void {
    if (this.queue.peek(this.deps.mono()) === trigger) this.queue.clear();
  }

  stop(): void {
    this.stopped = true;
    this.burst = null;
    this.queue.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Frame eligibility for a burst: exactly one face, not cut off, not badly obstructed (image quality is the server's call). */
export function burstEligible(faces: readonly FaceObservation[]): { box: NormBox } | null {
  const plausible = plausibleFaces(faces);
  if (plausible.length !== 1) return null;
  const f = plausible[0];
  if (f.cutOff || (Number.isFinite(f.visibility) && f.visibility < 0.3)) return null;
  return { box: f.box };
}
