import { classifyCameraLabel, type CameraLabelClassification } from '../../camera/label';
import { parseHash64, popcount32 } from '../../metrics/hash';
import type { DetectorHost, TickContext } from '../context';
import { dur, type FlushReason } from '../span';
import { round } from '../../util/math';

const VIRTUAL_KEY = 'camera_feed_suspect:virtual';
const REPLAY_KEY = 'camera_feed_suspect:replay';

/** Replay detection parameters. */
export const REPLAY = {
  sampleMs: 1000,
  /** ~10 minutes of 1 Hz samples. */
  capacity: 600,
  /** Query length (most recent samples). */
  querySamples: 6,
  /** Per-sample match tolerance (bits of 64). */
  matchBits: 4,
  /** A consecutive-sample change above this counts as motion. */
  motionBits: 4,
  /** Motion transitions required inside the query (static scenes carry no evidence). */
  minMotionTransitions: 2,
  /** The matched earlier run must start at least this long before the query. */
  minLagMs: 15000,
  /** Consecutive matching evaluations needed to open. */
  confirmEvaluations: 2,
  /** Close after this long without a match. */
  clearMs: 10000,
} as const;

/**
 * camera_feed_suspect, two independent signals (separate episodes, details.signal distinguishes):
 *
 * (a) 'virtual_camera_label' — the active camera's label matches virtual-camera software (or, with lower
 *     confidence, a phone-as-webcam app). Opens immediately on setCameraInfo; closes when the camera
 *     changes. Re-opened after a flush if the same camera is still in use.
 * (b) 'repeating_footage' — ~1 Hz dHash history (bounded ring, ~10 min). When the most recent 6 samples
 *     contain motion (≥ 2 consecutive changes > 4 bits) and each is within 4 bits of the corresponding
 *     sample of a contiguous earlier run that started ≥ 15 s before, on 2 consecutive evaluations, the
 *     footage is repeating. A still person / static scene never matches (no motion); a frozen feed has no
 *     motion either. Once open, any continued match keeps it open; closes after 10 s without a match.
 */
export class FeedDetector {
  // virtual label
  private label = '';
  private deviceIdHash = '';
  private cls: CameraLabelClassification = { kind: 'none', confidence: 0, match: null };
  private virtualOpen = false;
  private virtualSince = 0;
  // replay
  private hi = new Uint32Array(REPLAY.capacity);
  private lo = new Uint32Array(REPLAY.capacity);
  private ts = new Float64Array(REPLAY.capacity);
  private head = 0;
  private len = 0;
  private lastSample = -Infinity;
  private streak = 0;
  private streakStart = 0;
  private replayOpen = false;
  private lastMatch = 0;
  private lagMs = 0;
  private matches = 0;

  constructor(private host: DetectorHost) {}

  private get enabled(): boolean {
    return this.host.policy.enabled.cameraIntegrity;
  }

  get camera(): { label: string; deviceIdHash: string } {
    return { label: this.label, deviceIdHash: this.deviceIdHash };
  }

  /** Returns true if the device changed (not on the first call). */
  setCamera(info: { label: string; deviceIdHash: string }, t: number): boolean {
    const first = this.label === '' && this.deviceIdHash === '';
    const changed = !first && info.deviceIdHash !== this.deviceIdHash;
    const newCls = classifyCameraLabel(info.label);
    const labelChanged = info.label !== this.label;
    if (this.virtualOpen && (changed || (labelChanged && newCls.kind === 'none'))) this.closeVirtual(t);
    if (changed) this.clearHistory(t);
    this.label = info.label ?? '';
    this.deviceIdHash = info.deviceIdHash ?? '';
    this.cls = newCls;
    if (!this.virtualOpen && this.enabled && this.cls.kind !== 'none') this.openVirtual(t);
    return changed;
  }

  step(ctx: TickContext): void {
    if (!this.enabled) return;
    const t = ctx.t;
    if (!this.virtualOpen && this.cls.kind !== 'none') this.openVirtual(t);
    if (this.replayOpen && t - this.lastMatch >= REPLAY.clearMs + REPLAY.sampleMs) this.closeReplay(t, this.lastMatch);
    if (!ctx.live || !ctx.frame || ctx.covered || t - this.lastSample < REPLAY.sampleMs * 0.9) return;
    const h = parseHash64(ctx.frame.dhash);
    if (!h) return;
    this.lastSample = t;
    this.push(h[0], h[1], t);
    this.evaluate(t);
  }

  /** Camera restarted / device changed: history no longer comparable. */
  clearHistory(t: number): void {
    if (this.replayOpen) this.closeReplay(t, this.lastMatch || t);
    this.head = 0;
    this.len = 0;
    this.lastSample = -Infinity;
    this.streak = 0;
  }

  flush(t: number, reason: FlushReason): void {
    if (this.virtualOpen) this.closeVirtual(t, reason);
    if (this.replayOpen) this.closeReplay(t, Math.max(this.lastMatch, this.streakStart), reason);
    this.streak = 0;
    // Keep the dHash history across a pause: replaying earlier footage after resuming is still a replay.
    if (reason === 'stop' || reason === 'submit') this.clearHistory(t);
  }

