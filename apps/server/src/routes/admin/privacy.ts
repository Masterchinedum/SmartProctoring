/**
 * Staff API — privacy operations (services/privacy-requests.ts, privacy-export.ts, privacy-ops.ts). Administrators
 * and owners only: the register holds what people asked, and an export holds everything about a candidate.
 *
 *   GET  /privacy-requests?status=open|closed|all&candidateId=  -> PrivacyRequestsDTO   [admin]
 *   POST /privacy-requests  CreatePrivacyRequest                -> PrivacyRequestDTO    [admin]
 *   GET  /privacy-requests/:id                                  -> PrivacyRequestDTO    [admin]
 *   PUT  /privacy-requests/:id  UpdatePrivacyRequest            -> PrivacyRequestDTO    [admin]  status / assignee / extension / resolution
 *   GET  /privacy-requests/:id/export                           -> application/zip      [admin]  the candidate's data (audited)
 *   POST /privacy-requests/:id/erase {confirm:true}             -> { request, sessionsDeleted, evidencePurged } [admin]  erasure requests only
 *   GET  /retention/preview?days=                               -> RetentionPreviewDTO  [admin]
 *   GET  /ops/checks                                            -> OpsChecksDTO         [admin]
 *
 * Exports exist only through a register entry, so every copy of a candidate's data that left the system is accounted
 * for (request.exportedAt, audit `privacy_request.exported`).
 */
import {
  createPrivacyRequestSchema,
  erasePrivacyRequestSchema,
  privacyRequestListQuerySchema,
  retentionPreviewQuerySchema,
  updatePrivacyRequestSchema,
  type OpsChecksDTO,
  type PrivacyRequestDTO,
  type PrivacyRequestsDTO,
  type RetentionPreviewDTO,
} from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { privacyRequests } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict } from '../../lib/errors.js';
import { zipStream } from '../../lib/zip.js';
import { buildCandidateExport } from '../../services/privacy-export.js';
import { opsChecks, retentionPreview } from '../../services/privacy-ops.js';
import { createPrivacyRequest, eraseForRequest, listPrivacyRequests, loadPrivacyRequest, privacyRequestDTO, updatePrivacyRequest } from '../../services/privacy-requests.js';
import { blankToUndefined, idParam, noStore } from './common.js';

/** RFC 6266: an ASCII fallback plus the UTF-8 name. */
function attachment(filename: string): string {
  const ascii = filename.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'export.zip';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const privacyRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const admin = { preHandler: requireStaff('admin') };
  const actorOf = (staff: ReturnType<typeof getStaff>, ip: string) => ({ id: staff.id, orgId: staff.orgId, ip });

  app.get('/privacy-requests', admin, async (req, reply): Promise<PrivacyRequestsDTO> => {
    const staff = getStaff(req);
    noStore(reply);
    return listPrivacyRequests(ctx, staff.orgId, privacyRequestListQuerySchema.parse(blankToUndefined(req.query)), ctx.now());
  });

  app.post('/privacy-requests', admin, async (req): Promise<PrivacyRequestDTO> => {
    const staff = getStaff(req);
    const body = createPrivacyRequestSchema.parse(req.body ?? {});
    const now = ctx.now();
    const row = await ctx.db.transaction((tx) => createPrivacyRequest(ctx, tx, actorOf(staff, req.ip), body, now));
    return privacyRequestDTO(ctx, staff.orgId, row.id, now);
  });

  app.get('/privacy-requests/:id', admin, async (req, reply): Promise<PrivacyRequestDTO> => {
    const staff = getStaff(req);
    noStore(reply);
    return privacyRequestDTO(ctx, staff.orgId, idParam(req, 'id', 'Request', 'privacy_request_not_found'), ctx.now());
  });

  app.put('/privacy-requests/:id', admin, async (req): Promise<PrivacyRequestDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Request', 'privacy_request_not_found');
    const body = updatePrivacyRequestSchema.parse(req.body ?? {});
    const now = ctx.now();
    await ctx.db.transaction((tx) => updatePrivacyRequest(tx, actorOf(staff, req.ip), id, body, now));
    return privacyRequestDTO(ctx, staff.orgId, id, now);
  });

  app.get('/privacy-requests/:id/export', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Request', 'privacy_request_not_found');
    const request = await loadPrivacyRequest(ctx.db, staff.orgId, id);
    if (!request.candidateId) {
      throw conflict('no_candidate', request.erasedAt ? 'The candidate was erased, so there is no data left to export.' : 'Link the request to a candidate record before exporting their data.');
    }
    const now = ctx.now();
    const exp = await buildCandidateExport(ctx, staff.orgId, request.candidateId, { requestId: id, generatedBy: staff.name });
    // Recorded before streaming starts: the archive is produced from here on (a dropped download is still an export).
    await ctx.db.transaction(async (tx) => {
      await tx.update(privacyRequests).set({ exportedAt: new Date(now), updatedAt: new Date(now) }).where(eq(privacyRequests.id, id));
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'privacy_request.exported', targetType: 'privacy_request', targetId: id, meta: { candidateId: request.candidateId, ...exp.counts }, ip: req.ip, at: now });
    });
    const stream = zipStream(exp.entries);
    stream.on('error', (err) => req.log.error({ err, privacyRequestId: id }, 'personal-data export failed while streaming'));
    return noStore(reply).type('application/zip').header('Content-Disposition', attachment(exp.filename)).send(stream);
  });

  app.post('/privacy-requests/:id/erase', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Request', 'privacy_request_not_found');
    erasePrivacyRequestSchema.parse(req.body ?? {});
    const result = await eraseForRequest(ctx, actorOf(staff, req.ip), id);
    return { request: await privacyRequestDTO(ctx, staff.orgId, id, ctx.now()), ...result };
  });

  app.get('/retention/preview', admin, async (req): Promise<RetentionPreviewDTO> => {
    const staff = getStaff(req);
    const q = retentionPreviewQuerySchema.parse(blankToUndefined(req.query));
    return retentionPreview(ctx, staff.orgId, q.days, ctx.now());
  });

  app.get('/ops/checks', admin, async (req): Promise<OpsChecksDTO> => opsChecks(ctx, getStaff(req).orgId, ctx.now()));
};
