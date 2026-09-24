/**
 * Image decoding and whole-image statistics (luminance, dHash).
 *
 * All pixel buffers in the vision module are 8-bit RGB, interleaved (HWC), row-major, no padding.
 */
import sharp, { type Metadata as SharpMetadata } from 'sharp';

export interface RgbImage {
  /** width * height * 3 bytes, RGB interleaved. */
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DecodedImage extends RgbImage {
  /** Size after EXIF orientation was applied, before any downscaling. */
  origWidth: number;
  origHeight: number;
  /** Working-image size = original size * scale (scale <= 1). */
  scale: number;
}

/** Thrown when the input is not a decodable image (callers should map this to HTTP 400/415). */
export class VisionInputError extends Error {
  readonly code = 'invalid_image';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VisionInputError';
  }
}

/** Refuse decompression bombs: 50 MP is far above any webcam / phone photo. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Default max side of the working image used for alignment, statistics and face crops. */
export const DEFAULT_MAX_DECODE_SIDE = 1280;

const SHARP_INPUT = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS } as const;

/** Oriented (EXIF-applied) size of an encoded image without decoding the pixels. */
export async function orientedSize(input: Buffer): Promise<{ width: number; height: number }> {
  let meta: SharpMetadata;
  try {
    meta = await sharp(input, SHARP_INPUT).metadata();
  } catch (err) {
    throw new VisionInputError('Unsupported or corrupt image', { cause: err });
  }
  if (!meta.width || !meta.height) throw new VisionInputError('Image has no dimensions');
  const swap = (meta.orientation ?? 1) >= 5;
  return swap ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/**
 * Decode JPEG/PNG/WebP/... to RGB, applying EXIF orientation, removing alpha, converting to sRGB 8-bit
 * and downscaling so that max(width, height) <= maxSide.
 */
export async function decodeImage(input: Buffer, maxSide = DEFAULT_MAX_DECODE_SIDE): Promise<DecodedImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw new VisionInputError('Image must be a non-empty Buffer');
  const { width: origWidth, height: origHeight } = await orientedSize(input);
  const scale = Math.min(1, maxSide / Math.max(origWidth, origHeight));
  let pipeline = sharp(input, SHARP_INPUT).rotate();
  if (scale < 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(origWidth * scale)),
      height: Math.max(1, Math.round(origHeight * scale)),
      fit: 'fill',
    });
  }
  try {
    const { data, info } = await pipeline
      .removeAlpha()
      .toColourspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    const rgb = toRgb(data, info.width, info.height, info.channels);
    return { data: rgb, width: info.width, height: info.height, origWidth, origHeight, scale: info.width / origWidth };
  } catch (err) {
    if (err instanceof VisionInputError) throw err;
    throw new VisionInputError('Unsupported or corrupt image', { cause: err });
  }
}

/**
 * Decode a rectangular region of the ORIGINAL (oriented) image at up to `maxSide` resolution.
 * Used to re-sample small faces in large photos at native resolution.
 */
export async function decodeRegion(
  input: Buffer,
  region: { left: number; top: number; width: number; height: number },
  maxSide: number,
): Promise<RgbImage & { scale: number }> {
  const scale = Math.min(1, maxSide / Math.max(region.width, region.height));
  let pipeline = sharp(input, SHARP_INPUT).rotate().extract(region);
  if (scale < 1) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round(region.width * scale)),
      height: Math.max(1, Math.round(region.height * scale)),
      fit: 'fill',
    });
  }
  const { data, info } = await pipeline.removeAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return { data: toRgb(data, info.width, info.height, info.channels), width: info.width, height: info.height, scale: info.width / region.width };
}

function toRgb(data: Buffer, width: number, height: number, channels: number): Uint8Array {
  const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (channels === 3) return view;
  const out = new Uint8Array(width * height * 3);
  const n = width * height;
  if (channels === 1) {
    for (let i = 0, o = 0; i < n; i++, o += 3) out[o] = out[o + 1] = out[o + 2] = view[i];
  } else {
    for (let i = 0, s = 0, o = 0; i < n; i++, s += channels, o += 3) {
      out[o] = view[s];
      out[o + 1] = view[s + 1];
      out[o + 2] = view[s + 2];
    }
  }
  return out;
}

