import { Debouncer } from '../debounce';
import { K, type DetectorHost, type TickContext } from '../context';
import { dur, type FlushReason } from '../span';
import { clamp01, round } from '../../util/math';

const KEY = 'unusual_movement';
const MAX_EXITS = 64;
const MAX_LISTED = 20;

interface Exit {
  start: number;
  end: number | null;
  consumed: boolean;
  inEpisode: boolean;
}

/**
 * unusual_movement — one episode fed by two sub-conditions:
 *  (a) repeated exits: ≥ movementExitCount face absences of ≥ 2 s (including ones too short for
 *      candidate_absent) within movementWindowSec. Opens when the Nth exit starts; stays open while exits
 *      keep coming; closes once no exit happened for max(30 s, window / count) — endedAt = the return
 *      after the last exit. Exits that belonged to a closed episode are not re-counted.
 *  (b) far from baseline: face centre shifted > 0.25 of the frame, or face width < 0.5× / > 1.9× the
 *      baseline width, for ≥ farFromBaselineSec (debounced like every other span).
 * The episode is open while either sub-condition is active.
 */
export class MovementDetector {
  private exits: Exit[] = [];
  private exitsActive = false;
  private exitsStart = 0;
  private far: Debouncer;
  private farStart: number | null = null;
  private farEnd: number | null = null;
  private open = false;
  private epStart = 0;
  // far stats
  private maxShift = 0;
  private minRatio = Infinity;
  private maxRatio = 0;
  private farSec = 0;
  private farConfirmed = false;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.far = new Debouncer({ onsetMs: p.farFromBaselineSec * 1000, clearMs: Math.max(p.clearSec * 1000, 3000), minFraction: 0.7, gapTolMs: 1500, minTicks: 5 });
  }

  private get enabled(): boolean {
    return this.host.policy.enabled.movement;
  }

  /** Presence detector: an absence reached exitMinMs (started at `start`). */
  exitStarted(start: number, t: number): void {
    if (!this.enabled) return;
    this.exits.push({ start, end: null, consumed: false, inEpisode: false });
    if (this.exits.length > MAX_EXITS) this.exits.shift();
    const windowMs = this.host.policy.movementWindowSec * 1000;
    const recent = this.exits.filter((e) => !e.consumed && e.start >= t - windowMs);
    if (this.exitsActive) {
      this.exits[this.exits.length - 1].inEpisode = true;
      this.touch(t, true);
      return;
    }
    if (recent.length >= this.host.policy.movementExitCount) {
      this.exitsActive = true;
      this.exitsStart = recent[0].start;
      for (const e of recent) e.inEpisode = true;
      this.ensureOpen(this.exitsStart, t);
    }
  }

  /** Presence detector: the face returned at `end` after an exit. */
  exitEnded(end: number): void {
    const last = this.exits[this.exits.length - 1];
    if (last && last.end === null) last.end = end;
  }

  step(ctx: TickContext): void {
    const t = ctx.t;
    if (!this.enabled) return;
    const p = this.host.policy;
    // (b) far from baseline
    let v: boolean | null = null;
    if (ctx.visionOk && ctx.primary) {
      const b = ctx.baseline;
      const f = ctx.primary;
      const cx = f.box.x + f.box.w / 2;
      const cy = f.box.y + f.box.h / 2;
      const shift = Math.hypot(cx - b.cx, cy - b.cy);
      const ratio = b.faceWidth > 0 ? f.box.w / b.faceWidth : 1;
      v = shift > K.farCentre || ratio < K.farWidthMin || ratio > K.farWidthMax;
      if (v) {
        if (!this.far.active && this.far.runStart === null && !this.open) this.resetFarStats();
        this.maxShift = Math.max(this.maxShift, shift);
        this.minRatio = Math.min(this.minRatio, ratio);
        this.maxRatio = Math.max(this.maxRatio, ratio);
      }
    }
    const ev = this.far.step(t, v, ctx.primary?.score ?? 1);
    if (ev?.kind === 'onset') {
      this.farStart = ev.startedAt;
      this.farEnd = null;
      this.farConfirmed = true;
      this.ensureOpen(ev.startedAt, t);
    } else if (ev?.kind === 'clear') {
      if (this.farStart !== null) this.farSec += (ev.endedAt - this.farStart) / 1000;
      this.farEnd = ev.endedAt;
      this.farStart = null;
    }
    // (a) exits pattern end
    if (this.exitsActive) {
      const last = this.exits[this.exits.length - 1];
      const closeAfter = Math.max(30000, Math.min((p.movementWindowSec * 1000) / p.movementExitCount, p.movementWindowSec * 1000));
      if (last && last.end !== null && t - last.end >= closeAfter) {
        this.exitsActive = false;
        for (const e of this.exits) if (e.inEpisode) e.consumed = true;
      }
    }
    if (this.open) {
      if (!this.exitsActive && !this.far.active) this.close(t, this.endTime(t));
      else this.touch(t, false);
    }
  }

  flush(t: number, reason: FlushReason): void {
    if (this.open) {
      if (this.far.active && this.farStart !== null) this.farSec += (t - this.farStart) / 1000;
      this.close(t, this.far.active ? t : this.endTime(t), reason);
    }
    this.reset();
  }

  reset(): void {
    this.exits = [];
    this.exitsActive = false;
    this.far.reset();
    this.farStart = null;
    this.farEnd = null;
    this.open = false;
    this.resetFarStats();
  }

  private resetFarStats(): void {
    this.maxShift = 0;
    this.minRatio = Infinity;
    this.maxRatio = 0;
    this.farSec = 0;
    this.farConfirmed = false;
  }

  private endTime(t: number): number {
    let end = this.farEnd ?? -Infinity;
    for (const e of this.exits) if (e.inEpisode) end = Math.max(end, e.end ?? t);
    return Number.isFinite(end) ? end : t;
  }

  private ensureOpen(startedAt: number, t: number): void {
    if (this.open) {
      this.touch(t, true);
      return;
    }
    const { update } = this.host.book.begin(KEY, 'unusual_movement', startedAt, t, this.data(t, null), this.material());
    this.epStart = update.startedAt;
    this.open = true;
    this.host.episodes.push(update);
  }

  private touch(t: number, peak: boolean): void {
    const u = this.host.book.touch(KEY, t, this.material(), () => this.data(t, null), { peak });
    if (u) this.host.episodes.push(u);
  }

  private close(t: number, endedAt: number, closedBy?: FlushReason): void {
    const d = this.data(t, endedAt);
    if (closedBy) d.details.closedBy = closedBy;
    const u = this.host.book.end(KEY, endedAt, t, d);
    if (u) this.host.episodes.push(u);
    this.open = false;
    for (const e of this.exits) if (e.inEpisode) e.consumed = true;
    this.resetFarStats();
  }

  private material(): string {
    const n = this.exits.filter((e) => e.inEpisode).length;
    return `${n}|${this.far.active ? 1 : 0}`;
  }

  private data(t: number, endedAt: number | null) {
    const p = this.host.policy;
    const listed = this.exits.filter((e) => e.inEpisode);
    const reasons: string[] = [];
    if (listed.length) reasons.push('repeated_exits');
    if (this.farConfirmed) reasons.push('far_from_baseline');
    const until = endedAt ?? t;
    const durationSec = round((until - this.epStart) / 1000, 1);
    const details: Record<string, unknown> = { durationSec, reasons };
    const parts: string[] = [];
    if (listed.length) {
      details.exitCount = listed.length;
      details.windowSec = p.movementWindowSec;
      details.exits = listed.slice(-MAX_LISTED).map((e) => ({ at: e.start, durationSec: e.end === null ? null : round((e.end - e.start) / 1000, 1) }));
      const spanSec = ((listed[listed.length - 1].end ?? until) - listed[0].start) / 1000;
      parts.push(`The candidate moved out of the camera view ${listed.length} times within ${dur(spanSec)}.`);
    }
    if (reasons.includes('far_from_baseline')) {
      const farSecNow = this.farSec + (this.far.active && this.farStart !== null ? (until - this.farStart) / 1000 : 0);
      details.farFromBaseline = {
        durationSec: round(farSecNow, 1),
        maxCentreShift: round(this.maxShift, 3),
        minWidthRatio: Number.isFinite(this.minRatio) ? round(this.minRatio, 2) : null,
        maxWidthRatio: round(this.maxRatio, 2),
      };
      parts.push(`The candidate’s position in the camera view was far from their normal position for ${dur(farSecNow)}.`);
    }
    const conf = listed.length
      ? clamp01(0.55 + 0.1 * (listed.length - p.movementExitCount + 1))
      : clamp01(this.far.confidence(t));
    return { confidence: Math.min(0.95, conf), details, observation: parts.join(' ') || 'The candidate moved out of view or far from their normal position.' };
  }
}
