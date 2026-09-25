/**
 * Decides when a live-person / identity check should be handed to the server for a verdict even
 * though the guided capture did not finish — so every attempt is recorded server-side (unable to
 * verify / liveness not shown), counts toward the exam's attempt limit, is visible to staff, and the
 * candidate gets the server's guidance instead of waiting for the challenge to expire.
 *
 *  - frontal frames the server keeps rejecting (e.g. too dark): give up after `maxFrontalRejections`
 *    (kept below the server's cap of 10 frontal frames per check);
 *  - no progress at all (no accepted frame, no liveness step advancing / getting closer) for `stallMs`.
 */
import type { StartCheckResponse } from '@sp/shared';

export interface CheckProgressOptions {
  maxFrontalRejections?: number;
  stallMs?: number;
  /** Minimum increase of a liveness step's progress (0..1) that counts as "getting closer". */
  minProgressGain?: number;
}

export type GiveUpReason = 'frontal_rejected' | 'stalled';

export class CheckProgress {
  readonly maxFrontalRejections: number;
  readonly stallMs: number;
  private readonly minGain: number;
  private lastProgressAt = 0;
  private rejected = 0;
  private stepIndex: number | null = null;
  private bestStepProgress = 0;

  constructor(opts: CheckProgressOptions = {}) {
    this.maxFrontalRejections = opts.maxFrontalRejections ?? 6;
    this.stallMs = opts.stallMs ?? 30_000;
    this.minGain = opts.minProgressGain ?? 0.05;
  }

  start(now: number): void {
    this.lastProgressAt = now;
    this.rejected = 0;
    this.stepIndex = null;
    this.bestStepProgress = 0;
  }

  /** The server accepted a frame (frontal or step). */
  accepted(now: number): void {
    this.lastProgressAt = now;
  }

  /** The server rejected a frontal frame. Returns true when the check should be completed now. */
  frontalRejected(): boolean {
    this.rejected++;
    return this.rejected >= this.maxFrontalRejections;
  }

  get frontalRejections(): number {
    return this.rejected;
  }

  /** Liveness guidance update: a new step, or getting closer to the current step's target, is progress. */
  liveness(stepIndex: number, progress: number, now: number): void {
    if (stepIndex !== this.stepIndex) {
      this.stepIndex = stepIndex;
      this.bestStepProgress = progress;
      this.lastProgressAt = now;
      return;
    }
    if (progress >= this.bestStepProgress + this.minGain) {
      this.bestStepProgress = progress;
      this.lastProgressAt = now;
    }
  }

  /** A liveness frame was captured for the current step. */
  captured(now: number): void {
    this.lastProgressAt = now;
  }

  stalled(now: number): boolean {
    return now - this.lastProgressAt >= this.stallMs;
  }
}

/**
 * "Attempts remaining after this one": an attempt that fails only because the pictures were unclear (poor light,
 * blur) counts as half an attempt, so it may leave one more try than an ordinary failure (older server: no split).
 */
export function attemptsAfterText(check: Pick<StartCheckResponse, 'attemptsRemaining' | 'attemptsAfter'>): string {
  const failed = check.attemptsAfter?.failed ?? Math.max(0, check.attemptsRemaining - 1);
  const unclear = check.attemptsAfter?.unclear ?? failed;
  // Never "0" while pictures that are merely unclear would still allow another try.
  if (failed === 0 && unclear > 0) return 'This is your last attempt — unless the pictures are too unclear to compare (for example too dark); then you can try once more.';
  return `Attempts remaining after this one: ${failed}`;
}
