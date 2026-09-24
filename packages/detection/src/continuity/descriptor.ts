import type { FaceObservation, NormBox } from '@sp/shared';

/**
 * Compact, identity-agnostic face APPEARANCE descriptor for the in-browser swap triggers (track_break /
 * appearance_change, see engine/detectors/continuity.ts). It is not a face-recognition template and is never
 * sent anywhere: it only tells the host "the face in view just looked different from a moment ago", so the
 * host captures an identity sample for the server (which alone decides whether the person changed).
 *
 *  - patch: the inner face region of the small grayscale analysis frame, area-sampled to 16×16 and
 *    normalised to zero mean / unit variance (robust to global brightness and contrast changes);
 *  - geom:  scale-free ratios between facial landmarks of the face mesh (null when no mesh was given).
 *
 * Distances: patchDistance = 1 − normalised cross-correlation (0 identical … 2 inverted; different people in
 * the same seat typically ≥ ~0.2, the same person frame to frame ≤ ~0.05); geomDistance = mean |ln(ratio)|.
 */

export const PATCH_SIZE = 16;
/** Faces narrower than this many pixels on the gray frame give no patch (too little detail). */
export const PATCH_MIN_PX = 12;

export interface FaceDescriptor {
  /** PATCH_SIZE² values, zero mean / unit variance, row-major. */
  patch: Float32Array | null;
  /** Landmark ratios (see GEOMETRY_POINTS), or null. */
  geom: number[] | null;
}

/** A FaceObservation the host may annotate with an appearance descriptor (not part of traces). */
export type DescribedFace = FaceObservation & { descriptor?: FaceDescriptor | null };

export function descriptorOf(face: FaceObservation | null | undefined): FaceDescriptor | null {
  return (face as DescribedFace | null | undefined)?.descriptor ?? null;
}

/** Inner face region of a landmark box: drops most hair, ears and background at the sides. */
export function innerFaceRegion(box: NormBox): NormBox {
  return { x: box.x + box.w * 0.12, y: box.y + box.h * 0.08, w: box.w * 0.76, h: box.h * 0.86 };
}

/** Eye centres (normalised frame coordinates, either order) for a roll/scale-aligned patch. */
export interface EyePair {
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/**
 * Canonical face window for the aligned patch, in inter-ocular distances (IOD) around the eye midpoint with
 * the eye line horizontal: x ∈ [−1, 1] (cheek to cheek), y ∈ [−0.7, 1.5] (brows to below the mouth).
 */
export const ALIGNED_WINDOW = { x0: -1, x1: 1, y0: -0.7, y1: 1.5 } as const;

/**
 * 16×16 zero-mean / unit-variance appearance patch on a grayscale frame. With `eyes` (preferred) the patch
 * is sampled in a face-aligned frame (eye line horizontal, scaled by the inter-ocular distance), so head
 * roll, distance to the camera and position do not change it; otherwise the inner region of the face box
 * is area-sampled. Null when the face is too small on the frame or the patch is flat.
 */
export function facePatch(gray: Uint8Array, width: number, height: number, box: NormBox, eyes?: EyePair | null, size = PATCH_SIZE): Float32Array | null {
  if (!gray || width <= 0 || height <= 0) return null;
  if (eyes) return alignedPatch(gray, width, height, eyes, size);
  const r = innerFaceRegion(box);
  const x0 = Math.max(0, r.x * width);
  const y0 = Math.max(0, r.y * height);
  const x1 = Math.min(width, (r.x + r.w) * width);
  const y1 = Math.min(height, (r.y + r.h) * height);
  if (x1 - x0 < PATCH_MIN_PX || y1 - y0 < PATCH_MIN_PX) return null;
  const out = new Float32Array(size * size);
  const cw = (x1 - x0) / size;
  const ch = (y1 - y0) / size;
  for (let cy = 0; cy < size; cy++) {
    const sy0 = y0 + cy * ch;
    const sy1 = sy0 + ch;
    for (let cx = 0; cx < size; cx++) {
      const sx0 = x0 + cx * cw;
      const sx1 = sx0 + cw;
      let sum = 0;
      let n = 0;
      for (let y = Math.ceil(sy0 - 0.5); y + 0.5 < sy1 && y < height; y++) {
        if (y < 0) continue;
        const off = y * width;
        for (let x = Math.ceil(sx0 - 0.5); x + 0.5 < sx1 && x < width; x++) {
          if (x < 0) continue;
          sum += gray[off + x];
          n++;
        }
      }
      out[cy * size + cx] = n > 0 ? sum / n : bilinear(gray, width, height, (sx0 + sx1) / 2 - 0.5, (sy0 + sy1) / 2 - 0.5);
    }
  }
  return normalise(out);
}

function alignedPatch(gray: Uint8Array, width: number, height: number, eyes: EyePair, size: number): Float32Array | null {
  // Pixel coordinates, left eye (image-left) first.
  let l = { x: eyes.a.x * width, y: eyes.a.y * height };
  let r = { x: eyes.b.x * width, y: eyes.b.y * height };
  if (r.x < l.x) [l, r] = [r, l];
  const ex = r.x - l.x;
  const ey = r.y - l.y;
  const iod = Math.hypot(ex, ey);
  if (![l.x, l.y, r.x, r.y].every(Number.isFinite) || iod * (ALIGNED_WINDOW.x1 - ALIGNED_WINDOW.x0) < PATCH_MIN_PX) return null;
  const ux = ex / iod; // unit vector along the eye line
  const uy = ey / iod;
  const vx = -uy; // perpendicular, pointing down the face
  const vy = ux;
  const mx = (l.x + r.x) / 2;
  const my = (l.y + r.y) / 2;
  const W = ALIGNED_WINDOW;
  const out = new Float32Array(size * size);
  const sub = 2; // 2×2 bilinear sub-samples per cell (anti-aliasing)
  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      let sum = 0;
      for (let sy = 0; sy < sub; sy++) {
        const fy = W.y0 + ((cy + (sy + 0.5) / sub) / size) * (W.y1 - W.y0);
        for (let sx = 0; sx < sub; sx++) {
          const fx = W.x0 + ((cx + (sx + 0.5) / sub) / size) * (W.x1 - W.x0);
          const px = mx + (fx * ux + fy * vx) * iod;
          const py = my + (fx * uy + fy * vy) * iod;
          sum += bilinear(gray, width, height, px - 0.5, py - 0.5);
        }
      }
      out[cy * size + cx] = sum / (sub * sub);
    }
  }
  return normalise(out);
}

