import type { CheckFrameResponse, CheckProgressDTO, StartCheckResponse } from '@sp/shared';

/**
 * Adaptive frame collection for a check (initial / resume / reconnect / reverify) — what to send next and
 * when to ask the server for its verdict. The server is authoritative; this only follows its lead:
 *
 *  v2 (CheckFrameResponse.progress present):
 *   - frontal frames while progress.frontalNeeded > 0, up to StartCheckResponse.maxFrontalFrames;
 *   - liveness steps in order; a step the server reports unsatisfied is re-prompted in place (the liveness
 *     tracker handles the in-place retry; see its `verdict`);
 *   - /complete as soon as progress.canComplete and the liveness steps are resolved (satisfied, or their frame
 *     budget used up), or when there is nothing left the client could add.
 *  v1 (no progress — an older server): frontalFramesRequired accepted frontal frames (giving up after
 *   `maxFrontalRejections` rejected ones so the server records "unable to verify" with its guidance), then the
 *   liveness steps, then /complete.
 */

export const DEFAULT_MAX_FRONTAL_FRAMES = 10;
/** v1: rejected frontal frames before the attempt is handed to the server (kept below its cap of 10). */
export const V1_MAX_FRONTAL_REJECTIONS = 6;

export type AdaptivePhase = 'frontal' | 'liveness' | 'complete';

export class AdaptiveCheck {
  readonly required: number;
  readonly maxFrontal: number;
  private progressDTO: CheckProgressDTO | null = null;
  frontalSent = 0;
  frontalAnswered = 0;
  frontalAccepted = 0;
  frontalRejected = 0;
  /** Client poses of accepted frontal frames (for the liveness tracker's centre). */
  private readonly frontalPoses: { yaw: number; pitch: number }[] = [];
  private readonly stepSatisfied = new Map<number, boolean>();
  private readonly stepSent = new Map<number, number>();
  private readonly stepAnswered = new Map<number, number>();
  /** The server refused more frames (429 too_many_frames): complete with what it has. */
  framesExhausted = false;

  constructor(
    readonly check: Pick<StartCheckResponse, 'frontalFramesRequired' | 'maxFrontalFrames' | 'liveness'>,
    private readonly opts: { maxFrontalRejections?: number } = {},
  ) {
    this.required = Math.max(0, check.frontalFramesRequired);
    this.maxFrontal = Math.max(this.required, check.maxFrontalFrames ?? DEFAULT_MAX_FRONTAL_FRAMES);
  }

  /** Latest server assessment (v2), or null (v1 server / nothing answered yet). */
  get progress(): CheckProgressDTO | null {
    return this.progressDTO;
  }

  get hasLiveness(): boolean {
    return !!this.check.liveness && this.check.liveness.steps.length > 0;
  }

  private take(res: CheckFrameResponse): void {
    if (res.progress && typeof res.progress === 'object') {
      this.progressDTO = res.progress;
      for (const s of res.progress.steps ?? []) if (s.satisfied) this.stepSatisfied.set(s.index, true);
    }
  }

  frontalSentOne(): void {
    this.frontalSent++;
  }

  /** A frontal upload failed without an answer (network): it may be sent again. */
  frontalFailed(): void {
    this.frontalSent = Math.max(this.frontalAnswered, this.frontalSent - 1);
  }

