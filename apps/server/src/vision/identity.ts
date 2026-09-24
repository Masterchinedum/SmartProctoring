/**
 * Identity math: similarity, per-sample decisions, reference enrolment and multi-frame aggregation.
 *
 * Decision rule (per sample):
 *   quality gate failed (or no embedding)   => unable_to_verify  (+ guidance; NEVER mismatch)
 *   similarity >= match threshold           => match
 *   similarity <  mismatch threshold        => mismatch, if the frame is not in the 'poor' quality bucket and the
 *                                              calibrated evidence is strong (sampleLLR >= MISMATCH_MIN_LLR);
 *                                              otherwise inconclusive with lighting guidance (poor light alone is
 *                                              never "a different person", as in the evidence window)
 *   otherwise                               => inconclusive
 *
 * Confidence (0..1) grows with the distance from the threshold that was crossed, saturating at
 * CONFIDENCE_MARGIN (0.25 cosine) beyond it:
 *   match:        0.5 + 0.5 * clamp01((s - tMatch) / CONFIDENCE_MARGIN)
 *   mismatch:     0.5 + 0.5 * clamp01((tMismatch - s) / CONFIDENCE_MARGIN)
 *   inconclusive: 0.5 + 0.5 * (1 - |s - mid| / halfWidth)   (1 in the middle of the grey zone, 0.5 at its edges)
 *   unable_to_verify: 1 (the image failed objective quality checks; there is no identity claim).
 */
import { DEFAULT_IDENTITY_THRESHOLDS, type FaceQuality, type IdentityDecision, type IdentityThresholds } from '@sp/shared';
import type { FrameAggregateResult, FrameDecision, IdentityComparison, ImageAnalysis, ReferenceBuildResult } from './types';
import { advisoryGuidance, guidanceForIssues, qualityScore } from './quality';
import { qualityBucket, sampleLLR, type EvidenceContext } from './calibration';

export type ComparisonTarget = 'reference' | 'id_photo';

export const CONFIDENCE_MARGIN = 0.25;
/**
 * A per-sample "mismatch" label needs at least this calibrated evidence (natural-log likelihood ratio, i.e.
 * ~7:1 for a different person) on a frame that is not 'poor'; weaker low scores are "inconclusive".
 */
export const MISMATCH_MIN_LLR = 2;
/** With an evidence context, a per-sample "match" label needs sampleLLR <= -MATCH_MAX_LLR (~3:1 for the same person). */
export const MATCH_MAX_LLR = 1;
export const INCONCLUSIVE_GUIDANCE = 'We could not confirm the match. Face the camera directly, with even light on your face, and hold still.';
export const NO_EMBEDDING_GUIDANCE = 'We couldn’t analyse your face. Sit in front of the camera with your face fully visible.';

export const REFERENCE_MIN_FRAMES = 3;
export const REFERENCE_MAX_EMBEDDINGS = 5;
/** Reference frames must be closer to frontal than the general gate (pitch window centred like the gate's). */
export const REFERENCE_MAX_ABS_YAW_DEG = 20;
export const REFERENCE_MIN_PITCH_DEG = -30;
export const REFERENCE_MAX_PITCH_DEG = 20;
export const REFERENCE_INCONSISTENT_REASON = 'Frames appear to show different people or are inconsistent';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Cosine similarity (does not assume unit vectors). Returns 0 if either vector is all zeros. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Highest similarity of `probe` to any reference embedding, with its index. */
export function bestSimilarity(probe: ArrayLike<number>, refs: readonly ArrayLike<number>[]): { similarity: number; index: number } {
  if (refs.length === 0) throw new Error('bestSimilarity: no reference embeddings');
  let best = -Infinity;
  let index = 0;
  for (let i = 0; i < refs.length; i++) {
    const s = cosineSimilarity(probe, refs[i]);
    if (s > best) {
      best = s;
      index = i;
    }
  }
  return { similarity: best, index };
}

/** Max cosine similarity of `probe` over the reference embeddings (the reference comparison score). */
export function maxSimilarity(probe: ArrayLike<number>, refs: readonly ArrayLike<number>[]): number {
  return bestSimilarity(probe, refs).similarity;
}

/**
 * Identity template of several embeddings of ONE person: the L2-normalised mean of the unit embeddings.
 * Used for the enrolment gallery (several check-in frames) and for probe bursts (frames captured within
 * ~0.6 s). Averaging cancels per-frame noise (sensor noise, landmark jitter, JPEG), which is the dominant
 * error source on webcams (docs/accuracy/identity-v2.md §4).
 */