/** Resize an RGB image (off the main thread, via libvips). */
export async function resizeRgb(img: RgbImage, width: number, height: number): Promise<RgbImage> {
  const { data, info } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .resize({ width, height, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: toRgb(data, info.width, info.height, info.channels), width: info.width, height: info.height };
}

/** Encode a region of an RGB image as JPEG. */
export async function encodeJpegRegion(
  img: RgbImage,
  region: { left: number; top: number; width: number; height: number },
  maxSide: number,
  quality: number,
): Promise<Buffer> {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })
    .extract(region)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer();
}

/* ------------------------------------------------------------------------------------ luminance */

/** ITU-R BT.601 luma with integer weights (sum 256). */
export function luma(r: number, g: number, b: number): number {
  return (77 * r + 150 * g + 29 * b) >> 8;
}

export interface WholeImageStats {
  /** Mean luminance 0..255. */
  brightness: number;
  /** Std-dev of luminance. */
  contrast: number;
  /** 64-bit dHash, 16 hex chars. */
  dhash: string;
}

const DH_W = 9;
const DH_H = 8;

/**
 * Mean/std luminance and dHash of the whole image in a single pass. Images larger than 128x128 are
 * sampled on a 2-pixel grid (4x faster; the statistics and 9x8 cell means are unaffected in practice).
 */
export function wholeImageStats(img: RgbImage): WholeImageStats {
  const { data, width, height } = img;
  const step = width >= 128 && height >= 128 ? 2 : 1;
  const colBin = new Int32Array(width);
  for (let x = 0; x < width; x++) colBin[x] = Math.min(DH_W - 1, Math.floor((x * DH_W) / width));
  const sums = new Float64Array(DH_W * DH_H);
  const counts = new Float64Array(DH_W * DH_H);
  let total = 0;
  let totalSq = 0;
  let n = 0;
  const pixStep = 3 * step;
  for (let y = 0; y < height; y += step) {
    const rowBase = Math.min(DH_H - 1, Math.floor((y * DH_H) / height)) * DH_W;
    let rowSum = 0;
    let rowSq = 0;
    let p = y * width * 3;
    for (let x = 0; x < width; x += step, p += pixStep) {
      const l = (77 * data[p] + 150 * data[p + 1] + 29 * data[p + 2]) >> 8;
      rowSum += l;
      rowSq += l * l;
      const bin = rowBase + colBin[x];
      sums[bin] += l;
      counts[bin] += 1;
      n++;
    }
    total += rowSum;
    totalSq += rowSq;
  }
  n = Math.max(1, n);
  const mean = total / n;
  const variance = Math.max(0, totalSq / n - mean * mean);
  const cells = new Float64Array(DH_W * DH_H);
  for (let i = 0; i < cells.length; i++) cells[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return { brightness: mean, contrast: Math.sqrt(variance), dhash: dhashFromCells(cells) };
}

/**
 * 64-bit difference hash of a grayscale image: area-average to 9x8 cells, then for each row set a bit
 * when a cell is brighter than its right neighbour. Bits are row-major, most significant first,
 * rendered as 16 lowercase hex chars.
 */
export function dhashFromGray(gray: ArrayLike<number>, width: number, height: number): string {
  if (width <= 0 || height <= 0 || gray.length < width * height) throw new Error('dhashFromGray: bad dimensions');
  const sums = new Float64Array(DH_W * DH_H);
  const counts = new Float64Array(DH_W * DH_H);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.min(DH_H - 1, Math.floor((y * DH_H) / height)) * DH_W;
    for (let x = 0; x < width; x++) {
      const bin = rowBase + Math.min(DH_W - 1, Math.floor((x * DH_W) / width));
      sums[bin] += gray[y * width + x];
      counts[bin] += 1;
    }
  }
  const cells = new Float64Array(DH_W * DH_H);
  for (let i = 0; i < cells.length; i++) cells[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return dhashFromCells(cells);
}

function dhashFromCells(cells: Float64Array): string {
  let hex = '';
  for (let y = 0; y < DH_H; y++) {
    let byte = 0;
    for (let x = 0; x < DH_W - 1; x++) {
      byte = (byte << 1) | (cells[y * DH_W + x] > cells[y * DH_W + x + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * Hamming distance between two hex strings (e.g. dHashes). Strings of different length are compared
 * as if the shorter one were left-padded with zeros. Throws on non-hex input.
 */
export function hammingHex(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  const pa = a.padStart(len, '0');
  const pb = b.padStart(len, '0');
  let dist = 0;
  for (let i = 0; i < len; i++) {
    const x = parseInt(pa[i], 16);
    const y = parseInt(pb[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) throw new Error('hammingHex: not a hex string');
    dist += NIBBLE_BITS[x ^ y];
  }
  return dist;
}
