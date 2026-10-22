/**
 * Integration API (LMS / HR systems), prefix /api/v1. Customer documentation: docs/INTEGRATION_API.md; machine-readable
 * contract: GET /api/v1/openapi.json (docs/openapi.json), generated from packages/shared/src/integrations.ts.
 *
 * Every route is registered from the endpoint catalogue (INTEGRATION_ENDPOINTS: method, path, required scope,
 * idempotency), so the code cannot drift from the documented contract; test/integrations/contract.test.ts checks that
 * no other route exists below /api/v1 and validates every response against its schema.
 *
 * Auth: `Authorization: Bearer sp_live_...` (organisation API key, auth/api-key.ts): 401 invalid_api_key / api_key_expired,
 * then the endpoint's scope (403 insufficient_scope). Every query is scoped to the key's organisation (other
 * organisations' ids are 404). Rate limit: API_RATE_LIMIT_PER_MINUTE per key (default 600/min; 429 rate_limited).
 * POSTs and PUTs accept an Idempotency-Key header (services/idempotency.ts). Writes and reads of reports / event lists
 * are audit-logged with actorType 'api_key'. Evidence images are never exposed here (staff-only); events carry an
 * evidence count and a staff link instead.
 *
 *   GET  /openapi.json                                    -> the OpenAPI 3.1 document (no API key; 60/min per IP)
 *   GET  /exams?status=                                   -> { items: IntegrationExamDTO[] }                                    exams:read
 *   POST /candidates {name, email?, externalId?}          -> { candidate, created }  201 created | 200 updated (upsert by externalId)  candidates:write
 *   GET  /candidates?externalId=&email=&limit=&offset=    -> { items: IntegrationCandidateDTO[], total }                        candidates:read
 *   POST /exams/:examId/assignments {candidateIds?, externalIds?, window?} -> { items: IntegrationAssignmentDTO[] }         assignments:write
 *   GET  /sessions?examId=&externalId=&candidateId=&status=&limit=&offset= -> { items: IntegrationSessionDTO[], total }    sessions:read
 *   GET  /sessions/:id                                    -> IntegrationSessionDTO (accessLink only with assignments:write)  sessions:read
 *   PUT  /sessions/:id/window {window, note?}             -> IntegrationSessionDTO (before the exam starts; services/scheduling.ts)  assignments:write
 *   GET  /sessions/:id/report?tz=                         -> IntegrationSessionReportDTO                                    reports:read
 *   GET  /sessions/:id/events?category=&type=&severity=&review=&since= -> { items: IntegrationEventDTO[] }                  events:read
 */
