/**
 * Staff API — candidates and approved ID photos.
 *
 *   GET    /candidates?q=&limit=&offset=      -> { items: CandidateDTO[] }       [reviewer]
 *   POST   /candidates  CandidateInput        -> CandidateDTO                    [admin]
 *   GET    /candidates/:id                    -> CandidateDTO                    [reviewer]
 *   PUT    /candidates/:id  CandidateInput    -> CandidateDTO                    [admin]
 *   DELETE /candidates/:id                    -> { ok }  (409 while a session has not ended)  [admin]
 *   PUT    /candidates/:id/id-photo (image/jpeg, <= 5 MB) -> IdPhotoUploadResponse  [admin]
 *   DELETE /candidates/:id/id-photo           -> CandidateDTO                    [admin]
 *
 * ID photo upload: the photo is analysed under the ID-photo quality gate. If accepted, the JPEG is
 * stored as encrypted evidence (kind id_photo) and the face template encrypted with AAD
 * `idphoto:<candidateId>`; a previous photo is purged. If not accepted, NOTHING is stored and the
 * response (200) is the same IdPhotoUploadResponse with accepted=false, the quality measurements and
 * guidance for the staff member (the shared contract; the web UI shows the guidance). A body that is not
 * a JPEG is 415; an unreadable JPEG is 422 invalid_image; more than 5 MB is 413.
 */
import { candidateInputSchema, TERMINAL_STATUSES, type CandidateDTO, type IdPhotoUploadResponse } from '@sp/shared';
import { and, asc, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getStaff, requireStaff } from '../../auth/staff.js';
import type { DbOrTx } from '../../db/index.js';
import { candidates, evidence, examSessions, exams, type Candidate } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { isJpeg } from '../../lib/crypto.js';
import { conflict, HttpError, notFound, unsupportedMedia } from '../../lib/errors.js';
import { purgeCandidateIdPhoto, purgeEvidenceRows, purgeSessionEvidence, storeEvidence } from '../../services/evidence.js';
import { serializeEmbeddings } from '../../vision/embeddings.js';
import { processIdPhoto } from '../../vision/id-photo.js';
import type { IdPhotoCapableVisionService, IdPhotoResult } from '../../vision/types.js';
import { blankToUndefined, escapeLike, idParam } from './common.js';

export const ID_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ------------------------------------------------------------------ mapping */

export async function candidateDTOs(db: DbOrTx, rows: Candidate[]): Promise<CandidateDTO[]> {
  if (rows.length === 0) return [];
  const sessions = await db
    .select({ id: examSessions.id, candidateId: examSessions.candidateId, examId: examSessions.examId, examTitle: exams.title, status: examSessions.status })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .where(
      inArray(
        examSessions.candidateId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(desc(examSessions.createdAt), desc(examSessions.id));
  const byCandidate = new Map<string, CandidateDTO['sessions']>();
  for (const s of sessions) byCandidate.set(s.candidateId, [...(byCandidate.get(s.candidateId) ?? []), { id: s.id, examId: s.examId, examTitle: s.examTitle, status: s.status }]);
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email ?? null,
    externalId: c.externalId ?? null,
    idPhoto: c.idPhotoEvidenceId && c.idPhotoApprovedAt ? { evidenceId: c.idPhotoEvidenceId, approvedAt: c.idPhotoApprovedAt.getTime(), quality: c.idPhotoQuality ?? null } : null,
    createdAt: c.createdAt.getTime(),
    sessions: byCandidate.get(c.id) ?? [],
  }));
}

async function candidateDTO(db: DbOrTx, orgId: string, id: string): Promise<CandidateDTO> {
  const row = await loadScopedCandidate(db, orgId, id);
  return (await candidateDTOs(db, [row]))[0];
}

async function loadScopedCandidate(db: DbOrTx, orgId: string, id: string, lock = false): Promise<Candidate> {
  const q = db
    .select()
    .from(candidates)
    .where(and(eq(candidates.id, id), eq(candidates.orgId, orgId)));
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound('Candidate not found', 'candidate_not_found');
  return row;
}

function normaliseCandidateInput(body: unknown) {
  const input = candidateInputSchema.parse(body ?? {});
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v == null || v.trim() === '' ? null : v.trim());
  return { name: input.name.trim(), email: clean(input.email), externalId: clean(input.externalId) };
}

