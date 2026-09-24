import type { EventType, GazeDirection } from './events';

/**
 * Per-tick observation produced in the browser (MediaPipe + canvas metrics) and consumed by the
 * pure-TS monitoring engine in @sp/detection. Keeping this a plain data structure lets us record
 * traces and replay them offline for accuracy evaluation.
 */

export type CameraState =
  | 'live' // frames flowing
  | 'muted' // track muted (OS / other app took the camera)
  | 'ended' // track ended / device unplugged
  | 'no_permission' // permission revoked / denied
  | 'unavailable'; // no camera / failed to start

export interface NormBox {
  /** Normalized 0..1 relative to frame width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceObservation {
  box: NormBox;
  /** Detector / landmark presence confidence 0..1. */
  score: number;
  /** Head pose in degrees, POSE_CONVENTION (yaw+ = subject-left, pitch+ = up, un-mirrored). */
  yaw: number;
  pitch: number;
  roll: number;
  /**
   * Eye gaze relative to head, -1..1 (from iris position / blendshapes).
   * gazeX > 0 = looking toward subject-left, gazeY < 0 = looking down.
   */
  gazeX: number;
  gazeY: number;
  /** 0..1: fraction of expected landmarks that are plausible / visible (low => occluded). */
  visibility: number;
  /** Box touches the frame edge (face partially outside the image). */
  cutOff: boolean;
  /** Mean luminance of the face region 0..255 (if computed). */
  brightness?: number;
}

export interface ObjectObservation {
  /** COCO label as emitted by the detector, e.g. 'cell phone', 'book', 'laptop', 'tv', 'person'. */
  label: string;
  score: number;
  box: NormBox;
}

export interface FrameMetrics {
  /** Mean luminance of the whole frame 0..255. */
  luma: number;
  /** Std-dev of luminance. */
  contrast: number;
  /** Variance of Laplacian on a downscaled grayscale frame (sharpness / texture). */
  sharpness: number;
  /** 64-bit difference hash as 16 hex chars. */
  dhash: string;
  /** Mean absolute pixel difference vs previous analysed frame (0..255), null for first frame. */
  diffFromPrev: number | null;
}

export interface FrameObservation {
  /** Epoch ms (server-corrected clock). */
  t: number;
  camera: CameraState;
  /** Frame metrics; null when no frame was available. */
  frame: FrameMetrics | null;
  /** Faces found by the face landmarker this tick. */
  faces: FaceObservation[];
  /** Object detections, present only on ticks where the object detector ran. */
  objects: ObjectObservation[] | null;
  /** Analysis throughput over the last few seconds (frames per second). */
  fps?: number;
}

/** Candidate's normal position/appearance measured at the start of each observed period. */
export interface Baseline {
  yaw: number;
  pitch: number;
  /** Face center, normalized. */
  cx: number;
  cy: number;
  /** Face box width normalized. */
  faceWidth: number;
  luma: number;
  dhash: string;
  capturedAt: number;
  samples: number;
}

/** Output of the monitoring engine: episode lifecycle for one event. */
export interface EpisodeUpdate {
  /** Stable id for the episode; used as the event id (UUID v4). */
  episodeId: string;
  type: EventType;
  phase: 'open' | 'update' | 'close';
  startedAt: number;
  endedAt: number | null;
  /** 0..1 */
  confidence: number;
  /** Specific observation sentence, e.g. "No face visible for 42 s; the candidate returned at 10:32". */
  observation?: string;
  details: Record<string, unknown>;
  /** Monotonic per-episode version, starting at 1. */
  version: number;
  /** Ask the host to capture a screenshot now and attach it to this episode. */
  captureSnapshot?: 'onset' | 'peak' | 'periodic' | 'end';
}

/** Side-effect requests from the engine to the host (not events). */
export type EngineSignal =
  | { kind: 'identity_sample'; trigger: 'face_return' | 'camera_reconnect' | 'after_multiple_people' | 'after_obstruction' | 'periodic' }
  | { kind: 'candidate_prompt'; message: string; severity: 'info' | 'warning'; key: string }
  | { kind: 'candidate_prompt_clear'; key: string };

export interface EngineOutput {
  episodes: EpisodeUpdate[];
  signals: EngineSignal[];
  /** Short status for the admin dashboard, e.g. { state: 'ok', faces: 1, label: 'Candidate in view' }. */
  status: MonitoringStatus;
}

export interface MonitoringStatus {
  state: 'ok' | 'attention' | 'degraded' | 'off';
  faces: number;
  label: string;
  /** Types of episodes currently open. */
  open: EventType[];
  lookDirection?: GazeDirection | null;
}
