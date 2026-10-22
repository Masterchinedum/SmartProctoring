/**
 * Staff API — exams, versions and assignments.
 *
 *   GET  /exams                              -> { items: ExamDTO[] }                     [reviewer]
 *   POST /exams  ExamInput                   -> ExamDTO                                  [admin]
 *   POST /exams/import  ExamExport           -> ExamDTO (a new draft)                    [admin]
 *   GET  /exams/:id                          -> ExamDTO                                  [reviewer]
 *   PUT  /exams/:id  ExamInput               -> ExamDTO                                  [admin]
 *   POST /exams/:id/publish | /archive       -> ExamDTO                                  [admin]
 *   GET  /exams/:id/versions                 -> { items: ExamVersionSummaryDTO[] }       [reviewer]
 *   GET  /exams/:id/versions/:versionId      -> ExamVersionDTO                           [reviewer]
 *   GET  /exams/:id/export?versionId=        -> ExamExport (attachment; incl. answer keys) [admin]
 *   POST /exams/:id/regrade  RegradeRequest  -> RegradeResultDTO                         [admin]
 *   GET  /exams/:id/sessions                 -> { items: SessionSummaryDTO[] }           [reviewer]
 *   POST /exams/:id/assignments {candidateIds, window?} -> { items: AssignmentDTO[] }    [admin]  (window: services/scheduling.ts)
 *
 * Quotas (services/quotas.ts): creating or importing an exam, publishing an archived one again and assignments that
 * create sessions answer 409 quota_exceeded at the organisation's limit (nothing is created).
 *
 * Versions (services/exam-versions.ts). Publishing an exam, and every later edit of a published exam, writes an
 * immutable version; an attempt keeps the version it started with (questions, options, answer keys, points). An edit
 * therefore never reaches a candidate who already started, and the content can be edited freely — questions added,
 * removed, reordered, options changed. A question whose type changes becomes a new question (new id), so answers and
 * statistics never mix two kinds of question. A corrected answer key reaches finished attempts only through an explicit,
 * audited regrade. Duration changes apply to sessions assigned afterwards. Archived exams are read-only.
 */
import {
  assignRequestSchema,
  EXAM_EXPORT_FORMAT,
  EXAM_EXPORT_FORMAT_VERSION,
  examExportSchema,
  examInputSchema,
  regradeRequestSchema,
  TERMINAL_STATUSES,
  type AssignmentDTO,
  type ExamDTO,
  type ExamExport,
  type ExamInput,
  type ExamVersionDTO,
  type ExamVersionRefDTO,
  type ExamVersionSummaryDTO,
  type QuestionInput,
} from '@sp/shared';
import { and, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getStaff, requireStaff, roleAtLeast } from '../../auth/staff.js';
import type { DbOrTx, Tx } from '../../db/index.js';
import { candidates, examSessions, examVersions, exams, questions, staffUsers, type Exam, type ExamVersion, type Organization, type Question } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { accessLinkFor, loadSessionSummaries, sessionWindow } from '../../services/dto.js';
import { acceptWindow } from '../../services/scheduling.js';
import { listVersions, loadVersion, recordExamVersion, snapshotOf, totalPoints, versionSnapshot, type ExamSnapshot } from '../../services/exam-versions.js';
import { createExam, loadQuestions } from '../../services/exams.js';
import { regradeExam } from '../../services/regrade.js';
import { mergePolicy } from '../../services/org.js';
import { assertExamQuota, assertSessionQuota, recordSessionsCreated } from '../../services/quotas.js';
import { createExamSession } from '../../services/session-actions.js';
import { idParam, loadOrgRow, sanitizePolicyInput } from './common.js';

const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice']);
export const EXAM_SESSIONS_LIMIT = 5000;

type ExamStats = ExamDTO['stats'];
const ZERO_STATS: ExamStats = { assigned: 0, active: 0, completed: 0, flagged: 0 };

/* ------------------------------------------------------------------ mapping */

