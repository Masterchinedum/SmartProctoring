/**
 * Enrolment gallery, reference scoring, burst aggregation and check-frame selection (pure; no I/O).
 *
 *  - Enrolment (initial check, staff-authorised re-enrolment): up to GALLERY_MAX diverse, mutually consistent
 *    embeddings from the check's frontal frames plus its near-frontal liveness frames, and the session baseline
 *    (leave-one-out scores of the accepted frames against the rest of the gallery, identity-evidence.ts).
 *  - Scoring a probe (or a burst of probes) against the protected reference uses the vision helpers
 *    `scoreAgainst` / `templateFrom` — the same function everywhere (enrolment baseline, checks, samples, self-test).
 */
import { REFERENCE_INCONSISTENT_REASON, REFERENCE_MAX_ABS_YAW_DEG, REFERENCE_MAX_PITCH_DEG, REFERENCE_MIN_FRAMES, REFERENCE_MIN_PITCH_DEG, CALIBRATION, cosineSimilarity, guidanceForIssues, qualityBucket, qualityScore, scoreAgainst, templateFrom, type ImageAnalysis, type QualityBucket } from '../vision/index.js';
import type { FaceQuality, IdentityThresholds, LivenessAction } from '@sp/shared';
import { comparisonLLR, frameEvidence, type ComparisonContext, type FrameEvidence, type SessionBaseline } from './identity-evidence.js';

