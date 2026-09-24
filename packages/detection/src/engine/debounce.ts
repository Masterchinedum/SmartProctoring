import { TickWindow } from '../util/ring';
import { clamp01 } from '../util/math';

/**
 * Debounced condition state machine — the building block of every span detector.
 *
 * Feed one value per observation: `true` (condition holds), `false` (condition observed absent) or
 * `null` (cannot be assessed this tick, e.g. no usable face for a gaze detector, or the object detector
 * did not run). Time comes only from the observation timestamps.
 *
 * Onset (idle → active) requires ALL of:
 *   - a "run" that started at the first true tick and has not been interrupted for longer than
 *     `gapTolMs` (dropped frames / single contrary frames are tolerated);
 *   - run length ≥ `onsetMs`;
 *   - ≥ `minTicks` supporting ticks;
 *   - ≥ `minFraction` of the assessable ticks in the last `onsetMs` were true.
 *   The episode's start is the run start — when the condition actually began.
 * Clear (active → idle) requires the condition to be not-true (false or unassessable) continuously for
 * `clearMs` (hysteresis). The episode's end is the first not-true tick — when it actually stopped.
 */
export interface DebounceParams {
  onsetMs: number;
  clearMs: number;
  minFraction: number;
  gapTolMs: number;
  minTicks: number;
}

export type DebounceEvent = { kind: 'onset'; startedAt: number } | { kind: 'clear'; endedAt: number } | null;

export class Debouncer {
  active = false;
  /** Start of the current building or active run, or null. */
  runStart: number | null = null;
  lastTrue = -Infinity;
  /** First not-true tick since the last true tick while active (pending clear), else null. */
  firstOff: number | null = null;
  /** Last time step() was called with any value. */
  lastFeed = -Infinity;
  private win: TickWindow;
  private runTrue = 0;
  private runTotal = 0;
  private scoreSum = 0;
  /** Run statistics are kept readable until the next step after a clear (for the close description). */
  private pendingReset = false;

  constructor(public p: DebounceParams) {
    this.win = new TickWindow(32);
  }

  /** No episode and no run building (a finished run counts as idle). */
  get idle(): boolean {
    return !this.active && (this.runStart === null || this.pendingReset);
  }

  step(t: number, v: boolean | null, score = 1): DebounceEvent {
    if (this.pendingReset) this.resetRun();
    this.lastFeed = t;
    const p = this.p;
    if (!this.active) {
      if (this.runStart !== null && t - this.lastTrue > p.gapTolMs) this.resetRun();
      if (v === true) {
        if (this.runStart === null) {
          this.runStart = t;
          this.win.clear();
          this.runTrue = 0;
          this.runTotal = 0;
          this.scoreSum = 0;
        }
        this.lastTrue = t;
        this.win.push(t, true);
        this.runTrue++;
        this.runTotal++;
        this.scoreSum += Number.isFinite(score) ? score : 1;
        this.win.prune(t - p.onsetMs);
        if (t - this.runStart >= p.onsetMs && this.runTrue >= p.minTicks && this.win.fraction() >= p.minFraction) {
          this.active = true;
          this.firstOff = null;
          return { kind: 'onset', startedAt: this.runStart };
        }
      } else if (v === false && this.runStart !== null) {
        this.win.push(t, false);
        this.runTotal++;
        this.win.prune(t - p.onsetMs);
      }
      return null;
    }
    // active
    if (v === true) {
      this.lastTrue = t;
      this.firstOff = null;
      this.runTrue++;
      this.runTotal++;
      this.scoreSum += Number.isFinite(score) ? score : 1;
      return null;
    }
    if (v === false) this.runTotal++;
    if (this.firstOff === null) this.firstOff = t;
    if (t - this.firstOff >= p.clearMs) {
      const endedAt = this.firstOff;
      this.active = false;
      this.pendingReset = true;
      return { kind: 'clear', endedAt };
    }
    return null;
  }

  /**
   * For sparse inputs (object detector): if active and nothing has been fed for `maxSilenceMs`, clear
   * at the first not-true tick (or just after the last true tick if none was observed).
   */
  expire(t: number, maxSilenceMs: number): DebounceEvent {
    if (!this.active || t - this.lastFeed < maxSilenceMs) return null;
    const endedAt = this.firstOff ?? this.lastTrue;
    this.active = false;
    this.pendingReset = true;
    return { kind: 'clear', endedAt };
  }

  /** Time the pending/ongoing run has lasted (0 when idle without a run). */
  runDuration(t: number): number {
    return this.runStart === null || this.pendingReset ? 0 : t - this.runStart;
  }

  /** Fraction of assessable ticks in the current run where the condition held. */
  supportFraction(): number {
    return this.runTotal ? this.runTrue / this.runTotal : 0;
  }

  meanScore(): number {
    return this.runTrue ? this.scoreSum / this.runTrue : 0;
  }

  supportTicks(): number {
    return this.runTrue;
  }

  /**
   * Confidence 0..1 from mean detector score, supporting-tick fraction and duration relative to the
   * onset threshold (reaches full weight at 2× the onset duration).
   */
  confidence(t: number, scoreOverride?: number): number {
    const score = scoreOverride ?? this.meanScore();
    const frac = this.supportFraction();
    const dur = this.runStart === null ? 0 : Math.max(0, Math.min(t, this.lastTrue) - this.runStart);
    const durF = clamp01(dur / Math.max(1, 2 * this.p.onsetMs));
    return clamp01(score * (0.55 + 0.45 * frac) * (0.75 + 0.25 * durF));
  }

  /** Hard reset (flush / camera restart). */
  reset(): void {
    this.active = false;
    this.resetRun();
    this.lastFeed = -Infinity;
  }

  private resetRun(): void {
    this.pendingReset = false;
    this.runStart = null;
    this.firstOff = null;
    this.lastTrue = -Infinity;
    this.win.clear();
    this.runTrue = 0;
    this.runTotal = 0;
    this.scoreSum = 0;
  }
}

/**
 * Simple two-threshold hysteresis on a raw per-tick boolean: turns on after the value has been true for
 * `onMs` (tolerating single contrary ticks shorter than `tolMs`), off after it has been false/unknown for
 * `offMs`. Used for candidate prompts and status labels.
 */
export class Hysteresis {
  on = false;
  since: number | null = null;
  private lastTrue = -Infinity;
  private offSince: number | null = null;

  constructor(
    public onMs: number,
    public offMs: number,
    public tolMs = 450,
  ) {}

  /** Returns 'on' / 'off' when the state changes, else null. */
  step(t: number, v: boolean | null): 'on' | 'off' | null {
    if (v === true) {
      if (this.since === null || (!this.on && t - this.lastTrue > this.tolMs)) this.since = t;
      this.lastTrue = t;
      this.offSince = null;
      if (!this.on && t - this.since >= this.onMs) {
        this.on = true;
        return 'on';
      }
      return null;
    }
    if (!this.on) {
      if (this.since !== null && t - this.lastTrue > this.tolMs) this.since = null;
      return null;
    }
    if (this.offSince === null) this.offSince = t;
    if (t - this.offSince >= this.offMs) {
      this.on = false;
      this.since = null;
      this.offSince = null;
      return 'off';
    }
    return null;
  }

  /** Duration of the current true run (0 if none). */
  duration(t: number): number {
    return this.since === null ? 0 : t - this.since;
  }

  reset(): void {
    this.on = false;
    this.since = null;
    this.offSince = null;
    this.lastTrue = -Infinity;
  }
}