export function toExamDTO(exam: Exam, qs: Question[], stats: ExamStats, org: Pick<Organization, 'settings'> | null, currentVersion: ExamVersionRefDTO | null): ExamDTO {
  return {
    id: exam.id,
    title: exam.title,
    description: exam.description,
    instructions: exam.instructions,
    durationSec: exam.durationSec,
    status: exam.status,
    // The policy that new sessions of this exam get: organisation default merged with the exam's own rules.
    policy: mergePolicy(org?.settings?.defaultPolicy as Record<string, unknown> | undefined, exam.policy as Record<string, unknown>),
    questions: [...qs]
      .sort((a, b) => a.position - b.position)
      .map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options ?? [], correct: q.correct ?? [], points: q.points })),
    createdAt: exam.createdAt.getTime(),
    updatedAt: exam.updatedAt.getTime(),
    stats,
    currentVersion,
  };
}

const versionRef = (v: Pick<ExamVersion, 'id' | 'number' | 'createdAt'>): ExamVersionRefDTO => ({ id: v.id, number: v.number, createdAt: v.createdAt.getTime() });

async function loadVersionRefs(db: DbOrTx, ids: (string | null)[]): Promise<Map<string, ExamVersionRefDTO>> {
  const wanted = ids.filter((x): x is string => !!x);
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: examVersions.id, number: examVersions.number, createdAt: examVersions.createdAt }).from(examVersions).where(inArray(examVersions.id, wanted));
  return new Map(rows.map((r) => [r.id, versionRef(r)]));
}

