/**
 * Test helpers: synthetic grayscale "faces" rendered into a 160×120 analysis frame, so the appearance
 * descriptor and the swap triggers can be exercised end to end (render → facePatch → detector) with
 * controlled movement, talking, lighting and person changes. Not exported from the package entry point.
 *
 * A person = a shared face layout (skin, eyes, brows, nose shadow, mouth) + a person-specific smooth texture
 * and feature geometry (eye spacing / height, mouth width, brow thickness, hairline). Two different seeds give
 * two plausibly different faces with the same layout — the hard case (no change of position or size).
 */
import type { NormBox } from '@sp/shared';
import { Rng } from '../eval/prng';
import { facePatch, type EyePair, type FaceDescriptor } from '../continuity/descriptor';

export const FRAME_W = 160;
export const FRAME_H = 120;

export interface Person {
  /** Face-space texture 0..1 → luminance offset, sampled bilinearly. */
  tex: Float32Array;
  texSize: number;
  eyeY: number;
  eyeDx: number;
  eyeR: number;
  browT: number;
  mouthY: number;
  mouthW: number;
  hairline: number;
  skin: number;
  /** Geometry ratios as the mesh would report them (for FaceDescriptor.geom). */
  geom: number[];
}

export function person(seed: number): Person {
  const r = new Rng(seed);
  const rnd = () => r.next();
  const n = 16;
  const coarse = new Float32Array(n * n);
  for (let i = 0; i < coarse.length; i++) coarse[i] = rnd() * 2 - 1;
  const size = 64;
  const tex = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / (size - 1)) * (n - 1);
      const gy = (y / (size - 1)) * (n - 1);
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const x1 = Math.min(n - 1, x0 + 1);
      const y1 = Math.min(n - 1, y0 + 1);
      const fx = gx - x0;
      const fy = gy - y0;
      const a = coarse[y0 * n + x0] * (1 - fx) + coarse[y0 * n + x1] * fx;
      const b = coarse[y1 * n + x0] * (1 - fx) + coarse[y1 * n + x1] * fx;
      tex[y * size + x] = a * (1 - fy) + b * fy;
    }
  }
  const eyeDx = 0.19 + rnd() * 0.06;
  const mouthW = 0.16 + rnd() * 0.08;
  return {
    tex,
    texSize: size,
    eyeY: 0.36 + rnd() * 0.06,
    eyeDx,
    eyeR: 0.05 + rnd() * 0.02,
    browT: 0.02 + rnd() * 0.03,
    mouthY: 0.72 + rnd() * 0.06,
    mouthW,
    hairline: 0.06 + rnd() * 0.12,
    skin: 120 + rnd() * 60,
    geom: [0.42 + eyeDx * 0.5, 1.05 + rnd() * 0.15, 0.55 + rnd() * 0.1, 0.62 + rnd() * 0.12, 0.8 + rnd() * 0.08].map((v) => Math.round(v * 1000) / 1000),
  };
}

export interface RenderOptions {
  /** Head yaw (deg): squeezes the face horizontally and shifts features toward one side. */
  yaw?: number;
  /** 0..1 mouth opening (talking). */
  mouthOpen?: number;
  /** Multiplicative lighting gain and additive offset. */
  gain?: number;
  offset?: number;
  /** Per-pixel sensor noise amplitude (luminance units). */
  noise?: number;
  seed?: number;
  /** Background luminance. */
  background?: number;
}

