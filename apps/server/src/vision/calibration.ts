/**
 * Identity-score calibration: quality buckets, per-comparison log-likelihood ratios and the sequential
 * (SPRT) thresholds used to accumulate identity-continuity evidence over an exam.
 *
 * Model. For one comparison of a probe against the protected reference template, the cosine similarity s
 * is modelled per quality bucket as
 *
 *     p(s | same person)      = (1 - EPS) * N(s; genuine.mean, genuine.sd)  + EPS * U(-1, 1)
 *     p(s | different person) = (1 - EPS) * N(s; impostor.mean, impostor.sd) + EPS * U(-1, 1)
 *
 * The uniform floor gives both densities heavy ("conservative") tails, so a similarity far outside
 * both distributions yields a bounded LLR instead of an exploding Gaussian ratio; `llrClamp` caps it
 * further. `sampleLLR` = log(p(s|different) / p(s|same)): > 0 is evidence of a different person.
 *
 * Numbers are fitted on the webcam simulator over public multi-image identity sets
 * (apps/server/src/eval, docs/accuracy/identity-v2.md); `version` changes whenever they change.
 */
import type { FaceQuality } from '@sp/shared';

export type QualityBucket = 'good' | 'fair' | 'poor'; // 'unusable' is quality.usable === false

export interface BucketModel {
  genuine: { mean: number; sd: number };
  impostor: { mean: number; sd: number };
}

/** Thresholds deciding the bucket of a usable frame (see `qualityBucket`). */
export interface BucketThresholds {
  /** Inter-ocular distance (px) at or above which a frame can be 'good'; below `poorInterEyePx` => 'poor'. */
  goodInterEyePx: number;
  poorInterEyePx: number;
  /** Face-region luminance std-dev. */
  goodContrast: number;
  poorContrast: number;
  /** Face-region mean luminance: 'good' needs [goodMinBrightness, goodMaxBrightness]; outside the poor range => 'poor'. */
  goodMinBrightness: number;
  goodMaxBrightness: number;
  poorMinBrightness: number;
  poorMaxBrightness: number;
  /** Contrast-normalised Laplacian variance (quality.sharpness). */
  goodSharpness: number;
  poorSharpness: number;
  /** |yaw| (degrees). */
  goodMaxAbsYawDeg: number;
  poorMaxAbsYawDeg: number;
  /** Detector score. */
  goodDetectionScore: number;
  poorDetectionScore: number;
}

export interface Calibration {
  version: string;
  /** Per-comparison labels against the protected reference: >= match => match, < mismatch => mismatch, else inconclusive. */
  match: number;
  mismatch: number;
  /** Same against an (older, differently captured) approved ID photo. */
  idPhotoMatch: number;
  idPhotoMismatch: number;
  /** Prior probability that a given sample is of a different person. */
  prior: number;
  /** Thresholds on the accumulated LLR (natural log). */
  sprt: {
    /** Accumulated LLR >= suspect => 'suspect' (ask for a faster sample / follow-up burst). */
    suspect: number;
    /** Accumulated LLR >= confirm => confirmed mismatch (open identity_mismatch, hold per policy). */
    confirm: number;
    /** Accumulated LLR <= clear => evidence reset to 'consistent'. */
    clear: number;
    /** Evidence window: only the last `maxSamples` samples are accumulated. */
    maxSamples: number;
    /**
     * Positive evidence from 'poor'-bucket samples counts at most this much in the window (`windowEvidence`).
     * Below `confirm` on purpose: poor light alone can make a session 'suspect' (faster sampling, lighting
     * guidance, staff visibility as an uncertain observation) but never a confirmed mismatch — in a dim room a
     * genuine candidate's frames are too often unrecognisable (simulator: without the cap, 10 % of dim-room and 7 %
     * of backlit resumptions of genuine candidates, and 3 of 754 same-session candidates, alarmed within an hour).
     * Fair/good evidence confirms as usual.
     */
    maxPoorEvidence: number;
  };
  /** |per-sample LLR| cap so one freak frame can't decide alone. */
  llrClamp: number;
  /** Usable frontal frames needed at a check (resume / reconnect) before deciding. */
  minFramesForDecision: number;
}

/** One sample in the evidence window. */
export interface WindowEntry {
  /** Clamped per-sample LLR (after any per-session normalisation / weighting). */
  llr: number;
  bucket: QualityBucket | null;
}

/**
 * Accumulated evidence of an evidence window: the sum of the samples' LLRs, except that positive evidence from
 * 'poor' samples counts at most CALIBRATION.sprt.maxPoorEvidence in total. Compare the result with
 * CALIBRATION.sprt.{suspect, confirm, clear}.
 */
export function windowEvidence(window: readonly WindowEntry[], maxPoorEvidence: number = CALIBRATION.sprt.maxPoorEvidence): number {
  let sum = 0;
  let poor = 0;
  for (const e of window) {
    if (e.bucket === 'poor' && e.llr > 0) poor += e.llr;
    else sum += e.llr;
  }
  return sum + Math.min(maxPoorEvidence, poor);
}

