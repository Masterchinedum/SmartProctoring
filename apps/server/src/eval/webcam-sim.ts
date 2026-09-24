/**
 * Laptop-webcam capture simulator: renders a source photo of a person as a realistic webcam frame, so the
 * identity pipeline can be evaluated under the conditions candidates actually have (docs/accuracy/identity-v2.md).
 *
 * Why these ranges (typical built-in laptop webcams, 2018-2025):
 *   - Sensor / optics: 1/4"-1/6" sensors with ~1.1-1.4 um pixels, fixed-focus f/2.0-2.4 plastic lenses, 720p
 *     (many 1080p) streams; browsers usually request 640x480 or 1280x720. The optics + demosaic + in-ISP
 *     noise reduction leave an effective resolution well below the pixel grid: we model a Gaussian PSF with
 *     sigma 0.5-0.9 px (good light) up to 1.0-1.8 px (dim light, where temporal/spatial NR smears detail),
 *     at 720p scale.
 *   - Geometry: horizontal FOV ~ 65-78 deg (f ~ 800 px at 1280 wide). A 63 mm inter-pupillary distance at
 *     45-90 cm gives ~55-110 px at 720p; candidates who lean back or sit with the laptop further away go
 *     down to ~35 px. We sample inter-eye 35-90 px at 720p (x 2/3 at 640x480: 23-60 px) plus small roll
 *     (+/-3 deg) and placement jitter; bursts add sub-pixel/1-px jitter between frames.
 *   - Exposure: auto-exposure meters (centre-weighted) to a mid-grey target; indoor evening light (20-100 lux)
 *     drives exposure to its 1/30-1/15 s limit and analogue gain to its maximum, so faces end up UNDER-exposed
 *     (face luma 35-75) with strong noise and slight motion blur. A window behind the candidate makes the
 *     metering expose for the bright background: face luma 40-85, and veiling glare (lens flare) lifts the
 *     blacks and removes contrast.
 *   - Noise: read + shot noise amplified by gain; after demosaic/NR it is spatially correlated and has
 *     coloured (chroma) blotches. We add luma noise sigma 1.5-3 (good) ... 6-12 (dim) and low-frequency
 *     chroma noise, then a mild NR blur.
 *   - Tone / colour: ISP gamma differs between vendors (we vary +/-10-20 %), auto white balance leaves a warm
 *     cast under tungsten / warm LEDs (R +5-25 %, B -5-25 %) and a cool cast in daylight/monitor light.
 *   - Compression: MJPEG/H.264 in the camera and JPEG from the browser canvas at quality 0.7-0.92.
 *
 * Deterministic: the same (source, options) always gives the same bytes. `sceneSeed` draws the scene /
 * lighting / camera parameters; `frameSeed` draws per-frame noise and jitter (a burst shares the scene).
 */
import sharp from 'sharp';
import type { Point } from '../vision/types';

export const WEBCAM_CONDITIONS = ['good', 'typical', 'dim', 'backlit', 'sidelit'] as const;
export type WebcamCondition = (typeof WEBCAM_CONDITIONS)[number];
export const WEBCAM_RESOLUTIONS = ['640x480', '1280x720'] as const;
export type WebcamResolution = (typeof WEBCAM_RESOLUTIONS)[number];

type Range = readonly [number, number];

export interface ConditionParams {
  /** Mean luma of the face (inner face region) in the final frame. */
  faceLuma: Range;
  /** Luma noise std-dev (8-bit) before NR, and chroma noise std-dev. */
  lumaNoise: Range;
  chromaNoise: Range;
  /** Contrast factor about the face mean (1 = none) and black lift (flare / black level). */
  contrast: Range;
  lift: Range;
  /** Tone-curve exponent multiplier (ISP gamma variation). */
  gamma: Range;
  /** Optical + NR Gaussian blur sigma at 720p scale (px), motion-blur length (px). */
  blur: Range;
  motion: Range;
  /** Post-noise NR blur sigma (px). */
  nr: Range;
  /** Per-channel gains: red and blue multipliers (colour-temperature cast). */
  red: Range;
  blue: Range;
  jpeg: Range;
  /** Side-lighting: darkest side / brightest side illumination ratio (linear). 1 = even light. */
  sideRatio: Range;
  /** Background (bright window) radiance relative to the face; 0 = normal room. */
  window: Range;
}

