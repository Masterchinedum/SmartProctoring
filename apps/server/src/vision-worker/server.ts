/**
 * Dedicated vision worker: the face-analysis pipeline (src/vision: YuNet + SFace in a worker-thread pool) behind a
 * small authenticated HTTP API, so face analysis scales on its own hosts, independently of the API servers
 * (docs/ARCHITECTURE.md §4, docs/OPERATIONS.md §2). The server talks to it through the remote driver
 * (vision/remote.ts, VISION_DRIVER=remote); the wire format is vision/wire.ts.
 *
 *   GET  /health/live     the process answers                                     (no auth; liveness probe)
 *   GET  /health/ready    at least one analysis thread is ready (200 / 503)       (no auth; readiness probe)
 *   GET  /v1/load         the queue now: VisionLoad + this process' instance id    (bearer token)
 *   POST /v1/analyze      JPEG body, options in X-Vision-Options -> analysis       (bearer token)
 *   POST /v1/id-photo     JPEG body -> ID-photo intake result (relaxed gate + template stability)
 *
 * The pool's priorities (interactive before background, overdue background alternating), per-priority queue limit and
 * Retry-After estimate apply unchanged: a full queue answers 503 `vision_busy` with `Retry-After` = the estimated time
 * the analyses ahead need. A worker with no ready analysis thread answers 503 `vision_unavailable` at once, so the
 * driver can send the frame elsewhere. Images are never logged, stored or kept after the answer.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { processIdPhoto } from '../vision/id-photo.js';
import { VisionCancelledError } from '../vision/pool.js';
import type { AnalyzeOptions, ImageAnalysis, TimedAnalysis, VisionLoad, VisionService } from '../vision/types.js';
import {
  decodeOptions,
  encodeAnalysis,
  encodeIdPhotoResult,
  OPTIONS_HEADER,
  stringify,
  WORKER_MAX_BODY_BYTES,
  type AnalyzeAnswer,
  type IdPhotoAnswer,
  type LoadAnswer,
  type WireTiming,
  type WorkerErrorBody,
  type WorkerErrorCode,
} from '../vision/wire.js';

/** Analysis back-end of the worker: the ONNX service (analyzeTimed) or, in tests, the FakeVisionService. */
export type WorkerVision = VisionService & { analyzeTimed?: (image: Buffer, opts?: AnalyzeOptions, signal?: AbortSignal) => Promise<TimedAnalysis> };

