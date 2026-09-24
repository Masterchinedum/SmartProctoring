/**
 * Identity-continuity evidence (pure functions, no I/O): per-comparison log-likelihood ratios with per-session
 * normalisation, the sequential evidence accumulator used during the exam, the multi-frame assessment used at
 * resume / reconnect / reverify checks, and the server-driven sampling cadence.
 *
 * Calibration (similarity distributions per quality bucket, LLR clamp, SPRT thresholds, prior) comes from
 * vision/calibration.ts and is NOT duplicated here. This module adds what only the session knows:
 *
 *  1. Per-session normalisation. At enrolment we measure how similar the candidate's own frames are to each other
 *     (leave-one-out score against the rest of the gallery: `SessionBaseline`). The global genuine model of a
 *     bucket mixes people whose faces are very self-consistent with people who are not; knowing THIS person's level
 *     removes most of that between-person spread. A probe similarity s is mapped into the global genuine frame by a
 *     z-score transfer from the personal genuine model:
 *         s' = g.mean + (s - p.mean) * (g.sd / p.sd)
 *     where p.mean = baseline.mean - drift(bucket) and p.sd = sqrt(baseline.sd^2 + driftSd(bucket)^2) with the drift
 *     measured by the vision module (`GENUINE_DRIFT`: 'continuous' = same session, 'relaxed' = another day / room /
 *     camera), both bounded (band around the global mean, limited sharpening, shrinkage towards the global model with
 *     few enrolment frames), and then scored with the calibrated `sampleLLR(s', bucket)`. So a drop from the person's
 *     own level is evidence of a different person even above the global mismatch threshold, while a person whose own
 *     frames are only ~0.6 similar gets a more lenient model. Poor frames are barely normalised. The 'relaxed' drift
 *     applies at resume / reconnect / reverify checks and to every mid-exam sample after such a check (the room,
 *     light and camera may differ from enrolment): 'continuous' normalisation across days caused 9–27 false alarms
 *     per 1,000 h in the vision module's simulation (docs/accuracy/identity-v2.md §9).
 *  2. Accumulation (SPRT / windowed CUSUM): clamped LLRs of samples (a burst counts as ONE sample: its frames are
 *     taken within ~0.6 s and are not independent) are summed over a window of the last `sprt.maxSamples` samples
 *     no older than 10 minutes, with positive evidence from 'poor' samples capped at `sprt.maxPoorEvidence`
 *     (`windowEvidence`, below `sprt.confirm`): poor light alone can make a session 'suspect' — faster sampling,
 *     lighting guidance, an uncertain observation for staff — but confirmation waits for a fair or good frame. sum >= sprt.suspect => 'suspect' (ask for a faster sample), sum >= sprt.confirm =>
 *     'confirmed_mismatch', sum <= sprt.clear => evidence cleared ('consistent', window emptied) so lighting dips
 *     do not accumulate forever. Unusable frames contribute nothing (never "different person"). A discontinuity
 *     (track break, face return, camera reconnect, exam start...) drops earlier genuine evidence from the window —
 *     it vouched for whoever was in view BEFORE the break — and weights positive evidence of that sample by 1.25
 *     (a swap can only happen at a break). With the LLR clamp (5) and weight, a single sample can never reach
 *     `sprt.confirm` (7): at least two fair / good samples are always needed.
 */
import type { FaceQuality, IdentityCheckTrigger, IdentityDecision, IdentityEvidenceDTO, IdentityPolicy, IdentitySampleRequestDTO, IdentityThresholds, SessionStatus } from '@sp/shared';
import { GENUINE_DRIFT, windowEvidence } from '../vision/calibration.js';
import { BUCKET_MODELS, CALIBRATION, decideIdentity, posteriorSwap, qualityBucket, sampleLLR, type QualityBucket } from '../vision/index.js';

/* =================================================================== per-session normalisation */

/** Genuine self-similarity measured at enrolment (leave-one-out scores of the gallery frames). */
export interface SessionBaseline {
  mean: number;
  sd: number;
  /** Frames the statistics were computed from. */
  n: number;
  /** CALIBRATION.version when measured. */
  calibrationVersion?: string;
}

export type ComparisonContext =
  /** Same session, minutes apart (mid-exam samples). */
  | 'continuous'
  /** Possibly hours / days later, another room or camera (resume / reconnect / reverify checks, camera reconnect). */
  | 'relaxed';

