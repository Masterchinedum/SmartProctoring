import { poseFromFivePoints, type FaceObservation, type NormBox, type ObjectObservation, type Pt } from '@sp/shared';
import { regionStats } from '../metrics/frame';
import { clamp, clamp01 } from '../util/math';

/**
 * Adapters from MediaPipe Tasks results (FaceLandmarker, ObjectDetector) to the engine's
 * FrameObservation parts. Structural types only — this package never imports @mediapipe.
 *
 * The video must be analysed UN-MIRRORED (mirror only the preview element with CSS). Pose follows
 * POSE_CONVENTION (yaw+ = subject-left, pitch+ = up) via the shared poseFromFivePoints, i.e. exactly
 * the formula the server's liveness verifier uses on YuNet landmarks.
 */

export interface MpLandmark {
  x: number;
  y: number;
  z?: number;
}

export interface MpCategory {
  categoryName: string;
  score: number;
}

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

// 478-point Face Mesh (with iris refinement) indices.
const IRIS_RIGHT = 468; // subject's right iris centre (image-left in an un-mirrored frame)
const IRIS_LEFT = 473; // subject's left iris centre
const RIGHT_EYE_OUTER = 33;
const RIGHT_EYE_INNER = 133;
const LEFT_EYE_INNER = 362;
const LEFT_EYE_OUTER = 263;
/**
 * Nose point: landmark 4 (pronasale — the most anterior point of the nose on the canonical mesh), which is
 * what 5-point face annotations, and therefore YuNet on the server, call the "nose tip". Landmark 1 sits
 * ≈ 0.7 cm lower on the canonical mesh (y −1.13 vs −0.46, eye-to-mouth span 6.96); with it the shared
 * five-point formula reads pitch ≈ 20° lower than the server on the same frame (real-browser e2e:
 * frontal frames −27…−28° via landmark 1 vs −5…−9° from YuNet). With landmark 4 client and server
 * measure the same anatomical points, so client guidance and server liveness verification agree.
 */
const NOSE_TIP = 4;
const MOUTH_RIGHT = 61; // subject's right mouth corner
const MOUTH_LEFT = 291;

/** Face box extending past the frame edge by more than this fraction of its size counts as cut off. */
const CUTOFF_MARGIN = 0.08;

