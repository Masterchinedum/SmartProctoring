/**
 * Image-quality gate: decides whether an image is good enough for a dependable identity comparison.
 * An image failing the gate yields `unable_to_verify` with candidate guidance — never `mismatch`.
 */
import { QUALITY_GUIDANCE, type FaceQuality, type QualityIssue } from '@sp/shared';
import type { AlignedFace } from './align';
import type { DetectedFace, HeadPose, QualityGate } from './types';
import { interEyeDistance } from './detect';

/**
 * Default gate for live webcam frames (identity v2). It only refuses frames on which face RECOGNITION is not
 * reliable — measured on simulated laptop-webcam frames as the similarity of a frame to the same person's
 * good-light template collapsing (docs/accuracy/identity-v2.md §4):
 *   - face-region contrast (luma std) < 7: genuine similarity p05 0.03-0.10 (vs 0.65+ at >= 15), impostors alike —
 *     except when the detector is confident (score >= 0.88): such flat faces (typically backlit, lifted by lens
 *     flare) stay recognisable down to contrast 5 (v2.1: backlit contrast 5-7 with a confident detection: genuine
 *     p05 0.39, median 0.63, 2 % below 0.3; without: 16-42 % below 0.3)
 *   - face-region brightness < 40 (unchanged from v1: below it 33-50 % of genuine dim-room frames collapse to
 *     similarity < 0.2 against the person's own good-light template) or > 235 (clipped)
 *   - inter-eye distance < 20 px (at 20-24 px genuine similarity is still p05 0.91 in good light)
 *   - detector score < 0.65 (occluded / barely a face), |yaw| > 30 deg or pitch outside [-35, 25] deg
 *     (SFace degrades beyond ~35 deg; five-point pose jitters by ~3-6 deg), strong blur, cut-off, extra faces.
 * Everything else is usable and graded good / fair / poor by `qualityBucket` (calibration.ts); poor frames are
 * weak evidence (their calibrated LLR is small) instead of "unable to verify". The v1 gate (QUALITY_GATE_V1)
 * refused ~100 % of dim-room and backlit frames on photometry alone. Every value can be overridden per call
 * via `AnalyzeOptions.gate`.
 */
export const QUALITY_GATE: Readonly<QualityGate> = Object.freeze({
  minDetectionScore: 0.65,
  minInterEyePx: 20,
  minBrightness: 40,
  maxBrightness: 235,
  minContrast: 7,
  minContrastConfident: 5,
  confidentDetectionScore: 0.88,
  minSharpness: 80,
  maxAbsYawDeg: 30,
  minPitchDeg: -35,
  maxPitchDeg: 25,
  secondaryFaceSizeRatio: 0.4,
  cutOffTolerance: 0.08,
});

/**
 * The original (identity v1) live-frame gate, kept for before/after evaluation (eval:identity --webcam --legacy).
 * Its photometric limits (contrast >= 18, brightness >= 40, sharpness >= 80) rejected ~100 % of dim-room and
 * backlit webcam frames although SFace still separates genuine and impostor faces there.
 */
export const QUALITY_GATE_V1: Readonly<QualityGate> = Object.freeze({
  minDetectionScore: 0.75,
  minInterEyePx: 28,
  minBrightness: 40,
  maxBrightness: 220,
  minContrast: 18,
  minSharpness: 80,
  maxAbsYawDeg: 25,
  minPitchDeg: -35,
  maxPitchDeg: 25,
  secondaryFaceSizeRatio: 0.4,
  cutOffTolerance: 0.08,
});

/**
 * Relaxed gate for uploaded ID photos (often small, scanned, older, tightly cropped, and ID cards may
 * carry a smaller "ghost" portrait next to the main one).
 */
export const ID_PHOTO_QUALITY_GATE: Readonly<QualityGate> = Object.freeze({
  minDetectionScore: 0.65,
  minInterEyePx: 20,
  minBrightness: 35,
  maxBrightness: 230,
  minContrast: 14,
  minSharpness: 50,
  maxAbsYawDeg: 30,
  minPitchDeg: -40,
  maxPitchDeg: 30,
  secondaryFaceSizeRatio: 0.7,
  cutOffTolerance: 0.2,
});

