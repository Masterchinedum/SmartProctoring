import { classifyCameraLabel, type CameraLabelClassification } from '../../camera/label';
import { parseHash64, popcount32 } from '../../metrics/hash';
import type { DetectorHost, TickContext } from '../context';
import { dur, type FlushReason } from '../span';
import { round } from '../../util/math';

const VIRTUAL_KEY = 'camera_feed_suspect:virtual';
const REPLAY_KEY = 'camera_feed_suspect:replay';

/** Replay detection parameters. */
export const REPLAY = {
  /** History sampling period. */
  sampleMs: 1000,
  /** ~10 minutes of 1 Hz samples. */
  capacity: 600,
  /** Query length (most recent 1 Hz samples). */
  querySamples: 12,
  /** Per-sample match tolerance (bits of 64); raised in noisy scenes to noise floor + 2. */
  matchBits: 4,
  /** Motion content required in the query: Σ max(0, consecutive distance − noise floor − 1) (bits). */
  minMotionBits: 16,
  /** The best alignment's total distance must be ≤ this × the typical (10th percentile) other alignment … */
  discrimination: 0.4,
  /** … and at least this many bits better (absolute margin). */
  minMarginBits: 16,
  /** Each earlier sample may match any recent full-rate frame within ± this (loop phase offset). */
  phaseTolMs: 600,
  /** The matched earlier run must start at least this long before the query. */
  minLagMs: 15000,
  /** Consecutive matching evaluations (at a consistent lag, ±1 sample) needed to open. */
  confirmEvaluations: 3,
  /** Close after this long without a match. */
  clearMs: 10000,
} as const;

