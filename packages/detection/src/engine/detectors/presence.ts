import { K, type DetectorHost, type TickContext } from '../context';
import { dur, Span, type FlushReason } from '../span';
import type { MovementDetector } from './movement';

/** Face must be seen this long to count as "returned" (a single spurious face frame is ignored). */
const RETURN_CONFIRM_MS = 400;

/**
 * candidate_absent + face-presence bookkeeping.
 *
 * - candidate_absent: no face for ≥ absenceSec while the camera is live and the frame is usable (not
 *   covered/frozen, not too dark to see a face). A 'person' from the object detector without a face is
 *   face_obstructed, not absence.
 * - Absence run (any length) drives: candidate prompt after 3 s, exits (≥ 2 s) for unusual_movement, and
 *   an identity_sample 'face_return' when a face returns after ≥ 3 s (flagged or not).
 */
export class PresenceDetector {
  readonly span: Span;
  private state: 'unknown' | 'present' | 'absent' = 'unknown';
  private absentSince: number | null = null;
  private returnSince: number | null = null;
  private exitReported = false;
  private returned = false;

  constructor(
    private host: DetectorHost,
    private movement: MovementDetector,
  ) {
    const p = host.policy;
    this.span = new Span(host, 'candidate_absent', 'candidate_absent', { onsetMs: p.absenceSec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 1000, minTicks: 3 }, {
      describe: (d) => {
        const details: Record<string, unknown> = { durationSec: d.durationSec };
        let observation: string;
        if (d.phase === 'close') {
          details.faceReturned = this.returned && !d.closedBy;
          observation = details.faceReturned
            ? `No face was visible in the camera view for ${dur(d.durationSec)}; a face was visible again afterwards.`
            : `No face was visible in the camera view for ${dur(d.durationSec)}.`;
        } else observation = `No face has been visible in the camera view for ${dur(d.durationSec)}.`;
        return { details, observation };
      },
    });
    this.span.onBegin = () => {
      this.returned = false;
    };
  }

  get absentFor(): number {
    return this.absentSince === null ? 0 : this.lastT - this.absentSince;
  }

  get isAbsent(): boolean {
    return this.state === 'absent';
  }

  private lastT = 0;

  step(ctx: TickContext): void {
    const t = ctx.t;
    this.lastT = t;
    const p = this.host.policy;
    const evaluable = ctx.visionOk && !(ctx.frameDark && ctx.faceCount === 0);
    const noFace = ctx.faceCount === 0;
    this.run(t, evaluable ? noFace : null);
    if (p.enabled.absence) {
      const v = evaluable ? noFace && !ctx.personVisible : null;
      const score = ctx.frame && ctx.frame.luma < 50 ? 0.85 : 1;
      this.span.feed(t, v, score);
    }
    const promptOn = this.state === 'absent' && evaluable && t - (this.absentSince ?? t) >= K.absencePromptMs;
    if (promptOn) this.host.prompts.set('face_not_visible', true, this.host.signals);
    else if (this.state !== 'absent' || !ctx.live || ctx.covered) this.host.prompts.set('face_not_visible', false, this.host.signals);
  }

  private run(t: number, noFace: boolean | null): void {
    if (noFace === null) return;
    if (noFace) {
      this.returnSince = null;
      if (this.state !== 'absent') {
        this.state = 'absent';
        this.absentSince = t;
        this.exitReported = false;
      } else if (!this.exitReported && this.absentSince !== null && t - this.absentSince >= K.exitMinMs) {
        this.exitReported = true;
        this.movement.exitStarted(this.absentSince, t);
      }
      return;
    }
    if (this.state === 'absent') {
      this.returnSince ??= t;
      if (t - this.returnSince >= RETURN_CONFIRM_MS) {
        const since = this.absentSince ?? this.returnSince;
        const d = this.returnSince - since;
        if (d >= K.faceReturnMinMs) this.host.identity.arm('face_return');
        if (this.exitReported) this.movement.exitEnded(this.returnSince);
        this.returned = true;
        this.state = 'present';
        this.absentSince = null;
        this.returnSince = null;
      }
      return;
    }
    this.state = 'present';
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.host.prompts.set('face_not_visible', false, this.host.signals);
    this.reset();
  }

  reset(): void {
    this.span.reset();
    this.state = 'unknown';
    this.absentSince = null;
    this.returnSince = null;
    this.exitReported = false;
    this.returned = false;
  }
}