export function resolveGate(override?: Partial<QualityGate>, base: Readonly<QualityGate> = QUALITY_GATE): QualityGate {
  const g: QualityGate = { ...base };
  if (override) {
    for (const [k, v] of Object.entries(override) as [keyof QualityGate, number | undefined][]) {
      if (typeof v === 'number' && Number.isFinite(v)) g[k] = v;
    }
  }
  return g;
}

/** Typical pitch reading of a frontal face with YuNet landmarks (median over near-frontal portraits). */
export const FRONTAL_PITCH_DEG = -10;

/** Region of the 112x112 aligned crop used for brightness / contrast (cheeks, eyes, nose, mouth). */
const STATS_X0 = 22;
const STATS_X1 = 90;
const STATS_Y0 = 30;
const STATS_Y1 = 106;
/** Region used for the Laplacian (interior, so all 4 neighbours exist). */
const LAP_X0 = 18;
const LAP_X1 = 94;
const LAP_Y0 = 22;
const LAP_Y1 = 106;
/** Laplacian variance is normalised to this face-region std-dev so lighting does not masquerade as blur. */
const SHARPNESS_REF_STD = 50;

export interface FaceRegionStats {
  brightness: number;
  contrast: number;
  /** Variance of the 4-neighbour Laplacian, normalised to a face-region std-dev of 50. */
  sharpness: number;
  /** Variance of the Laplacian without normalisation (for diagnostics / calibration). */
  rawLaplacianVar: number;
  /** Estimated noise std-dev (Immerkaer's operator on the face region), 8-bit units. */
  noise?: number;
  /** Noise-robust sharpness: like `sharpness`, but on a 3x3-binomial-smoothed crop with the noise term removed. */
  detail?: number;
  /** Fraction of face-region pixels <= 3 or >= 252. */
  clipped?: number;
}

/** Brightness / contrast / sharpness of the aligned face crop (only pixels that map inside the image). */
export function faceRegionStats(face: AlignedFace): FaceRegionStats {
  const { gray, valid, size } = face;
  const scale = size / 112;
  const sx0 = Math.round(STATS_X0 * scale);
  const sx1 = Math.round(STATS_X1 * scale);
  const sy0 = Math.round(STATS_Y0 * scale);
  const sy1 = Math.round(STATS_Y1 * scale);
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = sy0; y < sy1; y++) {
    for (let x = sx0; x < sx1; x++) {
      const i = y * size + x;
      if (!valid[i]) continue;
      const v = gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const brightness = n > 0 ? sum / n : 0;
  const variance = n > 0 ? Math.max(0, sumSq / n - brightness * brightness) : 0;
  const contrast = Math.sqrt(variance);

  const lx0 = Math.max(1, Math.round(LAP_X0 * scale));
  const lx1 = Math.min(size - 1, Math.round(LAP_X1 * scale));
  const ly0 = Math.max(1, Math.round(LAP_Y0 * scale));
  const ly1 = Math.min(size - 1, Math.round(LAP_Y1 * scale));
  let ln = 0;
  let lsum = 0;
  let lsumSq = 0;
  for (let y = ly0; y < ly1; y++) {
    for (let x = lx0; x < lx1; x++) {
      const i = y * size + x;
      if (!valid[i] || !valid[i - 1] || !valid[i + 1] || !valid[i - size] || !valid[i + size]) continue;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size] - 4 * gray[i];
      lsum += lap;
      lsumSq += lap * lap;
      ln++;
    }
  }
  const lmean = ln > 0 ? lsum / ln : 0;
  const rawLaplacianVar = ln > 0 ? Math.max(0, lsumSq / ln - lmean * lmean) : 0;
  const sharpness = variance >= 1 ? (rawLaplacianVar * SHARPNESS_REF_STD * SHARPNESS_REF_STD) / variance : 0;
  const extra = noiseAndDetail(face, { sx0, sx1, sy0, sy1 }, variance);
  return { brightness, contrast, sharpness, rawLaplacianVar, ...extra };
}

