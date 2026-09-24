import type { FrameMetrics, NormBox } from '@sp/shared';
import { dhash64 } from './hash';

/**
 * Whole-frame and region image statistics computed on a small grayscale (luminance) buffer.
 * The host downsizes the video frame (e.g. 160×120) with a canvas, reads RGBA, converts with
 * rgbaToGray and calls computeFrameMetrics once per analysed tick. Everything here is O(pixels) with
 * no allocation beyond the returned values.
 */

/** ITU-R BT.601 luma, integer approximation: (77R + 150G + 29B) / 256. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  const max = Math.min(n, rgba.length >> 2);
  for (let i = 0, j = 0; i < max; i++, j += 4) {
    out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  return out;
}

interface Stats {
  mean: number;
  std: number;
  sharpness: number;
}

/** Mean, std-dev and variance-of-Laplacian over the pixel rectangle [x0,x1)×[y0,y1). */
function rectStats(gray: Uint8Array, width: number, x0: number, y0: number, x1: number, y1: number): Stats {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return { mean: 0, std: 0, sharpness: 0 };
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y < y1; y++) {
    const off = y * width;
    for (let x = x0; x < x1; x++) {
      const v = gray[off + x];
      sum += v;
      sumSq += v * v;
    }
  }
  const n = w * h;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  // 4-neighbour Laplacian on interior pixels of the rectangle.
  let lSum = 0;
  let lSq = 0;
  let ln = 0;
  for (let y = y0 + 1; y < y1 - 1; y++) {
    const off = y * width;
    for (let x = x0 + 1; x < x1 - 1; x++) {
      const i = off + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      lSum += lap;
      lSq += lap * lap;
      ln++;
    }
  }
  const lMean = ln ? lSum / ln : 0;
  const sharpness = ln ? Math.max(0, lSq / ln - lMean * lMean) : 0;
  return { mean, std, sharpness };
}

/**
 * Whole-frame metrics. `prevGray` must be the previous analysed frame at the same resolution for
 * `diffFromPrev` (mean absolute pixel difference); otherwise diffFromPrev is null.
 */
export function computeFrameMetrics(gray: Uint8Array, width: number, height: number, prevGray?: Uint8Array | null): FrameMetrics {
  const n = width * height;
  if (n <= 0 || gray.length < n) {
    return { luma: 0, contrast: 0, sharpness: 0, dhash: '0000000000000000', diffFromPrev: null };
  }
  const s = rectStats(gray, width, 0, 0, width, height);
  let diffFromPrev: number | null = null;
  if (prevGray && prevGray.length >= n && prevGray !== gray) {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const x = gray[i] - prevGray[i];
      d += x < 0 ? -x : x;
    }
    diffFromPrev = d / n;
  }
  return {
    luma: round2(s.mean),
    contrast: round2(s.std),
    sharpness: round2(s.sharpness),
    dhash: dhash64(gray, width, height),
    diffFromPrev: diffFromPrev == null ? null : Math.round(diffFromPrev * 1000) / 1000,
  };
}

/** Mean / std-dev / Laplacian variance of a normalized box region (clamped to the image). */
export function regionStats(gray: Uint8Array, width: number, height: number, box: NormBox): { mean: number; std: number; sharpness: number } {
  if (width <= 0 || height <= 0 || gray.length < width * height) return { mean: 0, std: 0, sharpness: 0 };
  const x0 = clampInt(Math.floor(box.x * width), 0, width);
  const y0 = clampInt(Math.floor(box.y * height), 0, height);
  const x1 = clampInt(Math.ceil((box.x + box.w) * width), 0, width);
  const y1 = clampInt(Math.ceil((box.y + box.h) * height), 0, height);
  const s = rectStats(gray, width, x0, y0, x1, y1);
  return { mean: round2(s.mean), std: round2(s.std), sharpness: round2(s.sharpness) };
}

/**
 * Convenience for hosts: keeps the previous grayscale frame so diffFromPrev is computed automatically.
 * Call reset() when the camera restarts or changes resolution.
 */
export interface FrameMetricsTracker {
  next(gray: Uint8Array, width: number, height: number): FrameMetrics;
  reset(): void;
}

export function createFrameMetricsTracker(): FrameMetricsTracker {
  let prev: Uint8Array | null = null;
  let pw = 0;
  let ph = 0;
  return {
    next(gray, width, height) {
      const usePrev = prev && pw === width && ph === height ? prev : null;
      const m = computeFrameMetrics(gray, width, height, usePrev);
      // Copy: hosts commonly reuse the same buffer for every frame.
      prev = gray.slice(0, width * height);
      pw = width;
      ph = height;
      return m;
    },
    reset() {
      prev = null;
    },
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
