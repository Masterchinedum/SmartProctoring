/**
 * Contract between the vision module (face detection / embedding / quality / liveness) and the rest of
 * the server. Implementation lives in this folder (index.ts exports createVisionService etc.).
 */
import type { FaceQuality, IdentityDecision, IdentityThresholds, LivenessAction, LivenessResultDTO } from '@sp/shared';

export interface Point { x: number; y: number }

export interface DetectedFace {
  /** Pixel box in the ORIGINAL image coordinates. */
  box: { x: number; y: number; w: number; h: number };
  score: number;
  /** YuNet order: [0] eye on image-left (subject's right eye), [1] eye on image-right, [2] nose tip,
   *  [3] mouth corner image-left, [4] mouth corner image-right. Original image coordinates. */
  landmarks: [Point, Point, Point, Point, Point];
}

export interface HeadPose {
  /** POSE_CONVENTION: yaw+ = subject turned to their left (nose toward image right); pitch+ = up. */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface ImageAnalysis {
  width: number;
  height: number;
  faces: DetectedFace[];
  /** Largest / highest scoring face, null if none. */
  primary: DetectedFace | null;
  pose: HeadPose | null;
  quality: FaceQuality;
  /** L2-normalised 128-d SFace embedding of the primary face (only when requested and a face exists). */
  embedding: Float32Array | null;
  /** 64-bit dHash of the whole image (hex) — used to detect identical/replayed frames. */
  dhash: string;
  /** JPEG of the primary face region with margin (~256px), for evidence display (only when requested). */
  faceCropJpeg: Buffer | null;
  /** Whole-image mean luminance 0..255. */
  imageBrightness: number;
}

export interface AnalyzeOptions {
  embed?: boolean;
  faceCrop?: boolean;
  /** Override (part of) the quality gate used to compute `quality.issues` / `quality.usable`. */
  gate?: Partial<QualityGate>;
  /**
   * Scheduling hint when the vision pool is busy: 'interactive' (default) — someone is waiting for the answer
   * (check frames, ID photos); 'background' — may wait a few seconds (mid-exam identity samples). Implementations
   * may ignore it.
   */
  priority?: 'interactive' | 'background';
}

export interface VisionService {
  analyze(jpeg: Buffer, opts?: AnalyzeOptions): Promise<ImageAnalysis>;
  close(): Promise<void>;
}

export interface IdentityComparison {
  decision: IdentityDecision;
  similarity: number | null;
  /** 0..1 confidence in the decision. */
  confidence: number;
  guidance: string[];
}

export interface ReferenceBuildResult {
  ok: boolean;
  /** Embeddings to store (encrypted) as the protected reference. */
  embeddings: Float32Array[];
  /** Index into the input analyses of the best frontal frame (used for the reference image). */
  bestIndex: number;
  quality: FaceQuality | null;
  reasons: string[];
}

export interface LivenessFrame {
  step: number | 'frontal';
  action: LivenessAction | 'center';
  analysis: ImageAnalysis;
  capturedAt: number;
  /** Optional client-reported pose for cross-checking (POSE_CONVENTION). */
  clientYaw?: number | null;
  clientPitch?: number | null;
}

export interface LivenessChallengeSpec {
  steps: { index: number; action: LivenessAction | 'center' }[];
  issuedAt: number;
  expiresAt: number;
  targetYawDeg: number;
  targetPitchDeg: number;
}

export type { IdentityThresholds, LivenessResultDTO };

/* ------------------------------------------------------------------------------------------------
 * Additive extensions (everything above is the original contract and is unchanged).
 * ---------------------------------------------------------------------------------------------- */

/** Thresholds of the image-quality gate. See `QUALITY_GATE` / `ID_PHOTO_QUALITY_GATE` in quality.ts. */
export interface QualityGate {
  /** Primary face detector score below this => `low_detection_confidence`. */
  minDetectionScore: number;
  /** Inter-ocular distance (original-image pixels) below this => `face_too_small`. */
  minInterEyePx: number;
  /** Face-region mean luminance outside [min, max] => `too_dark` / `too_bright`. */
  minBrightness: number;
  maxBrightness: number;
  /** Face-region luminance std-dev below this => `low_contrast`. */
  minContrast: number;
  /** Contrast-normalised variance of Laplacian on the aligned crop below this => `blurry`. */
  minSharpness: number;
  /** |yaw| above this (degrees) => `face_turned`. */
  maxAbsYawDeg: number;
  /**
   * Pitch outside [minPitchDeg, maxPitchDeg] => `face_turned`. Asymmetric on purpose: with YuNet
   * landmarks the shared five-point formula reads frontal faces ~10 deg "down", and laptop webcams sit
   * above the eyes, so candidates normally appear to look slightly down.
   */
  minPitchDeg: number;
  maxPitchDeg: number;
  /** A second face at least this fraction of the primary face's width => `multiple_faces`. */
  secondaryFaceSizeRatio: number;
  /** Fraction of the face box allowed outside the image before it counts as cut off. */
  cutOffTolerance: number;
}

/** Result of processing an uploaded ID photo (relaxed gate; see id-photo.ts). */
export interface IdPhotoResult {
  accepted: boolean;
  /** Analysis with `quality` evaluated against the ID-photo gate; `embedding` set when a face was found. */
  analysis: ImageAnalysis;
  quality: FaceQuality;
  guidance: string[];
}

/** Per-frame decision inside an aggregate. */
export interface FrameDecision extends IdentityComparison {
  index: number;
  usable: boolean;
}

/** Aggregate of several probe frames compared with a reference (resume / reconnect checks). */
export interface FrameAggregateResult extends IdentityComparison {
  frames: FrameDecision[];
  matchCount: number;
  mismatchCount: number;
  inconclusiveCount: number;
  unableCount: number;
  usableCount: number;
  /** Over usable frames with a similarity; null when there are none. */
  minSimilarity: number | null;
  maxSimilarity: number | null;
  medianSimilarity: number | null;
  /** Index (into the input) of the frame best suited as evidence for the decision; null if no face at all. */
  bestProbeIndex: number | null;
}

/** Anything that can analyze images (the ONNX service or the FakeVisionService). */
export interface IdPhotoCapableVisionService extends VisionService {
  processIdPhoto(image: Buffer): Promise<IdPhotoResult>;
}
