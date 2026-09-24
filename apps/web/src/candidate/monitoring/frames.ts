import { rgbaToGray } from '@sp/detection';
import type { NormBox } from '@sp/shared';

/**
 * Canvas helpers. Nothing we analyse or upload is mirrored (previews are mirrored with CSS only).
 *
 *  - GraySampler: small 160×120 grayscale frame for frame metrics (dHash, luma, sharpness) and the swap
 *    triggers' appearance patch.
 *  - AnalysisFrame: the video downscaled to ≤ 640 px (aspect ratio kept) for MediaPipe — the camera runs at
 *    up to 1280×720 for identity evidence, analysis does not need that.
 *  - captureFaceCrop: identity evidence (check frames, identity samples) at the camera's NATIVE resolution:
 *    a square, face-centred crop (~2.4× the face box, ≤ 720 px, JPEG 0.92); the full frame when no face box.
 *  - captureJpeg: event screenshots (full frame, ≤ 640×480).
 */

export const ANALYSIS_WIDTH = 160;
export const ANALYSIS_HEIGHT = 120;
/** Longest side of the frame MediaPipe analyses. */
export const ANALYSIS_MAX_SIDE = 640;

/** Identity evidence: crop side = FACE_CROP_SCALE × the larger face-box side, at most FACE_CROP_MAX px. */
export const FACE_CROP_SCALE = 2.4;
export const FACE_CROP_MAX = 720;
export const FACE_CROP_QUALITY = 0.92;
/** Without a face box the whole frame is sent, at most this size (keeps uploads well under the 1 MB limit). */
export const FULL_FRAME_MAX = 1280;

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

type Ctx2d = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

function make2d(w: number, h: number, readback = true): Ctx2d | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: readback, alpha: false }) as CanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx } : null;
}

/** Gray frame size for a vw×vh source: 160 px wide, the source's aspect ratio (160×120 for 4:3, 160×90 for 16:9). */
export function graySize(vw: number, vh: number): { width: number; height: number } {
  if (!vw || !vh) return { width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT };
  return { width: ANALYSIS_WIDTH, height: Math.max(60, Math.min(160, Math.round((ANALYSIS_WIDTH * vh) / vw))) };
}

/** Reusable sampler producing a small (160 px wide, aspect kept) grayscale frame from the video or a canvas. */
export class GraySampler {
  private c: Ctx2d | null | undefined;

  sample(source: HTMLVideoElement | HTMLCanvasElement): GrayFrame | null {
    const size = sourceSize(source);
    if (!size) return null;
    const { width, height } = graySize(size.w, size.h);
    if (this.c === undefined) this.c = make2d(width, height);
    if (!this.c) return null;
    const { canvas, ctx } = this.c;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      ctx.drawImage(source, 0, 0, width, height);
      const img = ctx.getImageData(0, 0, width, height);
      return { data: rgbaToGray(img.data, width, height), width, height };
    } catch {
      return null;
    }
  }
}

/** Size of the analysis frame for a video of vw×vh: ≤ maxSide on the longer side, aspect kept, never upscaled. */
export function analysisSize(vw: number, vh: number, maxSide = ANALYSIS_MAX_SIDE): { width: number; height: number } {
  if (!vw || !vh) return { width: 640, height: 480 };
  const s = Math.min(1, maxSide / Math.max(vw, vh));
  return { width: Math.max(2, Math.round(vw * s)), height: Math.max(2, Math.round(vh * s)) };
}

/**
 * The current video frame downscaled for analysis. Because the aspect ratio is kept, normalised
 * coordinates found on it (face boxes) are valid on the full-resolution video as well.
 */
export class AnalysisFrame {
  private c: Ctx2d | null | undefined;

  /** Draw the current frame (of the video or a HeldFrame); returns the canvas, or null when no frame is available. */
  draw(source: HTMLVideoElement | HTMLCanvasElement): HTMLCanvasElement | null {
    const size = sourceSize(source);
    if (!size) return null;
    const { width, height } = analysisSize(size.w, size.h);
    if (this.c === undefined) this.c = make2d(width, height, false);
    if (!this.c) return null;
    const { canvas, ctx } = this.c;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      ctx.drawImage(source, 0, 0, width, height);
      return canvas;
    } catch {
      return null;
    }
  }

  get canvas(): HTMLCanvasElement | null {
    return this.c?.canvas ?? null;
  }
}

