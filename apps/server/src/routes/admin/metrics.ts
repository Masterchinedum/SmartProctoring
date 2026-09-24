/**
 * Staff API — detection quality.
 *
 *   GET  /metrics/detection-quality?from=&to=   -> DetectionQualityDTO  (defaults: from=0 i.e. all time, to=now) [reviewer]
 *   POST /metrics/offline-evaluation            -> { id, kind, createdAt }                      [admin]
 *        body: the JSON report written by an eval CLI (e.g. `eval:identity --out report.json`),
 *        or { kind, report }. Stored in evaluation_reports; the latest report per kind is returned
 *        as `offlineEvaluation.reports[]` by the detection-quality endpoint.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff } from '../../auth/staff.js';
import { audit } from '../../lib/audit.js';
import { validationFailed } from '../../lib/errors.js';
import { detectionQuality, offlineReportKind, storeOfflineEvaluation } from '../../services/metrics.js';
import { blankToUndefined } from './common.js';

export const OFFLINE_REPORT_MAX_BYTES = 10 * 1024 * 1024;

const rangeSchema = z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional() });

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;

  app.get('/metrics/detection-quality', { preHandler: requireStaff('reviewer') }, async (req) => {
    const staff = getStaff(req);
    const q = rangeSchema.parse(blankToUndefined(req.query));
    // No range = all time (the web's "All time" option sends neither bound).
    const to = q.to ?? ctx.now();
    const from = q.from ?? 0;
    if (from > to) throw validationFailed('Invalid range', [{ path: 'from', message: '`from` must not be after `to`' }]);
    return detectionQuality(ctx, staff.orgId, from, to);
  });

  app.post('/metrics/offline-evaluation', { preHandler: requireStaff('admin'), bodyLimit: OFFLINE_REPORT_MAX_BYTES }, async (req) => {
    const staff = getStaff(req);
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      throw validationFailed('Upload the JSON report produced by an evaluation tool', [{ path: '', message: 'Expected a JSON object' }]);
    }
    const wrapped = 'report' in body && typeof (body as { report: unknown }).report === 'object' && (body as { report: unknown }).report !== null;
    const report = wrapped ? (body as { report: unknown }).report : body;
    const kind = offlineReportKind(wrapped ? (body as { kind?: unknown }).kind : undefined, report);
    if (!kind) throw validationFailed('Unknown report kind', [{ path: 'kind', message: 'Set `kind` (e.g. "identity-eval") or upload a report with a `tool` field' }]);
    const entry = await storeOfflineEvaluation(ctx, staff.orgId, kind, report);
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'metrics.offline_evaluation_uploaded', targetType: 'evaluation_report', targetId: entry.id, meta: { kind }, ip: req.ip, at: ctx.now() });
    return { id: entry.id, kind: entry.kind, createdAt: entry.createdAt };
  });
};