/**
 * How far a genuine probe's similarity falls below the candidate's own enrolment baseline (mean leave-one-out
 * similarity of the gallery frames), per quality bucket — for per-session normalisation of the score.
 * 'continuous': same session, other capture conditions (mid-exam; simulator: same photo, new scene / light).
 * 'relaxed': another day / room / camera (resume); measured on OTHER photos of the person, some taken years
 * apart, so it is a pessimistic bound. Impostors fall 0.76-0.79 ± 0.11-0.14 (family members) to 0.83-0.85 ± 0.09-0.15
 * below it. Measured on 600 / 246 / 368 (continuous) and 1,523 / 824 / 1,194 (relaxed) genuine bursts.
 */
export const GENUINE_DRIFT: Readonly<Record<'continuous' | 'relaxed', Readonly<Record<QualityBucket, { mean: number; sd: number }>>>> = Object.freeze({
  continuous: Object.freeze({ good: { mean: 0.02, sd: 0.04 }, fair: { mean: 0.06, sd: 0.09 }, poor: { mean: 0.21, sd: 0.2 } }),
  relaxed: Object.freeze({ good: { mean: 0.28, sd: 0.11 }, fair: { mean: 0.3, sd: 0.11 }, poor: { mean: 0.43, sd: 0.18 } }),
});

/** Weight of the uniform floor in both likelihoods (heavy, conservative tails). */
export const LLR_TAIL_EPS = 0.01;

/**
 * Bucket limits (webcam simulator, docs/accuracy/identity-v2.md §4). Face-region contrast is by far the strongest
 * predictor of recognition reliability (genuine similarity to the person's good-light template, p05: contrast
 * 7-10 -> 0.1-0.2, 12-15 -> 0.38, >= 15 -> 0.66+), then brightness and the detector score; face size matters
 * little above 20 px between the eyes. Faces found only by the low-light detection pass report a detector
 * score of at most 0.79 and are therefore 'poor'. Sharpness is not used: on noisy dim frames the Laplacian
 * measures noise, not focus (strong blur is refused by the gate).
 */
export const BUCKET_THRESHOLDS: Readonly<BucketThresholds> = Object.freeze({
  goodInterEyePx: 32,
  poorInterEyePx: 24,
  goodContrast: 18,
  poorContrast: 12,
  goodMinBrightness: 70,
  goodMaxBrightness: 200,
  poorMinBrightness: 50,
  poorMaxBrightness: 225,
  goodSharpness: 0,
  poorSharpness: 0,
  goodMaxAbsYawDeg: 18,
  poorMaxAbsYawDeg: 25,
  goodDetectionScore: 0.88,
  poorDetectionScore: 0.8,
});

/**
 * Similarity (`scoreAgainst`: probe or burst template vs gallery template) of the same person and of different
 * people, per bucket. Fitted on 9,080 simulated webcam frames (34 enrolled identities, 5 conditions, 640x480 and
 * 1280x720; bursts of 3 against 5-frame galleries enrolled in good / typical light): genuine = OTHER photos of the
 * person (another day / room / camera — the pessimistic, cross-session case; per-session normalisation narrows it
 * for mid-exam samples), impostor = everyone else incl. family members. Fitted sds are inflated by 15 %
 * (conservative tails). Fit (n): good genuine 0.666 ± 0.114 (1,518), impostor 0.098 ± 0.090 (74,656);
 * fair 0.647 ± 0.104 (764) / 0.095 ± 0.090 (35,184); poor 0.490 ± 0.160 (948) / 0.076 ± 0.095 (43,250) — poor frames
 * are embedded from a denoised crop (embed-prep.ts RECIPE_V2).
 */
export const BUCKET_MODELS: Readonly<Record<QualityBucket, Readonly<BucketModel>>> = Object.freeze({
  good: { genuine: { mean: 0.67, sd: 0.13 }, impostor: { mean: 0.1, sd: 0.1 } },
  fair: { genuine: { mean: 0.65, sd: 0.12 }, impostor: { mean: 0.1, sd: 0.1 } },
  poor: { genuine: { mean: 0.49, sd: 0.18 }, impostor: { mean: 0.08, sd: 0.11 } },
});

/**
 * Calibration v2 (webcam simulator, docs/accuracy/identity-v2.md). SPRT thresholds chosen by Monte-Carlo over
 * 754 same-session and 2,132 cross-session genuine sessions and 100k+ impostor sessions at the default cadence
 * (6 s for 3 min, then 15 s; bursts of 3): 0 false confirmed swaps in same-session monitoring, median 2 samples
 * to confirm a swap in good / typical / side light (family members: 77-83 % within 3 samples).
 */
