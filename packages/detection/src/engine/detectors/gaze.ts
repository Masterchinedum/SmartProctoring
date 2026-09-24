import type { GazeDirection } from '@sp/shared';
import { awayThresholds, directionOf, directionText, type AwayThresholds, type DetectorHost, type TickContext } from '../context';
import { dur, Span, type FlushReason } from '../span';
import { clamp01, round } from '../../util/math';

/** Non-away time tolerated inside one glance (≈ one dropped/contrary tick at 5 Hz). */
const GLANCE_GAP_MS = 350;
const MAX_GLANCES = 64;
const MAX_LISTED = 30;

interface Glance {
  start: number;
  lastAway: number;
  firstNonAway: number | null;
  end: number | null;
  sumH: number;
  sumV: number;
  n: number;
  qualified: boolean;
  sustained: boolean;
  dir: GazeDirection;
  /** Which pattern episode this glance was attributed to. */
  attr: 'offscreen' | 'repeated' | null;
  /** Belonged to a pattern episode that has closed — never counted again. */
  consumed: boolean;
  owner: Pattern | null;
}

interface Pattern {
  key: string;
  open: boolean;
  startedAt: number;
  /** Most recent attributed glances (bounded). */
  glances: Glance[];
  /** Total attributed glances and first glance start (the list above is bounded). */
  count: number;
  firstStart: number;
}

const MAX_PATTERN_GLANCES = 100;

function attach(pat: Pattern, g: Glance): void {
  g.owner = pat;
  if (pat.count === 0) pat.firstStart = g.start;
  pat.count++;
  pat.glances.push(g);
  if (pat.glances.length > MAX_PATTERN_GLANCES) pat.glances.shift();
}

function newPattern(key: string, startedAt: number): Pattern {
  return { key, open: false, startedAt, glances: [], count: 0, firstStart: startedAt };
}

/**
 * Attention detectors built on the effective attention direction (head pose offset from the baseline
 * plus dead-zoned eye gaze; see context.attentionAngles):
 *
 * - looking_away (sustained): away for ≥ lookAwaySec (debounced span). details.direction = dominant
 *   direction during the episode.
 * - Glances: contiguous away runs (one contrary tick tolerated). A glance QUALIFIES the moment it has
 *   lasted glanceMinSec — shorter glances are ignored entirely. Qualification happens while the
 *   candidate is still looking away, so the snapshot requested at that moment shows the behaviour.
 * - offscreen_attention_pattern: ≥ sameDirectionCount qualifying glances or sustained looks toward the
 *   same 8-way direction bucket within repeatedLookAwayWindowSec. One episode per direction; every
 *   further glance in that direction updates it with a 'peak' snapshot request.
 * - repeated_looking_away: ≥ repeatedLookAwayCount qualifying SHORT glances (< lookAwaySec) within the
 *   window, counting only glances not attributed to an offscreen pattern.
 *
 * Double-reporting policy: the same-direction pattern is the more specific observation, so glances
 * toward a direction that has (or just triggered) an offscreen_attention_pattern episode are attributed
 * to that episode only and are not counted toward repeated_looking_away. A repeated_looking_away episode
 * that was already open stays open (it may have been triggered by earlier mixed-direction glances), but
 * stops receiving glances of the attributed direction.
 *
 * Pattern episodes stay open while the pattern continues and close when no attributed glance happened
 * for max(20 s, 1.5 × window / count); endedAt = end of the last attributed glance. Glances of a closed
 * pattern are consumed and never count again, so a new episode needs a fresh set of glances (or merges
 * into the previous one when it starts within mergeGapSec).
 */