  frontalResult(res: CheckFrameResponse, pose?: { yaw: number; pitch: number } | null): void {
    this.frontalAnswered++;
    if (res.accepted) {
      this.frontalAccepted++;
      if (pose && Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch)) this.frontalPoses.push({ yaw: pose.yaw, pitch: pose.pitch });
    } else this.frontalRejected++;
    this.take(res);
  }

  stepSentOne(index: number): void {
    this.stepSent.set(index, (this.stepSent.get(index) ?? 0) + 1);
  }

  stepFailed(index: number): void {
    this.stepSent.set(index, Math.max(this.stepAnswered.get(index) ?? 0, (this.stepSent.get(index) ?? 1) - 1));
  }

  stepResult(index: number, res: CheckFrameResponse): void {
    this.stepAnswered.set(index, (this.stepAnswered.get(index) ?? 0) + 1);
    if (res.stepSatisfied) this.stepSatisfied.set(index, true);
    this.take(res);
  }

  /** Every frame sent for the step has been answered. */
  stepSettled(index: number): boolean {
    return (this.stepAnswered.get(index) ?? 0) >= (this.stepSent.get(index) ?? 0);
  }

  isStepSatisfied(index: number): boolean {
    return this.stepSatisfied.get(index) === true;
  }

  /** Median client pose of the accepted frontal frames (the same frames the server takes as the centre). */
  frontalCentre(): { yaw: number; pitch: number } | null {
    if (this.frontalPoses.length === 0) return null;
    const med = (v: number[]) => {
      const s = [...v].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    return { yaw: med(this.frontalPoses.map((p) => p.yaw)), pitch: med(this.frontalPoses.map((p) => p.pitch)) };
  }

  /** Usable frontal frames so far (the server's count when it reports one). */
  acceptedFrontal(): number {
    return Math.max(this.frontalAccepted, this.progressDTO?.frontalAccepted ?? 0);
  }

  /** More frontal frames are wanted (and may be sent). */
  wantsFrontal(): boolean {
    if (this.framesExhausted || this.frontalSent >= this.maxFrontal) return false;
    const p = this.progressDTO;
    if (p) return p.frontalNeeded > 0;
    if (this.frontalAnswered === 0 && this.frontalSent === 0) return this.required > 0;
    return this.frontalAccepted < this.required && this.frontalRejected < (this.opts.maxFrontalRejections ?? V1_MAX_FRONTAL_REJECTIONS);
  }

  /** v1: the frontal frames keep failing the quality gate — hand the attempt to the server. */
  frontalGaveUp(): boolean {
    if (this.progressDTO) return false;
    return this.frontalAccepted < this.required && this.frontalRejected >= (this.opts.maxFrontalRejections ?? V1_MAX_FRONTAL_REJECTIONS);
  }

  /**
   * What to do next, given whether the liveness guidance is finished (`livenessDone`: every step satisfied or
   * its frame budget used up) and whether frames are still on their way (`inflight`).
   */
  phase(livenessDone: boolean, inflight: number): AdaptivePhase {
    if (this.framesExhausted) return 'complete';
    const livenessPending = this.hasLiveness && !livenessDone;
    const accepted = this.acceptedFrontal();
    const waiting: AdaptivePhase = this.hasLiveness && accepted >= this.required ? 'liveness' : 'frontal';
    const p = this.progressDTO;
    if (p) {
      if (inflight === 0 && p.canComplete && (!livenessPending || p.identity === 'likely_mismatch')) return 'complete';
      // The minimum frontal frames first (the server's reference pose); more frontal frames after the steps.
      if (this.wantsFrontal() && (accepted < this.required || !livenessPending)) return 'frontal';
      // Frontal budget used up without enough usable frames: the server explains why ("unable to verify").
      if (accepted < this.required) return inflight === 0 ? 'complete' : 'frontal';
      if (livenessPending) return 'liveness';
      return inflight === 0 ? 'complete' : waiting;
    }
    if (this.frontalGaveUp()) return inflight === 0 ? 'complete' : 'frontal';
    if (this.frontalAccepted < this.required) return 'frontal';
    if (livenessPending) return 'liveness';
    return inflight === 0 ? 'complete' : waiting;
  }

  /** 0..1 progress for the candidate's overall progress bar. */
  overall(stepsDone: number): number {
    const steps = this.check.liveness?.steps.length ?? 0;
    const p = this.progressDTO;
    const need = p ? p.frontalAccepted + p.frontalNeeded : this.required;
    const frontalDone = Math.min(p ? p.frontalAccepted : this.frontalAccepted, need);
    const total = Math.max(1, need) + steps;
    return Math.min(1, (frontalDone + stepsDone) / total);
  }
}