/**
 * camera_feed_suspect, two independent signals (separate episodes, details.signal distinguishes):
 *
 * (a) 'virtual_camera_label' — the active camera's label matches virtual-camera software (or, with lower
 *     confidence, a phone-as-webcam app). Opens immediately on setCameraInfo; closes when the camera
 *     changes. Re-opened after a flush if the same camera is still in use.
 * (b) 'repeating_footage' — ~1 Hz dHash history (bounded ring, ~10 min). When the most recent 12 samples
 *     contain motion (accumulated consecutive-sample change above the noise floor) and every one of them
 *     matches (≤ 4 bits, more in noisy scenes) the corresponding sample of a contiguous earlier run that
 *     started ≥ 15 s before — on 3 consecutive evaluations at the same lag — the footage is repeating. A replayed loop is not sampled at the same phase in every
 *     iteration, so each earlier sample is compared with the recent full-rate frames within ±0.6 s of the
 *     corresponding query time. A still person / static scene never matches (no motion); a frozen feed
 *     has no motion either; a live person who happens to repeat one movement does not produce 3+ matching
 *     motion changes at the same relative timing. Once open, any continued match keeps it open; closes
 *     after 10 s without a match.
 *     Robustness to camera noise: thresholds adapt to the scene's dHash noise floor (25th percentile of
 *     consecutive-sample distances), and the best earlier alignment must be DISCRIMINATIVE — its total
 *     distance ≤ 0.4 × the 10th percentile of all other alignments (excluding other loop iterations) and
 *     ≥ 16 bits better. In live footage many alignments fit about equally well (static periods) or none
 *     does; a coincidental repeat of one or two movements does not persist for 3 evaluations with enough
 *     motion. This is stricter than a plain "6 samples within 4 bits" rule on purpose: dHash noise on
 *     flat backgrounds alone can flip 3–5 bits between frames.
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
  private streakLag = 0;
  private replayOpen = false;
  private lastMatch = 0;
  private lagMs = 0;
  private matches = 0;
  /** Recent full-rate frames (t, hash) covering the query span plus the phase tolerance. */
  private recent: { t: number; hi: number; lo: number }[] = [];
  /** Recent consecutive 1 Hz sample distances (noise floor estimate). */
  private consec: number[] = [];

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
    if (!ctx.live || !ctx.frame || ctx.covered) return;
    const h = parseHash64(ctx.frame.dhash);
    if (!h) return;
    this.recent.push({ t, hi: h[0], lo: h[1] });
    const keepMs = (REPLAY.querySamples + 1) * REPLAY.sampleMs + 2 * REPLAY.phaseTolMs;
    while (this.recent.length > 0 && this.recent[0].t < t - keepMs) this.recent.shift();
    if (t - this.lastSample < REPLAY.sampleMs * 0.9) return;
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
    this.recent = [];
    this.consec = [];
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

  /** Hamming distance between history samples i and j (0 = oldest). */
  private dist(i: number, j: number): number {
    const cap = REPLAY.capacity;
    const a = (this.head + i) % cap;
    const b = (this.head + j) % cap;
    return popcount32((this.hi[a] ^ this.hi[b]) >>> 0) + popcount32((this.lo[a] ^ this.lo[b]) >>> 0);
  }

  private time(i: number): number {
    return this.ts[(this.head + i) % REPLAY.capacity];
  }

  private noiseFloor(): number {
    if (this.consec.length < 10) return 0;
    const sorted = [...this.consec].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.25)];
  }

  private evaluate(t: number): void {
    const Q = REPLAY.querySamples;
    if (this.len >= 2) {
      this.consec.push(this.dist(this.len - 2, this.len - 1));
      if (this.consec.length > 120) this.consec.shift();
    }
    if (this.len < Q * 2 + 5) return;
    const floor = this.noiseFloor();
    const matchThr = Math.max(REPLAY.matchBits, floor + 2);
    const q0 = this.len - Q;
    let motion = 0;
    for (let i = q0; i < this.len - 1; i++) motion += Math.max(0, this.dist(i, i + 1) - floor - 1);
    if (!this.replayOpen && motion < REPLAY.minMotionBits) {
      this.streak = 0;
      return;
    }
    // Candidate recent frames per query position (phase tolerance).
    const near: { hi: number; lo: number }[][] = [];
    for (let k = 0; k < Q; k++) {
      const qt = this.time(q0 + k);
      near.push(this.recent.filter((r) => Math.abs(r.t - qt) <= REPLAY.phaseTolMs));
    }
    if (near.some((n) => n.length === 0)) return;
    const cap = REPLAY.capacity;
    const dk = (j: number, k: number): number => {
      const a = (this.head + j + k) % cap;
      const hi = this.hi[a];
      const lo = this.lo[a];
      let m = 64;
      for (const r of near[k]) {
        const d = popcount32((hi ^ r.hi) >>> 0) + popcount32((lo ^ r.lo) >>> 0);
        if (d < m) m = d;
      }
      return m;
    };
    // Total distance of every eligible earlier alignment.
    const latestStart = this.time(q0) - REPLAY.minLagMs;
    const totals: { j: number; total: number; worst: number }[] = [];
    for (let j = q0 - Q; j >= 0; j--) {
      if (this.time(j) > latestStart) continue;
      let total = 0;
      let worst = 0;
      for (let k = 0; k < Q; k++) {
        const d = dk(j, k);
        total += d;
        if (d > worst) worst = d;
      }
      totals.push({ j, total, worst });
    }
    let best: { j: number; total: number; worst: number } | null = null;
    for (const c of totals) if (c.worst <= matchThr && (!best || c.total < best.total)) best = c;
    if (!best) {
      this.streak = 0;
      return;
    }
    if (!this.replayOpen) {
      // Discrimination: exclude alignments at multiples of the lag (other loop iterations).
      const lag = q0 - best.j;
      const others = totals
        .filter((c) => {
          const l = q0 - c.j;
          const n = Math.max(1, Math.round(l / lag));
          return Math.abs(l - n * lag) > 2;
        })
        .map((c) => c.total)
        .sort((a, b) => a - b);
      const ref = others.length >= 10 ? others[Math.floor(others.length * 0.1)] : null;
      if (ref === null || best.total > REPLAY.discrimination * ref || ref - best.total < REPLAY.minMarginBits) {
        this.streak = 0;
        return;
      }
      // Consecutive confirmations must agree on the lag (±1 sample).
      const lagSamples = q0 - best.j;
      if (this.streak > 0 && Math.abs(lagSamples - this.streakLag) > 1) this.streak = 0;
      this.streakLag = lagSamples;
    }
    this.lagMs = this.time(q0) - this.time(best.j);
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
