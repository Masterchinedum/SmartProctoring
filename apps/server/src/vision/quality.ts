/**
 * Image-quality gate: decides whether an image is good enough for a dependable identity comparison.
 * An image failing the gate yields `unable_to_verify` with candidate guidance — never `mismatch`.
 */
import { QUALITY_GUIDANCE, type FaceQuality, type QualityIssue } from '@sp/shared';
import type { AlignedFace } from './align';
import type { DetectedFace, HeadPose, QualityGate } from './types';
import { interEyeDistance } from './detect';

/**
 * Default gate for live webcam frames. Tuned on real photos plus synthetic degradations
 * (see docs/accuracy/identity.md); every value can be overridden per call via `AnalyzeOptions.gate`.
 */
export const QUALITY_GATE: Readonly<QualityGate> = Object.freeze({
  minDetectionScore: 0.75,
  minInterEyePx: 28,
  minBrightness: 40,
  maxBrightness: 220,
  minContrast: 18,
  minSharpness: 120,
  maxAbsYawDeg: 25,
  maxAbsPitchDeg: 25,
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
  minSharpness: 70,
  maxAbsYawDeg: 30,
  maxAbsPitchDeg: 30,
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
  return { brightness, contrast, sharpness, rawLaplacianVar };
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
  if (contrast < gate.minContrast) issues.add('low_contrast');
  if (interEyePx < gate.minInterEyePx) issues.add('face_too_small');
  if (Math.abs(yawDeg) > gate.maxAbsYawDeg || Math.abs(pitchDeg) > gate.maxAbsPitchDeg) issues.add('face_turned');
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
  if (q.contrast < gate.minContrast) issues.add('low_contrast');
  if (q.interEyePx < gate.minInterEyePx) issues.add('face_too_small');
  if (Math.abs(q.yawDeg) > gate.maxAbsYawDeg || Math.abs(q.pitchDeg) > gate.maxAbsPitchDeg) issues.add('face_turned');
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
 * Scalar "how good is this frame for enrolment/evidence" score in ~[0, 1]; used to pick the best
 * reference frame / evidence probe. Not a gate.
 */
export function qualityScore(q: FaceQuality): number {
  const pose = 1 - Math.min(1, (Math.abs(q.yawDeg) + Math.abs(q.pitchDeg)) / 50);
  const sharp = Math.min(1, q.sharpness / 600);
  const size = Math.min(1, q.interEyePx / 80);
  const light = 1 - Math.min(1, Math.abs(q.brightness - 130) / 110);
  return 0.35 * q.detectionScore + 0.25 * pose + 0.15 * sharp + 0.15 * size + 0.1 * light;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
