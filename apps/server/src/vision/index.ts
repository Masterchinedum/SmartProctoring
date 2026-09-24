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
  MISMATCH_MIN_LLR,
  MATCH_MAX_LLR,
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
  referenceBucket,
  referenceClass,
  bucketModel,
  REFERENCE_MODELS,
  CONTINUOUS_MODEL,
  continuousLLR,
  windowEvidence,
  GENUINE_DRIFT,
  sampleLLR,
  rawLLR,
  posteriorSwap,
  type QualityBucket,
  type BucketModel,
  type BucketThresholds,
  type Calibration,
  type ComparisonContext,
  type ContinuousParams,
  type DriftModel,
  type EvidenceContext,
  type ReferenceBaseline,
  type ReferenceClass,
  type WindowEntry,
} from './calibration';
export {
  verifyLiveness,
  checkStepFrame,
  stepDelta,
  LIVENESS_DEFAULTS,
  LIVENESS_REASONS,
  FRONTAL_MIN_SIMILARITY,
  TURNED_MIN_SIMILARITY,
  type LivenessOptions,
  type StepFrameFeedback,
} from './liveness';
export {
  QUALITY_GATE,
  QUALITY_GATE_V1,
  ID_PHOTO_QUALITY_GATE,
  resolveGate,
  assessQuality,
  regateQuality,
  poseWithinGate,
  FRONTAL_PITCH_DEG,
  guidanceForIssues,
  advisoryGuidance,
  ADVISORY,
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
  EMBEDDING_MODEL_SFACE_2021DEC_FLIP,
  EMBEDDING_MODEL_CURRENT,
  COMPATIBLE_EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_RECIPE,
} from './embeddings';
export { RECIPE_V1, RECIPE_V2, type EmbeddingRecipe, type IlluminationNormalization } from './embed-prep';
export { hammingHex, dhashFromGray, VisionInputError, MAX_INPUT_PIXELS } from './image';
export { resolveModelsDir, VisionModelsNotFoundError } from './models';
export { FakeVisionService, fakeEmbedding, fakeAnalysis, syntheticLandmarks, type FakeImageSpec, type FakeVisionOptions } from './fake';