/** Byte-wise equality of two frames (a camera delivering fewer frames than we sample yields exact duplicates). */
export function sameFrame(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Target size for a snapshot: fit inside maxW×maxH keeping the camera's aspect ratio. */
export function fitSize(vw: number, vh: number, maxW: number, maxH: number): { width: number; height: number } {
  if (!vw || !vh) return { width: maxW, height: maxH };
  const s = Math.min(maxW / vw, maxH / vh, 1);
  return { width: Math.max(2, Math.round(vw * s)), height: Math.max(2, Math.round(vh * s)) };
}

export interface CropRect {
  /** Source rectangle on the full-resolution frame (pixels). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output size (pixels). */
  width: number;
  height: number;
  /** True when this is a face-centred crop (false: whole frame). */
  face: boolean;
}

/**
 * Face-centred square crop on a vw×vh frame: side = scale × the larger face-box side (pixels), clamped to
 * the frame's shorter side and shifted to stay inside the frame; output ≤ maxSide (never upscaled). Without a
 * usable box: the whole frame, ≤ fullMax on the longer side.
 */
export function faceCropRect(
  box: NormBox | null | undefined,
  vw: number,
  vh: number,
  opts: { scale?: number; maxSide?: number; fullMax?: number } = {},
): CropRect {
  const scale = opts.scale ?? FACE_CROP_SCALE;
  const maxSide = opts.maxSide ?? FACE_CROP_MAX;
  const fullMax = opts.fullMax ?? FULL_FRAME_MAX;
  const valid = !!box && [box.x, box.y, box.w, box.h].every(Number.isFinite) && box.w > 0 && box.h > 0 && vw > 0 && vh > 0;
  if (!valid) {
    const f = fitSize(vw, vh, fullMax, fullMax);
    return { sx: 0, sy: 0, sw: vw, sh: vh, width: f.width, height: f.height, face: false };
  }
  const b = box!;
  const faceSide = Math.max(b.w * vw, b.h * vh);
  const side = Math.max(2, Math.min(Math.min(vw, vh), faceSide * scale));
  const cx = (b.x + b.w / 2) * vw;
  const cy = (b.y + b.h / 2) * vh;
  const sx = Math.max(0, Math.min(vw - side, cx - side / 2));
  const sy = Math.max(0, Math.min(vh - side, cy - side / 2));
  const out = Math.max(2, Math.round(Math.min(side, maxSide)));
  return { sx: Math.round(sx), sy: Math.round(sy), sw: Math.round(side), sh: Math.round(side), width: out, height: out, face: true };
}

/**
 * A copy of one video frame at native resolution. Analysing a downscaled copy of it and cropping the identity
 * evidence from it guarantees both come from the SAME camera frame (the video may advance meanwhile).
 */
export class HeldFrame {
  private c: Ctx2d | null | undefined;

  capture(video: HTMLVideoElement): HTMLCanvasElement | null {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (this.c === undefined) this.c = make2d(w, h, false);
    if (!this.c) return null;
    const { canvas, ctx } = this.c;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    try {
      ctx.drawImage(video, 0, 0, w, h);
      return canvas;
    } catch {
      return null;
    }
  }
}

function sourceSize(src: HTMLVideoElement | HTMLCanvasElement): { w: number; h: number } | null {
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth ? { w: src.videoWidth, h: src.videoHeight } : null;
  return src.width > 0 && src.height > 0 ? { w: src.width, h: src.height } : null;
}

let cropCanvas: Ctx2d | null = null;

/**
 * JPEG of the current (un-mirrored) video frame — or of a HeldFrame — at native resolution, cropped around
 * `box` (see faceCropRect). Returns null when no frame is available.
 */
export async function captureFaceCrop(
  source: HTMLVideoElement | HTMLCanvasElement,
  box: NormBox | null | undefined,
  quality = FACE_CROP_QUALITY,
): Promise<{ blob: Blob; rect: CropRect } | null> {
  const size = sourceSize(source);
  if (!size) return null;
  const rect = faceCropRect(box, size.w, size.h);
  if (!cropCanvas) cropCanvas = make2d(rect.width, rect.height, false);
  if (!cropCanvas) return null;
  const { canvas, ctx } = cropCanvas;
  if (canvas.width !== rect.width) canvas.width = rect.width;
  if (canvas.height !== rect.height) canvas.height = rect.height;
  try {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.width, rect.height);
  } catch {
    return null;
  }
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
  return blob ? { blob, rect } : null;
}

let snapCanvas: Ctx2d | null = null;

/**
 * JPEG snapshot of the current (un-mirrored) video frame, at most 640×480 (event screenshots).
 * Returns null when no frame is available.
 */
export async function captureJpeg(video: HTMLVideoElement, quality = 0.85, maxW = 640, maxH = 480): Promise<Blob | null> {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const { width, height } = fitSize(video.videoWidth, video.videoHeight, maxW, maxH);
  if (!snapCanvas) snapCanvas = make2d(width, height);
  if (!snapCanvas) return null;
  const { canvas, ctx } = snapCanvas;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
    } catch {
      resolve(null);
    }
  });
}
