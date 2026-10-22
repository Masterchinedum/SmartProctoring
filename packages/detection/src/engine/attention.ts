import type { ActivityTiming, Baseline, DetectionPolicy, FaceObservation } from '@sp/shared';
import { clamp } from '../util/math';

/**
 * Where is the candidate's attention, relative to where THIS candidate looks while working?
 * (docs/accuracy/detection.md §2.3)
 *
 * Candidates look at the screen, not the camera: they read anywhere on it, look down at the keyboard while
 * typing, and look up while thinking. The calibration baseline (captured once per period while the candidate
 * looks at the check screen / camera) is only a prior. While the exam page reports interaction timing
 * (FrameObservation.activity), this model learns online, with robust statistics over bounded memory:
 *
 *  - the SCREEN region: head pose while the candidate is visibly engaged with the screen (pointer movement,
 *    clicks, scrolling or an answer change within `engageMs`, no typing), plus, once learned, typing samples
 *    inside it and calm reading (a steady head inside its core). Centre = median head pose; extent = 10th–90th
 *    percentiles of the attention offsets (min / max sizes); limits = max(policy threshold, extent + margin);
 *  - the KEYBOARD cone: attention while typing, below the screen region and near its horizontal centre, each
 *    sample confirmed by a later keystroke (so looking at a phone right after the last key is never learned);
 *  - the eye-gaze centre (and range) while engaged with the screen.
 * Until enough engaged samples exist (cold start) the region is centred on the baseline with generous extra
 * limits (`coldExtra`), blending into the learned region as samples arrive. Without activity reports (older
 * clients, old traces) or with policy.attentionReference = 'calibration' nothing is learned: the baseline is
 * the centre and the policy thresholds the limits.
 *
 * Away decision (per tick, attention offset (h, v) from the screen centre, normalised by the limits):
 *  - away outside the boundary (|h|/side)^p + (|v|/vertical)^p ≥ 1 (p = `boundaryPower` for the learned region,
 *    a box in calibration-only mode);
 *  - a DOWNWARD breach inside the keyboard cone is EXCUSED while a key was pressed within
 *    policy.typingExcuseSec; a side breach never is. Looking down without typing — a phone in the lap, notes —
 *    still counts (and the gaze detector counts a look that outlasts the excuse from the last keystroke);
 *  - `up`: a look mostly above the region, or whose gaze elevation is ≥ `upThinkMinDeg` without an extreme side
 *    turn (thinking up-left / up-right). The gaze detector gives it lookUpSec and keeps it out of glance
 *    patterns unless clearly beyond the region (`upPatternExtraDeg`).
 * Eye gaze (blendshape estimate, ±1 ≈ 25° horizontal / 20° vertical) does not turn reading into "away":
 * 'confirm' mode (default) adds the eyes (beyond a dead zone around the learned gaze centre) only where the HEAD
 * is already clearly turned the same way — ramping in between `confirmFrom` and `confirmFull` of the limit — and
 * always when they counter-rotate back toward the screen. The alternatives ('deadzone' — the previous fixed dead
 * zone, 'learned' — gaze beyond the learned reading range) were measured (docs/accuracy/detection.md §4.2).
 *
 * The learned state survives pause / resume within a session (exportState / constructor) while the camera is
 * unchanged; it is reset on a camera change or when a new baseline moved by more than `resetShiftDeg`.
 */

export type GazeMode = 'confirm' | 'deadzone' | 'learned';