export const SESSION_NORMALISATION = Object.freeze({
  /** Measured drop of a genuine probe below the enrolment baseline, per context and bucket (vision/calibration.ts). */
  drift: GENUINE_DRIFT,
  /** The personal genuine mean stays within [global - below, global + above]. */
  meanBand: Object.freeze({ below: 0.08, above: 0.04 }),
  /** The personal sd is at least global sd / maxSharpen (per bucket; poor frames and the 'relaxed' context are not sharpened). */
  maxSharpen: Object.freeze({ good: 1.35, fair: 1.2, poor: 1.0 }) as Readonly<Record<QualityBucket, number>>,
  /** Baselines from fewer frames are ignored. */
  minBaselineFrames: 3,
  /** Shrinkage towards the global model: weight n / (n + shrinkFrames). */
  shrinkFrames: 3,
});

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

export function usableBaseline(b: SessionBaseline | null | undefined): b is SessionBaseline {
  return !!b && Number.isFinite(b.mean) && Number.isFinite(b.sd) && b.n >= SESSION_NORMALISATION.minBaselineFrames;
}

/** The personal genuine model (similarity of this person's probes to their reference) for a bucket. */
export function personalGenuine(bucket: QualityBucket, baseline: SessionBaseline, context: ComparisonContext = 'continuous'): { mean: number; sd: number } {
  const g = BUCKET_MODELS[bucket].genuine;
  const N = SESSION_NORMALISATION;
  const d = N.drift[context][bucket];
  const rawMean = clamp(baseline.mean - d.mean, g.mean - N.meanBand.below, g.mean + N.meanBand.above);
  // Across rooms / cameras / days ('relaxed') the personal model may shift its mean but is never sharper than the global one.
  const sharpen = context === 'relaxed' ? 1 : N.maxSharpen[bucket];
  const rawSd = Math.max(Math.sqrt(baseline.sd * baseline.sd + d.sd * d.sd), g.sd / sharpen);
  const w = baseline.n / (baseline.n + N.shrinkFrames);
  return { mean: w * rawMean + (1 - w) * g.mean, sd: w * rawSd + (1 - w) * g.sd };
}

/** Similarity mapped into the global genuine frame of the bucket (identity when there is no usable baseline). */
export function normaliseSimilarity(similarity: number, bucket: QualityBucket, baseline: SessionBaseline | null | undefined, context: ComparisonContext = 'continuous'): number {
  if (!usableBaseline(baseline)) return similarity;
  const g = BUCKET_MODELS[bucket].genuine;
  const p = personalGenuine(bucket, baseline, context);
  return g.mean + (similarity - p.mean) * (g.sd / p.sd);
}

/**
 * Evidence of one comparison: clamped, monotone LLR (> 0 = evidence of a different person; vision/calibration.ts
 * `sampleLLR`) of the similarity after per-session normalisation.
 */
export function comparisonLLR(similarity: number, bucket: QualityBucket, baseline: SessionBaseline | null | undefined, context: ComparisonContext = 'continuous'): { llr: number; normalised: number } {
  if (!Number.isFinite(similarity)) return { llr: 0, normalised: similarity };
  const normalised = normaliseSimilarity(similarity, bucket, baseline, context);
  return { llr: round4(sampleLLR(normalised, bucket)), normalised: round4(normalised) };
}

export interface FrameEvidence {
  /** Quality gate passed and an embedding / similarity exists. */
  usable: boolean;
  similarity: number | null;
  bucket: QualityBucket | null;
  llr: number;
}

/** Evidence of one frame (or one burst aggregate) given its quality and similarity to the reference. */
export function frameEvidence(quality: FaceQuality | null, similarity: number | null, baseline: SessionBaseline | null | undefined, context: ComparisonContext = 'continuous'): FrameEvidence {
  if (!quality || !quality.usable || similarity == null || !Number.isFinite(similarity)) return { usable: false, similarity: similarity ?? null, bucket: null, llr: 0 };
  const bucket = qualityBucket(quality);
  return { usable: true, similarity, bucket, llr: comparisonLLR(similarity, bucket, baseline, context).llr };
}

/** Clear genuine evidence for one sample (used for "clean match" and to end a confirmed mismatch). */
export const CLEAR_MATCH_LLR = -3;
/** A single sample at or above this is shown to staff as notable evidence of a different person. */
export const STRONG_MISMATCH_LLR = 4;

/* =================================================================== accumulator (mid-exam samples) */

export type EvidenceStateName = IdentityEvidenceDTO['state'];

export interface EvidenceEntry {
  /** identity_checks row id of the sample. */
  id: string;
  at: number;
  /** Contribution (clamped LLR, trigger weight applied). */
  llr: number;
  similarity: number | null;
  bucket: QualityBucket;
  trigger: IdentityCheckTrigger;
}