import {
  EVENT_CATALOG,
  integrationAssignSchema,
  integrationCandidateSchema,
  integrationCandidatesQuerySchema,
  integrationEndpoint,
  integrationEventsQuerySchema,
  integrationExamsQuerySchema,
  integrationOpenApiJson,
  integrationReportQuerySchema,
  integrationSessionsQuerySchema,
  rescheduleRequestSchema,
  SESSION_STATUSES,
  TERMINAL_STATUSES,
  type EventDTO,
  type IntegrationAssignmentDTO,
  type IntegrationCandidateDTO,
  type IntegrationCandidateUpsertDTO,
  type IntegrationEventDTO,
  type IntegrationExamDTO,
  type IntegrationOperationId,
  type IntegrationSessionDTO,
  type IntegrationSessionReportDTO,
  type SessionStatus,
  type SessionSummaryDTO,
} from '@sp/shared';
import { and, asc, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { bearerApiKey, getApiKey, requireApiKey, requireScope, type ApiKeyPrincipal } from '../../auth/api-key.js';
import type { Ctx } from '../../context.js';
import type { DbOrTx } from '../../db/index.js';
import { candidates, examSessions, examVersions, exams, type Candidate } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { sha256Hex } from '../../lib/crypto.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { accessLinkFor, loadSessionSummaries, sessionWindow } from '../../services/dto.js';
import { acceptWindow, rescheduleSession } from '../../services/scheduling.js';
import { sessionStaffUrl } from '../../services/email-alerts.js';
import { idempotencyGuard, storeIdempotentResponse } from '../../services/idempotency.js';
import { buildSessionReport } from '../../services/reports.js';
import { resolveTimeZone } from '../../services/reports-format.js';
import { loadOrderedSessionEvents } from '../../services/reports-timeline.js';
import { assertCandidateQuota, assertSessionQuota, recordSessionsCreated } from '../../services/quotas.js';
import { createExamSession } from '../../services/session-actions.js';
import { eventFilterCondsFrom } from '../admin/events.js';
import { blankToUndefined, idParam, isUuid, listParam } from '../admin/common.js';

/** The OpenAPI document is public (no organisation data): limited per client IP. */
export const OPENAPI_RATE_LIMIT_PER_MINUTE = 60;

/* ------------------------------------------------------------------ mapping */

export function toIntegrationCandidateDTO(c: Candidate): IntegrationCandidateDTO {
  return { id: c.id, name: c.name, email: c.email ?? null, externalId: c.externalId ?? null, createdAt: c.createdAt.getTime() };
}

const FACE_SCORE_KEY = /similarity/i;
const FACE_SCORE_TEXT = / \((?:lowest |highest )?similarity -?\d+(?:\.\d+)?\)/gi;

/** `T` with every property named like "similarity" (at any depth) typed as null — what withoutFaceScores returns. */
export type WithoutFaceScores<T> = T extends readonly (infer U)[]
  ? WithoutFaceScores<U>[]
  : T extends object
    ? { [K in keyof T]: K extends `${string}${'similarity' | 'Similarity'}${string}` ? null : WithoutFaceScores<T[K]> }
    : T;

/**
 * The integration API never carries face-similarity scores (docs/INTEGRATION_API.md): they are biometric
 * measurements that stay behind staff sign-in. Every field named like `similarity` (session identity summary,
 * ID-photo result, event details such as min/maxSimilarity) becomes null, and the "(similarity 0.31)" asides
 * in report sentences are removed.
 */
export function withoutFaceScores<T>(value: T): WithoutFaceScores<T> {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(FACE_SCORE_TEXT, '');
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = FACE_SCORE_KEY.test(k) ? null : walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as WithoutFaceScores<T>;
}

export function toIntegrationEventDTO(e: EventDTO, publicUrl: string): IntegrationEventDTO {
  const { evidence, ...rest } = e;
  // Observations reported by the candidate's browser are client-authored text: integrations get the
  // catalog wording instead (same rule as webhooks and alert emails).
  const clientSourced = e.source === 'client_vision' || e.source === 'client_browser';
  const observation = clientSourced ? EVENT_CATALOG[e.type].observation : e.observation;
  return withoutFaceScores({ ...rest, observation, evidenceCount: evidence.length, staffUrl: `${sessionStaffUrl(publicUrl, e.sessionId)}?event=${e.id}` });
}

async function integrationSessions(ctx: Ctx, orgId: string, summaries: SessionSummaryDTO[]): Promise<IntegrationSessionDTO[]> {
  if (summaries.length === 0) return [];
  const rows = await ctx.db
    .select({ id: examSessions.id, createdAt: examSessions.createdAt, score: examSessions.score })
    .from(examSessions)
    .where(
      and(
        eq(examSessions.orgId, orgId),
        inArray(
          examSessions.id,
          summaries.map((s) => s.id),
        ),
      ),
    );
  const extra = new Map(rows.map((r) => [r.id, r]));
  return summaries.map((s) => {
    const x = extra.get(s.id);
    return {
      id: s.id,
      status: s.status,
      endReason: s.endReason,
      exam: s.exam,
      examVersion: s.examVersion?.number ?? null,
      accommodations: s.accommodations ?? [],
      candidate: s.candidate,
      createdAt: x?.createdAt.getTime() ?? 0,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      remainingMs: s.remainingMs,
      timerRunning: s.timerRunning,
      pauseCount: s.pauseCount,
      score: x?.score ? { points: x.score.points, maxPoints: x.score.maxPoints, autoGraded: x.score.autoGraded, regraded: x.score.regrades?.length ?? 0 } : null,
      counts: s.counts,
      hold: s.hold,
      accessLink: s.accessLink,
      window: s.window ?? null,
      review: { state: s.review?.state ?? 'none', outcome: s.review?.outcome ?? null },
      staffUrl: sessionStaffUrl(ctx.config.publicUrl, s.id),
    };
  });
}

function normaliseCandidate(body: unknown) {
  const input = integrationCandidateSchema.parse(body ?? {});
  const clean = (v: string | null | undefined) => (v === undefined ? undefined : v == null || v.trim() === '' ? null : v.trim());
  const name = input.name.trim();
  if (!name) throw validationFailed('Request validation failed', [{ path: 'name', message: 'Required' }]);
  return { name, email: clean(input.email), externalId: clean(input.externalId) };
}

async function apiAudit(db: DbOrTx, key: ApiKeyPrincipal, now: number, action: string, targetType: string, targetId: string | null, meta: Record<string, unknown> = {}) {
  await audit(db, { orgId: key.orgId, actorType: 'api_key', actorId: key.id, action, targetType, targetId, meta: { apiKey: key.name, ...meta }, ip: key.ip, at: now });
}

/* ------------------------------------------------------------------ routes */

export const integrationApiRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const keyRateLimit = {
    max: ctx.config.integrationApi.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Per API key (hashed; no database access), falling back to the client IP for requests without a key.
    keyGenerator: (req: FastifyRequest) => {
      const key = bearerApiKey(req);
      return key ? `api:${sha256Hex(key).slice(0, 32)}` : `api-ip:${req.ip}`;
    },
  };

  /** Register an endpoint of the catalogue: its method, path, scope check and idempotency come from the contract. */
  function endpoint<T>(operationId: IntegrationOperationId, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<T>): void {
    const e = integrationEndpoint(operationId);
    const preHandler: preHandlerAsyncHookHandler[] = e.scope ? [requireApiKey, requireScope(e.scope)] : [];
    if (e.idempotent) preHandler.push(idempotencyGuard);
    app.route({
      method: e.method,
      url: e.path,
      preHandler,
      ...(e.idempotent ? { onSend: storeIdempotentResponse } : {}),
      config: { rateLimit: e.scope ? keyRateLimit : { max: OPENAPI_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
      handler,
    });
  }

  /* ---------------------------------------------------------------- the contract */

  const openApiDocument = integrationOpenApiJson({ serverUrl: `${ctx.config.publicUrl}/api/v1` });
  endpoint('getOpenApiDocument', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300').type('application/json; charset=utf-8');
    return openApiDocument;
  });

  /* ---------------------------------------------------------------- exams */

  endpoint('listExams', async (req): Promise<{ items: IntegrationExamDTO[] }> => {
    const key = getApiKey(req);
    const q = integrationExamsQuerySchema.parse(blankToUndefined(req.query));
    const rows = await ctx.db
      .select({ id: exams.id, title: exams.title, status: exams.status, durationSec: exams.durationSec, version: examVersions.number })
      .from(exams)
      .leftJoin(examVersions, eq(examVersions.id, exams.currentVersionId))
      .where(and(eq(exams.orgId, key.orgId), q.status ? eq(exams.status, q.status) : undefined))
      .orderBy(desc(exams.createdAt), desc(exams.id));
    return { items: rows };
  });

  /* ---------------------------------------------------------------- candidates */

  endpoint('upsertCandidate', async (req, reply): Promise<IntegrationCandidateUpsertDTO> => {
    const key = getApiKey(req);
    const input = normaliseCandidate(req.body);
    const now = ctx.now();
    const { row, created } = await ctx.db.transaction(async (tx) => {
      if (input.externalId) {
        // Serialise upserts of the same external id (no unique index: older data may contain duplicates).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`candidate-ext:${key.orgId}:${input.externalId}`}))`);
        const [existing] = await tx
          .select()
          .from(candidates)
          .where(and(eq(candidates.orgId, key.orgId), eq(candidates.externalId, input.externalId)))
          .orderBy(asc(candidates.createdAt))
          .limit(1);
        if (existing) {
          const patch: Partial<typeof candidates.$inferInsert> = {};
          if (input.name !== existing.name) patch.name = input.name;
          if (input.email !== undefined && input.email !== existing.email) patch.email = input.email;
          if (Object.keys(patch).length === 0) return { row: existing, created: false };
          const [updated] = await tx
            .update(candidates)
            .set({ ...patch, updatedAt: new Date(now) })
            .where(eq(candidates.id, existing.id))
            .returning();
          await apiAudit(tx, key, now, 'api.candidate.updated', 'candidate', existing.id, { fields: Object.keys(patch), externalId: input.externalId });
          return { row: updated, created: false };
        }
      }
      await assertCandidateQuota(tx, key.orgId, 1, now); // 409 quota_exceeded (services/quotas.ts)
      const [inserted] = await tx
        .insert(candidates)
        .values({ orgId: key.orgId, name: input.name, email: input.email ?? null, externalId: input.externalId ?? null, createdAt: new Date(now), updatedAt: new Date(now) })
        .returning();
      await apiAudit(tx, key, now, 'api.candidate.created', 'candidate', inserted.id, { externalId: input.externalId ?? null });
      return { row: inserted, created: true };
    });
    reply.status(created ? 201 : 200);
    return { candidate: toIntegrationCandidateDTO(row), created };
  });

  endpoint('listCandidates', async (req): Promise<{ items: IntegrationCandidateDTO[]; total: number }> => {
    const key = getApiKey(req);
    const q = integrationCandidatesQuerySchema.parse(blankToUndefined(req.query));
    const where = and(
      eq(candidates.orgId, key.orgId),
      q.externalId ? eq(candidates.externalId, q.externalId.trim()) : undefined,
      q.email ? eq(sql`lower(${candidates.email})`, q.email.trim().toLowerCase()) : undefined,
    );
    const [[{ total }], rows] = await Promise.all([
      ctx.db.select({ total: sql<number>`count(*)::int` }).from(candidates).where(where),
      ctx.db.select().from(candidates).where(where).orderBy(asc(candidates.createdAt), asc(candidates.id)).limit(q.limit).offset(q.offset),
    ]);
    return { items: rows.map(toIntegrationCandidateDTO), total };
  });

  /* ---------------------------------------------------------------- assignments */

  endpoint('assignCandidates', async (req): Promise<{ items: IntegrationAssignmentDTO[] }> => {
    const key = getApiKey(req);
    const examId = idParam(req, 'examId', 'Exam', 'exam_not_found');
    const body = integrationAssignSchema.parse(req.body ?? {});
    const now = ctx.now();
    const window = acceptWindow(body.window, now);
    const items = await ctx.db.transaction(async (tx) => {
      const [exam] = await tx
        .select()
        .from(exams)
        .where(and(eq(exams.id, examId), eq(exams.orgId, key.orgId)))
        .for('update'); // serialises concurrent assignment requests for this exam
      if (!exam) throw notFound('Exam not found', 'exam_not_found');
      if (exam.status !== 'published') {
        throw conflict('exam_not_published', exam.status === 'archived' ? 'This exam is archived; candidates can no longer be assigned.' : 'Publish the exam before assigning candidates.');
      }
      const ids = [...new Set((body.candidateIds ?? []).map((c) => c.trim().toLowerCase()))];
      const extIds = [...new Set((body.externalIds ?? []).map((c) => c.trim()))];
      const byId = ids.filter(isUuid).length
        ? await tx
            .select()
            .from(candidates)
            .where(and(eq(candidates.orgId, key.orgId), inArray(candidates.id, ids.filter(isUuid))))
        : [];
      const byExt = extIds.length
        ? await tx
            .select()
            .from(candidates)
            .where(and(eq(candidates.orgId, key.orgId), inArray(candidates.externalId, extIds)))
            .orderBy(asc(candidates.createdAt))
        : [];
      const issues: { path: string; message: string }[] = [];
      const unknownIds = ids.filter((id) => !byId.some((c) => c.id === id));
      if (unknownIds.length) issues.push({ path: 'candidateIds', message: `Unknown candidate ids: ${unknownIds.join(', ')}` });
      const extMap = new Map<string, Candidate>();
      for (const c of byExt) if (c.externalId && !extMap.has(c.externalId)) extMap.set(c.externalId, c);
      const unknownExt = extIds.filter((x) => !extMap.has(x));
      if (unknownExt.length) issues.push({ path: 'externalIds', message: `Unknown external ids: ${unknownExt.join(', ')} (create them with POST /api/v1/candidates first)` });
      if (issues.length) throw validationFailed('Some candidates were not found', issues);

      // Requested order, each candidate once.
      const ordered: Candidate[] = [];
      const seen = new Set<string>();
      for (const c of [...ids.map((id) => byId.find((x) => x.id === id)!), ...extIds.map((x) => extMap.get(x)!)]) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          ordered.push(c);
        }
      }
      // Same rule as the staff endpoint: a candidate with a not-yet-finished session for this exam keeps it.
      const current = await tx
        .select()
        .from(examSessions)
        .where(
          and(
            eq(examSessions.examId, examId),
            inArray(
              examSessions.candidateId,
              ordered.map((c) => c.id),
            ),
            notInArray(examSessions.status, TERMINAL_STATUSES),
          ),
        )
        .orderBy(desc(examSessions.createdAt));
      const existing = new Map<string, (typeof current)[number]>();
      for (const s of current) if (!existing.has(s.candidateId)) existing.set(s.candidateId, s);

      await assertSessionQuota(tx, key.orgId, ordered.filter((c) => !existing.has(c.id)).length, now); // 409 quota_exceeded
      const out: IntegrationAssignmentDTO[] = [];
      let created = 0;
      for (const c of ordered) {
        const prev = existing.get(c.id);
        if (prev) {
          out.push({ sessionId: prev.id, candidateId: c.id, candidateName: c.name, externalId: c.externalId ?? null, accessLink: accessLinkFor(ctx, prev) ?? '', existing: true, window: sessionWindow(prev) });
          continue;
        }
        const s = await createExamSession(ctx, tx, { orgId: key.orgId, examId, candidateId: c.id, window });
        out.push({ sessionId: s.session.id, candidateId: c.id, candidateName: c.name, externalId: c.externalId ?? null, accessLink: s.accessLink, existing: false, window });
        created++;
      }
      await recordSessionsCreated(tx, key.orgId, created, now);
      await apiAudit(tx, key, now, 'api.exam.assigned', 'exam', examId, { requested: ordered.length, created, existing: ordered.length - created, ...(window ? { window } : {}) });
      return out;
    });
    for (const a of items) if (!a.existing) ctx.live.sessionChanged(a.sessionId, { orgId: key.orgId });
    return { items };
  });

  /* ---------------------------------------------------------------- sessions */

  endpoint('listSessions', async (req): Promise<{ items: IntegrationSessionDTO[]; total: number }> => {
    const key = getApiKey(req);
    const q = integrationSessionsQuerySchema.parse(blankToUndefined(req.query));
    const conds: SQL[] = [];
    if (q.examId) {
      if (!isUuid(q.examId)) throw validationFailed('Invalid exam id', [{ path: 'examId', message: 'Must be an exam id' }]);
      conds.push(eq(examSessions.examId, q.examId.toLowerCase()));
    }
    if (q.candidateId) {
      if (!isUuid(q.candidateId)) throw validationFailed('Invalid candidate id', [{ path: 'candidateId', message: 'Must be a candidate id' }]);
      conds.push(eq(examSessions.candidateId, q.candidateId.toLowerCase()));
    }
    if (q.externalId) conds.push(eq(candidates.externalId, q.externalId.trim()));
    const statuses = listParam(q.status);
    if (statuses.length) {
      const bad = statuses.filter((s) => !(SESSION_STATUSES as readonly string[]).includes(s));
      if (bad.length) throw validationFailed('Unknown status filter', [{ path: 'status', message: `Unknown status: ${bad.join(', ')}` }]);
      conds.push(inArray(examSessions.status, statuses as SessionStatus[]));
    }
    const where = conds.length ? and(...conds) : undefined;
    const [[{ total }], summaries] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(examSessions)
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .where(and(eq(examSessions.orgId, key.orgId), where)),
      loadSessionSummaries(ctx, ctx.db, { orgId: key.orgId, where, limit: q.limit, offset: q.offset, orderBy: [desc(examSessions.createdAt), desc(examSessions.id)] }),
    ]);
    return { items: await integrationSessions(ctx, key.orgId, summaries), total };
  });

  endpoint('getSession', async (req): Promise<IntegrationSessionDTO> => {
    const key = getApiKey(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    // The candidate's link is returned for a single session (like the staff detail view), never in lists, and only to
    // keys that may assign candidates (it lets its holder take the exam as the candidate).
    const summaries = await loadSessionSummaries(ctx, ctx.db, { orgId: key.orgId, sessionIds: [id], includeAccessLink: key.scopes.includes('assignments:write') });
    if (summaries.length === 0) throw notFound('Session not found', 'session_not_found');
    return (await integrationSessions(ctx, key.orgId, summaries))[0];
  });

  /** Set, change or clear the scheduling window of a session that has not started (409 already_started / invalid_state). */
  endpoint('rescheduleSession', async (req): Promise<IntegrationSessionDTO> => {
    const key = getApiKey(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const body = rescheduleRequestSchema.parse(req.body ?? {});
    await rescheduleSession(ctx, id, { type: 'api_key', id: key.id, orgId: key.orgId, ip: key.ip, name: key.name }, body.window, body.note ?? null);
    const summaries = await loadSessionSummaries(ctx, ctx.db, { orgId: key.orgId, sessionIds: [id] });
    if (summaries.length === 0) throw notFound('Session not found', 'session_not_found');
    return (await integrationSessions(ctx, key.orgId, summaries))[0];
  });

  endpoint('getSessionReport', async (req): Promise<IntegrationSessionReportDTO> => {
    const key = getApiKey(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const tz = resolveTimeZone(integrationReportQuerySchema.parse(blankToUndefined(req.query)).tz);
    const report = await buildSessionReport(ctx, id, key.orgId, { timeZone: tz });
    await apiAudit(ctx.db, key, ctx.now(), 'api.session.report_read', 'session', id);
    // Explanations are reviewer-facing (they quote detector and identity measurements): not for integrations; nor
    // are the internal decision versions (Quality page). Reports never carry the candidate's link.
    const { explanations: _explanations, ...rest } = report;
    const { versions: _versions, ...identity } = rest.identity;
    return withoutFaceScores({
      ...rest,
      session: { ...rest.session, accessLink: null },
      identity,
      notableEvents: report.notableEvents.map((e) => toIntegrationEventDTO(e, ctx.config.publicUrl)),
      staffUrl: sessionStaffUrl(ctx.config.publicUrl, id),
    });
  });

  endpoint('listSessionEvents', async (req): Promise<{ items: IntegrationEventDTO[] }> => {
    const key = getApiKey(req);
    const id = idParam(req, 'id', 'Session', 'session_not_found');
    const filters = integrationEventsQuerySchema.parse(blankToUndefined(req.query));
    const [s] = await ctx.db
      .select({ id: examSessions.id })
      .from(examSessions)
      .where(and(eq(examSessions.id, id), eq(examSessions.orgId, key.orgId)));
    if (!s) throw notFound('Session not found', 'session_not_found');
    const conds = eventFilterCondsFrom(filters);
    const list = conds === null ? [] : await loadOrderedSessionEvents(ctx.db, id, ...conds);
    await apiAudit(ctx.db, key, ctx.now(), 'api.session.events_read', 'session', id, { rows: list.length });
    return { items: list.map((e) => toIntegrationEventDTO(e, ctx.config.publicUrl)) };
  });
};
