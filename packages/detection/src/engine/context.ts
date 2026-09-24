import type { Baseline, CameraState, DetectionPolicy, EngineSignal, EpisodeUpdate, FaceObservation, FrameMetrics, FrameObservation, GazeDirection, NormBox, ObjectObservation } from '@sp/shared';
import type { EpisodeBook } from './episodes';
import type { IdentityScheduler } from './identity';
import type { PromptManager } from './prompts';

/** Engine constants not exposed in the policy. Documented in docs/accuracy/detection.md. */
export const K = {
  /** Camera covered: very dark and flat, or near-uniform at any brightness. */
  coveredLuma: 20,
  coveredContrast: 8,
  uniformContrast: 4,
  /** Lighting thresholds (whole frame / face region mean luminance). */
  darkLuma: 35,
  brightLuma: 225,
  faceDark: 40,
  faceBright: 235,
  /** Frozen: mean abs diff below this AND identical dHash. Real sensors produce ≥ ~0.5 of noise. */
  frozenDiff: 0.15,
  /** Plausible face for counting people. */
  faceMinScore: 0.5,
  faceMinWidth: 0.035,
  /** Primary face assessable for pose/gaze when visibility ≥ this and not cut off. */
  assessableVisibility: 0.5,
  /** Obstruction: visibility below this. */
  obstructedVisibility: 0.5,
  /** Gaze (−1..1) → degrees, with a dead zone for normal reading eye movement. */
  gazeXDeg: 25,
  gazeYDeg: 20,
  gazeDeadzone: 0.15,
  /** "Up" threshold = lookDownPitchDeg + this. */
  upExtraDeg: 5,
  /** Object-detector person results are valid this long (object detector runs at ~1 Hz). */
  personCountFreshMs: 1500,
  personVisibleFreshMs: 1200,
  /** Far from baseline: centre shift (fraction of frame) or width ratio. */
  farCentre: 0.25,
  farWidthMin: 0.5,
  farWidthMax: 1.9,
  /** A face absence at least this long counts as an exit for unusual_movement. */
  exitMinMs: 2000,
  /** A face absence at least this long triggers an identity sample on return. */
  faceReturnMinMs: 3000,
  /** Candidate prompt "we can't see your face" after this long. */
  absencePromptMs: 3000,
  disconnectOnsetMs: 2000,
  permissionOnsetMs: 1000,
  /** Any non-live camera period at least this long triggers a camera_reconnect identity sample. */
  reconnectSampleMinMs: 1000,
  lowFps: 1.5,
  lowFpsOnsetMs: 15000,
  /** Identity samples need a roughly frontal face (server quality gate rejects |yaw| > 25°). */
  identityMaxYawOffset: 22,
  identityMaxPitchOffset: 22,
  /** Min interval between 'update' emissions for material detail changes. */
  minUpdateMs: 10000,
  peakSpacingMs: 3000,
} as const;

export const DEFAULT_BASELINE: Baseline = { yaw: 0, pitch: 0, cx: 0.5, cy: 0.45, faceWidth: 0.3, luma: 0, dhash: '', capturedAt: 0, samples: 0 };

/** Per-tick derived view shared by all detectors. */
export interface TickContext {
  t: number;
  obs: FrameObservation;
  camera: CameraState;
  live: boolean;
  frame: FrameMetrics | null;
  covered: boolean;
  frameDark: boolean;
  frameBright: boolean;
  faceDark: boolean;
  faceBright: boolean;
  /** Frame or face too dark/bright (and not covered). */
  lightingBad: boolean;
  frozenRaw: boolean;
  /** camera_frozen is confirmed (episode open). */
  frozenActive: boolean;
  /** Camera live, a frame is available, not covered, not frozen: behavioural detectors may run. */
  visionOk: boolean;
  faces: FaceObservation[];
  faceCount: number;
  primary: FaceObservation | null;
  /** Primary face pose/gaze can be trusted (not cut off, visibility OK). */
  primaryAssessable: boolean;
  objectsRan: boolean;
  objects: ObjectObservation[] | null;
  /** Distinct 'person' boxes on this tick (null if the object detector did not run). */
  persons: number | null;
  /** Latest person count from an object tick no older than personCountFreshMs (null if none). */
  personsFresh: number | null;
  /** A 'person' was seen by the object detector within personVisibleFreshMs. */
  personVisible: boolean;
  /** Effective horizontal / vertical attention angles relative to baseline (deg). */
  h: number;
  v: number;
  yawOff: number;
  pitchOff: number;
  away: boolean | null;
  direction: GazeDirection | null;
  baseline: Baseline;
  fps: number;
}

export interface DetectorHost {
  policy: DetectionPolicy;
  book: EpisodeBook;
  prompts: PromptManager;
  identity: IdentityScheduler;
  episodes: EpisodeUpdate[];
  signals: EngineSignal[];
}

export function iou(a: NormBox, b: NormBox): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}

function centreInside(a: NormBox, b: NormBox): boolean {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
}

