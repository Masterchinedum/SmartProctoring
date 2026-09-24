/**
 * Staff API — evidence images and the identity comparison view.
 *
 *   GET /evidence/:id                -> image/jpeg (decrypted; every access audit-logged; 410 once purged) [reviewer]
 *   GET /identity/compare/:eventId   -> IdentityComparisonDTO                                              [reviewer]
 */
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { gone, HttpError, notFound } from '../../lib/errors.js';
import { readEvidenceForStaff } from '../../services/evidence.js';
import { resolveTimeZone } from '../../services/reports-format.js';
import { buildIdentityComparison } from '../../services/reports-identity.js';
import { idParam, noStore } from './common.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const evidenceRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };

  app.get('/evidence/:id', reviewer, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Evidence', 'evidence_not_found');
    noStore(reply);
    const res = await readEvidenceForStaff(ctx, id, { id: staff.id, orgId: staff.orgId, ip: req.ip });
    if (!res) throw notFound('Evidence not found', 'evidence_not_found');
    if (!res.data) {
      if (res.row.purgedAt) {
        const reason = res.row.purgeReason === 'retention' ? 'under the retention policy' : res.row.purgeReason ? `(${res.row.purgeReason.replace(/_/g, ' ')})` : '';
        throw gone('evidence_purged', `This image was deleted on ${res.row.purgedAt.toISOString()} ${reason}`.trim() + '. The event record remains.');
      }
      // Metadata exists but the encrypted blob is missing from storage (e.g. a failed or partial purge).
      throw new HttpError(410, 'evidence_unavailable', 'This image is no longer available in the evidence store.');
    }
    const type = IMAGE_TYPES.has(res.row.contentType) ? res.row.contentType : 'application/octet-stream';
    return reply
      .header('Content-Type', type)
      .header('Content-Length', String(res.data.length))
      .header('Content-Disposition', `inline; filename="evidence-${res.row.id}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}"`)
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .send(res.data);
  });

  app.get('/identity/compare/:eventId', reviewer, async (req) => {
    const staff = getStaff(req);
    const eventId = idParam(req, 'eventId', 'Event', 'event_not_found');
    const tz = resolveTimeZone((req.query as Record<string, unknown> | undefined)?.tz);
    return buildIdentityComparison(ctx, staff.orgId, eventId, { timeZone: tz });
  });
};
