/**
 * Staff API — tools.
 *
 *   POST /tools/identity-test?testId=<uuid>&mode=enroll|probe|reset   body image/jpeg (none for reset)
 *        -> IdentityTestResponse                                                              [reviewer]
 *
 * Camera self-test of the identity pipeline (services/identity-selftest.ts): an operator enrols their own face
 * with their webcam and probes with the same or another person to see quality, guidance, similarity, the
 * per-sample decision, the LLR and the accumulated evidence exactly as an exam would compute them. Transient
 * in-memory galleries per staff user (15 min TTL, <= 20 enrolment frames); nothing is stored. The audit log records
 * that the tool was used (once per test id, and resets), never images or scores.
 *
 * Errors: 415 when the body is not a JPEG, 413 for images above 4096 px per side, 409 not_enrolled (probe before a
 * usable enrolment frame), 409 too_many_frames / too_many_probes (reset the test).
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { organizations } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { isJpeg, jpegDimensions } from '../../lib/crypto.js';
import { conflict, HttpError, unsupportedMedia } from '../../lib/errors.js';
import { runSelfTest, SelfTestError } from '../../services/identity-selftest.js';
import { orgThresholds } from '../../services/org.js';

const MAX_SIDE = 4096;
const MAX_PIXELS = 3840 * 2160;

const querySchema = z.object({
  testId: z.string().uuid(),
  mode: z.enum(['enroll', 'probe', 'reset']),
});

export const toolRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };

  app.post('/tools/identity-test', { ...reviewer, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const staff = getStaff(req);
    const q = querySchema.parse(req.query);
    let jpeg: Buffer | null = null;
    if (q.mode !== 'reset') {
      const body = req.body;
      if (!Buffer.isBuffer(body) || !isJpeg(body)) throw unsupportedMedia('Send a JPEG camera frame (Content-Type: image/jpeg).');
      const size = jpegDimensions(body);
      if (size && (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS)) {
        throw new HttpError(413, 'image_too_large', `Images larger than ${MAX_SIDE} pixels per side are not accepted.`);
      }
      jpeg = body;
    }
    const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, staff.orgId));
    try {
      const { response, created } = await runSelfTest(ctx, { staffId: staff.id, testId: q.testId.toLowerCase(), mode: q.mode, thresholds: orgThresholds(org ?? null) }, jpeg);
      if (created || q.mode === 'reset') {
        await audit(ctx.db, {
          orgId: staff.orgId,
          actorType: 'staff',
          actorId: staff.id,
          action: q.mode === 'reset' ? 'tools.identity_test_reset' : 'tools.identity_test',
          targetType: 'identity_test',
          targetId: q.testId,
          meta: { mode: q.mode },
          ip: req.ip,
          at: ctx.now(),
        });
      }
      return response;
    } catch (err) {
      if (err instanceof SelfTestError) throw conflict(err.code, err.message);
      throw err;
    }
  });
};

export default toolRoutes;