function validFace(f: FaceObservation | null | undefined): f is FaceObservation {
  return (
    !!f &&
    !!f.box &&
    [f.box.x, f.box.y, f.box.w, f.box.h, f.yaw, f.pitch, f.score].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    f.box.w > 0 &&
    f.box.h > 0
  );
}

/**
 * Plausible, de-duplicated faces, largest first. A face must have score ≥ 0.5 and width ≥ 3.5% of the
 * frame; overlapping duplicates (IoU > 0.4 or centre inside a larger face) are dropped.
 */
export function plausibleFaces(faces: readonly FaceObservation[] | null | undefined): FaceObservation[] {
  const list = (faces ?? []).filter(validFace).filter((f) => f.score >= K.faceMinScore && f.box.w >= K.faceMinWidth);
  list.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const kept: FaceObservation[] = [];
  for (const f of list) {
    if (kept.some((k) => iou(f.box, k.box) > 0.4 || centreInside(f.box, k.box))) continue;
    kept.push(f);
  }
  return kept;
}

/** Distinct 'person' detections above `minScore` (overlapping duplicates merged). */
export function countPersons(objects: readonly ObjectObservation[], minScore: number): number {
  const persons = objects
    .filter((o) => o && o.label === 'person' && Number.isFinite(o.score) && o.score >= minScore)
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const kept: ObjectObservation[] = [];
  for (const p of persons) {
    // A box mostly inside another person box (e.g. head/torso sub-detection) is the same person.
    if (kept.some((k) => iou(p.box, k.box) > 0.5 || containment(p.box, k.box) > 0.8)) continue;
    kept.push(p);
  }
  return kept.length;
}

function containment(inner: NormBox, outer: NormBox): number {
  const x0 = Math.max(inner.x, outer.x);
  const y0 = Math.max(inner.y, outer.y);
  const x1 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const y1 = Math.min(inner.y + inner.h, outer.y + outer.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const a = inner.w * inner.h;
  return a > 0 ? inter / a : 0;
}

function deadzone(g: number): number {
  if (!Number.isFinite(g)) return 0;
  const a = Math.abs(g) - K.gazeDeadzone;
  return a > 0 ? Math.sign(g) * a : 0;
}

/** Effective attention angles: head pose offset from baseline plus eye gaze (dead-zoned). */
export function attentionAngles(face: FaceObservation, baseline: Baseline): { h: number; v: number; yawOff: number; pitchOff: number } {
  const yawOff = face.yaw - baseline.yaw;
  const pitchOff = face.pitch - baseline.pitch;
  return { h: yawOff + deadzone(face.gazeX) * K.gazeXDeg, v: pitchOff + deadzone(face.gazeY) * K.gazeYDeg, yawOff, pitchOff };
}

export interface AwayThresholds {
  yaw: number;
  down: number;
  up: number;
}

export function awayThresholds(p: DetectionPolicy): AwayThresholds {
  return { yaw: p.lookAwayYawDeg, down: p.lookDownPitchDeg, up: p.lookDownPitchDeg + K.upExtraDeg };
}

export function isAway(h: number, v: number, th: AwayThresholds): boolean {
  return Math.abs(h) >= th.yaw || v <= -th.down || v >= th.up;
}

const SECTORS: GazeDirection[] = ['right', 'down_right', 'down', 'down_left', 'left', 'up_left', 'up', 'up_right', 'right'];

/**
 * 8-way direction bucket of an attention vector, from the CANDIDATE's perspective ('left' = the
 * candidate's left). Axes are normalised by their thresholds so diagonals mean "comparably far on both".
 */
export function directionOf(h: number, v: number, th: AwayThresholds): GazeDirection {
  return directionOfAngle(attentionAngle(h, v, th));
}

/** Angle (deg) of the threshold-normalised attention vector: 0 = left, 90 = up, ±180 = right, −90 = down. */
export function attentionAngle(h: number, v: number, th: AwayThresholds): number {
  const x = h / th.yaw;
  const y = v / (v < 0 ? th.down : th.up);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function directionOfAngle(angDeg: number): GazeDirection {
  const a = ((((angDeg + 180) % 360) + 360) % 360) - 180;
  const idx = Math.round(a / 45) + 4; // 0..8 (−180° → 0, 0° → 4, 180° → 8)
  return SECTORS[Math.max(0, Math.min(8, idx))];
}

/** Smallest absolute difference between two angles (deg). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Circular mean of angles (deg). */
export function meanAngle(angles: readonly number[]): number {
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos((a * Math.PI) / 180);
    y += Math.sin((a * Math.PI) / 180);
  }
  return (Math.atan2(y, x) * 180) / Math.PI;
}

const DIRECTION_TEXT: Record<GazeDirection, string> = {
  left: 'toward the candidate’s left',
  right: 'toward the candidate’s right',
  up: 'upward',
  down: 'downward',
  down_left: 'downward and to the candidate’s left',
  down_right: 'downward and to the candidate’s right',
  up_left: 'upward and to the candidate’s left',
  up_right: 'upward and to the candidate’s right',
};

export function directionText(d: GazeDirection): string {
  return DIRECTION_TEXT[d];
}