export function templateFrom(embeddings: readonly ArrayLike<number>[]): Float32Array {
  if (embeddings.length === 0) throw new Error('templateFrom: no embeddings');
  const dim = embeddings[0].length;
  const out = new Float32Array(dim);
  for (const e of embeddings) {
    if (e.length !== dim) throw new Error('templateFrom: dimension mismatch');
    let n = 0;
    for (let i = 0; i < dim; i++) n += e[i] * e[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dim; i++) out[i] += e[i] / n;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) out[i] /= n;
  return out;
}

/**
 * THE similarity of a probe (one embedding, or the frames of one burst) to an enrolled gallery (the
 * embeddings of the protected reference): cosine between the probe template (mean of the burst) and the
 * gallery template (mean of the gallery). Calibrated in calibration.ts (`sampleLLR`, CALIBRATION.match /
 * mismatch) for exactly this score, so use it everywhere a probe is compared with the reference.
 */
export function scoreAgainst(probe: ArrayLike<number> | readonly ArrayLike<number>[], gallery: readonly ArrayLike<number>[]): number {
  if (gallery.length === 0) throw new Error('scoreAgainst: empty gallery');
  const probes = isEmbeddingList(probe) ? probe : [probe];
  if (probes.length === 0) throw new Error('scoreAgainst: no probe');
  const p = probes.length === 1 ? probes[0] : templateFrom(probes);
  const g = gallery.length === 1 ? gallery[0] : templateFrom(gallery);
  return cosineSimilarity(p, g);
}

function isEmbeddingList(v: ArrayLike<number> | readonly ArrayLike<number>[]): v is readonly ArrayLike<number>[] {
  return Array.isArray(v) && (v.length === 0 || typeof v[0] !== 'number');
}

/** Effective [match, mismatch] thresholds for a comparison target (sanitised so mismatch <= match). */
export function thresholdsFor(thresholds: IdentityThresholds, against: ComparisonTarget): { match: number; mismatch: number } {
  const match = against === 'id_photo' ? thresholds.idPhotoMatch : thresholds.match;
  const mismatch = against === 'id_photo' ? thresholds.idPhotoMismatch : thresholds.mismatch;
  return { match, mismatch: Math.min(mismatch, match) };
}

/**
 * Decide one probe against a reference (or ID photo). See the module comment for the rule.
 * `evidence` (identity v2.1, optional): the reference's bucket / enrolment baseline / context as passed to
 * `sampleLLR`. With it, "match" also needs the calibrated evidence to favour the same person
 * (sampleLLR <= -MATCH_MAX_LLR): in a dim room a look-alike can score above `match` against a dim-light gallery
 * while clearly below the candidate's own level — that is "inconclusive", not "match".
 */
export function decideIdentity(
  similarity: number | null,
  quality: FaceQuality | null,
  thresholds: IdentityThresholds = DEFAULT_IDENTITY_THRESHOLDS,
  against: ComparisonTarget = 'reference',
  evidence?: EvidenceContext,
): IdentityComparison {
  const sim = similarity == null || !Number.isFinite(similarity) ? null : round4(similarity);
  if (!quality || !quality.usable || sim == null) {
    const guidance = quality && quality.issues.length > 0 ? guidanceForIssues(quality.issues) : [NO_EMBEDDING_GUIDANCE];
    return { decision: 'unable_to_verify', similarity: sim, confidence: 1, guidance };
  }
  const t = thresholdsFor(thresholds, against);
  const bucket = qualityBucket(quality);
  if (sim >= t.match) {
    if (evidence && against === 'reference' && sampleLLR(sim, bucket, evidence) > -MATCH_MAX_LLR) {
      return { decision: 'inconclusive', similarity: sim, confidence: 0.5, guidance: advisoryGuidance(quality).concat(INCONCLUSIVE_GUIDANCE) };
    }
    return { decision: 'match', similarity: sim, confidence: round4(0.5 + 0.5 * clamp01((sim - t.match) / CONFIDENCE_MARGIN)), guidance: [] };
  }
  if (sim < t.mismatch) {
    // A low score on a poor-quality frame (dim room, backlight, small face) is weak evidence: say "mismatch" only
    // when the calibrated per-sample evidence is strong, otherwise "inconclusive" (with lighting guidance).
    if (bucket === 'poor' || sampleLLR(sim, bucket, against === 'reference' ? evidence : undefined) < MISMATCH_MIN_LLR) {
      return { decision: 'inconclusive', similarity: sim, confidence: 0.5, guidance: advisoryGuidance(quality).concat(INCONCLUSIVE_GUIDANCE) };
    }
    return { decision: 'mismatch', similarity: sim, confidence: round4(0.5 + 0.5 * clamp01((t.mismatch - sim) / CONFIDENCE_MARGIN)), guidance: [] };
  }
  const mid = (t.match + t.mismatch) / 2;
  const half = Math.max(1e-6, (t.match - t.mismatch) / 2);
  return {
    decision: 'inconclusive',
    similarity: sim,
    confidence: round4(0.5 + 0.5 * clamp01(1 - Math.abs(sim - mid) / half)),
    guidance: [INCONCLUSIVE_GUIDANCE],
  };
}