export interface EvidenceAccumulator {
  /** Samples contributing to the current evidence (since the last clear), oldest first, at most sprt.maxSamples. */
  window: EvidenceEntry[];
  state: EvidenceStateName;
  /** When the current confirmed mismatch was reached. */
  confirmedAt: number | null;
  /** Consecutive clear genuine samples while confirmed (ends the confirmed state). */
  clearStreak: number;
  /** Consecutive samples without a usable face image. */
  unusableStreak: number;
  lastSampleAt: number | null;
  lastUsableAt: number | null;
}

export const EMPTY_ACCUMULATOR: Readonly<EvidenceAccumulator> = Object.freeze({
  window: [],
  state: 'consistent',
  confirmedAt: null,
  clearStreak: 0,
  unusableStreak: 0,
  lastSampleAt: null,
  lastUsableAt: null,
}) as Readonly<EvidenceAccumulator>;

export const EVIDENCE = Object.freeze({
  /** Accumulated evidence (or the latest contribution) above this => 'monitoring' (sample a little faster). */
  monitorLLR: 1,
  /** Consecutive clear genuine samples that end a confirmed mismatch (the original person is back). */
  closeAfterClearSamples: 2,
  /** Samples older than this leave the evidence window. */
  maxAgeMs: 10 * 60_000,
  /** Weight of positive evidence from a sample taken at a discontinuity. */
  discontinuityWeight: 1.25,
});

/** Triggers at which the person in view may have changed (earlier genuine evidence no longer vouches for them). */
export const DISCONTINUITY_TRIGGERS: ReadonlySet<IdentityCheckTrigger> = new Set<IdentityCheckTrigger>([
  'exam_start',
  'track_break',
  'appearance_change',
  'face_return',
  'camera_reconnect',
  'after_multiple_people',
  'after_obstruction',
]);

/** Triggers processed with interactive priority (someone may have just swapped in). */
export const URGENT_TRIGGERS: ReadonlySet<IdentityCheckTrigger> = new Set<IdentityCheckTrigger>([...DISCONTINUITY_TRIGGERS, 'server_request', 'follow_up']);

/** Accumulated evidence of a window: the LLR sum with poor-only positive evidence capped (`windowEvidence`). */
export function windowSum(window: readonly EvidenceEntry[]): number {
  return round4(windowEvidence(window));
}

/**
 * The window is 'suspect' only because of poor-quality samples: without their (capped) positive evidence it would not
 * be. Confirmation then waits for a fair / good frame; staff see an uncertain observation, the candidate lighting
 * guidance.
 */
export function poorLightSuspect(acc: Pick<EvidenceAccumulator, 'state' | 'window'>): boolean {
  if (acc.state !== 'suspect') return false;
  const poorPositive = acc.window.some((e) => e.bucket === 'poor' && e.llr > 0);
  return poorPositive && windowSum(acc.window.filter((e) => !(e.bucket === 'poor' && e.llr > 0))) < CALIBRATION.sprt.suspect;
}

export function toEvidenceDTO(acc: Readonly<EvidenceAccumulator>, prior: number = CALIBRATION.prior): IdentityEvidenceDTO {
  const sum = windowSum(acc.window);
  return { swapProbability: round4(posteriorSwap(sum, prior)), state: acc.state, samples: acc.window.length };
}

export interface SampleObservation {
  id: string;
  at: number;
  trigger: IdentityCheckTrigger;
  evidence: FrameEvidence;
}

export type EvidenceTransition = 'none' | 'monitoring' | 'suspect' | 'confirmed' | 'cleared' | 'recovered';

export interface AccumulateResult {
  acc: EvidenceAccumulator;
  /** What changed with this sample. */
  transition: EvidenceTransition;
  /** Contribution of this sample to the window (0 for unusable samples). */
  contribution: number;
  sum: number;
  posterior: number;
}