export const CONDITION_PARAMS: Readonly<Record<WebcamCondition, Readonly<ConditionParams>>> = Object.freeze({
  good: {
    faceLuma: [115, 165],
    lumaNoise: [1.5, 3],
    chromaNoise: [1, 2],
    contrast: [0.95, 1.05],
    lift: [0, 4],
    gamma: [0.95, 1.05],
    blur: [0.5, 0.9],
    motion: [0, 1],
    nr: [0, 0.4],
    red: [0.96, 1.04],
    blue: [0.96, 1.04],
    jpeg: [85, 92],
    sideRatio: [1, 1],
    window: [0, 0],
  },
  typical: {
    faceLuma: [85, 130],
    lumaNoise: [3, 6],
    chromaNoise: [2, 4],
    contrast: [0.8, 0.95],
    lift: [4, 10],
    gamma: [0.9, 1.1],
    blur: [0.7, 1.3],
    motion: [0, 2],
    nr: [0.3, 0.6],
    red: [1.03, 1.12],
    blue: [0.88, 0.97],
    jpeg: [75, 90],
    sideRatio: [0.7, 1],
    window: [0, 0],
  },
  dim: {
    faceLuma: [35, 75],
    lumaNoise: [6, 12],
    chromaNoise: [4, 8],
    contrast: [0.6, 0.8],
    lift: [8, 18],
    gamma: [0.9, 1.2],
    blur: [1, 1.8],
    motion: [0.5, 3],
    nr: [0.5, 0.9],
    red: [1.1, 1.25],
    blue: [0.75, 0.9],
    jpeg: [70, 85],
    sideRatio: [0.6, 1],
    window: [0, 0],
  },
  backlit: {
    faceLuma: [40, 85],
    lumaNoise: [4, 8],
    chromaNoise: [2, 5],
    contrast: [0.6, 0.8],
    lift: [15, 35],
    gamma: [0.9, 1.1],
    blur: [0.8, 1.3],
    motion: [0, 1.5],
    nr: [0.4, 0.7],
    red: [0.9, 1.0],
    blue: [1.0, 1.1],
    jpeg: [75, 90],
    sideRatio: [0.8, 1],
    window: [4, 8],
  },
  sidelit: {
    faceLuma: [70, 130],
    lumaNoise: [3, 7],
    chromaNoise: [2, 4],
    contrast: [0.85, 1.0],
    lift: [2, 8],
    gamma: [0.9, 1.1],
    blur: [0.7, 1.2],
    motion: [0, 1.5],
    nr: [0.3, 0.6],
    red: [1.0, 1.12],
    blue: [0.88, 1.0],
    jpeg: [75, 90],
    sideRatio: [0.12, 0.35],
    window: [0, 0],
  },
});

/** Inter-eye distance range at 720p (px); scaled by height/720 for other resolutions. */
export const INTER_EYE_720: Range = [35, 90];

export interface SourceFace {
  /** YuNet 5 landmarks of the subject in the source photo (original, EXIF-oriented coordinates). */
  landmarks: readonly Point[];
}

export interface WebcamSimOptions {
  condition: WebcamCondition;
  resolution: WebcamResolution;
  /** Scene / lighting / camera parameters and placement. */
  sceneSeed: number;
  /** Per-frame noise and small jitter (a burst = same sceneSeed, different frameSeed). */
  frameSeed?: number;
  /** Override the sampled inter-eye distance at 720p scale. */
  interEye720?: number;
  /** Per-frame jitter amplitude: 'burst' (sub-pixel..1 px, +/-0.5 deg) or 'session' (a few px, +/-2 deg). */
  jitter?: 'burst' | 'session';
}

export interface SimulatedFrame {
  jpeg: Buffer;
  width: number;
  height: number;
  params: {
    condition: WebcamCondition;
    resolution: WebcamResolution;
    interEyePx: number;
    faceLuma: number;
    lumaNoise: number;
    blur: number;
    motion: number;
    jpeg: number;
  };
}

/* ------------------------------------------------------------------------------------ PRNG */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussFactory(rnd: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare != null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u <= 1e-12) u = rnd();
    const v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

