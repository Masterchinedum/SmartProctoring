/**
 * Staff API — external second-opinion face verifier (docs/EXTERNAL_VERIFIER.md). [admin]
 *
 *   GET  /verifiers                        -> ExternalVerifierInfoDTO        (providers offered by this server)
 *   POST /verifiers/test  body image/jpeg  -> ExternalVerifierTestResultDTO  (the image compared with ITSELF using the
 *                                             SAVED settings; 409 verifier_not_configured when no provider is chosen)
 *
 * The settings themselves are part of GET/PUT /settings (`externalVerifier`, routes/admin/org.ts). The test sends
 * the uploaded image to the provider — nothing is stored — and is audit-logged (`external_verifier.tested`).
 */
import { EXTERNAL_VERIFIER_NAMES, type ExternalVerifierInfoDTO, type ExternalVerifierProvider, type ExternalVerifierTestResultDTO } from '@sp/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { audit } from '../../lib/audit.js';
import { isJpeg } from '../../lib/crypto.js';
import { conflict, unsupportedMedia } from '../../lib/errors.js';
import { orgSettings } from '../../services/org.js';
import { ExternalVerifierError } from '../../verifiers/types.js';
import { loadOrgRow } from './common.js';

/** Rekognition accepts image bytes up to 5 MB. */
export const VERIFIER_TEST_MAX_BYTES = 5 * 1024 * 1024;

export const verifierRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const admin = { preHandler: requireStaff('admin') };

  app.get('/verifiers', admin, async (): Promise<ExternalVerifierInfoDTO> => {
    const cfg = ctx.config.externalVerifiers;
    return {
      providers: ctx.verifiers.providers().map((p) => ({
        id: p.id as Exclude<ExternalVerifierProvider, 'none'>,
        name: EXTERNAL_VERIFIER_NAMES[p.id as ExternalVerifierProvider] ?? p.displayName,
        location: p.location,
        available: cfg.allowedProviders.includes(p.id),
      })),
      envCredentialsAllowed: cfg.allowEnvCredentials,
      timeoutMs: cfg.timeoutMs,
    };
  });

  app.post('/verifiers/test', { ...admin, bodyLimit: VERIFIER_TEST_MAX_BYTES, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<ExternalVerifierTestResultDTO> => {
    const staff = getStaff(req);
    const image = req.body;
    if (!Buffer.isBuffer(image) || !isJpeg(image)) throw unsupportedMedia('Send a JPEG photo with one clear face (Content-Type: image/jpeg).');
    const s = orgSettings(await loadOrgRow(ctx, staff.orgId)).externalVerifier;
    if (s.provider === 'none') throw conflict('verifier_not_configured', 'Choose an external verifier and save its settings first.');
    if (!ctx.config.externalVerifiers.allowedProviders.includes(s.provider)) throw conflict('verifier_unavailable', 'This provider is not available on this server (EXTERNAL_VERIFIERS).');

    let result: ExternalVerifierTestResultDTO;
    try {
      const r = await ctx.verifiers.compare(ctx, staff.orgId, s, { reference: [image], probe: image }, { bypassBreaker: true });
      result = { ok: true, provider: s.provider, faceFound: r.faceFound, similarity: r.faceFound ? r.similarity : null, latencyMs: r.latencyMs, error: null };
    } catch (err) {
      const e = err instanceof ExternalVerifierError ? err : new ExternalVerifierError('provider_error', 'Unexpected error');
      if (!(err instanceof ExternalVerifierError)) req.log.error({ err }, 'external verifier test failed unexpectedly');
      result = { ok: false, provider: s.provider, faceFound: false, similarity: null, latencyMs: e.latencyMs, error: { code: e.code, message: e.message } };
    }
    await audit(ctx.db, {
      orgId: staff.orgId,
      actorType: 'staff',
      actorId: staff.id,
      action: 'external_verifier.tested',
      targetType: 'organization',
      targetId: staff.orgId,
      meta: { provider: s.provider, region: s.region, ok: result.ok, faceFound: result.faceFound, error: result.error?.code ?? null, latencyMs: result.latencyMs },
      ip: req.ip,
      at: ctx.now(),
    });
    return result;
  });
};