function bilinear(g: Uint8Array, w: number, h: number, x: number, y: number): number {
  const xi = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const yi = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x2 = Math.min(w - 1, xi + 1);
  const y2 = Math.min(h - 1, yi + 1);
  const fx = Math.max(0, Math.min(1, x - xi));
  const fy = Math.max(0, Math.min(1, y - yi));
  const a = g[yi * w + xi] * (1 - fx) + g[yi * w + x2] * fx;
  const b = g[y2 * w + xi] * (1 - fx) + g[y2 * w + x2] * fx;
  return a * (1 - fy) + b * fy;
}

/** Zero mean, unit variance in place; null when the patch is (nearly) flat. */
export function normalise(v: Float32Array): Float32Array | null {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  const m = s / v.length;
  let q = 0;
  for (let i = 0; i < v.length; i++) {
    const d = v[i] - m;
    q += d * d;
  }
  const sd = Math.sqrt(q / v.length);
  if (!(sd > 1.5)) return null;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - m) / sd;
  return v;
}

/** 1 − normalised cross-correlation of two normalised patches (0 = identical). NaN if either is missing. */
export function patchDistance(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!(na > 0) || !(nb > 0)) return Number.NaN;
  return 1 - dot / Math.sqrt(na * nb);
}

/* ------------------------------------------------------------------ geometry */

interface P {
  x: number;
  y: number;
}

/**
 * Face Mesh (478 points) indices used for the geometry ratios. Chosen to be stable under speech and
 * expression (no lips / jaw-drop / eyebrow points) and computed in pixel units:
 *   0 inter-ocular / face width        (iris or eye-corner centres; cheek extremes 234–454)
 *   1 eye line → mouth corners / IOD   (mouth-corner midpoint, not the lips)
 *   2 mean eye width / IOD             (33–133, 362–263)
 *   3 nose width / IOD                 (alar points 129–358)
 *   4 jaw width at the mouth / face width (172–397)
 */
export const GEOMETRY_POINTS = {
  irisR: 468,
  irisL: 473,
  eyeROuter: 33,
  eyeRInner: 133,
  eyeLInner: 362,
  eyeLOuter: 263,
  cheekR: 234,
  cheekL: 454,
  mouthR: 61,
  mouthL: 291,
  noseR: 129,
  noseL: 358,
  jawR: 172,
  jawL: 397,
} as const;

function ok(p: { x: number; y: number } | undefined): p is { x: number; y: number } {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Geometry ratios from face-mesh landmarks (normalised coordinates, frame size W×H). Null if incomplete. */
export function meshGeometry(lm: readonly { x: number; y: number }[], W: number, H: number): number[] | null {
  const G = GEOMETRY_POINTS;
  if (!Array.isArray(lm) || lm.length <= G.cheekL) return null;
  const px = (i: number): P | null => (ok(lm[i]) ? { x: lm[i].x * W, y: lm[i].y * H } : null);
  const mid = (a: P | null, b: P | null): P | null => (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null);
  const d = (a: P | null, b: P | null): number => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Number.NaN);
  const hasIris = lm.length > G.irisL && ok(lm[G.irisR]) && ok(lm[G.irisL]);
  const eR = hasIris ? px(G.irisR) : mid(px(G.eyeROuter), px(G.eyeRInner));
  const eL = hasIris ? px(G.irisL) : mid(px(G.eyeLInner), px(G.eyeLOuter));
  const iod = d(eR, eL);
  const faceW = d(px(G.cheekR), px(G.cheekL));
  if (!(iod > 1) || !(faceW > 1)) return null;
  const eyeMid = mid(eR, eL);
  const mouthMid = mid(px(G.mouthR), px(G.mouthL));
  const eyeW = (d(px(G.eyeROuter), px(G.eyeRInner)) + d(px(G.eyeLInner), px(G.eyeLOuter))) / 2;
  const r = [iod / faceW, d(eyeMid, mouthMid) / iod, eyeW / iod, d(px(G.noseR), px(G.noseL)) / iod, d(px(G.jawR), px(G.jawL)) / faceW];
  return r.every((v) => Number.isFinite(v) && v > 0) ? r.map((v) => Math.round(v * 10_000) / 10_000) : null;
}

/** Mean absolute log-ratio between two geometry vectors (0 = identical). NaN if either is missing. */
export function geomDistance(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return Number.NaN;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    if (!(a[i] > 0) || !(b[i] > 0)) return Number.NaN;
    s += Math.abs(Math.log(a[i] / b[i]));
  }
  return s / a.length;
}
