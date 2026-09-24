/**
 * YuNet (face_detection_yunet_2023mar, MIT) pre/post-processing.
 *
 * Input: 1x3x640x640 float32, BGR planar, 0..255, image letterboxed into the top-left corner (zero pad).
 * Outputs per stride s in {8,16,32} with (640/s)^2 anchor-free cells, row-major:
 *   cls_s [1,N,1], obj_s [1,N,1], bbox_s [1,N,4] (dx, dy, log w, log h in stride units),
 *   kps_s [1,N,10] (5 landmark offsets in stride units, relative to the cell origin).
 */
import type { DetectedFace, Point } from './types';
import type { RgbImage } from './image';

export const YUNET_INPUT_SIZE = 640;
export const YUNET_STRIDES = [8, 16, 32] as const;
export const DEFAULT_DETECT_THRESHOLD = 0.6;
export const DEFAULT_NMS_IOU = 0.3;
/** Upper bound on candidates entering NMS (the model yields a handful above threshold in practice). */
const MAX_CANDIDATES = 2000;

export interface RawDetection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 5 landmarks, x0,y0,...,x4,y4 */
  kps: Float64Array;
}

/**
 * Pack an RGB image (max side <= `size`) into a BGR planar float tensor of size x size, placed in the
 * top-left corner with zero padding. `out` (if given, length 3*size*size) is fully overwritten, so
 * buffers can be reused without clearing.
 */
export function packBgrPlanar(img: RgbImage, size = YUNET_INPUT_SIZE, out?: Float32Array): Float32Array {
  const plane = size * size;
  const t = out && out.length === 3 * plane ? out : new Float32Array(3 * plane);
  const { data, width, height } = img;
  const w = Math.min(width, size);
  const h = Math.min(height, size);
  const r0 = 2 * plane;
  const g0 = plane;
  for (let y = 0; y < h; y++) {
    let s = y * width * 3;
    const rowStart = y * size;
    const rowEnd = rowStart + w;
    for (let o = rowStart; o < rowEnd; o++, s += 3) {
      t[r0 + o] = data[s];
      t[g0 + o] = data[s + 1];
      t[o] = data[s + 2];
    }
    if (w < size) {
      t.fill(0, rowEnd, rowStart + size);
      t.fill(0, g0 + rowEnd, g0 + rowStart + size);
      t.fill(0, r0 + rowEnd, r0 + rowStart + size);
    }
  }
  if (h < size) {
    t.fill(0, h * size, plane);
    t.fill(0, g0 + h * size, g0 + plane);
    t.fill(0, r0 + h * size, r0 + plane);
  }
  return t;
}

export interface TensorLike {
  data: unknown;
}

function f32(outputs: Record<string, TensorLike>, name: string): Float32Array {
  const t = outputs[name];
  if (!t || !(t.data instanceof Float32Array)) throw new Error(`YuNet output ${name} missing or not float32`);
  return t.data;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Decode raw YuNet outputs into detections (detector-input coordinates) with score >= threshold. */
export function decodeYuNet(outputs: Record<string, TensorLike>, threshold = DEFAULT_DETECT_THRESHOLD, size = YUNET_INPUT_SIZE): RawDetection[] {
  const dets: RawDetection[] = [];
  for (const s of YUNET_STRIDES) {
    const cols = Math.floor(size / s);
    const rows = Math.floor(size / s);
    const cls = f32(outputs, `cls_${s}`);
    const obj = f32(outputs, `obj_${s}`);
    const bbox = f32(outputs, `bbox_${s}`);
    const kps = f32(outputs, `kps_${s}`);
    const n = rows * cols;
    if (cls.length < n || obj.length < n || bbox.length < 4 * n || kps.length < 10 * n) {
      throw new Error(`YuNet output size mismatch at stride ${s}`);
    }
    for (let i = 0; i < n; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < threshold) continue;
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const cx = (c + bbox[4 * i]) * s;
      const cy = (r + bbox[4 * i + 1]) * s;
      const w = Math.exp(bbox[4 * i + 2]) * s;
      const h = Math.exp(bbox[4 * i + 3]) * s;
      const k = new Float64Array(10);
      for (let j = 0; j < 5; j++) {
        k[2 * j] = (kps[10 * i + 2 * j] + c) * s;
        k[2 * j + 1] = (kps[10 * i + 2 * j + 1] + r) * s;
      }
      dets.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, kps: k });
    }
  }
  return dets;
}

export function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS: keep highest-scoring boxes, drop any with IoU > iouThreshold against a kept box. */
export function nonMaxSuppression<T extends { x: number; y: number; w: number; h: number; score: number }>(dets: T[], iouThreshold = DEFAULT_NMS_IOU): T[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  const keep: T[] = [];
  for (const d of sorted) {
    let ok = true;
    for (const k of keep) {
      if (iou(k, d) > iouThreshold) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(d);
  }
  return keep;
}

/** Map detector-space detections to original-image coordinates (divide by the detector/original scale). */
export function toDetectedFaces(dets: RawDetection[], scaleX: number, scaleY = scaleX): DetectedFace[] {
  const ix = 1 / scaleX;
  const iy = 1 / scaleY;
  return dets.map((d) => {
    const lm: Point[] = [];
    for (let j = 0; j < 5; j++) lm.push({ x: d.kps[2 * j] * ix, y: d.kps[2 * j + 1] * iy });
    return {
      box: { x: d.x * ix, y: d.y * iy, w: d.w * ix, h: d.h * iy },
      score: d.score,
      landmarks: lm as DetectedFace['landmarks'],
    };
  });
}

/** Size the image must be resized to so its longer side equals the detector input (letterbox). */
export function planDetectorInput(width: number, height: number, size = YUNET_INPUT_SIZE): { resize: boolean; width: number; height: number } {
  const s = size / Math.max(width, height);
  const w = Math.max(1, Math.min(size, Math.round(width * s)));
  const h = Math.max(1, Math.min(size, Math.round(height * s)));
  return { resize: w !== width || h !== height, width: w, height: h };
}

/** Full post-processing: decode, NMS, map to original coordinates, primary first. */
export function decodeToDetectedFaces(
  outputs: Record<string, TensorLike>,
  threshold: number,
  scaleX: number,
  scaleY = scaleX,
  nmsIou = DEFAULT_NMS_IOU,
): DetectedFace[] {
  return sortFaces(toDetectedFaces(nonMaxSuppression(decodeYuNet(outputs, threshold), nmsIou), scaleX, scaleY));
}

/**
 * Order faces so the candidate's face comes first: rank = box area x score (a large, confident face
 * beats both a small background face and a large low-confidence false positive).
 */
export function sortFaces(faces: DetectedFace[]): DetectedFace[] {
  const rank = (f: DetectedFace) => f.box.w * f.box.h * f.score;
  return [...faces].sort((a, b) => rank(b) - rank(a));
}

/** Distance between the two eye landmarks. */
export function interEyeDistance(face: DetectedFace): number {
  const [a, b] = face.landmarks;
  return Math.hypot(b.x - a.x, b.y - a.y);
}