export interface AttentionParams {
  gazeMode: GazeMode;
  /**
   * Shape of the away boundary in limit-normalised space: away when (|h|/side)^p + (|v|/vertical)^p ≥ 1.
   * Infinity = a box (each axis on its own); 2 = an ellipse (a glance that is well off in BOTH directions —
   * down and to the side, where notes lie — counts before either limit is reached). Applies to the learned
   * region; calibration-only mode keeps the box (its centre may be off by the work-pose offset).
   */
  boundaryPower: number;
  /** Gaze (−1..1) → degrees. */
  gazeXDeg: number;
  gazeYDeg: number;
  /** Dead zone around the gaze centre (−1..1 units): 'confirm' and 'learned' modes. */
  gazeDeadzone: number;
  /** 'deadzone' mode: dead-zone width, and whether it is centred on the learned gaze centre (else on 0). */
  fixedDeadzone: number;
  deadzoneCentred: boolean;
  /** 'confirm': eyes count from this fraction of the limit of head turn (…to full at `confirmFull`). */
  confirmFrom: number;
  confirmFull: number;
  /** Interaction within this long = engaged (ms). */
  engageMs: number;
  /** Interaction samples for a fully learned screen region. */
  warmSamples: number;
  /** Learned extent → limit margin (deg). */
  marginDeg: number;
  minExtent: { side: number; up: number; down: number };
  maxExtent: { side: number; up: number; down: number };
  /** Extra limits during cold start (fades out as the region is learned). */
  coldExtra: { side: number; up: number; down: number };
  /**
   * Keyboard cone before it is learned: |h| ≤ x, bottom ≤ v < 0 (deg from the screen centre). Keyboard samples
   * are only taken within ±x, so notes to the side can never become "the keyboard" (a touch typist copying).
   */
  kbPrior: { x: number; bottom: number };
  kbMargin: number;
  kbMinHalfWidth: number;
  kbMaxHalfWidth: number;
  /** The learned cone's centre stays within ±this of the screen centre (deg). */
  kbMaxCentre: number;
  /** A keyboard sample is learned only if another key follows within this long (ms). */
  kbConfirmMs: number;
  /** Keyboard cone never shallower than this below the screen centre (deg). */
  kbMinDepth: number;
  kbMinSamples: number;
  /** An 'up' glance joins glance patterns only this far beyond the up limit (deg). */
  upPatternExtraDeg: number;
  /**
   * A look at least this far ABOVE the screen centre (deg) that is not an extreme side turn (< upSideMax × the
   * side limit) is a thinking look-up even when it goes more sideways than up (up-left / up-right). Second
   * screens, notes and people beside the desk are at eye level or below.
   */
  upThinkMinDeg: number;
  upSideMax: number;
  /** A new baseline this far from the one the region was learned with resets it (deg). */
  resetShiftDeg: number;
  /** Interaction samples are accepted this far from the baseline (deg). */
  sanityYaw: number;
  sanityPitch: number;
  caps: { pointer: number; typed: number; calm: number; keyboard: number };
  rebuildMs: number;
  /** Calm reading: head range over the last `calmTicks` ticks within this (deg). */
  calmRangeDeg: number;
  calmTicks: number;
}

export const ATTENTION: Readonly<AttentionParams> = Object.freeze({
  gazeMode: 'confirm',
  boundaryPower: 3,
  gazeXDeg: 25,
  gazeYDeg: 20,
  gazeDeadzone: 0.1,
  fixedDeadzone: 0.15,
  deadzoneCentred: false,
  confirmFrom: 0.3,
  confirmFull: 0.65,
  engageMs: 1500,
  warmSamples: 25,
  marginDeg: 10,
  minExtent: Object.freeze({ side: 6, up: 5, down: 6 }),
  maxExtent: Object.freeze({ side: 20, up: 15, down: 14 }),
  coldExtra: Object.freeze({ side: 10, up: 10, down: 12 }),
  kbPrior: Object.freeze({ x: 12, bottom: -55 }),
  kbMargin: 5,
  kbMinHalfWidth: 10,
  kbMaxHalfWidth: 14,
  kbMaxCentre: 5,
  kbConfirmMs: 1000,
  kbMinDepth: 30,
  kbMinSamples: 15,
  upPatternExtraDeg: 10,
  upThinkMinDeg: 12,
  upSideMax: 1.4,
  resetShiftDeg: 15,
  sanityYaw: 55,
  sanityPitch: 40,
  caps: Object.freeze({ pointer: 600, typed: 300, calm: 300, keyboard: 400 }),
  rebuildMs: 1000,
  calmRangeDeg: 4,
  calmTicks: 5,
}) as Readonly<AttentionParams>;

/** Serializable learned state (bounded: a few thousand numbers). Kept in memory by the host between periods. */
export interface AttentionState {
  v: 1;
  /** Camera the region was learned with (setCameraInfo deviceIdHash). */
  cameraId: string | null;
  /** Baseline (yaw, pitch) the region was learned with. */
  prior: { yaw: number; pitch: number } | null;
  /** Samples, flattened [yaw, pitch, gazeX, gazeY] × n (oldest first). */
  pointer: number[];
  typed: number[];
  calm: number[];
  keyboard: number[];
}

