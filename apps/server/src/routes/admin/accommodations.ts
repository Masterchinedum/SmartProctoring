/**
 * Staff API — accommodations (approved per-candidate exceptions to exam rules; services/accommodations.ts).
 *
 *   GET  /candidates/:id/accommodations                 -> { items: AccommodationDTO[] }   [reviewer; notes: admin]
 *   POST /candidates/:id/accommodations  Grant          -> AccommodationDTO                [admin]
 *   POST /accommodations/:id/revoke  { reason }         -> AccommodationDTO                [admin]
 *
 * Records are never edited (a change is a revocation plus a new grant). A grant or revocation reaches the candidate's
 * sessions that have not started (their snapshot and duration are refreshed after commit); a started attempt keeps
 * the accommodations it started with. Both are audit-logged without the note, which is encrypted and shown to
 * administrators only. Reviewers see what applies (to read sessions correctly), not why.
 */
import { accommodationGrantSchema, accommodationRevokeSchema, type AccommodationDTO } from '@sp/shared';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff, roleAtLeast } from '../../auth/staff.js';
import type { Ctx } from '../../context.js';
import { accommodations, candidates, examSessions, exams } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { accommodationNoteAad, refreshSessionAccommodations, toAccommodationDTOs, UNSTARTED } from '../../services/accommodations.js';
import { withSession } from '../../services/session-state.js';
import { idParam } from './common.js';

/** After a grant / revocation: bring the candidate's unstarted sessions in line (each under its own lock, published live). */
export async function refreshCandidateSessions(ctx: Ctx, candidateId: string, examId: string | null): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.candidateId, candidateId), inArray(examSessions.status, [...UNSTARTED]), isNull(examSessions.startedAt), examId ? eq(examSessions.examId, examId) : undefined));
  for (const r of rows) await withSession(ctx, r.id, (m) => refreshSessionAccommodations(m));
  return rows.map((r) => r.id);
}

export const accommodationRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };
  const admin = { preHandler: requireStaff('admin') };

  const scopedCandidate = async (orgId: string, id: string) => {
    const [c] = await ctx.db.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.id, id), eq(candidates.orgId, orgId)));
    if (!c) throw notFound('Candidate not found', 'candidate_not_found');
    return c;
  };

  app.get('/candidates/:id/accommodations', reviewer, async (req): Promise<{ items: AccommodationDTO[] }> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    await scopedCandidate(staff.orgId, id);
    const rows = await ctx.db.select().from(accommodations).where(eq(accommodations.candidateId, id)).orderBy(desc(accommodations.grantedAt), desc(accommodations.id));
    return { items: await toAccommodationDTOs(ctx.db, ctx.keyring, rows, { includeNote: roleAtLeast(staff.role, 'admin'), now: ctx.now() }) };
  });

  app.post('/candidates/:id/accommodations', admin, async (req): Promise<AccommodationDTO> => {
    const staff = getStaff(req);
    const candidateId = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    const body = accommodationGrantSchema.parse(req.body ?? {});
    const now = ctx.now();
    if (body.validUntil != null && body.validUntil <= now) throw validationFailed('The end date must be in the future', [{ path: 'validUntil', message: 'Must be in the future' }]);
    await scopedCandidate(staff.orgId, candidateId);
    if (body.examId) {
      const [e] = await ctx.db.select({ id: exams.id }).from(exams).where(and(eq(exams.id, body.examId), eq(exams.orgId, staff.orgId)));
      if (!e) throw validationFailed('Unknown exam', [{ path: 'examId', message: 'Exam not found' }]);
    }
    const id = randomUUID();
    const [row] = await ctx.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(accommodations)
        .values({
          id,
          orgId: staff.orgId,
          candidateId,
          examId: body.examId,
          kind: body.kind,
          params: body.params as Record<string, unknown>,
          basis: body.basis,
          noteEnc: body.note ? ctx.keyring.encryptString(body.note, accommodationNoteAad(id)) : null,
          validUntil: body.validUntil != null ? new Date(body.validUntil) : null,
          grantedBy: staff.id,
          grantedAt: new Date(now),
        })
        .returning();
      // Never the note (it may describe someone's circumstances); what was granted is enough for the audit trail.
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'accommodation.granted',
        targetType: 'candidate',
        targetId: candidateId,
        meta: { accommodationId: id, kind: body.kind, params: body.params, basis: body.basis, examId: body.examId, validUntil: body.validUntil },
        ip: req.ip,
        at: now,
      });
      return inserted;
    });
    await refreshCandidateSessions(ctx, candidateId, body.examId);
    const [dto] = await toAccommodationDTOs(ctx.db, ctx.keyring, [row], { includeNote: true, now });
    return dto;
  });

  app.post('/accommodations/:id/revoke', admin, async (req): Promise<AccommodationDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Accommodation', 'accommodation_not_found');
    const body = accommodationRevokeSchema.parse(req.body ?? {});
    const now = ctx.now();
    const row = await ctx.db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(accommodations)
        .where(and(eq(accommodations.id, id), eq(accommodations.orgId, staff.orgId)))
        .for('update');
      if (!cur) throw notFound('Accommodation not found', 'accommodation_not_found');
      if (cur.revokedAt) throw conflict('already_revoked', 'This accommodation was already revoked.');
      const [updated] = await tx.update(accommodations).set({ revokedAt: new Date(now), revokedBy: staff.id, revokeReason: body.reason }).where(eq(accommodations.id, id)).returning();
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'accommodation.revoked',
        targetType: 'candidate',
        targetId: cur.candidateId,
        meta: { accommodationId: id, kind: cur.kind, reason: body.reason },
        ip: req.ip,
        at: now,
      });
      return updated;
    });
    await refreshCandidateSessions(ctx, row.candidateId, row.examId);
    const [dto] = await toAccommodationDTOs(ctx.db, ctx.keyring, [row], { includeNote: true, now });
    return dto;
  });
};