/**
 * Noise and noise-robust sharpness of the face region.
 *
 * Noise: Immerkaer (1996) — the 3x3 operator [1 -2 1; -2 4 -2; 1 -2 1] cancels locally planar image structure,
 * so sigma = sqrt(pi/2) * mean(|I * N|) / 6 estimates additive noise. Detail: the Laplacian variance of a
 * binomial-smoothed crop (which suppresses pixel noise ~ 7x in variance but keeps the mid frequencies that
 * disappear with defocus / motion blur), minus the expected noise contribution, normalised like `sharpness`.
 */
function noiseAndDetail(face: AlignedFace, r: { sx0: number; sx1: number; sy0: number; sy1: number }, variance: number): { noise: number; detail: number; clipped: number } {
  const { gray, valid, size } = face;
  const x0 = Math.max(2, r.sx0);
  const x1 = Math.min(size - 2, r.sx1);
  const y0 = Math.max(2, r.sy0);
  const y1 = Math.min(size - 2, r.sy1);
  // Binomial-smoothed copy of the region (+1 px border).
  const sm = new Float32Array(size * size);
  for (let y = y0 - 1; y < y1 + 1; y++) {
    for (let x = x0 - 1; x < x1 + 1; x++) {
      const i = y * size + x;
      sm[i] =
        (4 * gray[i] + 2 * (gray[i - 1] + gray[i + 1] + gray[i - size] + gray[i + size]) + gray[i - size - 1] + gray[i - size + 1] + gray[i + size - 1] + gray[i + size + 1]) / 16;
    }
  }
  let nAbs = 0;
  let nN = 0;
  let clip = 0;
  let cN = 0;
  let ls = 0;
  let lss = 0;
  let lN = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * size + x;
      if (!valid[i]) continue;
      const g = gray[i];
      cN++;
      if (g <= 3 || g >= 252) clip++;
      if (!valid[i - size - 1] || !valid[i - size + 1] || !valid[i + size - 1] || !valid[i + size + 1]) continue;
      const conv =
        gray[i - size - 1] - 2 * gray[i - size] + gray[i - size + 1] - 2 * gray[i - 1] + 4 * g - 2 * gray[i + 1] + gray[i + size - 1] - 2 * gray[i + size] + gray[i + size + 1];
      nAbs += Math.abs(conv);
      nN++;
      const lap = sm[i - 1] + sm[i + 1] + sm[i - size] + sm[i + size] - 4 * sm[i];
      ls += lap;
      lss += lap * lap;
      lN++;
    }
  }
  const noise = nN > 0 ? (Math.sqrt(Math.PI / 2) * (nAbs / nN)) / 6 : 0;
  const lmean = lN > 0 ? ls / lN : 0;
  const lapVar = lN > 0 ? Math.max(0, lss / lN - lmean * lmean) : 0;
  // White noise of variance s^2 through binomial smoothing then the 4-neighbour Laplacian: gain = sum of squared kernel taps = 0.40625.
  const noiseLap = 0.40625 * noise * noise;
  const signalVar = Math.max(1, variance - noise * noise);
  const detail = variance >= 1 ? (Math.max(0, lapVar - noiseLap) * SHARPNESS_REF_STD * SHARPNESS_REF_STD) / signalVar : 0;
  return { noise, detail, clipped: cN > 0 ? clip / cN : 0 };
}

export interface QualityInput {
  width: number;
  height: number;
  /** All detections, primary first. */
  faces: DetectedFace[];
  pose: HeadPose | null;
  stats: FaceRegionStats | null;
  /** Whole-image luminance, used for guidance when no face is found. */
  imageBrightness: number;
  imageContrast: number;
}

/** Whether a head pose (POSE_CONVENTION degrees) is frontal enough for the gate. */
export function poseWithinGate(yawDeg: number, pitchDeg: number, gate: Pick<QualityGate, 'maxAbsYawDeg' | 'minPitchDeg' | 'maxPitchDeg'> = QUALITY_GATE): boolean {
  return Math.abs(yawDeg) <= gate.maxAbsYawDeg && pitchDeg >= gate.minPitchDeg && pitchDeg <= gate.maxPitchDeg;
}

