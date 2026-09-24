import type { EngineSignal } from '@sp/shared';

export type IdentityTrigger = Extract<EngineSignal, { kind: 'identity_sample' }>['trigger'];

const PRIORITY: Record<IdentityTrigger, number> = {
  track_break: 7,
  appearance_change: 6,
  camera_reconnect: 5,
  after_multiple_people: 4,
  face_return: 3,
  after_obstruction: 2,
  periodic: 1,
};

/** Face must be stably single & sampleable this long before a sample is requested (so the frame is good). */
export const STABLE_MS = 600;
/** Possible quick swap: sample the new face as soon as it is briefly steady. */
export const FAST_STABLE_MS = 300;
const FAST: ReadonlySet<IdentityTrigger> = new Set(['track_break', 'appearance_change']);

export function triggerPriority(t: IdentityTrigger): number {
  return PRIORITY[t] ?? 0;
}

export interface IdentitySchedulerOptions {
  /** Routine interval after the start-up window (policy.identity.periodicCheckIntervalSec). */
  intervalMs: number;
  /** Faster routine interval during the start-up window (policy.identity.startupIntervalSec); default = intervalMs. */
  startupIntervalMs?: number;
  /** Length of the start-up window from the first tick after (re)start (policy.identity.startupWindowSec). */
  startupWindowMs?: number;
}

export interface IdentitySchedule {
  /** Trigger waiting for a sampleable face. */
  pending: IdentityTrigger | null;
  /** When the next routine sample is due (engine time, ms), null before the first tick / when disabled. */
  nextDueAt: number | null;
  /** The due time was set by the host (server cadence) rather than the local interval. */
  hostScheduled: boolean;
  lastSampleAt: number | null;
  /** Inside the start-up window. */
  startup: boolean;
}

/**
 * Decides when the host should capture frames for a server-side identity check.
 *
 * Event-driven triggers (track break, appearance change, camera reconnect, after multiple people, face
 * return, after obstruction) are "armed" by detectors and fire as soon as exactly one sampleable face has
 * been visible for 0.6 s (0.3 s for the quick-swap triggers) — so the host captures frames the server can
 * compare. Only one trigger is pending at a time (highest priority wins). Routine ('periodic') samples are
 * due every `startupIntervalMs` during the first `startupWindowMs` after a (re)start and every `intervalMs`
 * afterwards, unless the host scheduled the next one explicitly (server cadence, `scheduleNext`). If the face
 * is not sampleable when a sample is due it is taken at the next opportunity. Any sample (including the
 * host's own, `noteSample`) restarts the routine timer.
 *
 * "Sampleable" is decided by the engine and deliberately lenient: lighting and image quality are judged by
 * the server, which answers "unable to verify" with guidance — a dim room must never silence the samples.
 */
export class IdentityScheduler {
  pending: IdentityTrigger | null = null;
  private lastSampleAt: number | null = null;
  private stableSince: number | null = null;
  private startedAt: number | null = null;
  private hostDueAt: number | null = null;
  private lastT: number | null = null;
  readonly intervalMs: number;
  readonly startupIntervalMs: number;
  readonly startupWindowMs: number;

  constructor(opts: IdentitySchedulerOptions | number) {
    const o: IdentitySchedulerOptions = typeof opts === 'number' ? { intervalMs: opts } : opts;
    this.intervalMs = Math.max(0, o.intervalMs);
    this.startupIntervalMs = o.startupIntervalMs != null && o.startupIntervalMs > 0 ? o.startupIntervalMs : this.intervalMs;
    this.startupWindowMs = Math.max(0, o.startupWindowMs ?? 0);
  }

  arm(trigger: IdentityTrigger): void {
    if (!this.pending || triggerPriority(trigger) > triggerPriority(this.pending)) this.pending = trigger;
  }

  /** Current routine interval at time t (start-up window or regular). */
  interval(t: number): number {
    if (this.intervalMs <= 0) return 0;
    const inStartup = this.startedAt !== null && this.startupWindowMs > 0 && t - this.startedAt < this.startupWindowMs;
    return inStartup ? this.startupIntervalMs : this.intervalMs;
  }

  /** When the next routine sample is due (null before the first tick or when routine sampling is off). */
  dueAt(t: number): number | null {
    if (this.hostDueAt !== null) return this.hostDueAt;
    if (this.lastSampleAt === null) return null;
    const iv = this.interval(t);
    return iv > 0 ? this.lastSampleAt + iv : null;
  }

  /**
   * Host-driven cadence (server `nextSampleInMs`, faster sampling while the evidence is uncertain): the next
   * routine sample is due at `at`. `null` returns to the local interval.
   */
  scheduleNext(at: number | null): void {
    this.hostDueAt = at != null && Number.isFinite(at) ? at : null;
  }

  /** The host took a sample itself (exam start, server follow-up …): restart the routine timer. */
  noteSample(t: number): void {
    this.lastSampleAt = t;
    this.hostDueAt = null;
  }

  step(t: number, sampleable: boolean, out: EngineSignal[]): IdentityTrigger | null {
    this.lastT = t;
    if (this.startedAt === null) this.startedAt = t;
    if (this.lastSampleAt === null) this.lastSampleAt = t;
    this.stableSince = sampleable ? (this.stableSince ?? t) : null;
    const need = this.pending && FAST.has(this.pending) ? FAST_STABLE_MS : STABLE_MS;
    const stable = this.stableSince !== null && t - this.stableSince >= need;
    if (!stable) return null;
    let trigger: IdentityTrigger | null = null;
    if (this.pending) trigger = this.pending;
    else {
      const due = this.dueAt(t);
      if (due !== null && t >= due) trigger = 'periodic';
    }
    if (!trigger) return null;
    this.pending = null;
    this.lastSampleAt = t;
    this.hostDueAt = null;
    out.push({ kind: 'identity_sample', trigger });
    return trigger;
  }

  schedule(): IdentitySchedule {
    const t = this.lastT;
    return {
      pending: this.pending,
      nextDueAt: t === null ? null : this.dueAt(t),
      hostScheduled: this.hostDueAt !== null,
      lastSampleAt: this.lastSampleAt,
      startup: t !== null && this.startedAt !== null && this.startupWindowMs > 0 && t - this.startedAt < this.startupWindowMs,
    };
  }

  /** Forget pending triggers and restart the timers (and the start-up window) at the next tick (pause / stop). */
  reset(): void {
    this.pending = null;
    this.lastSampleAt = null;
    this.stableSince = null;
    this.startedAt = null;
    this.hostDueAt = null;
    this.lastT = null;
  }
}