/** Add one sample (a burst aggregate or a single frame) to the session's evidence. Pure. */
export function accumulate(prev: Readonly<EvidenceAccumulator>, obs: SampleObservation): AccumulateResult {
  const sprt = CALIBRATION.sprt;
  const acc: EvidenceAccumulator = { ...EMPTY_ACCUMULATOR, ...prev, window: [...(prev.window ?? [])] };
  acc.lastSampleAt = obs.at;
  acc.window = acc.window.filter((e) => obs.at - e.at <= EVIDENCE.maxAgeMs);
  const prevState = acc.state;
  const done = (transition: EvidenceTransition, contribution: number): AccumulateResult => {
    const sum = windowSum(acc.window);
    return { acc, transition, contribution, sum, posterior: round4(posteriorSwap(sum)) };
  };

  if (!obs.evidence.usable || obs.evidence.bucket == null) {
    acc.unusableStreak += 1;
    return done('none', 0);
  }
  acc.unusableStreak = 0;
  acc.lastUsableAt = obs.at;

  const discontinuity = DISCONTINUITY_TRIGGERS.has(obs.trigger);
  if (discontinuity) acc.window = acc.window.filter((e) => e.llr > 0);
  const contribution = round4(obs.evidence.llr > 0 && discontinuity ? obs.evidence.llr * EVIDENCE.discontinuityWeight : obs.evidence.llr);
  acc.window.push({ id: obs.id, at: obs.at, llr: contribution, similarity: obs.evidence.similarity, bucket: obs.evidence.bucket, trigger: obs.trigger });
  while (acc.window.length > sprt.maxSamples) acc.window.shift();
  const sum = windowSum(acc.window);

  if (prevState === 'confirmed_mismatch') {
    acc.clearStreak = contribution <= CLEAR_MATCH_LLR ? acc.clearStreak + 1 : 0;
    if (acc.clearStreak >= EVIDENCE.closeAfterClearSamples) {
      acc.window = [];
      acc.state = 'consistent';
      acc.confirmedAt = null;
      acc.clearStreak = 0;
      return done('recovered', contribution);
    }
    return done('none', contribution);
  }
  if (sum <= sprt.clear) {
    acc.window = [];
    acc.state = 'consistent';
    return done(prevState === 'consistent' ? 'none' : 'cleared', contribution);
  }
  if (sum >= sprt.confirm) {
    acc.state = 'confirmed_mismatch';
    acc.confirmedAt = obs.at;
    acc.clearStreak = 0;
    return done('confirmed', contribution);
  }
  if (sum >= sprt.suspect) {
    acc.state = 'suspect';
    return done(prevState === 'suspect' ? 'none' : 'suspect', contribution);
  }
  if (sum > EVIDENCE.monitorLLR || contribution > EVIDENCE.monitorLLR) {
    acc.state = 'monitoring';
    return done(prevState === 'monitoring' ? 'none' : 'monitoring', contribution);
  }
  acc.state = 'consistent';
  return done(prevState === 'consistent' ? 'none' : 'cleared', contribution);
}

/* =================================================================== per-sample label */

/**
 * The per-sample decision label shown in identity-check lists (org thresholds, as before): the calibrated evidence
 * decides escalation, the label only describes the single comparison. Unusable images are never a mismatch.
 */
export function sampleLabel(similarity: number | null, quality: FaceQuality | null, thresholds: IdentityThresholds): IdentityDecision {
  // vision's quality-aware rule: a poor frame is never labelled "mismatch", a fair / good one only with strong
  // calibrated evidence (MISMATCH_MIN_LLR).
  return decideIdentity(similarity, quality, thresholds, 'reference').decision;
}

/* =================================================================== check assessment (resume / reconnect / reverify) */

export const CHECK_EVIDENCE = Object.freeze({
  /**
   * Frames of one check are seconds apart (same light, same camera, same pose range): they are not independent, so
   * each frame's LLR counts half. Three clear frames of either kind decide.
   */
  frameWeight: 0.5,
  /** Accumulated (weighted) LLR at or below => likely the same person. */
  matchLLR: CALIBRATION.sprt.clear,
  /** At or above => likely a different person. */
  mismatchLLR: CALIBRATION.sprt.confirm,
  /** Usable frames before the running assessment decides (fewer allowed once the collection limit is reached). */
  minFrames: CALIBRATION.minFramesForDecision,
  minFramesAtLimit: 2,
  /** Per-frame LLR regarded as clear evidence either way (mixed clear evidence stays 'uncertain'). */
  clearFrameLLR: 4,
});

export type CheckIdentityStatus = 'pending' | 'likely_match' | 'likely_mismatch' | 'uncertain';

export interface CheckAssessment {
  status: CheckIdentityStatus;
  /** Weighted sum of the usable frames' LLRs. */
  llr: number;
  usable: number;
  clearMatch: number;
  clearMismatch: number;
  posterior: number;
  /** 'uncertain' because the evidence of a different person came only from poor-quality frames (add light). */
  poorLight: boolean;
}

