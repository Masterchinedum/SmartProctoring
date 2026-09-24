/**
 * @sp/detection — pure-TypeScript in-browser monitoring engine (no DOM access, no Node APIs, no runtime
 * dependencies beyond @sp/shared). Turns per-tick FrameObservations into deduplicated, debounced
 * episodes, host signals and a monitoring status; plus frame metrics, MediaPipe adapters, baseline
 * calibration, environment comparison, liveness guidance and browser-signal tracking.
 * The offline accuracy harness lives in ./eval (not exported here; run `pnpm --filter @sp/detection eval`).
 */

// Engine
export { createMonitoringEngine } from './engine/engine';
export type { EngineOptions, MonitoringEngine } from './engine/engine';
export { K as ENGINE_CONSTANTS, DEFAULT_BASELINE, attentionAngles, directionOf, isAway, awayThresholds, plausibleFaces, countPersons } from './engine/context';
export { PROMPTS } from './engine/prompts';
export type { PromptKey } from './engine/prompts';
export { REPLAY as REPLAY_PARAMS } from './engine/detectors/feed';
export { UNAUTHORIZED_LABELS } from './engine/detectors/objects';

// Baseline & environment
export { createBaselineCalibrator } from './baseline/calibrator';
export type { BaselineCalibrator } from './baseline/calibrator';
export { compareEnvironment, ENVIRONMENT_THRESHOLDS } from './baseline/environment';

// Browser signals
export { createBrowserSignalTracker } from './browser/tracker';
export type { BrowserSignalTracker } from './browser/tracker';

// Frame metrics
export { rgbaToGray, computeFrameMetrics, regionStats, createFrameMetricsTracker } from './metrics/frame';
export type { FrameMetricsTracker } from './metrics/frame';
export { dhash64, hammingHex, majorityHash } from './metrics/hash';

// MediaPipe adapters
export { facesFromMediapipe, fivePointsFromMesh, gazeFromBlendshapes, objectsFromMediapipe, faceRegionQuality } from './mediapipe/adapters';
export type { MpLandmark, MpCategory, GrayFrame } from './mediapipe/adapters';

// Liveness guidance
export { createLivenessTracker } from './liveness/tracker';
export type { LivenessProgress, LivenessTracker } from './liveness/tracker';

// Camera label
export { isVirtualCameraLabel, classifyCameraLabel } from './camera/label';
export type { CameraLabelClassification, CameraLabelKind } from './camera/label';

// Utilities
export { defaultIdFactory, sequentialIdFactory } from './util/id';