const GAUSS_BITS = 16;
const GAUSS_MASK = (1 << GAUSS_BITS) - 1;
let gaussTableCache: Float32Array | null = null;
/** 65,536 standard-normal samples (fixed seed), indexed by a per-frame PRNG. */
function gaussTable(): Float32Array {
  if (gaussTableCache) return gaussTableCache;
  const g = gaussFactory(mulberry32(0x5eed));
  const t = new Float32Array(1 << GAUSS_BITS);
  for (let i = 0; i < t.length; i++) t[i] = g();
  return (gaussTableCache = t);
}

const lerp = (r: Range, t: number) => r[0] + (r[1] - r[0]) * t;

/* ------------------------------------------------------------------------------------ source cache */

interface DecodedSource {
  data: Buffer;
  width: number;
  height: number;
}

const sourceCache = new WeakMap<Buffer, Map<number, Promise<DecodedSource & { scale: number }>>>();

function decodedSource(src: Buffer, scale: number): Promise<DecodedSource & { scale: number }> {
  let m = sourceCache.get(src);
  if (!m) sourceCache.set(src, (m = new Map()));
  let p = m.get(scale);
  if (!p) m.set(scale, (p = decodeSource(src, scale)));
  return p;
}

async function decodeSource(src: Buffer, scale: number): Promise<DecodedSource & { scale: number }> {
  const meta = await sharp(src).rotate().metadata();
  const ow = meta.autoOrient?.width ?? meta.width ?? 0;
  const oh = meta.autoOrient?.height ?? meta.height ?? 0;
  let p = sharp(src).rotate();
  if (scale < 1) p = p.resize({ width: Math.max(1, Math.round(ow * scale)), height: Math.max(1, Math.round(oh * scale)), fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await p.removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, scale: info.width / Math.max(1, ow) };
}

/* ------------------------------------------------------------------------------------ simulator */

/**
 * Render one simulated webcam frame (JPEG). The subject's head and shoulders are cut from the source with a
 * feathered mask, scaled to the sampled inter-eye distance, placed in a synthetic room, then exposed,
 * lit, blurred, noised, colour-cast and JPEG-compressed per the condition.
 */
export async function simulateWebcamFrame(src: Buffer, face: SourceFace, opts: WebcamSimOptions): Promise<SimulatedFrame> {
  const [W, H] = opts.resolution === '1280x720' ? [1280, 720] : [640, 480];
  const cond = CONDITION_PARAMS[opts.condition];
  const scene = mulberry32(opts.sceneSeed * 7919 + 17);
  const frame = mulberry32((opts.sceneSeed * 7919 + 17) ^ ((opts.frameSeed ?? 0) * 104729 + 1));
  const fgauss = gaussFactory(frame);

  // Scene parameters.
  const u = () => scene();
  const ie720 = opts.interEye720 ?? lerp(INTER_EYE_720, u());
  const resScale = H / 720;
  const ieT = ie720 * resScale;
  const p = {
    faceLuma: lerp(cond.faceLuma, u()),
    lumaNoise: lerp(cond.lumaNoise, u()),
    chromaNoise: lerp(cond.chromaNoise, u()),
    contrast: lerp(cond.contrast, u()),
    lift: lerp(cond.lift, u()),
    gamma: lerp(cond.gamma, u()),
    blur: lerp(cond.blur, u()) * resScale,
    motion: lerp(cond.motion, u()) * resScale,
    motionAngle: u() * Math.PI,
    nr: lerp(cond.nr, u()),
    red: lerp(cond.red, u()),
    blue: lerp(cond.blue, u()),
    jpeg: Math.round(lerp(cond.jpeg, u())),
    sideRatio: lerp(cond.sideRatio, u()),
    sideDir: u() < 0.5 ? -1 : 1,
    window: lerp(cond.window, u()),
    cx: W * (0.5 + (u() - 0.5) * 0.16),
    cy: H * (0.4 + (u() - 0.5) * 0.12),
    roll: (u() - 0.5) * 6,
    wall: [100 + u() * 90, 0, 0] as number[],
    wallTint: [0.9 + u() * 0.2, 1, 0.85 + u() * 0.25],
    windowX: u() < 0.5 ? 0 : 0.45,
  };
  const jit = opts.jitter === 'session' ? { t: 0.02 * W, r: 2, s: 0.04 } : { t: 1, r: 0.5, s: 0.01 };
  const fr = opts.frameSeed ?? 0;
  const jx = fr === 0 ? 0 : fgauss() * jit.t;
  const jy = fr === 0 ? 0 : fgauss() * jit.t * 0.6;
  const jr = fr === 0 ? 0 : fgauss() * jit.r;
  const js = fr === 0 ? 1 : 1 + fgauss() * jit.s;

  // Source geometry.
  const [le, re] = face.landmarks;
  const ieS = Math.hypot(re.x - le.x, re.y - le.y);
  if (!(ieS > 1)) throw new Error('simulateWebcamFrame: degenerate source landmarks');
  const s = (ieT * js) / ieS;
  // Pre-downscale large sources so the bilinear warp never decimates by more than ~1.5x (no aliasing). Decode
  // scales are quantised to steps of sqrt(2) so repeated renders of one source share the decoded image.
  const want = Math.min(1, (1.5 * ieT) / ieS);
  const q = Math.min(1, Math.pow(2, Math.ceil(Math.log2(want) * 2) / 2));
  const dec = await decodedSource(src, q);
  const ds = dec.scale;
  const eyeMid = { x: ((le.x + re.x) / 2) * ds, y: ((le.y + re.y) / 2) * ds };
  const ieD = ieS * ds;
  const rollSrc = Math.atan2(re.y - le.y, re.x - le.x);
  // Output -> source mapping: rotate by (rollSrc - target roll), scale 1/k.
  const k = (ieT * js) / ieD;
  const theta = rollSrc - ((p.roll + jr) * Math.PI) / 180;
  const cosT = Math.cos(theta) / k;
  const sinT = Math.sin(theta) / k;
  const ox = p.cx + jx;
  const oy = p.cy + jy;
  // Mask in source (decoded) coordinates, in the face frame (u along the eye line, v down).
  const cr = Math.cos(rollSrc);
  const sr = Math.sin(rollSrc);

  // Background (linear radiance relative to the face = 1).
  const lin = new Float32Array(W * H * 3);
  const wallLin = Math.pow(p.wall[0] / 255, 2.2) * 1.4;
  const winX0 = p.windowX * W;
  const winX1 = winX0 + 0.55 * W;
  const colSin = new Float32Array(W);
  for (let x = 0; x < W; x++) colSin[x] = Math.sin((x / W) * 5.3 + p.wallTint[0] * 7);
  const [tr, tg, tb] = p.wallTint;
  const win = p.window;
  const deskY = H * 0.82;
  const winY = H * 0.75;
  for (let y = 0; y < H; y++) {
    const base = wallLin * (0.8 + 0.4 * (1 - y / H)) * (y > deskY ? 0.45 : 1);
    const rowCos = 0.2 * Math.cos((y / H) * 3.1);
    const rowWin = win > 0 && y < winY;
    let o = y * W * 3;
    for (let x = 0; x < W; x++, o += 3) {
      const v = rowWin && x >= winX0 && x < winX1 ? win : base * (0.9 + colSin[x] * rowCos);
      lin[o] = v * tr;
      lin[o + 1] = v * tg;
      lin[o + 2] = v * tb;
    }
  }

  // Person: inverse-map every output pixel into the decoded source.
  const sd = dec.data;
  const sw = dec.width;
  const sh = dec.height;
  const headA = 1.25 * ieD; // half-width of the head ellipse (eye line units)
  const headB = 1.75 * ieD; // half-height
  const headCy = 0.55 * ieD; // ellipse centre below the eye line
  const neckHalf = 1.9 * ieD; // shoulders / neck half-width
  const neckTop = 1.6 * ieD;
  const neckBottom = 3.6 * ieD;
  const feather = 0.35 * ieD;
  const borderFade = Math.max(2, 0.12 * ieD);
  const toLin = new Float32Array(256);
  for (let i = 0; i < 256; i++) toLin[i] = Math.pow(i / 255, 2.2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - ox;
      const dy = y - oy;
      const sx = eyeMid.x + cosT * dx - sinT * dy;
      const sy = eyeMid.y + sinT * dx + cosT * dy;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      // Face-frame coordinates.
      const fu = (sx - eyeMid.x) * cr + (sy - eyeMid.y) * sr;
      const fv = -(sx - eyeMid.x) * sr + (sy - eyeMid.y) * cr;
      const er = Math.hypot(fu / headA, (fv - headCy) / headB); // 1 at the ellipse boundary
      let m = er <= 1 ? 1 : Math.max(0, 1 - ((er - 1) * headA) / feather);
      if (fv > neckTop && fv < neckBottom + feather) {
        const mx = Math.max(0, Math.min(1, (neckHalf - Math.abs(fu)) / feather));
        const my = Math.max(0, Math.min(1, (neckBottom + feather - fv) / feather));
        m = Math.max(m, Math.min(mx, my));
      }
      // Fade near the source image border.
      const edge = Math.min(sx, sy, sw - 1 - sx, sh - 1 - sy);
      if (edge < borderFade) m *= edge / borderFade;
      if (m <= 0) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const p00 = (y0 * sw + x0) * 3;
      const p01 = (y0 * sw + x1) * 3;
      const p10 = (y1 * sw + x0) * 3;
      const p11 = (y1 * sw + x1) * 3;
      const o = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v =
          (1 - fy) * ((1 - fx) * toLin[sd[p00 + c]] + fx * toLin[sd[p01 + c]]) + fy * ((1 - fx) * toLin[sd[p10 + c]] + fx * toLin[sd[p11 + c]]);
        lin[o + c] = lin[o + c] * (1 - m) + v * m;
      }
    }
  }

  // Lighting: side light ramp across the face (and the scene).
  if (p.sideRatio < 0.999) {
    const faceW = 2.2 * ieT;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = Math.max(0, Math.min(1, 0.5 + (p.sideDir * (x - ox)) / faceW));
        const sm = t * t * (3 - 2 * t);
        const f = p.sideRatio + (1 - p.sideRatio) * sm;
        const o = (y * W + x) * 3;
        lin[o] *= f;
        lin[o + 1] *= f;
        lin[o + 2] *= f;
      }
    }
  }

  // Exposure: hit the face-luma target (inner face region around the nose).
  const target = Math.max(4, ((p.faceLuma - p.lift) * 255) / (255 - p.lift));
  const gammaEnc = (1 / 2.2) * p.gamma;
  let faceSum = 0;
  let faceN = 0;
  const rA = 0.9 * ieT;
  const rB = 1.2 * ieT;
  const fcx = ox;
  const fcy = oy + 0.55 * ieT;
  for (let y = Math.max(0, Math.floor(fcy - rB)); y < Math.min(H, Math.ceil(fcy + rB)); y++) {
    for (let x = Math.max(0, Math.floor(fcx - rA)); x < Math.min(W, Math.ceil(fcx + rA)); x++) {
      if (((x - fcx) / rA) ** 2 + ((y - fcy) / rB) ** 2 > 1) continue;
      const o = (y * W + x) * 3;
      faceSum += 0.299 * lin[o] * p.red + 0.587 * lin[o + 1] + 0.114 * lin[o + 2] * p.blue;
      faceN++;
    }
  }
  const faceLin = faceN > 0 ? faceSum / faceN : 0.2;
  // Solve mean(encode(k * lin)) ~= target using the mean in linear space (Jensen error is small and absorbed by the ranges).
  const kExp = Math.pow(target / 255, 1 / gammaEnc) / Math.max(1e-6, faceLin);

  // Encode (tone curve + colour gains), flare lift and contrast loss about the face mean.
  const enc = new Uint8ClampedArray(W * H * 3);
  const mf = p.faceLuma;
  const LUT_N = 16384;
  const tone = new Float32Array(LUT_N + 1);
  const liftScale = (255 - p.lift) / 255;
  for (let i = 0; i <= LUT_N; i++) tone[i] = mf + (p.lift + 255 * Math.pow(i / LUT_N, gammaEnc) * liftScale - mf) * p.contrast;
  const top = tone[LUT_N];
  const kr = kExp * p.red * LUT_N;
  const kg = kExp * LUT_N;
  const kb = kExp * p.blue * LUT_N;
  for (let i = 0, n = W * H * 3; i < n; i += 3) {
    const r = lin[i] * kr;
    const g = lin[i + 1] * kg;
    const b = lin[i + 2] * kb;
    enc[i] = r >= LUT_N ? top : tone[r | 0];
    enc[i + 1] = g >= LUT_N ? top : tone[g | 0];
    enc[i + 2] = b >= LUT_N ? top : tone[b | 0];
  }

  // Optics blur + motion blur (sharp), then noise, then NR.
  let img = sharp(Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength), { raw: { width: W, height: H, channels: 3 } });
  if (p.blur >= 0.3) img = img.blur(p.blur);
  let blurred = await img.raw().toBuffer();
  if (p.motion >= 1) {
    const len = Math.max(2, Math.round(p.motion));
    const size = len % 2 === 0 ? len + 1 : len;
    const kernel = new Array<number>(size * size).fill(0);
    const c = (size - 1) / 2;
    let sum = 0;
    for (let t = 0; t < 4 * size; t++) {
      const r = (t / (4 * size - 1) - 0.5) * (len - 1);
      const kx = Math.round(c + r * Math.cos(p.motionAngle));
      const ky = Math.round(c + r * Math.sin(p.motionAngle));
      kernel[ky * size + kx] += 1;
      sum += 1;
    }
    blurred = await sharp(blurred, { raw: { width: W, height: H, channels: 3 } })
      .convolve({ width: size, height: size, kernel: kernel.map((v) => v / sum) })
      .raw()
      .toBuffer();
  }
  // Noise: per-pixel luma noise + low-frequency chroma noise (1/4 resolution, bilinear upsampled).
  const cw = Math.ceil(W / 4) + 1;
  const ch = Math.ceil(H / 4) + 1;
  const chromaR = new Float32Array(cw * ch);
  const chromaB = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    chromaR[i] = fgauss() * p.chromaNoise;
    chromaB[i] = fgauss() * p.chromaNoise;
  }
  const noisy = new Uint8ClampedArray(W * H * 3);
  const normals = gaussTable();
  let st = (frame() * 4294967296) >>> 0 || 1;
  const ln = p.lumaNoise;
  const rowR = new Float32Array(W);
  const rowB = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    const cy = y / 4;
    const cy0 = Math.floor(cy);
    const fy = cy - cy0;
    for (let x = 0; x < W; x++) {
      const cx = x / 4;
      const cx0 = Math.floor(cx);
      const fx = cx - cx0;
      const ci = cy0 * cw + cx0;
      rowR[x] = (1 - fy) * ((1 - fx) * chromaR[ci] + fx * chromaR[ci + 1]) + fy * ((1 - fx) * chromaR[ci + cw] + fx * chromaR[ci + cw + 1]);
      rowB[x] = (1 - fy) * ((1 - fx) * chromaB[ci] + fx * chromaB[ci + 1]) + fy * ((1 - fx) * chromaB[ci + cw] + fx * chromaB[ci + cw + 1]);
    }
    let o = y * W * 3;
    for (let x = 0; x < W; x++, o += 3) {
      // xorshift32 index into a table of standard normals (deterministic, fast).
      st ^= st << 13;
      st ^= st >>> 17;
      st ^= st << 5;
      // Roughly flat noise in 8-bit (shot noise vs tone-curve compression), lower in clipped highlights.
      const nl = normals[(st >>> 0) & GAUSS_MASK] * ln * (blurred[o + 1] > 240 ? 0.3 : 1);
      const cR = rowR[x];
      const cB = rowB[x];
      noisy[o] = blurred[o] + nl + cR;
      noisy[o + 1] = blurred[o + 1] + nl - 0.3 * (cR + cB);
      noisy[o + 2] = blurred[o + 2] + nl + cB;
    }
  }
  let out = sharp(Buffer.from(noisy.buffer, noisy.byteOffset, noisy.byteLength), { raw: { width: W, height: H, channels: 3 } });
  if (p.nr >= 0.3) out = out.blur(p.nr);
  const jpeg = await out.jpeg({ quality: p.jpeg, chromaSubsampling: '4:2:0' }).toBuffer();
  return {
    jpeg,
    width: W,
    height: H,
    params: {
      condition: opts.condition,
      resolution: opts.resolution,
      interEyePx: Math.round(ieT * js * 10) / 10,
      faceLuma: Math.round(p.faceLuma),
      lumaNoise: Math.round(p.lumaNoise * 10) / 10,
      blur: Math.round(p.blur * 100) / 100,
      motion: Math.round(p.motion * 10) / 10,
      jpeg: p.jpeg,
    },
  };
}