/** Running identity assessment of a check's frames against the protected reference. */
export function assessCheck(frames: readonly FrameEvidence[], opts: { atLimit?: boolean } = {}): CheckAssessment {
  const usable = frames.filter((f) => f.usable);
  // Positive evidence from poor frames is capped as in the SPRT window: a dim-room check ends 'uncertain' (lighting
  // guidance), never 'likely_mismatch', unless fair / good frames add their own evidence.
  const weighted = usable.map((f) => ({ llr: f.llr * CHECK_EVIDENCE.frameWeight, bucket: f.bucket }));
  const llr = round4(windowEvidence(weighted));
  const poorLimited = weighted.some((f) => f.bucket === 'poor' && f.llr > 0) && windowEvidence(weighted.filter((f) => !(f.bucket === 'poor' && f.llr > 0))) < CHECK_EVIDENCE.mismatchLLR;
  const clearMatch = usable.filter((f) => f.llr <= -CHECK_EVIDENCE.clearFrameLLR).length;
  const clearMismatch = usable.filter((f) => f.llr >= CHECK_EVIDENCE.clearFrameLLR).length;
  const min = opts.atLimit ? CHECK_EVIDENCE.minFramesAtLimit : CHECK_EVIDENCE.minFrames;
  let status: CheckIdentityStatus;
  if (usable.length === 0 || usable.length < min) status = 'pending';
  else if (clearMatch >= 2 && clearMismatch >= 2) status = 'uncertain';
  else if (llr <= CHECK_EVIDENCE.matchLLR) status = 'likely_match';
  else if (llr >= CHECK_EVIDENCE.mismatchLLR) status = 'likely_mismatch';
  else status = 'uncertain';
  return { status, llr, usable: usable.length, clearMatch, clearMismatch, posterior: round4(posteriorSwap(llr)), poorLight: status === 'uncertain' && poorLimited };
}

/* =================================================================== cadence */

export const CADENCE = Object.freeze({
  /** While 'suspect': the next burst after this long (trigger server_request). */
  suspectMs: 2_500,
  /** While 'monitoring' or while a flagged mismatch is open (flag_only): at most this long. */
  monitoringMs: 5_000,
  /** After an unusable sample: at most this long (with guidance). */
  unusableMs: 10_000,
  /** A requested faster sample is "late" (heartbeat repeats the request) after this long. */
  lateAfterMs: 6_000,
});

export interface CadenceInput {
  /** When the current active period began (start / resume / reconnect / hold release). */
  activeSince: number | null;
  acc: Pick<EvidenceAccumulator, 'state' | 'unusableStreak'>;
}

/** Server-driven delay until the next routine sample (ms). */
export function nextSampleDelayMs(policy: Pick<IdentityPolicy, 'periodicCheckIntervalSec' | 'startupIntervalSec' | 'startupWindowSec'>, st: CadenceInput, now: number): number {
  const inStartup = st.activeSince != null && now - st.activeSince < policy.startupWindowSec * 1000;
  let ms = (inStartup ? policy.startupIntervalSec : policy.periodicCheckIntervalSec) * 1000;
  if (st.acc.state === 'suspect') ms = Math.min(ms, CADENCE.suspectMs);
  else if (st.acc.state === 'monitoring' || st.acc.state === 'confirmed_mismatch') ms = Math.min(ms, CADENCE.monitoringMs);
  if (st.acc.unusableStreak > 0) ms = Math.min(ms, CADENCE.unusableMs);
  return ms;
}

/**
 * The identity sample the server wants right now (HeartbeatResponse / CandidateSessionState.identitySample):
 * {trigger:'exam_start', inMs:0} after a (re)start until a sample arrives; {trigger:'server_request', inMs:0} while
 * the evidence is 'suspect' and the requested faster sample is late. Pure (computed from the session row), so the
 * single-statement heartbeat can answer it too.
 */
export function identitySampleRequest(
  status: SessionStatus,
  state: { sampleRequest?: { trigger: IdentityCheckTrigger; since: number } | null; evidence?: Partial<EvidenceAccumulator> | null } | null | undefined,
  burstSize: number,
  now: number,
): IdentitySampleRequestDTO | null {
  if (status !== 'active' || !state) return null;
  if (state.sampleRequest) return { trigger: state.sampleRequest.trigger, inMs: 0, burstSize };
  const acc = state.evidence;
  if (acc?.state === 'suspect' && acc.lastSampleAt != null && now - acc.lastSampleAt >= CADENCE.lateAfterMs) return { trigger: 'server_request', inMs: 0, burstSize };
  return null;
}