async function assertExternalIdFree(db: DbOrTx, orgId: string, externalId: string | null | undefined, exceptId?: string): Promise<void> {
  if (!externalId) return;
  const [dup] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.orgId, orgId), eq(candidates.externalId, externalId), exceptId ? ne(candidates.id, exceptId) : undefined))
    .limit(1);
  if (dup) throw conflict('duplicate_external_id', 'Another candidate already has this external ID.', { candidateId: dup.id });
}

function isVisionInputError(err: unknown): boolean {
  return err instanceof Error && err.name === 'VisionInputError';
}

/* ------------------------------------------------------------------ routes */

export const candidatesRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };
  const admin = { preHandler: requireStaff('admin') };

  app.get('/candidates', reviewer, async (req) => {
    const staff = getStaff(req);
    const q = listQuerySchema.parse(blankToUndefined(req.query));
    const text = q.q?.trim();
    const like = text ? `%${escapeLike(text)}%` : null;
    const rows = await ctx.db
      .select()
      .from(candidates)
      .where(and(eq(candidates.orgId, staff.orgId), like ? or(ilike(candidates.name, like), ilike(candidates.email, like), ilike(candidates.externalId, like)) : undefined))
      .orderBy(asc(sql`lower(${candidates.name})`), asc(candidates.id))
      .limit(q.limit)
      .offset(q.offset);
    return { items: await candidateDTOs(ctx.db, rows) };
  });

  app.post('/candidates', admin, async (req) => {
    const staff = getStaff(req);
    const input = normaliseCandidateInput(req.body);
    const now = ctx.now();
    const row = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'candidates:' + staff.orgId}))`);
      await assertExternalIdFree(tx, staff.orgId, input.externalId);
      const [c] = await tx
        .insert(candidates)
        .values({ orgId: staff.orgId, name: input.name, email: input.email ?? null, externalId: input.externalId ?? null, createdAt: new Date(now), updatedAt: new Date(now) })
        .returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.created', targetType: 'candidate', targetId: c.id, ip: req.ip, at: now });
      return c;
    });
    return (await candidateDTOs(ctx.db, [row]))[0];
  });

  app.get('/candidates/:id', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    return candidateDTO(ctx.db, staff.orgId, id);
  });

  app.put('/candidates/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    const input = normaliseCandidateInput(req.body);
    const now = ctx.now();
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'candidates:' + staff.orgId}))`);
      const cur = await loadScopedCandidate(tx, staff.orgId, id, true);
      await assertExternalIdFree(tx, staff.orgId, input.externalId, id);
      const patch = {
        name: input.name,
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        updatedAt: new Date(now),
      };
      await tx.update(candidates).set(patch).where(eq(candidates.id, id));
      const changed = (['name', 'email', 'externalId'] as const).filter((k) => k in patch && (patch as Record<string, unknown>)[k] !== cur[k]);
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.updated', targetType: 'candidate', targetId: id, meta: { fields: changed }, ip: req.ip, at: now });
    });
    return candidateDTO(ctx.db, staff.orgId, id);
  });

  app.delete('/candidates/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    const now = ctx.now();
    await loadScopedCandidate(ctx.db, staff.orgId, id);
    const open = await ctx.db
      .select({ id: examSessions.id, status: examSessions.status })
      .from(examSessions)
      .where(and(eq(examSessions.candidateId, id), notInArray(examSessions.status, TERMINAL_STATUSES)));
    if (open.length) {
      throw conflict('candidate_has_open_sessions', 'This candidate has an exam session that has not ended. Submit or terminate it before deleting the candidate.', { sessionIds: open.map((s) => s.id) });
    }
    const sessions = await ctx.db.select({ id: examSessions.id, legalHold: examSessions.legalHold }).from(examSessions).where(eq(examSessions.candidateId, id));
    const held = sessions.filter((s) => s.legalHold);
    if (held.length) {
      throw conflict('candidate_under_legal_hold', 'A session of this candidate is under legal hold, so its evidence must be kept. Lift the legal hold before deleting the candidate.', { sessionIds: held.map((s) => s.id) });
    }
    // Delete images and templates first (blobs are not transactional), then the records.
    let purged = 0;
    for (const s of sessions) purged += (await purgeSessionEvidence(ctx, ctx.db, s.id, 'candidate_deleted')).evidence;
    await purgeCandidateIdPhoto(ctx, ctx.db, id, 'candidate_deleted');
    const leftovers = await ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.candidateId, id), isNull(evidence.purgedAt)));
    purged += await purgeEvidenceRows(ctx, ctx.db, leftovers, 'candidate_deleted');
    await ctx.db.transaction(async (tx) => {
      const sessionIds = sessions.map((s) => s.id);
      await tx.delete(evidence).where(or(eq(evidence.candidateId, id), sessionIds.length ? inArray(evidence.sessionId, sessionIds) : undefined)!);
      await tx.delete(candidates).where(and(eq(candidates.id, id), eq(candidates.orgId, staff.orgId))); // cascades to sessions and their records
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.deleted', targetType: 'candidate', targetId: id, meta: { sessionsDeleted: sessions.length, evidencePurged: purged }, ip: req.ip, at: now });
    });
    return { ok: true };
  });

  /* ------------------------------------------------------------------ ID photo */

  app.put('/candidates/:id/id-photo', { ...admin, bodyLimit: ID_PHOTO_MAX_BYTES }, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    const body = req.body;
    if (!Buffer.isBuffer(body) || !isJpeg(body)) throw unsupportedMedia('The ID photo must be a JPEG image (Content-Type: image/jpeg).');
    await loadScopedCandidate(ctx.db, staff.orgId, id);
    const now = ctx.now();

    let result: IdPhotoResult;
    try {
      const vision = ctx.vision as Partial<IdPhotoCapableVisionService>;
      result = typeof vision.processIdPhoto === 'function' ? await vision.processIdPhoto(body) : await processIdPhoto(ctx.vision, body);
    } catch (err) {
      if (isVisionInputError(err)) throw new HttpError(422, 'invalid_image', 'The image could not be read. Upload a valid JPEG photo.');
      throw err;
    }

    if (!result.accepted || !result.analysis.embedding) {
      // Processed but not suitable: nothing is stored; the response explains why (IdPhotoUploadResponse, accepted=false).
      await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.id_photo_rejected', targetType: 'candidate', targetId: id, meta: { issues: result.quality.issues }, ip: req.ip, at: now });
      const rejected: IdPhotoUploadResponse = {
        accepted: false,
        quality: result.quality,
        guidance: result.guidance.length ? result.guidance : ['The photo is not suitable for identity comparison. Upload a clear, front-facing photo of the candidate.'],
        candidate: await candidateDTO(ctx.db, staff.orgId, id),
      };
      return rejected;
    }

    const embedding = result.analysis.embedding;
    await ctx.db.transaction(async (tx) => {
      await loadScopedCandidate(tx, staff.orgId, id, true);
      const { row } = await storeEvidence(ctx, tx, { orgId: staff.orgId, candidateId: id, kind: 'id_photo', reason: 'id_photo', capturedAt: now, data: body });
      const previous = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.candidateId, id), eq(evidence.kind, 'id_photo'), isNull(evidence.sessionId), isNull(evidence.purgedAt), ne(evidence.id, row.id)));
      await tx
        .update(candidates)
        .set({
          idPhotoEvidenceId: row.id,
          idPhotoEmbedding: ctx.keyring.encrypt(serializeEmbeddings([embedding]), `idphoto:${id}`),
          idPhotoQuality: result.quality,
          idPhotoApprovedAt: new Date(now),
          idPhotoApprovedBy: staff.id,
          updatedAt: new Date(now),
        })
        .where(eq(candidates.id, id));
      const replaced = await purgeEvidenceRows(ctx, tx, previous, 'id_photo_replaced');
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.id_photo_approved', targetType: 'candidate', targetId: id, meta: { evidenceId: row.id, replaced }, ip: req.ip, at: now });
    });
    const response: IdPhotoUploadResponse = { accepted: true, quality: result.quality, guidance: [], candidate: await candidateDTO(ctx.db, staff.orgId, id) };
    return response;
  });

  app.delete('/candidates/:id/id-photo', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Candidate', 'candidate_not_found');
    const now = ctx.now();
    const cur = await loadScopedCandidate(ctx.db, staff.orgId, id);
    await purgeCandidateIdPhoto(ctx, ctx.db, id, 'id_photo_removed');
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'candidate.id_photo_removed', targetType: 'candidate', targetId: id, meta: { evidenceId: cur.idPhotoEvidenceId }, ip: req.ip, at: now });
    return candidateDTO(ctx.db, staff.orgId, id);
  });
};
