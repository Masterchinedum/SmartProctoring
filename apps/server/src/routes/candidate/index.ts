/**
 * /api/candidate/* — authenticated by `Authorization: Bearer <accessToken>`; every request also carries
 * `X-Client-Instance: <clientInstanceId>`. Contract: packages/shared/src/api.ts.
 */
import {
  consentRequestSchema,
  eventBatchRequestSchema,
  heartbeatRequestSchema,
  identitySampleQuerySchema,
  pauseRequestSchema,
  saveAnswerRequestSchema,
  startCheckRequestSchema,
  type CandidateSessionState,
  type PauseResponse,
} from '@sp/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { bearerToken, candidateAuth, getCandidate, requireInstanceId } from '../../auth/candidate.js';
import { isJpeg, jpegDimensions, sha256Hex } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import {
  acceptConsent,
  cancelPauseRequest,
  candidateSubmit,
  heartbeat,
  requestPause,
  saveAnswer,
  startSession,
} from '../../services/candidate-actions.js';
import { buildCandidateState } from '../../services/candidate-state.js';
import { completeCheck, startCheck, submitCheckFrame } from '../../services/checks.js';
import { processIdentitySample } from '../../services/identity-samples.js';
import { ingestEvents, uploadEventEvidence } from '../../services/ingest.js';
import { trackInstanceRequest } from '../../services/instance-usage.js';

const uuid = z.string().uuid();
const optNum = z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().finite().optional());

const frameQuerySchema = z.object({
  step: z.union([z.literal('frontal'), z.string().regex(/^\d{1,2}$/)]),
  capturedAt: optNum,
  nonce: z.string().max(200).optional(),
  clientYaw: optNum,
  clientPitch: optNum,
});

const evidenceQuerySchema = z.object({
  eventId: z.preprocess((v) => (v === '' ? undefined : v), uuid.optional()),
  capturedAt: optNum,
  reason: z.string().max(40).optional(),
});

/**
 * Candidate frames are at most 640x480 (web client); anything beyond 4K is refused before it is decoded, so a
 * small progressive JPEG declaring tens of megapixels cannot tie up the vision pool (decompression bomb).
 */
export const CANDIDATE_JPEG_MAX_SIDE = 4096;
export const CANDIDATE_JPEG_MAX_PIXELS = 3840 * 2160;

function jpegBody(req: FastifyRequest): Buffer {
  const body = req.body;
  if (!Buffer.isBuffer(body) || !isJpeg(body)) throw new HttpError(415, 'invalid_image', 'Expected a JPEG image body (Content-Type: image/jpeg)');
  const size = jpegDimensions(body);
  if (size && (size.width > CANDIDATE_JPEG_MAX_SIDE || size.height > CANDIDATE_JPEG_MAX_SIDE || size.width * size.height > CANDIDATE_JPEG_MAX_PIXELS)) {
    throw new HttpError(413, 'image_too_large', `Images larger than ${CANDIDATE_JPEG_MAX_SIDE} pixels per side are not accepted.`);
  }
  return body;
}

/**
 * Rate-limit key: the access token (normalised, hashed), falling back to the client IP. Keying on the parsed
 * token rather than the raw header means `Bearer  <token>` / `bearer <token>` variants share one bucket.
 */
function tokenKey(req: FastifyRequest): string {
  const token = bearerToken(req);
  return token ? `t:${sha256Hex(token).slice(0, 32)}` : `ip:${req.ip}`;
}

const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: tokenKey } });

/** Client address (trust-proxy aware) and User-Agent, for concurrent-use detection (hashed there). */
function clientMeta(req: FastifyRequest): { ip: string; userAgent: string } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? '' };
}

export const candidateRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  app.addHook('preHandler', candidateAuth);
  // Concurrent use of the verified instance id from another device/network (services/instance-usage.ts). The
  // heartbeat does this itself (it also tracks `seq`).
  app.addHook('preHandler', async (req) => {
    const c = req.candidateAuth;
    if (!c?.instanceId || req.routeOptions.url?.endsWith('/heartbeat')) return;
    try {
      await trackInstanceRequest(ctx, c.session, c.instanceId, clientMeta(req));
    } catch (err) {
      req.log.error({ err, sessionId: c.session.id }, 'concurrent-use tracking failed (request continues)');
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  const state = (req: FastifyRequest): Promise<CandidateSessionState> => {
    const c = getCandidate(req);
    return buildCandidateState(ctx, ctx.db, c.session.id, c.instanceId);
  };

  app.get('/session', { config: limit(240) }, async (req) => state(req));

  app.post('/consent', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    const body = consentRequestSchema.parse(req.body);
    await acceptConsent(ctx, c.session.id, body, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    return state(req);
  });

  app.post('/checks', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    return startCheck(ctx, c.session.id, instanceId, startCheckRequestSchema.parse(req.body));
  });

  app.post('/checks/:checkId/frames', { config: limit(180) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const { checkId } = z.object({ checkId: uuid }).parse(req.params);
    const q = frameQuerySchema.parse(req.query);
    return submitCheckFrame(ctx, c.session.id, c.session.orgId, c.session.candidateId, instanceId, checkId, q, jpegBody(req));
  });

  app.post('/checks/:checkId/complete', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const { checkId } = z.object({ checkId: uuid }).parse(req.params);
    return completeCheck(ctx, c.session.id, instanceId, checkId);
  });

  app.post('/start', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    await startSession(ctx, c.session.id, requireInstanceId(req));
    return state(req);
  });

  app.put('/answers/:questionId', { config: limit(600) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const { questionId } = z.object({ questionId: uuid }).parse(req.params);
    return saveAnswer(ctx, c.session, instanceId, questionId, saveAnswerRequestSchema.parse(req.body));
  });

  app.post('/heartbeat', { config: limit(120) }, async (req) => {
    const c = getCandidate(req);
    return heartbeat(ctx, c.session.id, requireInstanceId(req), heartbeatRequestSchema.parse(req.body), clientMeta(req));
  });

  app.post('/events/batch', { config: limit(240) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const body = eventBatchRequestSchema.parse(req.body);
    return ingestEvents(ctx, c.session, c.policy, instanceId, body.events);
  });

  app.put('/evidence/:evidenceId', { config: limit(240) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const { evidenceId } = z.object({ evidenceId: uuid }).parse(req.params);
    const q = evidenceQuerySchema.parse(req.query);
    return uploadEventEvidence(ctx, c.session, c.policy, instanceId, evidenceId, q, jpegBody(req));
  });

  app.post('/identity/sample', { config: limit(60) }, async (req) => {
    const c = getCandidate(req);
    const instanceId = requireInstanceId(req);
    const q = identitySampleQuerySchema.parse(req.query);
    return processIdentitySample(ctx, c.session, instanceId, q, jpegBody(req));
  });

  app.post('/pause', { config: limit(30) }, async (req): Promise<PauseResponse> => {
    const c = getCandidate(req);
    const body = pauseRequestSchema.parse(req.body ?? {});
    const r = await requestPause(ctx, c.session.id, requireInstanceId(req), body.reason);
    return { ...r, state: await state(req) };
  });

  app.post('/pause/cancel', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    await cancelPauseRequest(ctx, c.session.id, requireInstanceId(req));
    return state(req);
  });

  app.post('/submit', { config: limit(30) }, async (req) => {
    const c = getCandidate(req);
    await candidateSubmit(ctx, c.session.id, requireInstanceId(req));
    return state(req);
  });
};
