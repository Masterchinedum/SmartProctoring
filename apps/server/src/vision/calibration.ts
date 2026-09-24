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
  };
  /** |per-sample LLR| cap so one freak frame can't decide alone. */
  llrClamp: number;
  /** Usable frontal frames needed at a check (resume / reconnect) before deciding. */
  minFramesForDecision: number;
}

/** Weight of the uniform floor in both likelihoods (heavy, conservative tails). */
export const LLR_TAIL_EPS = 0.01;

export const BUCKET_THRESHOLDS: Readonly<BucketThresholds> = Object.freeze({
  goodInterEyePx: 45,
  poorInterEyePx: 30,
  goodContrast: 22,
  poorContrast: 10,
  goodMinBrightness: 55,
  goodMaxBrightness: 200,
  poorMinBrightness: 30,
  poorMaxBrightness: 225,
  goodSharpness: 150,
  poorSharpness: 50,
  goodMaxAbsYawDeg: 15,
  poorMaxAbsYawDeg: 25,
  goodDetectionScore: 0.85,
  poorDetectionScore: 0.7,
});

/** Similarity distributions per bucket (single probe frame vs the reference template). */
export const BUCKET_MODELS: Readonly<Record<QualityBucket, Readonly<BucketModel>>> = Object.freeze({
  good: { genuine: { mean: 0.72, sd: 0.1 }, impostor: { mean: 0.1, sd: 0.1 } },
  fair: { genuine: { mean: 0.66, sd: 0.11 }, impostor: { mean: 0.1, sd: 0.1 } },
  poor: { genuine: { mean: 0.58, sd: 0.13 }, impostor: { mean: 0.1, sd: 0.11 } },
});

export const CALIBRATION: Readonly<Calibration> = Object.freeze({
  version: 'webcam-v2-placeholder',
  match: 0.45,
  mismatch: 0.3,
  idPhotoMatch: 0.42,
  idPhotoMismatch: 0.24,
  prior: 0.001,
  sprt: Object.freeze({ suspect: 4, confirm: 9, clear: -6, maxSamples: 8 }),
  llrClamp: 6,
  minFramesForDecision: 3,
}) as Readonly<Calibration>;

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