export interface AttentionLimits {
  /** Toward the candidate's left (h > 0) / right (h < 0), up (v > 0), down (v < 0) — positive degrees. */
  left: number;
  right: number;
  up: number;
  down: number;
}

export interface KeyboardCone {
  xLo: number;
  xHi: number;
  bottom: number;
}

export interface AttentionAssessment {
  /** Attention offset from the screen centre (head + gaze contribution), deg: h+ = left, v+ = up. */
  h: number;
  v: number;
  /** Head-only offset from the screen centre. */
  headH: number;
  headV: number;
  /** Counts as away (after the typing excuse). */
  away: boolean;
  /** Away only by looking up. */
  up: boolean;
  /** Would be away, excused because the candidate is typing and looking at the keyboard. */
  excused: boolean;
  /** Downward attention inside the keyboard cone. */
  inKeyboard: boolean;
  typingRecent: boolean;
  /** Last keystroke (epoch ms; −Infinity if none). */
  lastKeyAt: number;
  limits: AttentionLimits;
}

export type AttentionReference = 'learned' | 'cold_start' | 'calibration';

export interface AttentionInfo {
  reference: AttentionReference;
  /** Screen centre (absolute head pose, deg) and its offset from the baseline. */
  centre: { yaw: number; pitch: number };
  offsetFromBaseline: { yaw: number; pitch: number };
  limits: AttentionLimits;
  keyboard: KeyboardCone;
  samples: { pointer: number; typed: number; calm: number; keyboard: number };
  /** 0..1: how much the region is learned (vs the cold-start prior). */
  warmth: number;
}

/** Fixed-capacity ring of 4-tuples. */
class SampleRing {
  private buf: Float64Array;
  private head = 0;
  size = 0;
  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity * 4);
  }
  push(a: number, b: number, c: number, d: number): void {
    const i = ((this.head + this.size) % this.capacity) * 4;
    this.buf[i] = a;
    this.buf[i + 1] = b;
    this.buf[i + 2] = c;
    this.buf[i + 3] = d;
    if (this.size < this.capacity) this.size++;
    else this.head = (this.head + 1) % this.capacity;
  }
  get(k: number, j: number): number {
    return this.buf[((this.head + k) % this.capacity) * 4 + j];
  }
  clear(): void {
    this.head = 0;
    this.size = 0;
  }
  export(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.size; k++) for (let j = 0; j < 4; j++) out.push(Math.round(this.get(k, j) * (j < 2 ? 10 : 1000)) / (j < 2 ? 10 : 1000));
    return out;
  }
  import(flat: unknown): void {
    this.clear();
    if (!Array.isArray(flat)) return;
    const n = Math.floor(flat.length / 4);
    for (let k = Math.max(0, n - this.capacity); k < n; k++) {
      const v = flat.slice(k * 4, k * 4 + 4) as unknown[];
      if (v.every((x) => typeof x === 'number' && Number.isFinite(x))) this.push(v[0] as number, v[1] as number, v[2] as number, v[3] as number);
    }
  }
}

function quantile(sorted: Float64Array | number[], q: number): number {
  const n = sorted.length;
  if (!n) return NaN;
  const idx = clamp(q * (n - 1), 0, n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sortedOf(values: number[]): Float64Array {
  return Float64Array.from(values).sort();
}

const latest = (...xs: (number | null | undefined)[]): number => {
  let m = -Infinity;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x) && x > m) m = x;
  return m;
};

function deadzone(g: number, dz: number): number {
  if (!Number.isFinite(g)) return 0;
  const a = Math.abs(g) - dz;
  return a > 0 ? Math.sign(g) * a : 0;
}

