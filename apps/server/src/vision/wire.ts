/**
 * HTTP wire format between the server's remote vision driver (remote.ts) and the dedicated vision worker
 * (src/vision-worker). One version of both ships in the same image, so the format is internal, not a public API.
 *
 *   request   POST /v1/analyze | /v1/id-photo, body = the JPEG bytes (Content-Type: image/jpeg),
 *             `Authorization: Bearer <VISION_WORKER_TOKEN>`, analysis options as JSON in `X-Vision-Options`
 *   response  JSON. Float32 embeddings and the face-crop JPEG travel as base64 (little-endian Float32), non-finite
 *             numbers as {"$nf": "NaN" | "Infinity" | "-Infinity"} (JSON has none; structured clone, which the
 *             in-process pool uses, keeps them), `primary` as an index into `faces` (it is the same object there).
 *   errors    JSON `{ error, message, retryAfterSec?, load? }`; 503 `vision_busy` carries `Retry-After`.
 */
import { z } from 'zod';
import { VisionInputError } from './image';
import type { AnalyzeOptions, DetectedFace, IdPhotoResult, ImageAnalysis, QualityGate, VisionLoad } from './types';

export const OPTIONS_HEADER = 'x-vision-options';
/** Largest image the worker accepts (the server's own limits are lower: 1 MB frames, 5 MB ID photos). */
export const WORKER_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Largest response the driver reads (an analysis with a face crop is ~10–150 KB). */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Thrown by the driver when a worker's answer does not have the expected shape. */
export class VisionWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionWireError';
  }
}

/* ------------------------------------------------------------------------------------- numbers */

export function encodeFloat32(v: Float32Array): string {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf.toString('base64');
}

export function decodeFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length % 4 !== 0) throw new VisionWireError('embedding is not a whole number of float32 values');
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

const NON_FINITE = '$nf';

/** JSON.stringify that keeps NaN / ±Infinity. */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? { [NON_FINITE]: String(v) } : v));
}

/** JSON.parse, reversing stringify()'s non-finite numbers. */
export function parse(text: string): unknown {
  return JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof o[NON_FINITE] === 'string' && Object.keys(o).length === 1) return Number(o[NON_FINITE]);
    }
    return v;
  });
}

/* ------------------------------------------------------------------------------------- analyses */

export interface WireAnalysis extends Omit<ImageAnalysis, 'primary' | 'embedding' | 'faceCropJpeg' | 'embeddingVariants'> {
  /** Index of `primary` in `faces` (-1: none). */
  primaryIndex: number;
  embedding: string | null;
  faceCropJpeg: string | null;
  embeddingVariants?: Record<string, string>;
}

