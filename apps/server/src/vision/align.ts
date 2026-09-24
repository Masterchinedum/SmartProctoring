/**
 * Five-point face alignment to the 112x112 ArcFace template used by SFace.
 *
 * A 2-D similarity transform (uniform scale + rotation + translation, never a reflection) is fitted by
 * least squares from the detected landmarks to the template, then the crop is produced by inverse
 * mapping every output pixel into the source image with bilinear interpolation (constant black border,
 * as the reference OpenCV pipeline does).
 */
import type { Point } from './types';
import type { RgbImage } from './image';

export const ALIGNED_SIZE = 112;

/** ArcFace 5-point template for a 112x112 crop: left eye, right eye (image left/right), nose, mouth L, mouth R. */
export const ARCFACE_TEMPLATE_112: readonly Point[] = Object.freeze([
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
]);

/** x' = a*x - b*y + tx ;  y' = b*x + a*y + ty   (scale = hypot(a, b), angle = atan2(b, a)). */
export interface SimilarityTransform {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares similarity transform mapping `src[i]` onto `dst[i]`.
 *
 * With centred coordinates p = src - mean(src), q = dst - mean(dst), minimising
 * sum |[a -b; b a] p + t - q|^2 gives a = sum(p.q) / sum|p|^2, b = sum(p x q) / sum|p|^2 and
 * t = mean(dst) - [a -b; b a] mean(src). The [a -b; b a] parameterisation cannot represent a reflection.
 */
export function estimateSimilarityTransform(src: readonly Point[], dst: readonly Point[]): SimilarityTransform {
  const n = src.length;
  if (n < 2 || dst.length !== n) throw new Error('estimateSimilarityTransform: need >= 2 matching points');
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i].x;
    sy += src[i].y;
    dx += dst[i].x;
    dy += dst[i].y;
  }
  sx /= n;
  sy /= n;
  dx /= n;
  dy /= n;
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - sx;
    const py = src[i].y - sy;
    const qx = dst[i].x - dx;
    const qy = dst[i].y - dy;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  }
  if (norm < 1e-12) throw new Error('estimateSimilarityTransform: degenerate source points');
  const a = dot / norm;
  const b = cross / norm;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

export function applySimilarity(t: SimilarityTransform, p: Point): Point {
  return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty };
}

export function invertSimilarity(t: SimilarityTransform): SimilarityTransform {
  const d = t.a * t.a + t.b * t.b;
  if (d < 1e-18) throw new Error('invertSimilarity: singular transform');
  const a = t.a / d;
  const b = -t.b / d;
  return { a, b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) };
}

export interface AlignedFace {
  size: number;
  /** Planar RGB (3 x size x size), float 0..255 — the SFace input layout. */
  rgb: Float32Array;
  /** Luminance (size x size), float 0..255. */
  gray: Float32Array;
  /** 1 where the output pixel maps inside the source image, 0 where it fell on the border. */
  valid: Uint8Array;
  /** Transform used (source image -> crop). */
  transform: SimilarityTransform;
}

/**
 * Warp the face into the 112x112 template frame. `landmarks` are in `img` pixel coordinates
 * (pixel centres at integer coordinates, matching the detector output).
 */
export function alignFace(img: RgbImage, landmarks: readonly Point[], size = ALIGNED_SIZE): AlignedFace {
  const template = size === ALIGNED_SIZE ? ARCFACE_TEMPLATE_112 : ARCFACE_TEMPLATE_112.map((p) => ({ x: (p.x * size) / ALIGNED_SIZE, y: (p.y * size) / ALIGNED_SIZE }));
  const fwd = estimateSimilarityTransform(landmarks, template);
  return warpSimilarity(img, fwd, size);
}

/** Produce the `size`x`size` crop for a source->crop transform using inverse bilinear sampling. */
export function warpSimilarity(img: RgbImage, fwd: SimilarityTransform, size = ALIGNED_SIZE): AlignedFace {
  const inv = invertSimilarity(fwd);
  const { data, width: w, height: h } = img;
  const plane = size * size;
  const rgb = new Float32Array(3 * plane);
  const gray = new Float32Array(plane);
  const valid = new Uint8Array(plane);
  const stride = w * 3;
  for (let v = 0; v < size; v++) {
    // Source position of (0, v) and per-u increments (the map is affine).
    let x = inv.b * -v + inv.tx; // inv.a*0 - inv.b*v + tx
    let y = inv.a * v + inv.ty; // inv.b*0 + inv.a*v + ty
    const stepX = inv.a;
    const stepY = inv.b;
    for (let u = 0; u < size; u++, x += stepX, y += stepY) {
      const o = v * size + u;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h) {
        const p00 = y0 * stride + x0 * 3;
        const p01 = p00 + 3;
        const p10 = p00 + stride;
        const p11 = p10 + 3;
        const w00 = (1 - fx) * (1 - fy);
        const w01 = fx * (1 - fy);
        const w10 = (1 - fx) * fy;
        const w11 = fx * fy;
        r = w00 * data[p00] + w01 * data[p01] + w10 * data[p10] + w11 * data[p11];
        g = w00 * data[p00 + 1] + w01 * data[p01 + 1] + w10 * data[p10 + 1] + w11 * data[p11 + 1];
        b = w00 * data[p00 + 2] + w01 * data[p01 + 2] + w10 * data[p10 + 2] + w11 * data[p11 + 2];
        valid[o] = 1;
      } else if (x > -1 && y > -1 && x < w && y < h) {
        // Border: accumulate only the neighbours that exist (constant 0 outside).
        for (let k = 0; k < 4; k++) {
          const xx = x0 + (k & 1);
          const yy = y0 + (k >> 1);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const wt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
          const p = yy * stride + xx * 3;
          r += wt * data[p];
          g += wt * data[p + 1];
          b += wt * data[p + 2];
        }
        valid[o] = x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1 ? 1 : 0;
      }
      rgb[o] = r;
      rgb[plane + o] = g;
      rgb[2 * plane + o] = b;
      gray[o] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  return { size, rgb, gray, valid, transform: fwd };
}