export const CALIBRATION: Readonly<Calibration> = Object.freeze({
  version: 'webcam-v2.0',
  match: 0.45,
  mismatch: 0.3,
  idPhotoMatch: 0.42,
  idPhotoMismatch: 0.24,
  prior: 0.001,
  sprt: Object.freeze({ suspect: 3, confirm: 7, clear: -6, maxSamples: 8, maxPoorEvidence: 4 }),
  llrClamp: 5,
  minFramesForDecision: 3,
});

/** Quality bucket of a USABLE frame (callers treat quality.usable === false as 'unusable' separately). */
export function qualityBucket(q: FaceQuality, t: Readonly<BucketThresholds> = BUCKET_THRESHOLDS): QualityBucket {
  const yaw = Math.abs(q.yawDeg);
  const poor =
    q.interEyePx < t.poorInterEyePx ||
    q.contrast < t.poorContrast ||
    q.brightness < t.poorMinBrightness ||
    q.brightness > t.poorMaxBrightness ||
    q.sharpness < t.poorSharpness ||
    yaw > t.poorMaxAbsYawDeg ||
    q.detectionScore < t.poorDetectionScore;
  if (poor) return 'poor';
  const good =
    q.interEyePx >= t.goodInterEyePx &&
    q.contrast >= t.goodContrast &&
    q.brightness >= t.goodMinBrightness &&
    q.brightness <= t.goodMaxBrightness &&
    q.sharpness >= t.goodSharpness &&
    yaw <= t.goodMaxAbsYawDeg &&
    q.detectionScore >= t.goodDetectionScore;
  return good ? 'good' : 'fair';
}

const LOG_SQRT_2PI = 0.5 * Math.log(2 * Math.PI);

function logMixture(s: number, mean: number, sd: number): number {
  const z = (s - mean) / sd;
  const logN = -0.5 * z * z - Math.log(sd) - LOG_SQRT_2PI;
  const logU = Math.log(0.5); // U(-1, 1)
  // log((1-eps) e^logN + eps e^logU), computed stably.
  const a = Math.log(1 - LLR_TAIL_EPS) + logN;
  const b = Math.log(LLR_TAIL_EPS) + logU;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** Unclamped log(p(s|different person) / p(s|same person)) for a bucket model. */
export function rawLLR(similarity: number, model: Readonly<BucketModel>): number {
  const s = Math.max(-1, Math.min(1, similarity));
  return logMixture(s, model.impostor.mean, model.impostor.sd) - logMixture(s, model.genuine.mean, model.genuine.sd);
}

const LLR_GRID_STEP = 0.001;
const llrTables = new Map<QualityBucket, Float64Array>();

/**
 * Monotone (non-increasing in s) version of the mixture LLR: similarities are clamped to
 * [impostor.mean, genuine.mean] — a similarity above the typical genuine score is never weaker evidence of
 * the same person, one below the typical impostor score never weaker evidence of a different person (the
 * raw ratio of two Gaussians with uniform floors is not monotone in its tails) — and a running minimum over
 * a 0.001 grid removes any remaining wiggle between the two means.
 */
function llrTable(bucket: QualityBucket): Float64Array {
  let t = llrTables.get(bucket);
  if (t) return t;
  const m = BUCKET_MODELS[bucket];
  const n = Math.round(2 / LLR_GRID_STEP) + 1;
  t = new Float64Array(n);
  let run = Infinity;
  for (let i = 0; i < n; i++) {
    const s = -1 + i * LLR_GRID_STEP;
    const x = Math.min(m.genuine.mean, Math.max(m.impostor.mean, s));
    run = Math.min(run, rawLLR(x, m));
    t[i] = run;
  }
  llrTables.set(bucket, t);
  return t;
}

/**
 * log(p(s|different person) / p(s|same person)) for one comparison of a probe (one frame or the template of
 * one burst, `scoreAgainst`) against the reference template; > 0 = evidence of a different person.
 * Monotone non-increasing in `similarity`, clamped to ±CALIBRATION.llrClamp. Non-finite similarity => 0.
 */
export function sampleLLR(similarity: number, bucket: QualityBucket): number {
  if (!Number.isFinite(similarity)) return 0;
  const t = llrTable(BUCKET_MODELS[bucket] ? bucket : 'poor');
  const x = Math.max(-1, Math.min(1, similarity));
  const f = (x + 1) / LLR_GRID_STEP;
  const i = Math.min(t.length - 2, Math.floor(f));
  const w = f - i;
  const llr = t[i] * (1 - w) + t[i + 1] * w;
  const c = CALIBRATION.llrClamp;
  return Math.max(-c, Math.min(c, llr));
}

/** P(different person | evidence) from an accumulated LLR and a prior probability of a different person. */
export function posteriorSwap(llrSum: number, prior: number = CALIBRATION.prior): number {
  const p = Math.min(1 - 1e-12, Math.max(1e-12, prior));
  const logit = Math.log(p / (1 - p)) + (Number.isFinite(llrSum) ? llrSum : 0);
  if (logit > 40) return 1;
  if (logit < -40) return 0;
  return 1 / (1 + Math.exp(-logit));
}