export class AttentionModel {
  readonly p: AttentionParams;
  private prior = { yaw: 0, pitch: 0 };
  private priorSet = false;
  private cameraId: string | null = null;
  /** The host reports exam-page activity (any observation carried `activity`). */
  private adaptive = false;
  private readonly learn: boolean;
  private readonly pointer: SampleRing;
  private readonly typed: SampleRing;
  private readonly calm: SampleRing;
  private readonly keyboard: SampleRing;
  private calmToggle = false;
  /**
   * Keyboard samples wait for a LATER keystroke (within kbConfirmMs) before they are learned: looking down
   * right after the last key (a phone in the lap) must not teach the model that the phone is the keyboard.
   */
  private kbPending: { t: number; yaw: number; pitch: number; gx: number; gy: number }[] = [];
  private recent: { yaw: number; pitch: number }[] = [];
  /** New samples since the last rebuild (rebuilt at most every rebuildMs). */
  private dirty = true;
  /** Rebuild on the next tick (baseline, camera, mode change). */
  private force = true;
  private lastRebuild = -Infinity;
  // Derived region.
  private centre = { yaw: 0, pitch: 0 };
  private gazeCentre = { x: 0, y: -0.05 };
  private gazeRange = { xLo: -0.45, xHi: 0.45, yLo: -0.45, yHi: 0.3 };
  private extent = { left: 0, right: 0, up: 0, down: 0 };
  private lim: AttentionLimits;
  private kb: KeyboardCone;
  private warmth = 0;

  constructor(
    private readonly policy: DetectionPolicy,
    params: Partial<AttentionParams> = {},
    state?: AttentionState | null,
  ) {
    this.p = { ...ATTENTION, ...params };
    this.learn = policy.attentionReference !== 'calibration';
    const c = this.p.caps;
    this.pointer = new SampleRing(c.pointer);
    this.typed = new SampleRing(c.typed);
    this.calm = new SampleRing(c.calm);
    this.keyboard = new SampleRing(c.keyboard);
    this.lim = this.policyLimits();
    this.kb = { xLo: -this.p.kbPrior.x, xHi: this.p.kbPrior.x, bottom: this.p.kbPrior.bottom };
    if (state && state.v === 1) this.importState(state);
  }

  /** The policy thresholds (the limits without learning). */
  policyLimits(): AttentionLimits {
    const p = this.policy;
    return { left: p.lookAwayYawDeg, right: p.lookAwayYawDeg, up: p.lookUpPitchDeg, down: p.lookDownPitchDeg };
  }

  /* ------------------------------------------------------------------ host events */

  setBaseline(b: Baseline | null): void {
    if (!b) return;
    const moved = this.priorSet && (Math.abs(b.yaw - this.prior.yaw) > this.p.resetShiftDeg || Math.abs(b.pitch - this.prior.pitch) > this.p.resetShiftDeg);
    if (moved) this.clearSamples();
    this.prior = { yaw: b.yaw, pitch: b.pitch };
    this.priorSet = true;
    this.force = true;
  }

  /** Camera in use; a different camera than the region was learned with resets it. */
  setCamera(id: string): void {
    if (this.cameraId !== null && id !== this.cameraId) this.clearSamples();
    this.cameraId = id;
  }

  /** Forget what was learned (camera change). */
  reset(): void {
    this.clearSamples();
  }

  private clearSamples(): void {
    this.pointer.clear();
    this.typed.clear();
    this.calm.clear();
    this.keyboard.clear();
    this.recent = [];
    this.kbPending = [];
    this.force = true;
  }

  exportState(): AttentionState {
    return {
      v: 1,
      cameraId: this.cameraId,
      prior: this.priorSet ? { ...this.prior } : null,
      pointer: this.pointer.export(),
      typed: this.typed.export(),
      calm: this.calm.export(),
      keyboard: this.keyboard.export(),
    };
  }

  private importState(s: AttentionState): void {
    this.cameraId = typeof s.cameraId === 'string' ? s.cameraId : null;
    if (s.prior && Number.isFinite(s.prior.yaw) && Number.isFinite(s.prior.pitch)) {
      this.prior = { yaw: s.prior.yaw, pitch: s.prior.pitch };
      this.priorSet = true;
    }
    this.pointer.import(s.pointer);
    this.typed.import(s.typed);
    this.calm.import(s.calm);
    this.keyboard.import(s.keyboard);
    this.force = true;
  }

  info(): AttentionInfo {
    if (this.force) this.rebuild(Number.isFinite(this.lastRebuild) ? this.lastRebuild : 0);
    return {
      reference: !this.adaptive || !this.learn ? 'calibration' : this.warmth >= 1 ? 'learned' : 'cold_start',
      centre: { yaw: round1(this.centre.yaw), pitch: round1(this.centre.pitch) },
      offsetFromBaseline: { yaw: round1(this.centre.yaw - this.prior.yaw), pitch: round1(this.centre.pitch - this.prior.pitch) },
      limits: { left: round1(this.lim.left), right: round1(this.lim.right), up: round1(this.lim.up), down: round1(this.lim.down) },
      keyboard: { xLo: round1(this.kb.xLo), xHi: round1(this.kb.xHi), bottom: round1(this.kb.bottom) },
      samples: { pointer: this.pointer.size, typed: this.typed.size, calm: this.calm.size, keyboard: this.keyboard.size },
      warmth: Math.round(this.warmth * 100) / 100,
    };
  }