/* ------------------------------------------------------------------------------ reference */

function isReferenceCandidate(a: ImageAnalysis): boolean {
  if (!a.quality.usable || !a.embedding) return false;
  const yaw = a.pose?.yawDeg ?? a.quality.yawDeg;
  const pitch = a.pose?.pitchDeg ?? a.quality.pitchDeg;
  return Math.abs(yaw) <= REFERENCE_MAX_ABS_YAW_DEG && pitch >= REFERENCE_MIN_PITCH_DEG && pitch <= REFERENCE_MAX_PITCH_DEG;
}

/**
 * Build the protected identity reference from check-in frames.
 *
 * Needs >= 3 usable, near-frontal frames with embeddings that are mutually consistent: any pair below
 * the mismatch threshold fails outright (different people); frames in the grey zone are dropped one
 * at a time (most inconsistent first) until every remaining pair is >= the match threshold, and at
 * least 3 must remain. Returns up to 5 embeddings: the best-quality frame first, then the most
 * diverse of the rest (farthest-point selection), so the reference covers natural variation.
 */
export function buildReference(analyses: readonly ImageAnalysis[], thresholds: IdentityThresholds = DEFAULT_IDENTITY_THRESHOLDS): ReferenceBuildResult {
  const fail = (reasons: string[]): ReferenceBuildResult => ({ ok: false, embeddings: [], bestIndex: -1, quality: null, reasons });
  if (analyses.length === 0) return fail(['No frames were submitted']);

  const cands = analyses.map((a, i) => ({ a, i })).filter(({ a }) => isReferenceCandidate(a));
  if (cands.length < REFERENCE_MIN_FRAMES) {
    const reasons = [`Only ${cands.length} of ${analyses.length} frames showed one clear, frontal face; at least ${REFERENCE_MIN_FRAMES} are needed`];
    const issues = analyses.flatMap((a) => a.quality.issues);
    const guidance = guidanceForIssues(issues);
    const turnedButUsable = analyses.some((a) => a.quality.usable && a.embedding && !isReferenceCandidate(a));
    if (turnedButUsable && !issues.includes('face_turned')) guidance.push(guidanceForIssues(['face_turned'])[0]);
    return fail([...reasons, ...guidance]);
  }

  const n = cands.length;
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sim[i][j] = sim[j][i] = cosineSimilarity(cands[i].a.embedding!, cands[j].a.embedding!);
    }
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (sim[i][j] < thresholds.mismatch) return fail([REFERENCE_INCONSISTENT_REASON]);

  const alive = new Set<number>(Array.from({ length: n }, (_, i) => i));
  const weak = (i: number) => [...alive].filter((j) => j !== i && sim[i][j] < thresholds.match).length;
  for (;;) {
    let worst = -1;
    let worstCount = 0;
    for (const i of alive) {
      const c = weak(i);
      if (c > worstCount || (c === worstCount && c > 0 && qualityScore(cands[i].a.quality) < qualityScore(cands[worst].a.quality))) {
        worst = i;
        worstCount = c;
      }
    }
    if (worstCount === 0) break;
    alive.delete(worst);
    if (alive.size < REFERENCE_MIN_FRAMES) return fail([REFERENCE_INCONSISTENT_REASON]);
  }

  const aliveList = [...alive];
  let best = aliveList[0];
  for (const i of aliveList) if (qualityScore(cands[i].a.quality) > qualityScore(cands[best].a.quality)) best = i;
  const selected = [best];
  while (selected.length < REFERENCE_MAX_EMBEDDINGS && selected.length < aliveList.length) {
    let pick = -1;
    let pickSim = Infinity;
    for (const i of aliveList) {
      if (selected.includes(i)) continue;
      const closest = Math.max(...selected.map((s) => sim[i][s]));
      if (closest < pickSim - 1e-9 || (Math.abs(closest - pickSim) <= 1e-9 && qualityScore(cands[i].a.quality) > qualityScore(cands[pick].a.quality))) {
        pick = i;
        pickSim = closest;
      }
    }
    selected.push(pick);
  }
  const bestAnalysis = cands[best].a;
  return {
    ok: true,
    embeddings: selected.map((i) => Float32Array.from(cands[i].a.embedding!)),
    bestIndex: cands[best].i,
    quality: bestAnalysis.quality,
    reasons: [],
  };
}