/** Faces other than the primary that are large enough to count as another person in view. */
export function significantSecondaryFaces(faces: DetectedFace[], ratio: number): DetectedFace[] {
  if (faces.length < 2) return [];
  const pw = faces[0].box.w;
  return faces.slice(1).filter((f) => f.box.w >= ratio * pw);
}

export function isCutOff(face: DetectedFace, width: number, height: number, tolerance: number): boolean {
  const { x, y, w, h } = face.box;
  const tx = tolerance * w;
  const ty = tolerance * h;
  if (x < -tx || y < -ty || x + w > width + tx || y + h > height + ty) return true;
  const margin = 0.02 * Math.max(w, h);
  return face.landmarks.some((p) => p.x < margin || p.y < margin || p.x > width - 1 - margin || p.y > height - 1 - margin);
}

/** Face contrast too low to recognise: below `minContrast`, unless the detection is confident (then below `minContrastConfident`). */
export function lowContrast(contrast: number, detectionScore: number, gate: Pick<QualityGate, 'minContrast' | 'minContrastConfident' | 'confidentDetectionScore'>): boolean {
  if (contrast >= gate.minContrast) return false;
  if (gate.minContrastConfident == null || gate.confidentDetectionScore == null) return true;
  return contrast < gate.minContrastConfident || detectionScore < gate.confidentDetectionScore;
}

/** Order in which issues (and therefore guidance) are presented: most fundamental first. */
const ISSUE_ORDER: QualityIssue[] = [
  'no_face',
  'multiple_faces',
  'face_cut_off',
  'too_dark',
  'too_bright',
  'low_contrast',
  'face_too_small',
  'face_turned',
  'blurry',
  'low_detection_confidence',
];

export function assessQuality(input: QualityInput, gate: QualityGate = QUALITY_GATE): FaceQuality {
  const { faces, width, height, pose, stats } = input;
  const primary = faces[0] ?? null;
  const issues = new Set<QualityIssue>();
  if (!primary) {
    issues.add('no_face');
    if (input.imageBrightness < gate.minBrightness) issues.add('too_dark');
    else if (input.imageBrightness > gate.maxBrightness) issues.add('too_bright');
    else if (input.imageContrast < gate.minContrast) issues.add('low_contrast');
    return {
      faceCount: 0,
      detectionScore: 0,
      interEyePx: 0,
      faceWidthRatio: 0,
      brightness: round2(input.imageBrightness),
      contrast: round2(input.imageContrast),
      sharpness: 0,
      yawDeg: 0,
      pitchDeg: 0,
      cutOff: false,
      issues: orderIssues(issues),
      usable: false,
    };
  }
  const secondary = significantSecondaryFaces(faces, gate.secondaryFaceSizeRatio);
  const interEyePx = interEyeDistance(primary);
  const cutOff = isCutOff(primary, width, height, gate.cutOffTolerance);
  const brightness = stats?.brightness ?? input.imageBrightness;
  const contrast = stats?.contrast ?? input.imageContrast;
  const sharpness = stats?.sharpness ?? 0;
  const yawDeg = pose?.yawDeg ?? 0;
  const pitchDeg = pose?.pitchDeg ?? 0;

  if (secondary.length > 0) issues.add('multiple_faces');
  if (cutOff) issues.add('face_cut_off');
  if (brightness < gate.minBrightness) issues.add('too_dark');
  if (brightness > gate.maxBrightness) issues.add('too_bright');
  if (lowContrast(contrast, primary.score, gate)) issues.add('low_contrast');
  if (interEyePx < gate.minInterEyePx) issues.add('face_too_small');
  if (!poseWithinGate(yawDeg, pitchDeg, gate)) issues.add('face_turned');
  // Sharpness is meaningless on a crop that is mostly dark/flat; those images are already rejected.
  if (sharpness < gate.minSharpness && !issues.has('too_dark') && !issues.has('low_contrast')) issues.add('blurry');
  if (primary.score < gate.minDetectionScore) issues.add('low_detection_confidence');

  return {
    faceCount: 1 + secondary.length,
    detectionScore: round4(primary.score),
    interEyePx: round2(interEyePx),
    faceWidthRatio: round4(Math.min(1, primary.box.w / Math.max(1, width))),
    brightness: round2(brightness),
    contrast: round2(contrast),
    sharpness: round2(sharpness),
    yawDeg: round2(yawDeg),
    pitchDeg: round2(pitchDeg),
    cutOff,
    ...(stats?.noise != null ? { noise: round2(stats.noise) } : {}),
    ...(stats?.detail != null ? { detail: round2(stats.detail) } : {}),
    ...(stats?.clipped != null ? { clipped: round4(stats.clipped) } : {}),
    issues: orderIssues(issues),
    usable: issues.size === 0,
  };
}

