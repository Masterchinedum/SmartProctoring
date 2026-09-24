import type { EngineSignal } from '@sp/shared';

export type IdentityTrigger = Extract<EngineSignal, { kind: 'identity_sample' }>['trigger'];

const PRIORITY: Record<IdentityTrigger, number> = {
  camera_reconnect: 5,
  after_multiple_people: 4,
  face_return: 3,
  after_obstruction: 2,
  periodic: 1,
};

/** Face must be stably single & usable this long before a sample is requested (so the frame is good). */
const STABLE_MS = 600;

/**
 * Decides when the host should capture a frame for a server-side identity check.
 *
 * Event-driven triggers (face return, camera reconnect, after multiple people, after obstruction) are
 * "armed" by detectors and fire as soon as exactly one usable, roughly frontal face has been visible
 * for 0.6 s — so the host captures a frame the server can actually compare. Only one trigger is pending
 * at a time (highest priority wins). Periodic samples fire every `intervalMs` under the same condition;
 * if the condition is not met when a periodic sample is due, it is taken at the next opportunity. Any
 * sample resets the periodic timer.
 */
export class IdentityScheduler {
  pending: IdentityTrigger | null = null;
  private lastSampleAt: number | null = null;
  private stableSince: number | null = null;

  constructor(public intervalMs: number) {}

  arm(trigger: IdentityTrigger): void {
    if (!this.pending || PRIORITY[trigger] > PRIORITY[this.pending]) this.pending = trigger;
  }

  step(t: number, singleUsableFace: boolean, out: EngineSignal[]): IdentityTrigger | null {
    if (this.lastSampleAt === null) this.lastSampleAt = t;
    this.stableSince = singleUsableFace ? (this.stableSince ?? t) : null;
    const stable = this.stableSince !== null && t - this.stableSince >= STABLE_MS;
    if (!stable) return null;
    let trigger: IdentityTrigger | null = null;
    if (this.pending) trigger = this.pending;
    else if (this.intervalMs > 0 && t - this.lastSampleAt >= this.intervalMs) trigger = 'periodic';
    if (!trigger) return null;
    this.pending = null;
    this.lastSampleAt = t;
    out.push({ kind: 'identity_sample', trigger });
    return trigger;
  }

  /** Forget pending triggers and restart the periodic timer at the next tick (pause / stop). */
  reset(): void {
    this.pending = null;
    this.lastSampleAt = null;
    this.stableSince = null;
  }
}