  reset(): void {
    this.clearHistory(0);
    this.virtualOpen = false;
    this.replayOpen = false;
  }

  /* ------------------------------------------------------------------ virtual label */

  private openVirtual(t: number): void {
    const phone = this.cls.kind === 'phone_as_webcam';
    const label = this.label.slice(0, 120);
    const { update } = this.host.book.begin(VIRTUAL_KEY, 'camera_feed_suspect', t, t, {
      confidence: this.cls.confidence,
      details: { signal: 'virtual_camera_label', cameraLabel: label, matched: this.cls.match, kind: this.cls.kind },
      observation: phone
        ? `The camera device name (“${label}”) matches an app that streams a phone’s camera; the video may come from another device.`
        : `The camera device name (“${label}”) matches virtual-camera software, which can substitute other video for the camera.`,
    });
    this.host.episodes.push(update);
    this.virtualOpen = true;
    this.virtualSince = t;
  }

  private closeVirtual(t: number, closedBy?: FlushReason): void {
    const d = round((t - this.virtualSince) / 1000, 1);
    const details: Record<string, unknown> = { signal: 'virtual_camera_label', cameraLabel: this.label.slice(0, 120), matched: this.cls.match, kind: this.cls.kind, durationSec: d };
    if (closedBy) details.closedBy = closedBy;
    const u = this.host.book.end(VIRTUAL_KEY, t, t, {
      confidence: this.cls.confidence,
      details,
      observation: `A camera whose device name (“${this.label.slice(0, 120)}”) matches virtual-camera or phone-camera software was in use for ${dur(d)}.`,
    });
    if (u) this.host.episodes.push(u);
    this.virtualOpen = false;
  }

  /* ------------------------------------------------------------------ replay */

  private push(hi: number, lo: number, t: number): void {
    const cap = REPLAY.capacity;
    const idx = (this.head + this.len) % cap;
    this.hi[idx] = hi;
    this.lo[idx] = lo;
    this.ts[idx] = t;
    if (this.len < cap) this.len++;
    else this.head = (this.head + 1) % cap;
  }

  private dist(i: number, j: number): number {
    const cap = REPLAY.capacity;
    const a = (this.head + i) % cap;
    const b = (this.head + j) % cap;
    return popcount32((this.hi[a] ^ this.hi[b]) >>> 0) + popcount32((this.lo[a] ^ this.lo[b]) >>> 0);
  }

  private time(i: number): number {
    return this.ts[(this.head + i) % REPLAY.capacity];
  }

  private evaluate(t: number): void {
    const Q = REPLAY.querySamples;
    if (this.len < Q * 2 + 2) return;
    const q0 = this.len - Q;
    let motion = 0;
    for (let i = q0; i < this.len - 1; i++) if (this.dist(i, i + 1) > REPLAY.motionBits) motion++;
    const needMotion = !this.replayOpen;
    if (needMotion && motion < REPLAY.minMotionTransitions) {
      this.streak = 0;
      return;
    }
    const latestStart = this.time(q0) - REPLAY.minLagMs;
    let found = -1;
    // Most recent earlier run first.
    for (let j = q0 - Q; j >= 0; j--) {
      if (this.time(j) > latestStart) continue;
      let ok = true;
      for (let i = 0; i < Q; i++) {
        if (this.dist(j + i, q0 + i) > REPLAY.matchBits) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      this.streak = 0;
      return;
    }
    this.lagMs = this.time(q0) - this.time(found);
    this.lastMatch = t;
    this.matches++;
    if (this.replayOpen) {
      const u = this.host.book.touch(REPLAY_KEY, t, '', () => this.replayData(t, null), {});
      if (u) this.host.episodes.push(u);
      return;
    }
    if (this.streak === 0) this.streakStart = this.time(q0);
    this.streak++;
    if (this.streak >= REPLAY.confirmEvaluations) {
      const { update } = this.host.book.begin(REPLAY_KEY, 'camera_feed_suspect', this.streakStart, t, this.replayData(t, null));
      this.host.episodes.push(update);
      this.replayOpen = true;
      this.matches = this.streak;
      this.streak = 0;
    }
  }

  private replayData(t: number, endedAt: number | null) {
    const d = round(((endedAt ?? t) - this.streakStart) / 1000, 1);
    const lag = round(this.lagMs / 1000, 0);
    return {
      confidence: Math.min(0.9, 0.6 + 0.03 * this.matches),
      details: { signal: 'repeating_footage', durationSec: d, repeatLagSec: lag, matchedWindows: this.matches, windowSec: REPLAY.querySamples },
      observation:
        endedAt === null
          ? `The camera images closely match a sequence from about ${lag} s earlier, which can happen when recorded video is replayed.`
          : `For ${dur(d)} the camera images closely matched earlier footage (repeating about every ${lag} s), which can happen when recorded video is replayed.`,
    };
  }

  private closeReplay(t: number, endedAt: number, closedBy?: FlushReason): void {
    const d = this.replayData(t, endedAt);
    if (closedBy) d.details = { ...d.details, closedBy } as typeof d.details;
    const u = this.host.book.end(REPLAY_KEY, endedAt, t, d);
    if (u) this.host.episodes.push(u);
    this.replayOpen = false;
    this.matches = 0;
  }
}