async function loadExamStats(db: DbOrTx, examIds: string[]): Promise<Map<string, ExamStats>> {
  const out = new Map<string, ExamStats>();
  if (examIds.length === 0) return out;
  const rows = await db
    .select({
      examId: examSessions.examId,
      assigned: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${examSessions.status} in ('active', 'paused', 'on_hold'))::int`,
      completed: sql<number>`count(*) filter (where ${examSessions.status} in ('submitted', 'terminated'))::int`,
      flagged: sql<number>`count(*) filter (where exists (select 1 from events e where e.session_id = ${examSessions.id} and e.category = 'integrity' and e.review_status <> 'dismissed'))::int`,
    })
    .from(examSessions)
    .where(inArray(examSessions.examId, examIds))
    .groupBy(examSessions.examId);
  for (const r of rows) out.set(r.examId, { assigned: r.assigned, active: r.active, completed: r.completed, flagged: r.flagged });
  return out;
}

async function loadScopedExam(db: DbOrTx, orgId: string, examId: string, lock = false): Promise<Exam> {
  const q = db
    .select()
    .from(exams)
    .where(and(eq(exams.id, examId), eq(exams.orgId, orgId)));
  const [exam] = lock ? await q.for('update') : await q;
  if (!exam) throw notFound('Exam not found', 'exam_not_found');
  return exam;
}

async function examDTO(db: DbOrTx, exam: Exam, org: Organization | null): Promise<ExamDTO> {
  const [qs, stats, refs] = await Promise.all([loadQuestions(db, exam.id), loadExamStats(db, [exam.id]), loadVersionRefs(db, [exam.currentVersionId])]);
  return toExamDTO(exam, qs, stats.get(exam.id) ?? { ...ZERO_STATS }, org, exam.currentVersionId ? (refs.get(exam.currentVersionId) ?? null) : null);
}

/* ------------------------------------------------------------------ versions */

async function versionSessionCounts(db: DbOrTx, examId: string): Promise<Map<string, { started: number; finished: number }>> {
  const rows = await db
    .select({
      versionId: examSessions.examVersionId,
      started: sql<number>`count(*) filter (where ${examSessions.startedAt} is not null)::int`,
      finished: sql<number>`count(*) filter (where ${examSessions.status} in ('submitted', 'terminated'))::int`,
    })
    .from(examSessions)
    .where(and(eq(examSessions.examId, examId), isNotNull(examSessions.examVersionId)))
    .groupBy(examSessions.examVersionId);
  return new Map(rows.map((r) => [r.versionId!, { started: r.started, finished: r.finished }]));
}

async function staffNames(db: DbOrTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toVersionSummaryDTO(v: ExamVersion, counts: Map<string, { started: number; finished: number }>, names: Map<string, string>, currentId: string | null): ExamVersionSummaryDTO {
  return {
    ...versionRef(v),
    reason: v.reason,
    createdBy: v.createdBy ? { id: v.createdBy, name: names.get(v.createdBy) ?? 'Former staff member' } : null,
    contentHash: v.contentHash,
    changes: v.changes,
    questionCount: v.questions.length,
    totalPoints: totalPoints(v.questions),
    sessions: counts.get(v.id) ?? { started: 0, finished: 0 },
    current: v.id === currentId,
  };
}

/* ------------------------------------------------------------------ export / import */

function exportDocument(snap: ExamSnapshot, source: { examId: string; version: number | null }): ExamExport {
  return {
    format: EXAM_EXPORT_FORMAT,
    formatVersion: EXAM_EXPORT_FORMAT_VERSION,
    source: { ...source, title: snap.title },
    exam: {
      title: snap.title,
      description: snap.description,
      instructions: snap.instructions,
      durationSec: snap.durationSec,
      policy: snap.policy as Record<string, unknown>,
      // No question ids: an import creates new questions. Option ids are kept (answer keys refer to them).
      questions: snap.questions.map((q) => ({ type: q.type, prompt: q.prompt, options: q.options, correct: q.correct, points: q.points })),
    },
  };
}

/** A safe download file name from an exam title. */
export function exportFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${slug || 'exam'}.exam.json`;
}

/* ------------------------------------------------------------------ validation */

/** Structural checks on questions beyond the zod schema. Throws 400 validation_failed with per-field details. */
export function validateQuestions(qs: QuestionInput[]): void {
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  qs.forEach((q, i) => {
    const p = `questions.${i}`;
    if (q.id) {
      if (ids.has(q.id)) issues.push({ path: `${p}.id`, message: 'Duplicate question id' });
      ids.add(q.id);
    }
    const optIds = q.options.map((o) => o.id);
    if (new Set(optIds).size !== optIds.length) issues.push({ path: `${p}.options`, message: 'Option ids must be unique within a question' });
    if (CHOICE_TYPES.has(q.type)) {
      if (q.options.length < 2) issues.push({ path: `${p}.options`, message: 'A choice question needs at least two options' });
      const unknown = q.correct.filter((c) => !optIds.includes(c));
      if (unknown.length) issues.push({ path: `${p}.correct`, message: `Correct answers must be option ids (unknown: ${unknown.join(', ')})` });
      if (q.type === 'single_choice' && q.correct.length > 1) issues.push({ path: `${p}.correct`, message: 'A single-choice question has at most one correct option' });
    } else if (q.type === 'numeric') {
      const bad = q.correct.filter((c) => !Number.isFinite(Number(c.split(/±|\|/)[0].trim().replace(',', '.'))));
      if (bad.length) issues.push({ path: `${p}.correct`, message: 'Numeric answers must be numbers (optionally "value±tolerance")' });
    }
  });
  if (issues.length) throw validationFailed('Some questions are invalid', issues);
}

/** Validate + normalise an exam input: sanitized partial policy that resolves against the org default. */
function normaliseExamInput(input: ExamInput, org: Organization | null): ExamInput & { policy: Record<string, unknown> } {
  const policy = sanitizePolicyInput(input.policy);
  mergePolicy(org?.settings?.defaultPolicy as Record<string, unknown> | undefined, policy); // throws ZodError (400) when invalid
  validateQuestions(input.questions);
  return {
    ...input,
    title: input.title.trim(),
    policy,
    questions: input.questions.map((q) => ({ ...q, prompt: q.prompt, options: CHOICE_TYPES.has(q.type) ? q.options : [] })),
  };
}

/**
 * Apply a question list to an exam's working copy. Question ids are kept for questions that keep their type; a
 * question whose type changes is replaced by a new one (new id). Returns what changed.
 */
async function applyQuestions(tx: Tx, examId: string, existing: Question[], incoming: QuestionInput[], now: Date) {
  const byId = new Map(existing.map((q) => [q.id, q]));
  const keep = (q: QuestionInput) => !!q.id && byId.get(q.id)?.type === q.type;
  const keptIds = new Set(incoming.filter(keep).map((q) => q.id!));
  const toDelete = existing.filter((q) => !keptIds.has(q.id)).map((q) => q.id);
  if (toDelete.length) await tx.delete(questions).where(inArray(questions.id, toDelete));
  let changed = 0;
  let added = 0;
  for (let i = 0; i < incoming.length; i++) {
    const q = incoming[i];
    const fields = { position: i, type: q.type, prompt: q.prompt, options: q.options ?? [], correct: q.correct ?? [], points: q.points ?? 1, updatedAt: now };
    const cur = keep(q) ? byId.get(q.id!) : undefined;
    if (cur) {
      const same =
        cur.position === i &&
        cur.prompt === q.prompt &&
        cur.points === fields.points &&
        JSON.stringify(cur.options ?? []) === JSON.stringify(fields.options) &&
        JSON.stringify(cur.correct ?? []) === JSON.stringify(fields.correct);
      if (!same) {
        await tx.update(questions).set(fields).where(eq(questions.id, cur.id));
        changed++;
      }
    } else {
      // New question (or a type change): always a server-generated id (never trust a client id that is not ours).
      await tx.insert(questions).values({ examId, ...fields, createdAt: now });
      added++;
    }
  }
  return { added, changed, removed: toDelete.length };
}

/* ------------------------------------------------------------------ routes */

export const examRoutes: FastifyPluginAsync = async (app) => {
  const ctx = app.ctx;
  const reviewer = { preHandler: requireStaff('reviewer') };
  const admin = { preHandler: requireStaff('admin') };

  app.get('/exams', reviewer, async (req) => {
    const staff = getStaff(req);
    const org = await loadOrgRow(ctx, staff.orgId);
    const list = await ctx.db.select().from(exams).where(eq(exams.orgId, staff.orgId)).orderBy(desc(exams.createdAt), desc(exams.id));
    const ids = list.map((e) => e.id);
    const [qs, stats, refs] = await Promise.all([
      ids.length ? ctx.db.select().from(questions).where(inArray(questions.examId, ids)) : Promise.resolve([] as Question[]),
      loadExamStats(ctx.db, ids),
      loadVersionRefs(ctx.db, list.map((e) => e.currentVersionId)),
    ]);
    const byExam = new Map<string, Question[]>();
    for (const q of qs) byExam.set(q.examId, [...(byExam.get(q.examId) ?? []), q]);
    return { items: list.map((e) => toExamDTO(e, byExam.get(e.id) ?? [], stats.get(e.id) ?? { ...ZERO_STATS }, org, e.currentVersionId ? (refs.get(e.currentVersionId) ?? null) : null)) };
  });

  app.post('/exams', admin, async (req) => {
    const staff = getStaff(req);
    const org = await loadOrgRow(ctx, staff.orgId);
    const input = normaliseExamInput(examInputSchema.parse(req.body ?? {}), org);
    const now = ctx.now();
    const exam = await ctx.db.transaction(async (tx) => {
      await assertExamQuota(tx, staff.orgId, 1, now);
      const { exam: created } = await createExam(tx, staff.orgId, { ...input, questions: input.questions.map(({ id: _id, ...q }) => q) }, { createdBy: staff.id, status: 'draft', now });
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.created', targetType: 'exam', targetId: created.id, meta: { title: created.title, questions: input.questions.length }, ip: req.ip, at: now });
      return created;
    });
    return examDTO(ctx.db, exam, org);
  });

  app.post('/exams/import', { ...admin, bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const staff = getStaff(req);
    const org = await loadOrgRow(ctx, staff.orgId);
    const doc = examExportSchema.parse(req.body ?? {});
    const input = normaliseExamInput(doc.exam, org);
    const now = ctx.now();
    const exam = await ctx.db.transaction(async (tx) => {
      await assertExamQuota(tx, staff.orgId, 1, now);
      const { exam: created } = await createExam(tx, staff.orgId, { ...input, questions: input.questions.map(({ id: _id, ...q }) => q) }, { createdBy: staff.id, status: 'draft', now });
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.imported', targetType: 'exam', targetId: created.id, meta: { title: created.title, questions: input.questions.length, source: doc.source ?? null }, ip: req.ip, at: now });
      return created;
    });
    return examDTO(ctx.db, exam, org);
  });

  app.get('/exams/:id', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const [exam, org] = await Promise.all([loadScopedExam(ctx.db, staff.orgId, id), loadOrgRow(ctx, staff.orgId)]);
    return examDTO(ctx.db, exam, org);
  });

  app.put('/exams/:id', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const org = await loadOrgRow(ctx, staff.orgId);
    const input = normaliseExamInput(examInputSchema.parse(req.body ?? {}), org);
    const now = ctx.now();
    const exam = await ctx.db.transaction(async (tx) => {
      const cur = await loadScopedExam(tx, staff.orgId, id, true);
      if (cur.status === 'archived') throw conflict('exam_archived', 'This exam is archived and can no longer be edited.');
      const existing = await loadQuestions(tx, id);
      const changes = await applyQuestions(tx, id, existing, input.questions, new Date(now));
      const [updated] = await tx
        .update(exams)
        .set({ title: input.title, description: input.description, instructions: input.instructions, durationSec: input.durationSec, policy: input.policy, updatedAt: new Date(now) })
        .where(eq(exams.id, id))
        .returning();
      // A published exam is live: the edit becomes a new version for attempts that start from now on.
      const v = updated.status === 'published' ? await recordExamVersion(tx, updated, { reason: 'edited', by: staff.id, now }) : null;
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.updated', targetType: 'exam', targetId: id, meta: { questions: changes, version: v?.created ? v.version.number : null }, ip: req.ip, at: now });
      return updated;
    });
    return examDTO(ctx.db, exam, org);
  });

  const setStatus = (status: Exam['status'], action: string) => async (req: FastifyRequest) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const org = await loadOrgRow(ctx, staff.orgId);
    const now = ctx.now();
    const exam = await ctx.db.transaction(async (tx) => {
      const cur = await loadScopedExam(tx, staff.orgId, id, true);
      if (cur.status === status) return cur;
      // An archived exam does not count against the exam limit; bringing it back does.
      if (cur.status === 'archived') await assertExamQuota(tx, staff.orgId, 1, now);
      if (status === 'published') {
        // Re-validate what is stored (it may predate current validation rules).
        mergePolicy(org.settings?.defaultPolicy as Record<string, unknown> | undefined, cur.policy as Record<string, unknown>);
        const qs = await loadQuestions(tx, id);
        validateQuestions(qs.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options ?? [], correct: q.correct ?? [], points: q.points })));
      }
      const [updated] = await tx.update(exams).set({ status, updatedAt: new Date(now) }).where(eq(exams.id, id)).returning();
      const v = status === 'published' ? await recordExamVersion(tx, updated, { reason: 'published', by: staff.id, now }) : null;
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action, targetType: 'exam', targetId: id, meta: { from: cur.status, version: v?.version.number ?? null }, ip: req.ip, at: now });
      return updated;
    });
    return examDTO(ctx.db, exam, org);
  };
  app.post('/exams/:id/publish', admin, setStatus('published', 'exam.published'));
  app.post('/exams/:id/archive', admin, setStatus('archived', 'exam.archived'));

  app.get('/exams/:id/versions', reviewer, async (req): Promise<{ items: ExamVersionSummaryDTO[] }> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const exam = await loadScopedExam(ctx.db, staff.orgId, id);
    const [versions, counts] = await Promise.all([listVersions(ctx.db, id), versionSessionCounts(ctx.db, id)]);
    const names = await staffNames(ctx.db, versions.map((v) => v.createdBy));
    return { items: versions.map((v) => toVersionSummaryDTO(v, counts, names, exam.currentVersionId)) };
  });

  app.get('/exams/:id/versions/:versionId', reviewer, async (req): Promise<ExamVersionDTO> => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const versionId = idParam(req, 'versionId', 'Exam version', 'exam_version_not_found');
    const exam = await loadScopedExam(ctx.db, staff.orgId, id);
    const v = await loadVersion(ctx.db, versionId);
    if (!v || v.examId !== exam.id) throw notFound('Exam version not found', 'exam_version_not_found');
    const [counts, names] = await Promise.all([versionSessionCounts(ctx.db, id), staffNames(ctx.db, [v.createdBy])]);
    return {
      ...toVersionSummaryDTO(v, counts, names, exam.currentVersionId),
      title: v.title,
      description: v.description,
      instructions: v.instructions,
      durationSec: v.durationSec,
      policy: v.policy as Record<string, unknown>,
      questions: v.questions,
    };
  });

  app.get('/exams/:id/export', admin, async (req, reply) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const { versionId } = req.query as { versionId?: string };
    const exam = await loadScopedExam(ctx.db, staff.orgId, id);
    let doc: ExamExport;
    if (versionId) {
      const v = /^[0-9a-f-]{36}$/i.test(versionId) ? await loadVersion(ctx.db, versionId.toLowerCase()) : null;
      if (!v || v.examId !== exam.id) throw notFound('Exam version not found', 'exam_version_not_found');
      doc = exportDocument(versionSnapshot(v), { examId: exam.id, version: v.number });
    } else {
      // The editable working copy (for a published exam: the same as its current version).
      doc = exportDocument(snapshotOf(exam, await loadQuestions(ctx.db, id)), { examId: exam.id, version: null });
    }
    doc.exportedAt = ctx.now();
    await audit(ctx.db, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.exported', targetType: 'exam', targetId: id, meta: { version: doc.source?.version ?? null }, ip: req.ip, at: ctx.now() });
    return reply.header('Content-Disposition', `attachment; filename="${exportFileName(exam.title)}"`).send(doc);
  });

  app.post('/exams/:id/regrade', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    await loadScopedExam(ctx.db, staff.orgId, id);
    return regradeExam(ctx, { id: staff.id, orgId: staff.orgId, ip: req.ip }, id, regradeRequestSchema.parse(req.body ?? {}));
  });

  app.get('/exams/:id/sessions', reviewer, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    await loadScopedExam(ctx.db, staff.orgId, id);
    return {
      // The exam's assignment list: admins copy access links from here (reviewers never receive them).
      items: await loadSessionSummaries(ctx, ctx.db, {
        orgId: staff.orgId,
        where: eq(examSessions.examId, id),
        orderBy: [desc(examSessions.createdAt), desc(examSessions.id)],
        limit: EXAM_SESSIONS_LIMIT,
        includeAccessLink: roleAtLeast(staff.role, 'admin'),
      }),
    };
  });

  app.post('/exams/:id/assignments', admin, async (req) => {
    const staff = getStaff(req);
    const id = idParam(req, 'id', 'Exam', 'exam_not_found');
    const body = assignRequestSchema.parse(req.body ?? {});
    const requested = [...new Set(body.candidateIds.map((c) => c.trim().toLowerCase()))];
    const now = ctx.now();
    const window = acceptWindow(body.window, now);
    const items = await ctx.db.transaction(async (tx) => {
      const exam = await loadScopedExam(tx, staff.orgId, id, true); // row lock serialises concurrent assignment requests
      if (exam.status !== 'published') {
        throw conflict('exam_not_published', exam.status === 'archived' ? 'This exam is archived; candidates can no longer be assigned.' : 'Publish the exam before assigning candidates.');
      }
      const valid = requested.filter((c) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c));
      const found = valid.length ? await tx.select({ id: candidates.id, name: candidates.name }).from(candidates).where(and(inArray(candidates.id, valid), eq(candidates.orgId, staff.orgId))) : [];
      const names = new Map(found.map((c) => [c.id, c.name]));
      const unknown = requested.filter((c) => !names.has(c));
      if (unknown.length) throw validationFailed('Some candidates were not found', [{ path: 'candidateIds', message: `Unknown candidate ids: ${unknown.join(', ')}` }]);

      // Candidates that already have a session in progress (or not yet started) for this exam keep it.
      const current = await tx
        .select()
        .from(examSessions)
        .where(and(eq(examSessions.examId, id), inArray(examSessions.candidateId, requested), notInArray(examSessions.status, TERMINAL_STATUSES)))
        .orderBy(desc(examSessions.createdAt));
      const existingByCandidate = new Map<string, (typeof current)[number]>();
      for (const s of current) if (!existingByCandidate.has(s.candidateId)) existingByCandidate.set(s.candidateId, s);

      await assertSessionQuota(tx, staff.orgId, requested.filter((c) => !existingByCandidate.has(c)).length, now);
      const out: AssignmentDTO[] = [];
      let created = 0;
      for (const candidateId of requested) {
        const existing = existingByCandidate.get(candidateId);
        if (existing) {
          out.push({ sessionId: existing.id, candidateId, candidateName: names.get(candidateId)!, accessLink: accessLinkFor(ctx, existing) ?? '', existing: true, window: sessionWindow(existing) });
          continue;
        }
        const s = await createExamSession(ctx, tx, { orgId: staff.orgId, examId: id, candidateId, window });
        out.push({ sessionId: s.session.id, candidateId, candidateName: names.get(candidateId)!, accessLink: s.accessLink, existing: false, window });
        created++;
      }
      await recordSessionsCreated(tx, staff.orgId, created, now);
      await audit(tx, {
        orgId: staff.orgId,
        actorType: 'staff',
        actorId: staff.id,
        action: 'exam.assigned',
        targetType: 'exam',
        targetId: id,
        meta: { requested: requested.length, created, existing: requested.length - created, ...(window ? { window } : {}) },
        ip: req.ip,
        at: now,
      });
      return out;
    });
    for (const a of items) if (!a.existing) ctx.live.sessionChanged(a.sessionId, { orgId: staff.orgId });
    return { items };
  });
};