  /* ------------------------------------------------------------------ geometry */

  /** Eye contribution (deg) along one axis given the head offset along it and the limit on that side. */
  private eyes(g: number, head: number, axis: 'x' | 'y', limit: number): number {
    const p = this.p;
    const k = axis === 'x' ? p.gazeXDeg : p.gazeYDeg;
    const c = axis === 'x' ? this.gazeCentre.x : this.gazeCentre.y;
    if (p.gazeMode === 'deadzone') return deadzone(p.deadzoneCentred ? g - c : g, p.fixedDeadzone) * k;
    if (p.gazeMode === 'learned') {
      const lo = axis === 'x' ? this.gazeRange.xLo : this.gazeRange.yLo;
      const hi = axis === 'x' ? this.gazeRange.xHi : this.gazeRange.yHi;
      const e = g > hi + p.gazeDeadzone ? g - hi - p.gazeDeadzone : g < lo - p.gazeDeadzone ? g - lo + p.gazeDeadzone : 0;
      return e * k;
    }
    // confirm
    const e = deadzone(g - c, p.gazeDeadzone) * k;
    if (e === 0) return 0;
    if (Math.sign(e) !== Math.sign(head) || head === 0) return e; // counter-rotating toward the screen
    const from = p.confirmFrom * limit;
    const full = p.confirmFull * limit;
    const ramp = clamp((Math.abs(head) - from) / Math.max(1e-6, full - from), 0, 1);
    return e * ramp;
  }

  /** Attention offset from the screen centre for a face (with the current region). */
  offsets(face: FaceObservation, lim: AttentionLimits = this.lim): { h: number; v: number; headH: number; headV: number } {
    const headH = face.yaw - this.centre.yaw;
    const headV = face.pitch - this.centre.pitch;
    const h = headH + this.eyes(face.gazeX, headH, 'x', headH >= 0 ? lim.left : lim.right);
    const v = headV + this.eyes(face.gazeY, headV, 'y', headV >= 0 ? lim.up : lim.down);
    return { h, v, headH, headV };
  }

  /** Full vertical gaze elevation (head + eyes, no confirmation ramp): how far UP the candidate looks. */
  private elevation(face: FaceObservation, headV: number): number {
    return headV + deadzone(face.gazeY - this.gazeCentre.y, this.p.gazeDeadzone) * this.p.gazeYDeg;
  }

  /* ------------------------------------------------------------------ per tick */

  assess(t: number, face: FaceObservation, activity: ActivityTiming | undefined, learnable: boolean): AttentionAssessment {
    if (activity && !this.adaptive) {
      this.adaptive = true;
      this.force = true;
    }
    if (this.force || (this.dirty && t - this.lastRebuild >= this.p.rebuildMs)) this.rebuild(t);
    const lim = this.lim;
    const o = this.offsets(face);
    const nx = Math.abs(o.h) / (o.h >= 0 ? lim.left : lim.right);
    const ny = o.v >= 0 ? o.v / lim.up : -o.v / lim.down;
    const awaySide = nx >= 1;
    const pw = this.adaptive && this.learn ? this.p.boundaryPower : Infinity;
    const rawAway = awaySide || ny >= 1 || (Number.isFinite(pw) && nx ** pw + ny ** pw >= 1);
    // Vertical-dominant breaches: down (the keyboard excuse may apply) or up (thinking; also up-and-sideways,
    // judged on the full elevation of the gaze — the eyes go up first when thinking).
    const awayDown = rawAway && o.v < 0 && ny >= nx;
    const awayUp = rawAway && ((o.v > 0 && ny >= nx) || (this.elevation(face, o.headV) >= this.p.upThinkMinDeg && nx < this.p.upSideMax));
    const keyAt = latest(activity?.keyAt, activity?.answerKeyAt);
    const excuseMs = this.policy.typingExcuseSec * 1000;
    const typingRecent = excuseMs > 0 && t - keyAt <= excuseMs;
    const inKeyboard = o.v < 0 && o.h >= this.kb.xLo && o.h <= this.kb.xHi && o.v >= this.kb.bottom;
    // Only a DOWNWARD breach is excused: attention beyond the side limit is never "the keyboard".
    const excused = awayDown && !awaySide && typingRecent && inKeyboard;
    if (learnable && activity && this.learn) this.sample(t, face, o, activity, keyAt);
    return { ...o, away: rawAway && !excused, up: awayUp, excused, inKeyboard, typingRecent, lastKeyAt: keyAt, limits: lim };
  }