export interface VisionWorkerAppOptions {
  vision: WorkerVision;
  /**
   * Shared secret(s) the server sends as `Authorization: Bearer <token>` (VISION_WORKER_TOKEN). Several are accepted
   * while the secret is rotated (the new one and the old one, until every server sends the new one).
   */
  token: string | string[];
  /** Fastify logger option (default: no logging). */
  logger?: FastifyServerOptions['logger'];
  /** A pino instance instead (main.ts: the same logger the pool's crash messages use). */
  loggerInstance?: FastifyServerOptions['loggerInstance'];
  /** Identifies this process in every answer (the driver merges two addresses that reach the same worker). */
  instanceId?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time check of the bearer token against every accepted one (both sides hashed first, so lengths never leak
 * through timing, and every candidate is compared, so neither does which one matched).
 */
export function tokenMatches(header: string | undefined, expectedHashes: Buffer[]): boolean {
  const given = sha256(header?.startsWith('Bearer ') ? header.slice(7) : '');
  let ok = false;
  for (const h of expectedHashes) ok = timingSafeEqual(given, h) || ok;
  return ok;
}

const idle = { interactive: 0, background: 0 };
function loadOf(vision: VisionService): VisionLoad {
  // A back-end that does not measure its queue (none in production) counts as one idle thread.
  return vision.load ?? { workers: 1, inFlight: 0, queued: idle, oldestWaitMs: idle, serviceMs: 100, estimatedWaitMs: idle, maxQueue: 256 };
}

export async function buildVisionWorker(o: VisionWorkerAppOptions): Promise<FastifyInstance> {
  const instanceId = o.instanceId ?? randomUUID();
  const expected = (Array.isArray(o.token) ? o.token : [o.token]).map(sha256);
  if (!expected.length) throw new Error('The vision worker needs a token.');
  const startedAt = Date.now();
  const vision = o.vision;
  const app = Fastify({
    ...(o.loggerInstance ? { loggerInstance: o.loggerInstance } : { logger: o.logger ?? false }),
    bodyLimit: WORKER_MAX_BODY_BYTES,
    // Keep-alive connections from the server's driver are reused for every frame (the driver closes idle ones first).
    keepAliveTimeout: 65_000,
  });

  const send = (reply: FastifyReply, status: number, body: object) => reply.status(status).header('content-type', 'application/json; charset=utf-8').send(stringify(body));
  const fail = (reply: FastifyReply, status: number, error: WorkerErrorCode, message: string, extra: Partial<WorkerErrorBody> = {}) =>
    send(reply, status, { error, message, ...extra } satisfies WorkerErrorBody);

  app.addContentTypeParser(['image/jpeg', 'image/jpg', 'application/octet-stream'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Before the body is read: an unauthenticated client cannot make the worker buffer an image.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    if (!tokenMatches(req.headers.authorization, expected)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return fail(reply, 401, 'unauthorized', 'A valid vision worker token is required.');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string; retryAfterSec?: number };
    if (e.name === 'VisionBusyError') {
      const retryAfterSec = e.retryAfterSec ?? 2;
      reply.header('Retry-After', String(retryAfterSec));
      return fail(reply, 503, 'vision_busy', 'The face-analysis queue is full.', { retryAfterSec, load: loadOf(vision) });
    }
    if (e.name === 'VisionCancelledError') {
      // The server stopped waiting (its timeout) while the analysis was queued: dropped, and nobody reads this answer.
      return fail(reply, 503, 'vision_busy', 'The analysis was cancelled before it started.', { retryAfterSec: 2 });
    }
    if (e.name === 'VisionClosedError') {
      reply.header('Retry-After', '2');
      return fail(reply, 503, 'vision_unavailable', 'This vision worker is shutting down.', { retryAfterSec: 2 });
    }
    if (e.name === 'VisionInputError') return fail(reply, 400, 'invalid_image', e.message);
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) return fail(reply, 413, 'payload_too_large', 'The image is too large.');
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.statusCode === 415) return fail(reply, 415, 'unsupported_media_type', 'Send the image as image/jpeg.');
    if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) return fail(reply, 400, 'invalid_image', e.message);
    // The error only (never the request body): the image must not reach the logs.
    req.log.error({ err: { name: e.name, message: e.message, code: e.code } }, 'face analysis failed');
    return fail(reply, 500, 'analysis_failed', e.message, { name: e.name });
  });

  app.setNotFoundHandler((req, reply) => fail(reply, 404, 'not_found', `Route ${req.method} ${req.url.split('?')[0]} not found`));

  // Per-frame routes log warnings and errors only (dozens of frames per second); the image is never logged.
  const quiet = { logLevel: 'warn' as const };

  app.get('/health/live', quiet, async (_req, reply) => send(reply, 200, { ok: true, instanceId, uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
  app.get('/health/ready', quiet, async (_req, reply) => {
    const workers = loadOf(vision).workers;
    return send(reply, workers > 0 ? 200 : 503, { ok: workers > 0, workers, instanceId });
  });
  app.get('/v1/load', quiet, async (_req, reply) => send(reply, 200, { instanceId, load: loadOf(vision) } satisfies LoadAnswer));

  /** The image body, or a 400 / 415 answer. */
  const imageOf = (body: unknown): Buffer => {
    if (!Buffer.isBuffer(body) || body.length === 0) throw Object.assign(new Error('Send the image bytes as the request body (Content-Type: image/jpeg).'), { statusCode: 415 });
    return body;
  };
  /** No ready analysis thread (e.g. all restarting): refuse at once so the driver can send the frame elsewhere. */
  const unavailable = (reply: FastifyReply) => {
    if (loadOf(vision).workers > 0) return false;
    reply.header('Retry-After', '5');
    void fail(reply, 503, 'vision_unavailable', 'No face-analysis thread is ready on this worker.', { retryAfterSec: 5, load: loadOf(vision) });
    return true;
  };
  /** Aborts when the server stops waiting for this answer (its timeout closed the connection): queued work is dropped. */
  const abandoned = (reply: FastifyReply): AbortSignal => {
    const ac = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) ac.abort();
    });
    return ac.signal;
  };
  const timed = async (image: Buffer, opts: AnalyzeOptions, signal?: AbortSignal): Promise<TimedAnalysis> => {
    if (signal?.aborted) throw new VisionCancelledError();
    if (vision.analyzeTimed) return vision.analyzeTimed(image, opts, signal);
    const t0 = performance.now();
    const analysis = await vision.analyze(image, opts);
    return { analysis, waitMs: 0, runMs: Math.round(performance.now() - t0) };
  };

  app.post('/v1/analyze', quiet, async (req, reply) => {
    const opts = decodeOptions(req.headers[OPTIONS_HEADER] as string | undefined);
    const image = imageOf(req.body);
    if (unavailable(reply)) return reply;
    const r = await timed(image, opts, abandoned(reply));
    return send(reply, 200, { instanceId, analysis: encodeAnalysis(r.analysis), timings: [{ waitMs: r.waitMs, runMs: r.runMs }], load: loadOf(vision) } satisfies AnalyzeAnswer);
  });

  app.post('/v1/id-photo', quiet, async (req, reply) => {
    const image = imageOf(req.body);
    if (unavailable(reply)) return reply;
    // processIdPhoto analyses the photo and three perturbed copies (template stability) with interactive priority.
    const timings: WireTiming[] = [];
    const signal = abandoned(reply);
    const counting: VisionService = {
      analyze: async (img: Buffer, opts?: AnalyzeOptions): Promise<ImageAnalysis> => {
        const r = await timed(img, opts ?? {}, signal);
        timings.push({ waitMs: r.waitMs, runMs: r.runMs });
        return r.analysis;
      },
      close: async () => undefined,
    };
    const result = await processIdPhoto(counting, image);
    return send(reply, 200, { instanceId, result: encodeIdPhotoResult(result), timings, load: loadOf(vision) } satisfies IdPhotoAnswer);
  });

  return app;
}
