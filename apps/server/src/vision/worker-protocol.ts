/**
 * Messages between the vision worker pool (pool.ts, main thread) and its workers (worker.ts).
 * Plain data only (structured clone): Buffers arrive as Uint8Array and are re-wrapped by the receiver.
 */
import { VisionInputError } from './image';
import type { VisionEngineOptions } from './engine';
import type { AnalyzeOptions, DetectedFace, ImageAnalysis } from './types';

export interface VisionWorkerData {
  engine: VisionEngineOptions;
  /** Linux only: nice value added to the worker thread (and the onnxruntime threads it creates). */
  nice: number;
}

export type WorkerRequest =
  | { type: 'analyze'; id: number; image: Uint8Array; opts: AnalyzeOptions }
  | { type: 'detect'; id: number; image: Uint8Array }
  | { type: 'close' };

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'init_error'; error: SerializedError }
  | { type: 'result'; id: number; ok: true; analysis?: ImageAnalysis; faces?: DetectedFace[] }
  | { type: 'result'; id: number; ok: false; error: SerializedError };

export function serializeError(err: unknown): SerializedError {
  const e = err as { name?: string; message?: string; code?: unknown };
  return { name: e?.name ?? 'Error', message: e?.message ?? String(err), code: typeof e?.code === 'string' ? e.code : undefined };
}

/** Rebuild an error thrown inside a worker (VisionInputError keeps its class: routes map it to HTTP 400). */
export function reviveError(e: SerializedError): Error {
  if (e.name === 'VisionInputError') return new VisionInputError(e.message);
  const err = new Error(e.message) as Error & { code?: string };
  err.name = e.name;
  if (e.code) err.code = e.code;
  return err;
}

/** A Buffer view of transferred bytes (no copy). */
export function asBuffer(u8: Uint8Array): Buffer {
  return Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

/** Structured clone turns Buffers into Uint8Arrays: restore the ImageAnalysis contract. */
export function reviveAnalysis(a: ImageAnalysis): ImageAnalysis {
  return { ...a, faceCropJpeg: a.faceCropJpeg ? asBuffer(a.faceCropJpeg) : null };
}