  /** An 'up' glance with this mean vertical offset joins glance patterns. */
  upCountsForPatterns(meanV: number): boolean {
    return meanV >= this.lim.up + this.p.upPatternExtraDeg;
  }

  /* ------------------------------------------------------------------ learning */

  private sample(t: number, face: FaceObservation, o: { h: number; v: number }, a: ActivityTiming, keyAt: number): void {
    const p = this.p;
    const { yaw, pitch, gazeX, gazeY } = face;
    if (![yaw, pitch, gazeX, gazeY].every(Number.isFinite)) return;
    this.recent.push({ yaw, pitch });
    if (this.recent.length > p.calmTicks) this.recent.shift();
    // Confirm (a key followed) or drop pending keyboard samples.
    while (this.kbPending.length) {
      const k = this.kbPending[0];
      if (keyAt > k.t && keyAt - k.t <= p.kbConfirmMs) this.keyboard.push(k.yaw, k.pitch, k.gx, k.gy);
      else if (t - k.t <= p.kbConfirmMs) break;
      this.kbPending.shift();
      this.dirty = true;
    }
    const typing = t - keyAt <= p.engageMs;
    const pointing = t - latest(a.pointerAt, a.clickAt, a.scrollAt, a.answerAt) <= p.engageMs;
    const warm = this.warmth >= 1;
    if (pointing && !typing) {
      if (Math.abs(yaw - this.prior.yaw) <= p.sanityYaw && Math.abs(pitch - this.prior.pitch) <= p.sanityPitch) {
        this.pointer.push(yaw, pitch, gazeX, gazeY);
        this.dirty = true;
      }
      return;
    }
    if (!warm) return;
    const inCore = o.h <= this.extent.left && o.h >= -this.extent.right && o.v <= this.extent.up && o.v >= -this.extent.down;
    if (typing) {
      if (inCore) this.typed.push(yaw, pitch, gazeX, gazeY);
      else if (o.v < -this.extent.down && o.h >= -p.kbPrior.x && o.h <= p.kbPrior.x && o.v >= p.kbPrior.bottom) {
        this.kbPending.push({ t, yaw, pitch, gx: gazeX, gy: gazeY });
        return;
      } else return;
      this.dirty = true;
      return;
    }
    // Calm reading: no interaction, steady head, inside the learned core.
    if (t - keyAt <= this.policy.typingExcuseSec * 1000 || !inCore || this.recent.length < p.calmTicks) return;
    let yLo = Infinity;
    let yHi = -Infinity;
    let pLo = Infinity;
    let pHi = -Infinity;
    for (const r of this.recent) {
      yLo = Math.min(yLo, r.yaw);
      yHi = Math.max(yHi, r.yaw);
      pLo = Math.min(pLo, r.pitch);
      pHi = Math.max(pHi, r.pitch);
    }
    if (yHi - yLo > p.calmRangeDeg || pHi - pLo > p.calmRangeDeg) return;
    this.calmToggle = !this.calmToggle;
    if (!this.calmToggle) return;
    this.calm.push(yaw, pitch, gazeX, gazeY);
    this.dirty = true;
  }