function valid(p: MpLandmark | undefined): p is MpLandmark {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function mid(a: MpLandmark, b: MpLandmark): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Five points [subject-right eye, subject-left eye, nose tip, subject-right mouth corner,
 * subject-left mouth corner] in normalized image coordinates — the same anatomical points YuNet
 * returns. Eyes: iris centres 468/473 when the mesh has iris refinement (478 points), otherwise
 * eye-corner midpoints 33/133 and 362/263. Nose: landmark 4 (pronasale, see NOSE_TIP). Mouth: 61/291.
 */
export function fivePointsFromMesh(landmarks: MpLandmark[]): Pt[] {
  const rEye =
    landmarks.length > IRIS_LEFT && valid(landmarks[IRIS_RIGHT])
      ? { x: landmarks[IRIS_RIGHT].x, y: landmarks[IRIS_RIGHT].y }
      : mid(landmarks[RIGHT_EYE_OUTER], landmarks[RIGHT_EYE_INNER]);
  const lEye =
    landmarks.length > IRIS_LEFT && valid(landmarks[IRIS_LEFT])
      ? { x: landmarks[IRIS_LEFT].x, y: landmarks[IRIS_LEFT].y }
      : mid(landmarks[LEFT_EYE_INNER], landmarks[LEFT_EYE_OUTER]);
  const nose = landmarks[NOSE_TIP];
  const mr = landmarks[MOUTH_RIGHT];
  const ml = landmarks[MOUTH_LEFT];
  return [rEye, lEye, { x: nose.x, y: nose.y }, { x: mr.x, y: mr.y }, { x: ml.x, y: ml.y }];
}

/**
 * Eye gaze relative to the head from ARKit-style blendshapes ("Left" = subject's left eye).
 *   gazeX (+ = toward subject-left) = ((eyeLookOutLeft + eyeLookInRight) − (eyeLookInLeft + eyeLookOutRight)) / 2
 *   gazeY (+ = up)                 = ((eyeLookUpLeft + eyeLookUpRight) − (eyeLookDownLeft + eyeLookDownRight)) / 2
 * Missing categories count as 0. Output clamped to −1..1.
 */
export function gazeFromBlendshapes(categories: MpCategory[]): { gazeX: number; gazeY: number } {
  const s: Record<string, number> = {};
  for (const c of categories) if (c && typeof c.categoryName === 'string' && Number.isFinite(c.score)) s[c.categoryName] = c.score;
  const g = (k: string) => s[k] ?? 0;
  const gazeX = (g('eyeLookOutLeft') + g('eyeLookInRight') - (g('eyeLookInLeft') + g('eyeLookOutRight'))) / 2;
  const gazeY = (g('eyeLookUpLeft') + g('eyeLookUpRight') - (g('eyeLookDownLeft') + g('eyeLookDownRight'))) / 2;
  return { gazeX: clamp(gazeX, -1, 1), gazeY: clamp(gazeY, -1, 1) };
}

/**
 * Convert FaceLandmarker output to FaceObservations.
 *
 * - box: landmark bounding box, clamped to [0,1].
 * - cutOff: the (unclamped) landmark box extends beyond an image edge by more than 8% of its size,
 *   or fewer than 90% of landmarks fall inside the image.
 * - visibility: fraction of landmarks inside [0,1]², multiplied by a face-region quality factor when
 *   `gray` is given (very dark / washed-out / flat / blurry face regions lower it).
 * - score: MediaPipe does not expose a per-face confidence; faces it returns already passed its
 *   presence threshold, so score = 0.55 + 0.4 × inFrameFraction × sizeFactor (tiny faces score lower).
 * - brightness: face-region mean luminance when `gray` is given.
 * - Pose is computed on pixel-scaled points (frame size from `frame`, else `gray`, else 4:3).
 */
export function facesFromMediapipe(
  result: { faceLandmarks: MpLandmark[][]; faceBlendshapes?: { categories: MpCategory[] }[] },
  gray?: GrayFrame | null,
  frame?: { width: number; height: number } | null,
): FaceObservation[] {
  const W = frame?.width || gray?.width || 640;
  const H = frame?.height || gray?.height || 480;
  const out: FaceObservation[] = [];
  const list = Array.isArray(result?.faceLandmarks) ? result.faceLandmarks : [];
  for (let i = 0; i < list.length; i++) {
    const lm = list[i];
    if (!Array.isArray(lm) || lm.length < 292) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let inside = 0;
    let n = 0;
    for (const p of lm) {
      if (!valid(p)) continue;
      n++;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) inside++;
    }
    if (n < 292 || !(maxX > minX) || !(maxY > minY)) continue;
    const five = fivePointsFromMesh(lm);
    if (!five.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    const pose = poseFromFivePoints(five.map((p) => ({ x: p.x * W, y: p.y * H })));
    const inFrame = inside / n;
    const bw = maxX - minX;
    const bh = maxY - minY;
    const outX = Math.max(0, -minX) + Math.max(0, maxX - 1);
    const outY = Math.max(0, -minY) + Math.max(0, maxY - 1);
    const cutOff = outX / bw > CUTOFF_MARGIN || outY / bh > CUTOFF_MARGIN || inFrame < 0.9;
    const x0 = clamp(minX, 0, 1);
    const y0 = clamp(minY, 0, 1);
    const box: NormBox = { x: round4(x0), y: round4(y0), w: round4(Math.max(0, clamp(maxX, 0, 1) - x0)), h: round4(Math.max(0, clamp(maxY, 0, 1) - y0)) };
    const blend = result.faceBlendshapes?.[i]?.categories;
    const gaze = blend && blend.length ? gazeFromBlendshapes(blend) : { gazeX: 0, gazeY: 0 };
    let visibility = inFrame;
    let brightness: number | undefined;
    if (gray && gray.data && gray.width > 0 && gray.height > 0 && box.w > 0 && box.h > 0) {
      const r = regionStats(gray.data, gray.width, gray.height, box);
      brightness = r.mean;
      visibility = inFrame * (0.2 + 0.8 * faceRegionQuality(r));
    }
    const sizeFactor = clamp01((bw - 0.02) / 0.08);
    const score = clamp01(0.55 + 0.4 * inFrame * sizeFactor);
    const face: FaceObservation = {
      box,
      score: round3(score),
      yaw: round3(pose.yawDeg),
      pitch: round3(pose.pitchDeg),
      roll: round3(pose.rollDeg),
      gazeX: round3(gaze.gazeX),
      gazeY: round3(gaze.gazeY),
      visibility: round3(clamp01(visibility)),
      cutOff,
    };
    if (brightness !== undefined) face.brightness = brightness;
    out.push(face);
  }
  return out;
}

/** 0..1 quality of a face region: 0 when very dark, blown out or featureless; blur reduces it. */
export function faceRegionQuality(r: { mean: number; std: number; sharpness: number }): number {
  const dark = clamp01((r.mean - 20) / 30);
  const bright = clamp01((250 - r.mean) / 20);
  const flat = clamp01((r.std - 4) / 10);
  const blur = clamp(0.5 + r.sharpness / 60, 0.5, 1);
  return Math.min(dark, bright, flat) * blur;
}

/**
 * Convert ObjectDetector output (pixel bounding boxes) to ObjectObservations with normalized boxes.
 * Each detection contributes its highest-scoring category; labels are lower-cased and trimmed
 * (COCO names such as 'cell phone', 'book', 'laptop', 'tv', 'person').
 */
export function objectsFromMediapipe(
  result: { detections: { categories: MpCategory[]; boundingBox?: { originX: number; originY: number; width: number; height: number } }[] },
  frameWidth: number,
  frameHeight: number,
): ObjectObservation[] {
  const out: ObjectObservation[] = [];
  const W = frameWidth > 0 ? frameWidth : 1;
  const H = frameHeight > 0 ? frameHeight : 1;
  for (const d of result?.detections ?? []) {
    let best: MpCategory | null = null;
    for (const c of d.categories ?? []) {
      if (!c || typeof c.categoryName !== 'string' || !Number.isFinite(c.score)) continue;
      if (!best || c.score > best.score) best = c;
    }
    if (!best) continue;
    const bb = d.boundingBox;
    let box: NormBox = { x: 0, y: 0, w: 0, h: 0 };
    if (bb && [bb.originX, bb.originY, bb.width, bb.height].every(Number.isFinite)) {
      const x0 = clamp(bb.originX / W, 0, 1);
      const y0 = clamp(bb.originY / H, 0, 1);
      const x1 = clamp((bb.originX + bb.width) / W, 0, 1);
      const y1 = clamp((bb.originY + bb.height) / H, 0, 1);
      box = { x: round4(x0), y: round4(y0), w: round4(Math.max(0, x1 - x0)), h: round4(Math.max(0, y1 - y0)) };
    }
    out.push({ label: best.categoryName.trim().toLowerCase(), score: round3(clamp01(best.score)), box });
  }
  return out;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