/** Luminance of person `p` at face coordinates (u, v) ∈ [0,1]² (u = image-left → right). */
function faceLum(p: Person, u: number, v: number, o: RenderOptions): number {
  const yawShift = Math.sin(((o.yaw ?? 0) * Math.PI) / 180) * 0.12;
  const uu = u - yawShift;
  // Person texture (large-scale shading, beard / freckles / glasses frames …).
  const tx = Math.max(0, Math.min(p.texSize - 1, u * (p.texSize - 1)));
  const ty = Math.max(0, Math.min(p.texSize - 1, v * (p.texSize - 1)));
  let lum = p.skin + p.tex[Math.round(ty) * p.texSize + Math.round(tx)] * 38;
  // Hair above the hairline.
  if (v < p.hairline) lum -= 70;
  // Eyes and brows.
  for (const side of [-1, 1]) {
    const ex = 0.5 + side * p.eyeDx + yawShift * 0.5;
    const d = Math.hypot((uu + yawShift - ex) / 1.3, v - p.eyeY);
    if (d < p.eyeR) lum -= 75;
    if (Math.abs(v - (p.eyeY - p.eyeR - 0.04)) < p.browT && Math.abs(uu + yawShift - ex) < p.eyeR * 1.6) lum -= 45;
  }
  // Nose shadow.
  if (Math.abs(uu - 0.5 - yawShift * 0.8) < 0.03 && v > p.eyeY + 0.05 && v < p.mouthY - 0.08) lum -= 25;
  // Mouth (opens when talking).
  const open = (o.mouthOpen ?? 0) * 0.05;
  if (Math.abs(uu - 0.5) < p.mouthW / 2 && Math.abs(v - p.mouthY) < 0.018 + open) lum -= 55;
  return lum;
}

/**
 * Render `p` into a FRAME_W×FRAME_H gray frame with the face box `box` (normalised). Returns the frame; the
 * caller computes the descriptor exactly like the adapter does (facePatch on the gray frame).
 */
export function renderFrame(p: Person, box: NormBox, o: RenderOptions = {}): Uint8Array {
  const g = new Uint8Array(FRAME_W * FRAME_H);
  const r = new Rng(o.seed ?? 1);
  const rnd = () => r.next();
  const bg = o.background ?? 90;
  const gain = o.gain ?? 1;
  const off = o.offset ?? 0;
  const squeeze = Math.cos(((o.yaw ?? 0) * Math.PI) / 180);
  const cx = (box.x + box.w / 2) * FRAME_W;
  const w = box.w * FRAME_W * squeeze;
  const x0 = cx - w / 2;
  const y0 = box.y * FRAME_H;
  const h = box.h * FRAME_H;
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const u = (x + 0.5 - x0) / w;
      const v = (y + 0.5 - y0) / h;
      let lum = bg + ((x * 7 + y * 3) % 23) - 11; // textured background
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const inside = Math.hypot((u - 0.5) / 0.5, (v - 0.5) / 0.55) <= 1;
        if (inside) lum = faceLum(p, u, v, o);
      }
      lum = lum * gain + off + (o.noise ?? 0) * (rnd() * 2 - 1);
      g[y * FRAME_W + x] = Math.max(0, Math.min(255, Math.round(lum)));
    }
  }
  return g;
}

/** Eye centres of the rendered face (normalised frame coordinates), as the mesh would report them. */
export function eyesOf(p: Person, box: NormBox, o: RenderOptions = {}): EyePair {
  const squeeze = Math.cos(((o.yaw ?? 0) * Math.PI) / 180);
  const yawShift = Math.sin(((o.yaw ?? 0) * Math.PI) / 180) * 0.12;
  const cx = box.x + box.w / 2;
  const w = box.w * squeeze;
  const ey = box.y + p.eyeY * box.h;
  const ex = (side: number) => cx - w / 2 + (0.5 + side * p.eyeDx + yawShift * 0.5) * w;
  return { a: { x: ex(-1), y: ey }, b: { x: ex(1), y: ey } };
}

/** Descriptor of a rendered frame, as facesFromMediapipe({descriptors:true}) would attach it. */
export function describe(p: Person, box: NormBox, o: RenderOptions = {}, geomJitter = 0): FaceDescriptor {
  const gray = renderFrame(p, box, o);
  const r = new Rng((o.seed ?? 1) * 31 + 7);
  const rnd = () => r.next();
  const geom = p.geom.map((v) => v * (1 + geomJitter * (rnd() * 2 - 1)));
  return { patch: facePatch(gray, FRAME_W, FRAME_H, box, eyesOf(p, box, o)), geom };
}