/** Embeddings kept in the protected reference. */
export const GALLERY_MAX = 8;
/** Usable frontal frames an enrolment asks for (StartCheckResponse.frontalFramesRequired). */
export const ENROL_TARGET_FRAMES = 5;
/** Liveness step frames this close to the candidate's own frontal pose also count as identity evidence. */
export const NEAR_FRONTAL_MAX_DYAW = 20;
export const NEAR_FRONTAL_MAX_DPITCH = 15;

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Similarity of a probe (or the mean of several probes of one burst) to the protected reference. */
export function scoreReference(probe: Float32Array | readonly Float32Array[], gallery: readonly Float32Array[]): number {
  return round4(scoreAgainst(Array.isArray(probe) ? [...probe] : (probe as Float32Array), [...gallery]));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function meanSd(values: number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) * (v - mean), 0) / Math.max(1, values.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

/* =================================================================== check frames */

export interface CheckFrameLike {
  step: string;
  action: LivenessAction | 'center';
  analysis: ImageAnalysis;
}

/** The candidate's own frontal pose (median over frontal frames with one face), or null. */
export function frontalCentre(frames: readonly CheckFrameLike[]): { yawDeg: number; pitchDeg: number } | null {
  const poses = frames.filter((f) => (f.step === 'frontal' || f.action === 'center') && f.analysis.quality.faceCount === 1 && f.analysis.pose).map((f) => f.analysis.pose!);
  return poses.length ? { yawDeg: median(poses.map((p) => p.yawDeg)), pitchDeg: median(poses.map((p) => p.pitchDeg)) } : null;
}

/**
 * Frames of a check that are identity evidence, in receipt order: frontal frames (and 'center' step frames) plus
 * liveness step frames within NEAR_FRONTAL_* of the candidate's frontal pose. `frontal` marks the former.
 */
export function identityFrameIndexes(frames: readonly CheckFrameLike[]): { index: number; frontal: boolean }[] {
  const centre = frontalCentre(frames);
  const out: { index: number; frontal: boolean }[] = [];
  frames.forEach((f, index) => {
    if (f.step === 'frontal' || f.action === 'center') {
      out.push({ index, frontal: true });
      return;
    }
    const p = f.analysis.pose;
    if (!centre || !p || f.analysis.quality.faceCount !== 1) return;
    if (Math.abs(p.yawDeg - centre.yawDeg) <= NEAR_FRONTAL_MAX_DYAW && Math.abs(p.pitchDeg - centre.pitchDeg) <= NEAR_FRONTAL_MAX_DPITCH) out.push({ index, frontal: false });
  });
  return out;
}

/* =================================================================== enrolment gallery */

export interface GalleryFrame {
  analysis: ImageAnalysis;
  /** A frontal frame (vs a near-frontal liveness frame, which may only add pose diversity). */
  frontal: boolean;
}

export interface GalleryResult {
  ok: boolean;
  /** Embeddings for the protected reference (best-quality frame first, then the most diverse). */
  gallery: Float32Array[];
  baseline: SessionBaseline | null;
  /** Index (into the input) of the best frontal frame — the reference image. */
  bestIndex: number;
  quality: FaceQuality | null;
  reasons: string[];
  /** Why it failed: too few clear frames (more frames may help) or frames of different people. */
  failure: 'too_few' | 'inconsistent' | null;
  /** Input indexes accepted as the candidate (frontal + near-frontal). */
  accepted: number[];
  /** Usable frontal frames seen. */
  usableFrontal: number;
}

function isFrontalCandidate(a: ImageAnalysis): boolean {
  if (!a.quality.usable || !a.embedding) return false;
  const yaw = a.pose?.yawDeg ?? a.quality.yawDeg;
  const pitch = a.pose?.pitchDeg ?? a.quality.pitchDeg;
  return Math.abs(yaw) <= REFERENCE_MAX_ABS_YAW_DEG && pitch >= REFERENCE_MIN_PITCH_DEG && pitch <= REFERENCE_MAX_PITCH_DEG;
}

/** Leave-one-out similarity of member i to the mean of the others. */
function looScores(embs: readonly Float32Array[]): number[] {
  return embs.map((e, i) => cosineSimilarity(e, templateFrom(embs.filter((_, j) => j !== i))));
}

/**
 * Build the enrolment gallery. Needs >= REFERENCE_MIN_FRAMES clear frontal frames of ONE person:
 *  - a frame far from the others (leave-one-out below the mismatch threshold) is a clearly different face: two or
 *    more such frames that resemble each other, or more than a third of the frames, fail the enrolment
 *    ("different people"); a lone one is dropped (e.g. a blurred frame that still passed the gate);
 *  - grey-zone frames (below the match threshold) are dropped, worst first, while enough remain;
 *  - near-frontal liveness frames that match the frontal template join for pose diversity.
 */
export function buildGallery(frames: readonly GalleryFrame[], thresholds: Pick<IdentityThresholds, 'match' | 'mismatch'>): GalleryResult {
  const fail = (failure: 'too_few' | 'inconsistent', reasons: string[], usableFrontal: number): GalleryResult => ({
    ok: false,
    gallery: [],
    baseline: null,
    bestIndex: -1,
    quality: null,
    reasons,
    failure,
    accepted: [],
    usableFrontal,
  });
  const frontal = frames.map((f, i) => ({ ...f, i })).filter((f) => f.frontal && isFrontalCandidate(f.analysis));
  if (frontal.length < REFERENCE_MIN_FRAMES) {
    const all = frames.filter((f) => f.frontal);
    const issues = all.flatMap((f) => f.analysis.quality.issues);
    const guidance = guidanceForIssues(issues);
    const turnedButUsable = all.some((f) => f.analysis.quality.usable && f.analysis.embedding && !isFrontalCandidate(f.analysis));
    if (turnedButUsable && !issues.includes('face_turned')) guidance.push(guidanceForIssues(['face_turned'])[0]);
    return fail('too_few', [`Only ${frontal.length} of ${all.length} frames showed one clear, frontal face; at least ${REFERENCE_MIN_FRAMES} are needed`, ...guidance], frontal.length);
  }

  let alive = [...frontal];
  for (;;) {
    const loo = looScores(alive.map((f) => f.analysis.embedding!));
    const strong = alive.filter((_, k) => loo[k] < thresholds.mismatch);
    if (strong.length >= 2) {
      const pairLike = strong.some((a, x) => strong.some((b, y) => y > x && cosineSimilarity(a.analysis.embedding!, b.analysis.embedding!) >= thresholds.match));
      if (pairLike || strong.length * 3 > alive.length) return fail('inconsistent', [REFERENCE_INCONSISTENT_REASON], frontal.length);
    }
    let worst = -1;
    for (let k = 0; k < alive.length; k++) if (loo[k] < thresholds.match && (worst < 0 || loo[k] < loo[worst])) worst = k;
    if (worst < 0) break;
    if (alive.length <= REFERENCE_MIN_FRAMES) return fail('inconsistent', [REFERENCE_INCONSISTENT_REASON], frontal.length);
    alive = alive.filter((_, k) => k !== worst);
  }

  const frontalTemplate = templateFrom(alive.map((f) => f.analysis.embedding!));
  const extras = frames
    .map((f, i) => ({ ...f, i }))
    .filter((f) => !f.frontal && f.analysis.quality.usable && f.analysis.embedding && cosineSimilarity(f.analysis.embedding, frontalTemplate) >= thresholds.match);
  const pool = [...alive, ...extras];

  // Best-quality frontal frame first, then farthest-point selection for diversity.
  let best = alive[0];
  for (const f of alive) if (qualityScore(f.analysis.quality) > qualityScore(best.analysis.quality)) best = f;
  const selected = [best];
  while (selected.length < GALLERY_MAX && selected.length < pool.length) {
    let pick: (typeof pool)[number] | null = null;
    let pickSim = Infinity;
    for (const f of pool) {
      if (selected.includes(f)) continue;
      const closest = Math.max(...selected.map((s) => cosineSimilarity(f.analysis.embedding!, s.analysis.embedding!)));
      if (closest < pickSim - 1e-9 || (pick && Math.abs(closest - pickSim) <= 1e-9 && qualityScore(f.analysis.quality) > qualityScore(pick.analysis.quality))) {
        pick = f;
        pickSim = closest;
      }
    }
    if (!pick) break;
    selected.push(pick);
  }
  const gallery = selected.map((f) => Float32Array.from(f.analysis.embedding!));

  // Baseline: how every accepted frame scores against the gallery without itself (same scorer as later probes).
  let baseline: SessionBaseline | null = null;
  if (gallery.length >= 2) {
    const scores = pool.map((f) => {
      const k = selected.indexOf(f);
      const rest = k >= 0 ? gallery.filter((_, j) => j !== k) : gallery;
      return scoreReference(f.analysis.embedding!, rest);
    });
    const { mean, sd } = meanSd(scores);
    const buckets = selected.map((f) => qualityBucket(f.analysis.quality)).sort((a, b) => BUCKET_ORDER[a] - BUCKET_ORDER[b]);
    baseline = { mean: round4(mean), sd: round4(sd), n: scores.length, calibrationVersion: CALIBRATION.version, bucket: buckets[Math.floor(buckets.length / 2)] };
  }
  return {
    ok: true,
    gallery,
    baseline,
    bestIndex: best.i,
    quality: best.analysis.quality,
    reasons: [],
    failure: null,
    accepted: pool.map((f) => f.i),
    usableFrontal: frontal.length,
  };
}

/* =================================================================== probes (checks / bursts) */

export interface ProbeEvidence extends FrameEvidence {
  index: number;
}

/** Evidence of each probe frame against the reference. */
export function probeEvidence(analyses: readonly ImageAnalysis[], gallery: readonly Float32Array[], baseline: SessionBaseline | null, context: ComparisonContext): ProbeEvidence[] {
  return analyses.map((a, index) => {
    const sim = a.embedding && gallery.length ? scoreReference(a.embedding, gallery) : null;
    return { ...frameEvidence(a.quality, sim, baseline, context), index };
  });
}

const BUCKET_ORDER: Record<QualityBucket, number> = { good: 0, fair: 1, poor: 2 };

/**
 * Per-frame similarities of a burst spreading more than this (max - min) are not averaged into a template score:
 * the burst is judged by its frames' median. A wide spread means the frames disagree (heavy noise, a turned face, two
 * people), and averaging disagreeing frames can score the template above every single frame — e.g. dim impostor
 * frames at 0.32–0.51 whose template scores 0.55. Genuine bursts in good light spread ~0.08 (p95 ~0.15).
 */
export const BURST_MAX_SPREAD = 0.15;

export interface BurstAggregate {
  evidence: FrameEvidence;
  perFrame: FrameEvidence[];
  /** The frames' embeddings agree with each other (one person); false => judged per frame (median). */
  consistent: boolean;
  /** How the burst was scored: the burst template (frames agree) or the frames' median (they disagree). */
  scoring: 'template' | 'median';
  /** max - min of the usable frames' similarities. */
  spread: number;
  usable: number;
  /** Index of the frame representing the burst (evidence image, quality). */
  representative: number;
  quality: FaceQuality | null;
}

/**
 * Decide a burst (1–5 frames taken within ~0.6 s) as ONE sample: the mean embedding of the usable frames scored
 * against the reference, in the median quality bucket of those frames. Frames that disagree with each other
 * (possibly two people during the burst) are judged per frame instead (median LLR).
 */
export function aggregateBurst(
  frames: readonly { embedding: Float32Array | null; quality: FaceQuality }[],
  gallery: readonly Float32Array[],
  baseline: SessionBaseline | null,
  context: ComparisonContext,
  thresholds: Pick<IdentityThresholds, 'mismatch'>,
): BurstAggregate {
  const perFrame = frames.map((f) => frameEvidence(f.quality, f.embedding && gallery.length ? scoreReference(f.embedding, gallery) : null, baseline, context));
  const usableIdx = frames.map((_, i) => i).filter((i) => perFrame[i].usable && frames[i].embedding);
  if (usableIdx.length === 0) {
    const withFace = frames.findIndex((f) => f.quality.faceCount > 0);
    const rep = withFace >= 0 ? withFace : 0;
    return { evidence: { usable: false, similarity: null, bucket: null, llr: 0 }, perFrame, consistent: true, scoring: 'median', spread: 0, usable: 0, representative: rep, quality: frames[rep]?.quality ?? null };
  }
  let consistent = true;
  for (let x = 0; x < usableIdx.length && consistent; x++) {
    for (let y = x + 1; y < usableIdx.length; y++) {
      if (cosineSimilarity(frames[usableIdx[x]].embedding!, frames[usableIdx[y]].embedding!) < thresholds.mismatch) {
        consistent = false;
        break;
      }
    }
  }
  const buckets = usableIdx.map((i) => perFrame[i].bucket!).sort((a, b) => BUCKET_ORDER[a] - BUCKET_ORDER[b]);
  const bucket = buckets[Math.floor(buckets.length / 2)] ?? buckets[buckets.length - 1];
  const frameSims = usableIdx.map((i) => perFrame[i].similarity!);
  const spread = round4(Math.max(...frameSims) - Math.min(...frameSims));
  let evidence: FrameEvidence;
  let scoring: BurstAggregate['scoring'];
  if (consistent && spread <= BURST_MAX_SPREAD) {
    // The template of the burst averages frame noise out (the score the calibration is fitted for).
    const sim = scoreReference(usableIdx.map((i) => frames[i].embedding!), gallery);
    evidence = { usable: true, similarity: sim, bucket, llr: comparisonLLR(sim, bucket, baseline, context, usableIdx.length).llr };
    scoring = 'template';
  } else {
    scoring = 'median';
    const llrs = usableIdx.map((i) => perFrame[i].llr);
    const sims = usableIdx.map((i) => perFrame[i].similarity!);
    evidence = { usable: true, similarity: round4(median(sims)), bucket, llr: round4(median(llrs)) };
  }
  // Representative frame: the strongest "different" frame when the burst points that way, else the best quality one.
  let representative = usableIdx[0];
  for (const i of usableIdx) {
    if (evidence.llr > 0 ? perFrame[i].llr > perFrame[representative].llr : qualityScore(frames[i].quality) > qualityScore(frames[representative].quality)) representative = i;
  }
  return { evidence, perFrame, consistent, scoring, spread, usable: usableIdx.length, representative, quality: frames[representative].quality };
}

export { qualityBucket };
