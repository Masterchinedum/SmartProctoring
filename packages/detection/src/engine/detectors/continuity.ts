import type { FaceObservation, NormBox } from '@sp/shared';
import { descriptorOf, geomDistance, patchDistance } from '../../continuity/descriptor';
import { K, type DetectorHost, type TickContext } from '../context';
import { triggerPriority, type IdentityTrigger } from '../identity';

/**
 * Fast person-swap triggers (identity samples only — never events or flags; the server decides).
 *
 * track_break — the single-face track was interrupted, even briefly:
 *   - gap: no face for ≥ 250 ms (≥ 2 analysed frames) and less than the face-return threshold (3 s; longer
 *     absences are 'face_return' samples);
 *   - count: a brief second face (≥ 2 frames, shorter than multiplePeopleSec — longer ones open a
 *     multiple_people episode and are sampled as 'after_multiple_people'), then one face again;
 *   - jump: between consecutive analysed frames the face box moved by more than 0.6 face sizes per 200 ms
 *     (at most 1.5) or its width changed by more than ×1.35 per 200 ms (boxes touching the frame edge are
 *     not compared: clamped boxes shrink as a face leaves the view).
 * appearance_change — without any break, the face's appearance descriptor (16×16 face-aligned, normalised
 *   grey patch + landmark ratios, continuity/descriptor.ts) jumped away from a rolling baseline of the recent
 *   stable track and stayed away for ≥ 300 ms. Turning the head changes the patch too, so the comparison is
 *   pose-aware: within 10° of the baseline pose the threshold is max(0.2, mean + 6·sd of this track's own
 *   distances); beyond that it rises by 0.01 per degree, and beyond 25° nothing is compared. (A different
 *   person usually also sits at a different measured pose — the e2e swap fixture: +17° pitch — so the gate
 *   must not simply skip other poses.) Only frames within 10° update the rolling baseline. After firing, the
 *   baseline is rebuilt from the new appearance, so a lasting change (glasses on, a hand at the chin) fires
 *   once.
 *
 * Tuning (MediaPipe landmarks on real images, 160×120 analysis frame; docs in the package README):
 *   same image re-framed / re-lit / blurred / noisy / rolled ±6°: patch p95 0.039, max 0.131;
 *   same person turned (synthetic head-turn video) within 10°: max 0.048, 15–20°: ≤ 0.133, 20–25°: ≤ 0.167;
 *   different people, frontal: p5 0.309, min 0.218 (262 pairs); e2e A→B swap: 0.52–0.54 at +17° pose.
 *
 * Both triggers share a rate limit (≥ 4 s apart). A trigger inside that window is not lost: it is deferred to
 * the end of the window (highest priority kept). The scheduler then samples as soon as one face is steady
 * for 0.3 s, ahead of any routine sample.
 */
export const CONTINUITY = {
  breakMinGapMs: 250,
  breakMinMissingFrames: 2,
  multiMinFrames: 2,
  /** Face-box centre shift allowed per 200 ms, in face sizes (scaled with the frame interval, capped). */
  jumpPer200ms: 0.6,
  jumpMax: 1.5,
  /** Face-box width ratio allowed per 200 ms (compounded with the frame interval, capped at ×2). */
  scalePer200ms: 1.35,
  /** Frames further apart than this are not "consecutive" (no jump test). */
  consecutiveMaxMs: 1000,
  /** Frames that build a baseline must stay within this pose distance of each other (deg). */
  buildPoseDeg: 8,
  /** No comparison beyond this pose distance from the baseline pose (deg). */
  poseGateDeg: 25,
  /** Pose distance with the plain threshold; beyond it the threshold rises by poseSlope per degree. */
  poseFreeDeg: 10,
  poseSlope: 0.01,
  /** Frames needed to (re)build the rolling appearance baseline. */
  baselineFrames: 5,
  /** Weight of a new (non-exceeding) frame in the rolling baseline. */
  baselineAlpha: 0.1,
  /** Patch distance threshold: max(floor, mean + k·sd of this track's own recent distances), capped. */
  patchFloor: 0.2,
  patchK: 6,
  patchCap: 0.45,
  /** Weight of the distance statistics EWMA. */
  statsAlpha: 0.05,
  /** Geometry corroboration: a patch distance ≥ patchCorroborated × threshold counts when geometry moved ≥ geomThreshold. */
  geomThreshold: 0.06,
  patchCorroborated: 0.7,
  persistMs: 300,
  persistFrames: 2,
  /** Minimum time between swap triggers. */
  minGapMs: 4000,
} as const;

export interface ContinuityFire {
  t: number;
  trigger: 'track_break' | 'appearance_change';
  reason: 'gap' | 'count' | 'jump' | 'appearance';
  /** Set when the trigger was deferred by the rate limit and armed later. */
  armedAt?: number;
  detail?: Record<string, number>;
}