export function encodeAnalysis(a: ImageAnalysis): WireAnalysis {
  const { primary, embedding, faceCropJpeg, embeddingVariants, ...rest } = a;
  let primaryIndex = primary ? a.faces.indexOf(primary) : -1;
  if (primary && primaryIndex < 0) primaryIndex = a.faces.findIndex((f) => JSON.stringify(f) === JSON.stringify(primary));
  if (primary && primaryIndex < 0) throw new VisionWireError('primary face is not one of the detected faces');
  return {
    ...rest,
    primaryIndex,
    embedding: embedding ? encodeFloat32(embedding) : null,
    faceCropJpeg: faceCropJpeg ? faceCropJpeg.toString('base64') : null,
    ...(embeddingVariants ? { embeddingVariants: Object.fromEntries(Object.entries(embeddingVariants).map(([k, v]) => [k, encodeFloat32(v)])) } : {}),
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number';

export function decodeAnalysis(w: unknown): ImageAnalysis {
  const o = w as WireAnalysis;
  if (!o || typeof o !== 'object' || !Array.isArray(o.faces) || !isNum(o.width) || !isNum(o.height) || !isNum(o.primaryIndex) || typeof o.dhash !== 'string' || !o.quality || typeof o.quality !== 'object') {
    throw new VisionWireError('malformed analysis');
  }
  if (o.primaryIndex >= o.faces.length) throw new VisionWireError('primary face index out of range');
  const { primaryIndex, embedding, faceCropJpeg, embeddingVariants, ...rest } = o;
  const faces = o.faces as DetectedFace[];
  return {
    ...rest,
    faces,
    primary: primaryIndex >= 0 ? faces[primaryIndex] : null,
    embedding: typeof embedding === 'string' ? decodeFloat32(embedding) : null,
    faceCropJpeg: typeof faceCropJpeg === 'string' ? Buffer.from(faceCropJpeg, 'base64') : null,
    ...(embeddingVariants && typeof embeddingVariants === 'object'
      ? { embeddingVariants: Object.fromEntries(Object.entries(embeddingVariants).map(([k, v]) => [k, decodeFloat32(String(v))])) }
      : {}),
  };
}

export interface WireIdPhotoResult extends Omit<IdPhotoResult, 'analysis'> {
  analysis: WireAnalysis;
}

export function encodeIdPhotoResult(r: IdPhotoResult): WireIdPhotoResult {
  return { ...r, analysis: encodeAnalysis(r.analysis) };
}

export function decodeIdPhotoResult(w: unknown): IdPhotoResult {
  const o = w as WireIdPhotoResult;
  if (!o || typeof o !== 'object' || typeof o.accepted !== 'boolean' || !Array.isArray(o.guidance) || !o.quality) throw new VisionWireError('malformed ID-photo result');
  return { ...o, analysis: decodeAnalysis(o.analysis) };
}

/* ------------------------------------------------------------------------------------- options */

const illumination = z.enum(['none', 'stretch', 'gamma', 'clahe', 'denoise', 'denoise-stretch', 'soft']);
// Every QualityGate field (the compiler checks the list is complete), each optional.
const gateShape = {
  minDetectionScore: z.number(),
  minInterEyePx: z.number(),
  minBrightness: z.number(),
  maxBrightness: z.number(),
  minContrast: z.number(),
  minContrastConfident: z.number(),
  confidentDetectionScore: z.number(),
  minSharpness: z.number(),
  maxAbsYawDeg: z.number(),
  minPitchDeg: z.number(),
  maxPitchDeg: z.number(),
  secondaryFaceSizeRatio: z.number(),
  cutOffTolerance: z.number(),
} satisfies Record<keyof QualityGate, z.ZodNumber>;
const gateSchema = z.object(gateShape).partial().strict();
const optionsSchema = z
  .object({
    embed: z.boolean().optional(),
    faceCrop: z.boolean().optional(),
    gate: gateSchema.optional(),
    priority: z.enum(['interactive', 'background']).optional(),
    embeddingVariants: z
      .array(z.object({ id: z.string().max(64), normalize: illumination, flip: z.boolean(), poor: z.object({ normalize: illumination, flip: z.boolean() }).strict().optional() }).strict())
      .max(16)
      .optional(),
    enhanceLowLight: z.boolean().optional(),
  })
  .strict();

/** The `X-Vision-Options` header for an analysis. */
export function encodeOptions(o: AnalyzeOptions): string {
  return stringify({
    ...(o.embed != null ? { embed: o.embed } : {}),
    ...(o.faceCrop != null ? { faceCrop: o.faceCrop } : {}),
    ...(o.gate ? { gate: o.gate } : {}),
    ...(o.priority ? { priority: o.priority } : {}),
    ...(o.embeddingVariants?.length ? { embeddingVariants: o.embeddingVariants } : {}),
    ...(o.enhanceLowLight != null ? { enhanceLowLight: o.enhanceLowLight } : {}),
  });
}

/** Parse the `X-Vision-Options` header (absent = defaults); throws VisionInputError when it is not valid. */
export function decodeOptions(header: string | undefined): AnalyzeOptions {
  if (header == null || header === '') return {};
  let raw: unknown;
  try {
    raw = parse(header);
  } catch {
    throw new VisionInputError('X-Vision-Options is not valid JSON');
  }
  const r = optionsSchema.safeParse(raw);
  if (!r.success) throw new VisionInputError(`X-Vision-Options: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

/* ------------------------------------------------------------------------------------- load */

const byPriority = z.object({ interactive: z.number().nonnegative(), background: z.number().nonnegative() });
const loadSchema = z.object({
  workers: z.number().int().nonnegative(),
  inFlight: z.number().nonnegative(),
  queued: byPriority,
  oldestWaitMs: byPriority,
  serviceMs: z.number().nonnegative(),
  estimatedWaitMs: byPriority,
  maxQueue: z.number().nonnegative(),
});

export function decodeLoad(v: unknown): VisionLoad {
  const r = loadSchema.safeParse(v);
  if (!r.success) throw new VisionWireError('malformed load');
  return r.data;
}

/** What one analysis spent on the worker, as reported in every successful answer. */
export interface WireTiming {
  waitMs: number;
  runMs: number;
}

/** Successful answer of POST /v1/analyze. */
export interface AnalyzeAnswer {
  instanceId: string;
  analysis: WireAnalysis;
  timings: WireTiming[];
  /** The worker's queue right after this analysis (keeps the driver's view fresh between polls). */
  load: VisionLoad;
}

/** Successful answer of POST /v1/id-photo (one ID photo = several analyses: the photo and its perturbed copies). */
export interface IdPhotoAnswer {
  instanceId: string;
  result: WireIdPhotoResult;
  timings: WireTiming[];
  load: VisionLoad;
}

/** GET /v1/load. */
export interface LoadAnswer {
  instanceId: string;
  load: VisionLoad;
}

export type WorkerErrorCode = 'unauthorized' | 'vision_busy' | 'vision_unavailable' | 'invalid_image' | 'payload_too_large' | 'unsupported_media_type' | 'not_found' | 'analysis_failed';

export interface WorkerErrorBody {
  error: WorkerErrorCode;
  message: string;
  retryAfterSec?: number;
  /** Class name of the failed analysis' error (analysis_failed). */
  name?: string;
  load?: VisionLoad;
}

export function decodeTimings(v: unknown): WireTiming[] {
  if (!Array.isArray(v)) throw new VisionWireError('malformed timings');
  return v.map((t) => {
    const o = t as WireTiming;
    if (!o || !isNum(o.waitMs) || !isNum(o.runMs)) throw new VisionWireError('malformed timings');
    return { waitMs: o.waitMs, runMs: o.runMs };
  });
}
