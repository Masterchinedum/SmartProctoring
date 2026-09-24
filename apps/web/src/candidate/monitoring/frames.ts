import { rgbaToGray } from '@sp/detection';

/**
 * Canvas helpers: small grayscale frames for metrics and JPEG snapshots of the UN-MIRRORED camera
 * image (previews are mirrored with CSS only; nothing we analyse or upload is mirrored).
 */

export const ANALYSIS_WIDTH = 160;
export const ANALYSIS_HEIGHT = 120;

export interface GrayFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

function make2d(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false }) as CanvasRenderingContext2D | null;
  return ctx ? { canvas, ctx } : null;
}

/** Reusable sampler producing a 160×120 grayscale frame from the video. */
export class GraySampler {
  private c: ReturnType<typeof make2d> | undefined;

  sample(video: HTMLVideoElement): GrayFrame | null {
    if (video.readyState < 2 || !video.videoWidth) return null;
    if (this.c === undefined) this.c = make2d(ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    if (!this.c) return null;
    try {
      this.c.ctx.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
      const img = this.c.ctx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
      return { data: rgbaToGray(img.data, ANALYSIS_WIDTH, ANALYSIS_HEIGHT), width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT };
    } catch {
      return null;
    }
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

let snapCanvas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

/**
 * JPEG snapshot of the current (un-mirrored) video frame, at most 640×480.
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
