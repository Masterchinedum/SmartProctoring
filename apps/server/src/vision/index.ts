/**
 * Vision module: face detection (YuNet), embeddings (SFace), quality gate, identity decisions,
 * reference enrolment, liveness verification. See types.ts for the contract.
 */
export * from './types';
export { createVisionService, OnnxVisionService, VisionBusyError, VisionClosedError, type VisionServiceOptions, type VisionStats } from './service';
export {
  cosineSimilarity,
  maxSimilarity,
  bestSimilarity,
  thresholdsFor,
  templateFrom,
  scoreAgainst,
  decideIdentity,
  buildReference,
  aggregateFrames,
  CONFIDENCE_MARGIN,
  INCONCLUSIVE_GUIDANCE,
  NO_EMBEDDING_GUIDANCE,
  REFERENCE_MIN_FRAMES,
  REFERENCE_MAX_EMBEDDINGS,
  REFERENCE_MAX_ABS_YAW_DEG,
  REFERENCE_MIN_PITCH_DEG,
  REFERENCE_MAX_PITCH_DEG,
  REFERENCE_INCONSISTENT_REASON,
  type ComparisonTarget,
} from './identity';
export {
  CALIBRATION,
  BUCKET_MODELS,
  BUCKET_THRESHOLDS,
  LLR_TAIL_EPS,
  qualityBucket,
  sampleLLR,
  rawLLR,
  posteriorSwap,
  type QualityBucket,
  type BucketModel,
  type BucketThresholds,
  type Calibration,
} from './calibration';
export { verifyLiveness, checkStepFrame, stepDelta, LIVENESS_DEFAULTS, LIVENESS_REASONS, type LivenessOptions } from './liveness';
export {
  QUALITY_GATE,
  ID_PHOTO_QUALITY_GATE,
  resolveGate,
  assessQuality,
  regateQuality,
  poseWithinGate,
  FRONTAL_PITCH_DEG,
  guidanceForIssues,
  qualityScore,
} from './quality';
export { processIdPhoto, ID_PHOTO_GUIDANCE } from './id-photo';
export {
  serializeEmbeddings,
  deserializeEmbeddings,
  readEmbeddingHeader,
  EmbeddingFormatError,
  EMBEDDING_DIM,
  EMBEDDING_FORMAT_VERSION,
  EMBEDDING_MODEL_SFACE_2021DEC,
} from './embeddings';
export { hammingHex, dhashFromGray, VisionInputError, MAX_INPUT_PIXELS } from './image';
export { resolveModelsDir, VisionModelsNotFoundError } from './models';
export { FakeVisionService, fakeEmbedding, fakeAnalysis, syntheticLandmarks, type FakeImageSpec, type FakeVisionOptions } from './fake';