/**
 * Re-evaluate an existing FaceQuality against another gate. Needs the detections for the
 * multiple-face and cut-off rules; everything else is recomputed from the stored measurements.
 */
export function regateQuality(q: FaceQuality, faces: DetectedFace[], width: number, height: number, gate: QualityGate): FaceQuality {
  if (faces.length === 0) return { ...q, issues: q.issues.length ? q.issues : ['no_face'], usable: false };
  const issues = new Set<QualityIssue>();
  const secondary = significantSecondaryFaces(faces, gate.secondaryFaceSizeRatio);
  const cutOff = isCutOff(faces[0], width, height, gate.cutOffTolerance);
  if (secondary.length > 0) issues.add('multiple_faces');
  if (cutOff) issues.add('face_cut_off');
  if (q.brightness < gate.minBrightness) issues.add('too_dark');
  if (q.brightness > gate.maxBrightness) issues.add('too_bright');
  if (lowContrast(q.contrast, q.detectionScore, gate)) issues.add('low_contrast');
  if (q.interEyePx < gate.minInterEyePx) issues.add('face_too_small');
  if (!poseWithinGate(q.yawDeg, q.pitchDeg, gate)) issues.add('face_turned');
  if (q.sharpness < gate.minSharpness && !issues.has('too_dark') && !issues.has('low_contrast')) issues.add('blurry');
  if (q.detectionScore < gate.minDetectionScore) issues.add('low_detection_confidence');
  return { ...q, faceCount: 1 + secondary.length, cutOff, issues: orderIssues(issues), usable: issues.size === 0 };
}

function orderIssues(set: Set<QualityIssue>): QualityIssue[] {
  return ISSUE_ORDER.filter((i) => set.has(i));
}

/** Candidate-facing guidance strings for a list of quality issues (deduplicated, in priority order). */
export function guidanceForIssues(issues: readonly QualityIssue[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const text = QUALITY_GUIDANCE[issue];
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * Candidate guidance for a USABLE frame of poor quality (dim, flat or backlit face, small face): the frame
 * still counts as (weak) evidence, but better light or a closer position makes checks faster. Empty for
 * good frames. Thresholds follow the 'poor' bucket of calibration.ts.
 */
export function advisoryGuidance(q: FaceQuality): string[] {
  if (!q.usable) return [];
  const issues: QualityIssue[] = [];
  if (q.brightness < ADVISORY.minBrightness) issues.push('too_dark');
  else if (q.contrast < ADVISORY.minContrast) issues.push('low_contrast');
  if (q.interEyePx < ADVISORY.minInterEyePx) issues.push('face_too_small');
  return guidanceForIssues(issues);
}

/** Soft limits behind `advisoryGuidance` (below them a usable frame is in the 'poor' bucket). */
export const ADVISORY = Object.freeze({ minBrightness: 50, minContrast: 12, minInterEyePx: 24 });

/**
 * Scalar "how good is this frame for enrolment/evidence" score in ~[0, 1]; used to pick the best
 * reference frame / evidence probe. Not a gate.
 */
export function qualityScore(q: FaceQuality): number {
  const pose = 1 - Math.min(1, (Math.abs(q.yawDeg) + Math.abs(q.pitchDeg - FRONTAL_PITCH_DEG)) / 50);
  const sharp = Math.min(1, q.sharpness / 600);
  const size = Math.min(1, q.interEyePx / 80);
  const light = 1 - Math.min(1, Math.abs(q.brightness - 130) / 110);
  return 0.35 * q.detectionScore + 0.25 * pose + 0.15 * sharp + 0.15 * size + 0.1 * light;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
