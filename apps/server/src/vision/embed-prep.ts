/**
 * Pre-processing of the aligned 112x112 face crop before SFace, and the embedding "recipes" (which views
 * are embedded and averaged). See docs/accuracy/identity-v2.md for the measurements behind the default.
 *
 *   illumination normalisation (`normalize`):
 *     'none'     the crop as sampled (SFace's native input, embedding model id 1)
 *     'stretch'  grey-world white balance + robust luma contrast stretch (1st..99th percentile of the inner
 *                face region -> 16..240), a single affine map per channel (keeps skin-tone ratios)
 *     'gamma'    'stretch' preceded by a gamma that moves the face-region median luma to 118
 *     'clahe'    contrast-limited adaptive histogram equalisation of luma (4x4 tiles, clip 2.5), applied as
 *                a per-pixel luma gain to R, G, B
 *     'denoise'  3x3 binomial smoothing only
 *     'denoise-stretch'  3x3 binomial denoise, then 'stretch' with the contrast gain capped at 2.5
 *     'soft'     3x3 binomial denoise, grey world, gamma to median 118, contrast gain capped at 2
 *   test-time augmentation: `flip` also embeds the horizontally mirrored crop; the recipe's embedding is
 *   normalize(sum of the views' unit embeddings).
 */
import type { AlignedFace } from './align';

export type IlluminationNormalization = 'none' | 'stretch' | 'gamma' | 'clahe' | 'denoise' | 'denoise-stretch' | 'soft';

export interface EmbeddingRecipe {
  id: string;
  normalize: IlluminationNormalization;
  flip: boolean;
  /** Different preprocessing for frames in the 'poor' quality bucket (calibration.ts `qualityBucket`). */
  poor?: { normalize: IlluminationNormalization; flip: boolean };
}

/** Recipe of embedding model id 1 (the original pipeline): raw crop, single view. */
export const RECIPE_V1: Readonly<EmbeddingRecipe> = Object.freeze({ id: 'v1-raw', normalize: 'none', flip: false });

/**
 * Recipe of embedding model id 2 (identity v2), measured on the webcam simulator (docs/accuracy/identity-v2.md §5):
 *  - good / fair frames: raw crop + its mirror image, normalize(e(x) + e(flip x)). Flip TTA separates genuine from
 *    impostor slightly better (d' +0.03..0.07, EER in fair light 0.34 % -> 0.30 %) at the cost of a second SFace run.
 *    Every photometric normalisation tried (grey-world + stretch, gamma, CLAHE) made SFace worse in good light.
 *  - poor frames (dim, flat, backlit, low detector score): a 3x3 binomial denoise of the aligned crop, single view.
 *    Sensor noise, not contrast, is what hurts SFace there: poor-bucket EER vs impostors 10.6 % -> 8.0 %, d'
 *    2.56 -> 2.84, with good-light galleries unchanged (flip TTA did not help poor frames).
 */
export const RECIPE_V2: Readonly<EmbeddingRecipe> = Object.freeze({
  id: 'v2',
  normalize: 'none',
  flip: true,
  poor: Object.freeze({ normalize: 'denoise', flip: false }),
});

/** Inner face region of the 112x112 template used for statistics (eyes, nose, mouth, cheeks). */
const R_X0 = 24;
const R_X1 = 88;
const R_Y0 = 36;
const R_Y1 = 104;

function lumaAt(rgb: Float32Array, plane: number, i: number): number {
  return 0.299 * rgb[i] + 0.587 * rgb[plane + i] + 0.114 * rgb[2 * plane + i];
}

/** Percentile of values (in place sort of a copy). */
function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

function regionStats(face: AlignedFace): { lumas: Float32Array; mean: [number, number, number] } {
  const { rgb, valid, size } = face;
  const plane = size * size;
  const sc = size / 112;
  const x0 = Math.round(R_X0 * sc);
  const x1 = Math.round(R_X1 * sc);
  const y0 = Math.round(R_Y0 * sc);
  const y1 = Math.round(R_Y1 * sc);
  const l: number[] = [];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * size + x;
      if (!valid[i]) continue;
      l.push(lumaAt(rgb, plane, i));
      r += rgb[i];
      g += rgb[plane + i];
      b += rgb[2 * plane + i];
    }
  }
  const n = Math.max(1, l.length);
  const lumas = Float32Array.from(l).sort();
  return { lumas, mean: [r / n, g / n, b / n] };
}

/**
 * Grey-world white balance (gains limited to [0.75, 1.33]) + robust luma stretch, optionally after a gamma
 * that brings the median face luma to 118. Returns a new planar RGB buffer (0..255).
 */