  private rebuild(t: number): void {
    this.lastRebuild = t;
    this.dirty = false;
    this.force = false;
    const p = this.p;
    const pol = this.policyLimits();
    if (!this.adaptive || !this.learn) {
      this.centre = { ...this.prior };
      this.warmth = 0;
      this.lim = pol;
      this.extent = { left: p.minExtent.side, right: p.minExtent.side, up: p.minExtent.up, down: p.minExtent.down };
      this.kb = { xLo: -p.kbPrior.x, xHi: p.kbPrior.x, bottom: p.kbPrior.bottom };
      return;
    }
    const rings = [this.pointer, this.typed, this.calm];
    const n = rings.reduce((a, r) => a + r.size, 0);
    const interaction = this.pointer.size + this.typed.size;
    const w = Math.min(1, interaction / p.warmSamples);
    this.warmth = w;
    const col = (j: number) => {
      const out: number[] = [];
      for (const r of rings) for (let k = 0; k < r.size; k++) out.push(r.get(k, j));
      return out;
    };
    if (n >= 3) {
      const yaws = sortedOf(col(0));
      const pitches = sortedOf(col(1));
      const gx = sortedOf(col(2));
      const gy = sortedOf(col(3));
      this.centre = { yaw: this.prior.yaw + w * (quantile(yaws, 0.5) - this.prior.yaw), pitch: this.prior.pitch + w * (quantile(pitches, 0.5) - this.prior.pitch) };
      this.gazeCentre = { x: w * quantile(gx, 0.5), y: -0.05 + w * (quantile(gy, 0.5) + 0.05) };
      if (n >= 10) {
        const mix = (prior: number, learned: number) => prior + w * (learned - prior);
        this.gazeRange = { xLo: mix(-0.45, quantile(gx, 0.05)), xHi: mix(0.45, quantile(gx, 0.95)), yLo: mix(-0.45, quantile(gy, 0.05)), yHi: mix(0.3, quantile(gy, 0.95)) };
      }
    } else {
      this.centre = { ...this.prior };
    }
    // Extents of the attention offsets of the screen samples (with the policy limits for the eye ramp).
    const ext = { left: p.minExtent.side, right: p.minExtent.side, up: p.minExtent.up, down: p.minExtent.down };
    if (n >= 10) {
      const hs: number[] = [];
      const vs: number[] = [];
      for (const r of rings) {
        for (let k = 0; k < r.size; k++) {
          const o = this.offsets({ yaw: r.get(k, 0), pitch: r.get(k, 1), gazeX: r.get(k, 2), gazeY: r.get(k, 3) } as FaceObservation, pol);
          hs.push(o.h);
          vs.push(o.v);
        }
      }
      const H = sortedOf(hs);
      const V = sortedOf(vs);
      ext.left = clamp(quantile(H, 0.9), p.minExtent.side, p.maxExtent.side);
      ext.right = clamp(-quantile(H, 0.1), p.minExtent.side, p.maxExtent.side);
      ext.up = clamp(quantile(V, 0.9), p.minExtent.up, p.maxExtent.up);
      ext.down = clamp(-quantile(V, 0.1), p.minExtent.down, p.maxExtent.down);
    }
    this.extent = ext;
    const cold = 1 - w;
    this.lim = {
      left: Math.max(pol.left, ext.left + p.marginDeg) + cold * p.coldExtra.side,
      right: Math.max(pol.right, ext.right + p.marginDeg) + cold * p.coldExtra.side,
      up: Math.max(pol.up, ext.up + p.marginDeg) + cold * p.coldExtra.up,
      down: Math.max(pol.down, ext.down + p.marginDeg) + cold * p.coldExtra.down,
    };
    // Keyboard cone.
    if (this.keyboard.size >= p.kbMinSamples) {
      const hs: number[] = [];
      const vs: number[] = [];
      for (let k = 0; k < this.keyboard.size; k++) {
        const o = this.offsets({ yaw: this.keyboard.get(k, 0), pitch: this.keyboard.get(k, 1), gazeX: this.keyboard.get(k, 2), gazeY: this.keyboard.get(k, 3) } as FaceObservation);
        hs.push(o.h);
        vs.push(o.v);
      }
      const H = sortedOf(hs);
      const V = sortedOf(vs);
      const mid = clamp(quantile(H, 0.5), -p.kbMaxCentre, p.kbMaxCentre);
      const half = clamp(Math.max(mid - quantile(H, 0.1), quantile(H, 0.9) - mid) + p.kbMargin, p.kbMinHalfWidth, p.kbMaxHalfWidth);
      this.kb = { xLo: mid - half, xHi: mid + half, bottom: Math.min(-p.kbMinDepth, quantile(V, 0.05) - p.kbMargin) };
    } else {
      this.kb = { xLo: -p.kbPrior.x, xHi: p.kbPrior.x, bottom: p.kbPrior.bottom };
    }
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