export class GazeDetector {
  readonly sustained: Span;
  private th: AwayThresholds;
  private dirCounts = new Map<GazeDirection, number>();
  private maxYawOff = 0;
  private maxPitchOff = 0;
  private current: Glance | null = null;
  private glances: Glance[] = [];
  private repeated: Pattern = newPattern('repeated_looking_away', 0);
  private offscreen = new Map<GazeDirection, Pattern>();
  private lastScore = 1;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.th = awayThresholds(p);
    this.sustained = new Span(host, 'looking_away', 'looking_away', { onsetMs: p.lookAwaySec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 800, minTicks: 3 }, {
      material: () => this.dominant() ?? '',
      describe: (d) => {
        const dir = this.dominant() ?? 'left';
        return {
          details: { durationSec: d.durationSec, direction: dir, maxYawOffsetDeg: round(this.maxYawOff, 1), maxPitchOffsetDeg: round(this.maxPitchOff, 1) },
          observation:
            d.phase === 'close'
              ? `The candidate’s head or gaze was turned away from the screen (${directionText(dir)}) for ${dur(d.durationSec)}.`
              : `The candidate’s head or gaze has been turned away from the screen (${directionText(dir)}) for ${dur(d.durationSec)}.`,
        };
      },
    });
    this.sustained.onBegin = () => host.prompts.set('look_at_screen', true, host.signals);
    this.sustained.onEnd = () => host.prompts.set('look_at_screen', false, host.signals);
  }

  private get enabled(): boolean {
    return this.host.policy.enabled.lookingAway;
  }

  get lookingAway(): boolean {
    return this.sustained.active;
  }

  step(ctx: TickContext): void {
    if (!this.enabled) return;
    const t = ctx.t;
    const assess = ctx.visionOk && ctx.primary !== null && ctx.primaryAssessable;
    const away = assess ? ctx.away : null;
    if (assess && ctx.primary) this.lastScore = ctx.primary.score;
    if (away && ctx.direction) {
      if (!this.sustained.deb.active && this.sustained.deb.runStart === null) this.resetSustainedStats();
      this.dirCounts.set(ctx.direction, (this.dirCounts.get(ctx.direction) ?? 0) + 1);
      if (Math.abs(ctx.yawOff) > Math.abs(this.maxYawOff)) this.maxYawOff = ctx.yawOff;
      if (Math.abs(ctx.pitchOff) > Math.abs(this.maxPitchOff)) this.maxPitchOff = ctx.pitchOff;
    }
    this.sustained.feed(t, away, ctx.primary?.score ?? 1);
    this.segment(t, away, ctx);
    this.maintain(t);
  }

  flush(t: number, reason: FlushReason): void {
    this.sustained.flush(t, reason);
    this.host.prompts.set('look_at_screen', false, this.host.signals);
    if (this.current) this.finalize(this.current, this.current.firstNonAway ?? t);
    if (this.repeated.open) this.closePattern(this.repeated, t, reason);
    for (const p of this.offscreen.values()) if (p.open) this.closePattern(p, t, reason);
    this.reset();
  }

  reset(): void {
    this.sustained.reset();
    this.resetSustainedStats();
    this.current = null;
    this.glances = [];
    this.repeated = newPattern('repeated_looking_away', 0);
    this.offscreen.clear();
  }

  /** Open pattern episode types (for status). */
  patternOpen(): boolean {
    if (this.repeated.open) return true;
    for (const p of this.offscreen.values()) if (p.open) return true;
    return false;
  }

  private resetSustainedStats(): void {
    this.dirCounts.clear();
    this.maxYawOff = 0;
    this.maxPitchOff = 0;
  }

  private dominant(): GazeDirection | null {
    let best: GazeDirection | null = null;
    let n = 0;
    for (const [d, c] of this.dirCounts) {
      if (c > n) {
        best = d;
        n = c;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ glances */

  private segment(t: number, away: boolean | null, ctx: TickContext): void {
    const p = this.host.policy;
    const g0 = this.current;
    if (away === true) {
      if (g0 && t - g0.lastAway > GLANCE_GAP_MS) this.finalize(g0, g0.firstNonAway ?? g0.lastAway);
      let g = this.current;
      if (!g) {
        g = { start: t, lastAway: t, firstNonAway: null, end: null, sumH: 0, sumV: 0, n: 0, qualified: false, sustained: false, dir: 'left', attr: null, consumed: false, owner: null };
        this.current = g;
      }
      g.lastAway = t;
      g.firstNonAway = null;
      g.sumH += ctx.h;
      g.sumV += ctx.v;
      g.n++;
      if (!g.qualified && t - g.start >= p.glanceMinSec * 1000) this.qualify(g, t);
      if (g.qualified && !g.sustained && t - g.start >= p.lookAwaySec * 1000) g.sustained = true;
      return;
    }
    if (!g0) return;
    if (away === false) {
      g0.firstNonAway ??= t;
      if (t - g0.lastAway > GLANCE_GAP_MS) this.finalize(g0, g0.firstNonAway);
      return;
    }
    // Unassessable (face lost / obstructed): the glance ends where observation ended.
    this.finalize(g0, g0.firstNonAway ?? t);
  }

  private finalize(g: Glance, end: number): void {
    g.end = Math.max(end, g.lastAway);
    if (g.qualified && g.end - g.start >= this.host.policy.lookAwaySec * 1000) g.sustained = true;
    if (this.current === g) this.current = null;
  }

  private qualify(g: Glance, t: number): void {
    const p = this.host.policy;
    g.qualified = true;
    g.dir = directionOf(g.sumH / g.n, g.sumV / g.n, this.th);
    this.glances.push(g);
    const windowMs = p.repeatedLookAwayWindowSec * 1000;
    // Bounded history: drop finished glances outside the window, cap the length.
    while (this.glances.length > 0 && (this.glances.length > MAX_GLANCES || (this.glances[0].end !== null && this.glances[0].start < t - windowMs && this.glances[0] !== g))) {
      this.glances.shift();
    }
    const inWindow = (x: Glance) => !x.consumed && x.start >= t - windowMs;

    // Same-direction pattern (more specific) first.
    let pat = this.offscreen.get(g.dir);
    if (pat?.open) {
      g.attr = 'offscreen';
      attach(pat, g);
      this.touchPattern(pat, t, true);
    } else {
      const same = this.glances.filter((x) => inWindow(x) && x.dir === g.dir && x.attr !== 'offscreen');
      if (same.length >= p.sameDirectionCount) {
        pat = newPattern(`offscreen_attention_pattern:${g.dir}`, same[0].start);
        this.offscreen.set(g.dir, pat);
        for (const x of same) {
          x.attr = 'offscreen';
          attach(pat, x);
        }
        this.openPattern(pat, 'offscreen_attention_pattern', same[0].start, t);
      }
    }
    if (g.attr === 'offscreen') return;

    // Mixed-direction repeated pattern.
    if (this.repeated.open) {
      g.attr = 'repeated';
      attach(this.repeated, g);
      this.touchPattern(this.repeated, t, false);
      return;
    }
    const pool = this.glances.filter((x) => inWindow(x) && !x.sustained && x.attr === null && !this.offscreen.get(x.dir)?.open);
    if (pool.length >= p.repeatedLookAwayCount) {
      this.repeated = newPattern('repeated_looking_away', pool[0].start);
      for (const x of pool) {
        x.attr = 'repeated';
        attach(this.repeated, x);
      }
      this.openPattern(this.repeated, 'repeated_looking_away', pool[0].start, t);
    }
  }

  /* ------------------------------------------------------------------ patterns */

  private closeAfterMs(count: number): number {
    const w = this.host.policy.repeatedLookAwayWindowSec * 1000;
    return Math.min(w, Math.max(20000, (1.5 * w) / Math.max(1, count)));
  }

  private maintain(t: number): void {
    const p = this.host.policy;
    if (this.repeated.open) this.maybeClose(this.repeated, t, this.closeAfterMs(p.repeatedLookAwayCount));
    for (const pat of this.offscreen.values()) if (pat.open) this.maybeClose(pat, t, this.closeAfterMs(p.sameDirectionCount));
    if (this.repeated.open) this.touchPattern(this.repeated, t, false);
    for (const pat of this.offscreen.values()) if (pat.open) this.touchPattern(pat, t, false);
  }

  private maybeClose(pat: Pattern, t: number, afterMs: number): void {
    const last = pat.glances[pat.glances.length - 1];
    if (!last || last.end === null) return;
    if (t - last.end >= afterMs) this.closePattern(pat, t);
  }

  private openPattern(pat: Pattern, type: 'offscreen_attention_pattern' | 'repeated_looking_away', startedAt: number, t: number): void {
    const { update } = this.host.book.begin(pat.key, type, startedAt, t, this.patternData(pat, t, null), String(pat.count));
    pat.open = true;
    pat.startedAt = update.startedAt;
    this.host.episodes.push(update);
  }

  private touchPattern(pat: Pattern, t: number, peak: boolean): void {
    const u = this.host.book.touch(pat.key, t, String(pat.count), () => this.patternData(pat, t, null), { peak });
    if (u) this.host.episodes.push(u);
  }

  private closePattern(pat: Pattern, t: number, closedBy?: FlushReason): void {
    const last = pat.glances[pat.glances.length - 1];
    const endedAt = last ? (last.end ?? t) : t;
    const d = this.patternData(pat, t, endedAt);
    if (closedBy) d.details.closedBy = closedBy;
    const u = this.host.book.end(pat.key, endedAt, t, d);
    if (u) this.host.episodes.push(u);
    pat.open = false;
    for (const g of pat.glances) g.consumed = true;
    for (const g of this.glances) if (g.owner === pat) g.consumed = true;
    pat.glances = [];
    pat.count = 0;
  }

  private patternData(pat: Pattern, t: number, endedAt: number | null) {
    const p = this.host.policy;
    const isOff = pat.key !== 'repeated_looking_away';
    const gl = pat.glances;
    const n = pat.count;
    const durations = gl.map((g) => ((g.end ?? t) - g.start) / 1000);
    const first = pat.count ? pat.firstStart : pat.startedAt;
    const last = gl[gl.length - 1];
    const spanSec = ((last?.end ?? t) - first) / 1000;
    const dirs: Partial<Record<GazeDirection, number>> = {};
    for (const g of gl) dirs[g.dir] = (dirs[g.dir] ?? 0) + 1;
    const threshold = isOff ? p.sameDirectionCount : p.repeatedLookAwayCount;
    const confidence = Math.min(0.95, clamp01((isOff ? 0.65 : 0.6) + 0.07 * (n - threshold)) * (0.7 + 0.3 * this.lastScore));
    const minD = durations.length ? Math.min(...durations) : 0;
    const maxD = durations.length ? Math.max(...durations) : 0;
    const details: Record<string, unknown> = {
      durationSec: round(((endedAt ?? t) - pat.startedAt) / 1000, 1),
      count: n,
      windowSec: p.repeatedLookAwayWindowSec,
      glances: gl.slice(-MAX_LISTED).map((g) => ({ at: g.start, durationSec: round(((g.end ?? t) - g.start) / 1000, 1), direction: g.dir })),
      maxGlanceSec: round(maxD, 1),
    };
    let observation: string;
    if (isOff) {
      const dir = gl[0]?.dir ?? 'left';
      details.direction = dir;
      observation = `The candidate repeatedly looked in the same direction (${directionText(dir)}): ${n} times within ${dur(spanSec)}.`;
    } else {
      details.directions = dirs;
      observation = `The candidate looked away from the screen ${n} times within ${dur(spanSec)} (each look ${round(minD, 1)}–${round(maxD, 1)} s).`;
    }
    return { confidence, details, observation };
  }
}