function stretch(face: AlignedFace, withGamma: boolean, maxGain = 4): Float32Array {
  const { rgb, size } = face;
  const plane = size * size;
  const out = new Float32Array(rgb.length);
  const { mean } = regionStats(face);
  const grey = (mean[0] + mean[1] + mean[2]) / 3;
  const gains = mean.map((m) => (m > 1 ? Math.min(1.33, Math.max(0.75, grey / m)) : 1));
  for (let c = 0; c < 3; c++) {
    const g = gains[c];
    for (let i = 0; i < plane; i++) out[c * plane + i] = Math.min(255, rgb[c * plane + i] * g);
  }
  let gamma = 1;
  if (withGamma) {
    const st = regionStats({ ...face, rgb: out });
    const med = percentile(st.lumas, 0.5);
    if (med > 2 && med < 253) gamma = Math.min(2.2, Math.max(0.45, Math.log(118 / 255) / Math.log(med / 255)));
    if (Math.abs(gamma - 1) > 1e-3) for (let i = 0; i < out.length; i++) out[i] = 255 * Math.pow(out[i] / 255, gamma);
  }
  const st = regionStats({ ...face, rgb: out });
  const lo = percentile(st.lumas, 0.01);
  const hi = percentile(st.lumas, 0.99);
  const span = hi - lo;
  if (span < 4) return out;
  // Do not amplify more than 4x (noise) nor compress a face that already spans the range.
  const a = Math.min(maxGain, Math.max(1, (240 - 16) / span));
  const mid = (lo + hi) / 2;
  for (let i = 0; i < out.length; i++) {
    const v = 128 + (out[i] - mid) * a;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/** CLAHE on luma (tiles x tiles, clip limit relative to the uniform bin height), applied as a luma gain. */
function clahe(face: AlignedFace, tiles = 4, clip = 2.5): Float32Array {
  const { rgb, size } = face;
  const plane = size * size;
  const lum = new Float32Array(plane);
  for (let i = 0; i < plane; i++) lum[i] = lumaAt(rgb, plane, i);
  const bins = 64;
  const ts = size / tiles;
  const maps: Float32Array[] = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const hist = new Float32Array(bins);
      let n = 0;
      for (let y = Math.floor(ty * ts); y < Math.floor((ty + 1) * ts); y++) {
        for (let x = Math.floor(tx * ts); x < Math.floor((tx + 1) * ts); x++) {
          hist[Math.min(bins - 1, Math.floor((lum[y * size + x] / 256) * bins))]++;
          n++;
        }
      }
      const limit = Math.max(1, (clip * n) / bins);
      let excess = 0;
      for (let b = 0; b < bins; b++) {
        if (hist[b] > limit) {
          excess += hist[b] - limit;
          hist[b] = limit;
        }
      }
      const add = excess / bins;
      const map = new Float32Array(bins);
      let acc = 0;
      for (let b = 0; b < bins; b++) {
        acc += hist[b] + add;
        map[b] = (acc / Math.max(1, n)) * 255;
      }
      maps.push(map);
    }
  }
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < size; y++) {
    const gy = Math.min(tiles - 1, Math.max(0, (y + 0.5) / ts - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(tiles - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < size; x++) {
      const gx = Math.min(tiles - 1, Math.max(0, (x + 0.5) / ts - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(tiles - 1, x0 + 1);
      const fx = gx - x0;
      const i = y * size + x;
      const b = Math.min(bins - 1, Math.floor((lum[i] / 256) * bins));
      const v =
        (1 - fy) * ((1 - fx) * maps[y0 * tiles + x0][b] + fx * maps[y0 * tiles + x1][b]) + fy * ((1 - fx) * maps[y1 * tiles + x0][b] + fx * maps[y1 * tiles + x1][b]);
      const gain = lum[i] > 1 ? Math.min(6, v / lum[i]) : 1;
      for (let c = 0; c < 3; c++) out[c * plane + i] = Math.min(255, rgb[c * plane + i] * gain);
    }
  }
  return out;
}

/** 3x3 binomial smoothing of a planar RGB crop (border pixels copied). */
function binomial(face: AlignedFace): Float32Array {
  const { rgb, size } = face;
  const plane = size * size;
  const out = Float32Array.from(rgb);
  for (let c = 0; c < 3; c++) {
    const b = c * plane;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = b + y * size + x;
        out[i] =
          (4 * rgb[i] + 2 * (rgb[i - 1] + rgb[i + 1] + rgb[i - size] + rgb[i + size]) + rgb[i - size - 1] + rgb[i - size + 1] + rgb[i + size - 1] + rgb[i + size + 1]) / 16;
      }
    }
  }
  return out;
}

/** The SFace input (planar RGB 0..255) for a normalisation mode. */
export function normalizedInput(face: AlignedFace, mode: IlluminationNormalization): Float32Array {
  switch (mode) {
    case 'none':
      return face.rgb;
    case 'stretch':
      return stretch(face, false);
    case 'gamma':
      return stretch(face, true);
    case 'clahe':
      return clahe(face);
    case 'denoise':
      return binomial(face);
    case 'denoise-stretch':
      return stretch({ ...face, rgb: binomial(face) }, false, 2.5);
    case 'soft':
      return stretch({ ...face, rgb: binomial(face) }, true, 2);
  }
}

/** Horizontally mirrored planar RGB crop. */
export function flipPlanar(input: Float32Array, size: number): Float32Array {
  const out = new Float32Array(input.length);
  const plane = size * size;
  for (let c = 0; c < 3; c++) {
    const base = c * plane;
    for (let y = 0; y < size; y++) {
      const row = base + y * size;
      for (let x = 0; x < size; x++) out[row + x] = input[row + size - 1 - x];
    }
  }
  return out;
}

/** Views (SFace inputs) to embed for a recipe (pass `recipe.poor` for a poor-quality frame when it is set). */
export function recipeViews(face: AlignedFace, recipe: Pick<EmbeddingRecipe, 'normalize' | 'flip'>): Float32Array[] {
  const base = normalizedInput(face, recipe.normalize);
  return recipe.flip ? [base, flipPlanar(base, face.size)] : [base];
}

/** L2-normalise in place and return. */
export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** normalize(sum of unit vectors). */
export function combineViews(unitViews: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(unitViews[0].length);
  for (const v of unitViews) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return l2normalize(out);
}