/* ---------------------------------------------------------------------------- aggregation */

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Aggregate several probe frames (resume / reconnect / re-verification checks):
 *   no usable frame                                   => unable_to_verify
 *   >= 2 matching frames (1 if only one frame given)  => match
 *   >= 2 mismatching usable frames and no match       => mismatch
 *   anything else (mixed or grey-zone evidence)       => inconclusive
 * `similarity` is the median over usable frames; confidence is the mean confidence of the frames that
 * agree with the overall decision times the fraction of usable frames that agree.
 */
export function aggregateFrames(
  analyses: readonly ImageAnalysis[],
  referenceEmbeddings: readonly ArrayLike<number>[],
  thresholds: IdentityThresholds = DEFAULT_IDENTITY_THRESHOLDS,
  against: ComparisonTarget = 'reference',
): FrameAggregateResult {
  const frames: FrameDecision[] = analyses.map((a, index) => {
    const s = a.embedding && referenceEmbeddings.length > 0 ? maxSimilarity(a.embedding, referenceEmbeddings) : null;
    const cmp = decideIdentity(s, a.quality, thresholds, against);
    return { ...cmp, index, usable: cmp.decision !== 'unable_to_verify' };
  });
  const usable = frames.filter((f) => f.usable);
  const count = (d: IdentityDecision) => frames.filter((f) => f.decision === d).length;
  const matchCount = count('match');
  const mismatchCount = count('mismatch');
  const inconclusiveCount = count('inconclusive');
  const unableCount = count('unable_to_verify');
  const need = Math.max(1, Math.min(2, analyses.length));

  let decision: IdentityDecision;
  if (usable.length === 0) decision = 'unable_to_verify';
  else if (matchCount >= need) decision = 'match';
  else if (mismatchCount >= need && matchCount === 0) decision = 'mismatch';
  else decision = 'inconclusive';

  const sims = usable.map((f) => f.similarity).filter((s): s is number => s != null);
  const medianSimilarity = median(sims);
  const agreeing = frames.filter((f) => f.decision === decision);

  let confidence: number;
  let guidance: string[];
  if (decision === 'unable_to_verify') {
    confidence = 1;
    guidance = dedupe(frames.flatMap((f) => f.guidance));
  } else {
    const meanConf = agreeing.length ? agreeing.reduce((s, f) => s + f.confidence, 0) / agreeing.length : 0.5;
    confidence = round4(meanConf * (agreeing.length / Math.max(1, usable.length)));
    if (decision === 'inconclusive') {
      const qualityGuidance = dedupe(frames.filter((f) => !f.usable).flatMap((f) => f.guidance));
      guidance = qualityGuidance.length ? qualityGuidance : [INCONCLUSIVE_GUIDANCE];
      if (agreeing.length === 0) confidence = 0.5;
    } else {
      guidance = [];
    }
  }

  const withFace = (i: number) => analyses[i].primary != null;
  const pickBest = (idx: number[]) =>
    idx.filter(withFace).reduce<number | null>((b, i) => (b == null || qualityScore(analyses[i].quality) > qualityScore(analyses[b].quality) ? i : b), null);
  const bestProbeIndex = pickBest(agreeing.map((f) => f.index)) ?? pickBest(frames.map((f) => f.index));

  return {
    decision,
    similarity: medianSimilarity == null ? null : round4(medianSimilarity),
    confidence,
    guidance,
    frames,
    matchCount,
    mismatchCount,
    inconclusiveCount,
    unableCount,
    usableCount: usable.length,
    minSimilarity: sims.length ? round4(Math.min(...sims)) : null,
    maxSimilarity: sims.length ? round4(Math.max(...sims)) : null,
    medianSimilarity: medianSimilarity == null ? null : round4(medianSimilarity),
    bestProbeIndex,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
