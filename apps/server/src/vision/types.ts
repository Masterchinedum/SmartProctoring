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