export interface ContinuityState {
  /** Latest patch / geometry distance to the rolling baseline (NaN when not compared this frame). */
  patchDistance: number;
  geomDistance: number;
  patchThreshold: number;
  baselineFrames: number;
  fired: ContinuityFire[];
}

interface Baseline {
  patch: Float32Array;
  geom: number[] | null;
  yaw: number;
  pitch: number;
  n: number;
}

function centre(b: NormBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export class ContinuityDetector {
  private last: { box: NormBox; t: number; cutOff: boolean } | null = null;
  private missingSince: number | null = null;
  private missingFrames = 0;
  private multiSince: number | null = null;
  private multiFrames = 0;
  private base: Baseline | null = null;
  private exceedSince: number | null = null;
  private exceedFrames = 0;
  private muP = 0;
  private varP = 0;
  private statN = 0;
  private lastFiredAt = -Infinity;
  private deferred: ContinuityFire | null = null;
  private readonly log: ContinuityFire[] = [];
  private lastP = Number.NaN;
  private lastG = Number.NaN;
  private lastThr: number = CONTINUITY.patchFloor;

  constructor(private readonly host: DetectorHost) {}

  step(ctx: TickContext): void {
    const t = ctx.t;
    this.releaseDeferred(t);
    this.lastP = Number.NaN;
    this.lastG = Number.NaN;
    if (!ctx.live) {
      // Camera off: the camera_reconnect sample covers what happens meanwhile; start a fresh track after.
      this.resetTrack();
      return;
    }
    if (!ctx.frame || ctx.covered || ctx.frozenActive) return; // nothing reliable to compare this tick
    const n = ctx.faceCount;
    if (n === 0) {
      if (this.last) {
        this.missingSince ??= t;
        this.missingFrames++;
      }
      this.clearExceed();
      return;
    }
    if (n >= 2) {
      this.multiSince ??= t;
      this.multiFrames++;
      this.clearExceed();
      return;
    }
    const f = ctx.primary as FaceObservation;
    let fire: ContinuityFire | null = null;
    if (this.missingSince !== null) {
      const gap = t - this.missingSince;
      if (this.missingFrames >= CONTINUITY.breakMinMissingFrames && gap >= CONTINUITY.breakMinGapMs && gap < K.faceReturnMinMs) {
        fire = { t, trigger: 'track_break', reason: 'gap', detail: { gapMs: Math.round(gap) } };
      }
      this.missingSince = null;
      this.missingFrames = 0;
    }
    if (this.multiSince !== null) {
      const dur = t - this.multiSince;
      if (!fire && this.multiFrames >= CONTINUITY.multiMinFrames && dur < this.host.policy.multiplePeopleSec * 1000) {
        fire = { t, trigger: 'track_break', reason: 'count', detail: { multiMs: Math.round(dur) } };
      }
      this.multiSince = null;
      this.multiFrames = 0;
    }
    if (!fire && this.last && !this.last.cutOff && !f.cutOff) {
      const dt = t - this.last.t;
      if (dt > 0 && dt <= CONTINUITY.consecutiveMaxMs) {
        const a = this.last.box;
        const b = f.box;
        const ca = centre(a);
        const cb = centre(b);
        const w = Math.max(1e-3, (a.w + b.w) / 2);
        const h = Math.max(1e-3, (a.h + b.h) / 2);
        const shift = Math.hypot((cb.x - ca.x) / w, (cb.y - ca.y) / h);
        const steps = Math.max(1, dt / 200);
        const allowShift = Math.min(CONTINUITY.jumpMax, CONTINUITY.jumpPer200ms * steps);
        const allowScale = Math.min(2, CONTINUITY.scalePer200ms ** steps);
        const scale = a.w > 0 ? b.w / a.w : 1;
        if (shift > allowShift || scale > allowScale || scale < 1 / allowScale) {
          fire = { t, trigger: 'track_break', reason: 'jump', detail: { shift: round3(shift), scale: round3(scale), dtMs: Math.round(dt) } };
        }
      }
    }
    this.last = { box: f.box, t, cutOff: f.cutOff };

    if (!fire) fire = this.appearance(ctx, f);
    else this.clearExceed();
    if (fire) this.request(fire);
  }

  /** Appearance comparison against the rolling baseline; returns a fire when the change persisted. */
  private appearance(ctx: TickContext, f: FaceObservation): ContinuityFire | null {
    const d = descriptorOf(f);
    if (!d?.patch) {
      this.clearExceed();
      return null;
    }
    const t = ctx.t;
    const C = CONTINUITY;
    const b = this.base;
    const dpose = b ? Math.max(Math.abs(f.yaw - b.yaw), Math.abs(f.pitch - b.pitch)) : 0;
    if (!b || b.n < C.baselineFrames) {
      // (Re)building the baseline: running mean of the first frames at a steady pose.
      if (b && dpose > C.buildPoseDeg) this.base = null; // not steady yet — start again from this pose
      this.accumulate(f, d.patch, d.geom, true);
      return null;
    }
    if (dpose > C.poseGateDeg) {
      // Head turned far: not comparable (and not evidence either way).
      this.clearExceed();
      return null;
    }
    const dp = patchDistance(d.patch, b.patch);
    const dg = geomDistance(d.geom, b.geom);
    this.lastP = dp;
    this.lastG = dg;
    if (!Number.isFinite(dp)) return null;
    const sd = Math.sqrt(Math.max(0, this.varP));
    const base = this.statN >= C.baselineFrames ? Math.min(C.patchCap, Math.max(C.patchFloor, this.muP + C.patchK * sd)) : C.patchCap;
    const thr = base + C.poseSlope * Math.max(0, dpose - C.poseFreeDeg);
    this.lastThr = thr;
    const exceed = dp > thr || (Number.isFinite(dg) && dg >= C.geomThreshold && dp >= C.patchCorroborated * thr);
    if (exceed) {
      this.exceedSince ??= t;
      this.exceedFrames++;
      if (this.exceedFrames >= C.persistFrames && t - this.exceedSince >= C.persistMs) {
        const fire: ContinuityFire = { t, trigger: 'appearance_change', reason: 'appearance', detail: { patch: round3(dp), geom: round3(dg), threshold: round3(thr) } };
        // The new appearance becomes the baseline (so a lasting change fires once, not every few seconds).
        this.base = null;
        this.statN = 0;
        this.muP = 0;
        this.varP = 0;
        this.clearExceed();
        return fire;
      }
      return null;
    }
    this.clearExceed();
    // Stable frame near the baseline pose: update the distance statistics and the rolling baseline.
    if (dpose > C.poseFreeDeg) return null;
    if (this.statN === 0) {
      this.muP = dp;
      this.varP = 0;
    } else {
      const a = C.statsAlpha;
      const diff = dp - this.muP;
      this.muP += a * diff;
      this.varP = (1 - a) * (this.varP + a * diff * diff);
    }
    this.statN++;
    this.accumulate(f, d.patch, d.geom, false);
    return null;
  }

  private accumulate(f: FaceObservation, patch: Float32Array, geom: number[] | null, building: boolean): void {
    const b = this.base;
    if (!b) {
      this.base = { patch: Float32Array.from(patch), geom: geom ? [...geom] : null, yaw: f.yaw, pitch: f.pitch, n: 1 };
      return;
    }
    const a = building ? 1 / (b.n + 1) : CONTINUITY.baselineAlpha;
    for (let i = 0; i < b.patch.length; i++) b.patch[i] += a * (patch[i] - b.patch[i]);
    if (geom && b.geom && geom.length === b.geom.length) for (let i = 0; i < geom.length; i++) b.geom[i] += a * (geom[i] - b.geom[i]);
    else if (geom && !b.geom) b.geom = [...geom];
    b.yaw += a * (f.yaw - b.yaw);
    b.pitch += a * (f.pitch - b.pitch);
    b.n++;
  }

  private request(fire: ContinuityFire): void {
    if (fire.t - this.lastFiredAt >= CONTINUITY.minGapMs) {
      this.arm(fire, fire.t);
      return;
    }
    if (!this.deferred || triggerPriority(fire.trigger) > triggerPriority(this.deferred.trigger)) this.deferred = fire;
  }

  private releaseDeferred(t: number): void {
    if (this.deferred && t - this.lastFiredAt >= CONTINUITY.minGapMs) {
      const d = this.deferred;
      this.deferred = null;
      this.arm(d, t);
    }
  }

  private arm(fire: ContinuityFire, at: number): void {
    this.lastFiredAt = at;
    const entry = at !== fire.t ? { ...fire, armedAt: at } : fire;
    this.log.push(entry);
    if (this.log.length > 50) this.log.shift();
    this.host.identity.arm(fire.trigger as IdentityTrigger);
  }

  private clearExceed(): void {
    this.exceedSince = null;
    this.exceedFrames = 0;
  }

  private resetTrack(): void {
    this.last = null;
    this.missingSince = null;
    this.missingFrames = 0;
    this.multiSince = null;
    this.multiFrames = 0;
    this.clearExceed();
  }

  state(): ContinuityState {
    return {
      patchDistance: this.lastP,
      geomDistance: this.lastG,
      patchThreshold: this.lastThr,
      baselineFrames: this.base?.n ?? 0,
      fired: [...this.log],
    };
  }

  /** Pause / stop: forget the track, the baseline and anything deferred. */
  reset(): void {
    this.resetTrack();
    this.base = null;
    this.statN = 0;
    this.muP = 0;
    this.varP = 0;
    this.deferred = null;
    this.lastFiredAt = -Infinity;
  }
}

function round3(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}
