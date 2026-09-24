/**
 * Staff API — exams and assignments.
 *
 *   GET  /exams                              -> { items: ExamDTO[] }             [reviewer]
 *   POST /exams  ExamInput                   -> ExamDTO                          [admin]
 *   GET  /exams/:id                          -> ExamDTO                          [reviewer]
 *   PUT  /exams/:id  ExamInput               -> ExamDTO                          [admin]
 *   POST /exams/:id/publish | /archive       -> ExamDTO                          [admin]
 *   GET  /exams/:id/sessions                 -> { items: SessionSummaryDTO[] }   [reviewer]
 *   POST /exams/:id/assignments {candidateIds} -> { items: AssignmentDTO[] }     [admin]
 *
 * Editing rules. A draft exam (no session has started) can be edited freely. Once an exam is published
 * or any session has started, edits must not break existing sessions or answers:
 *   - question ids are stable; existing questions cannot be removed, reordered or change type;
 *   - existing answer options cannot be removed (their text may be corrected, options may be added);
 *   - prompts, points, answer keys, title, instructions, duration (new sessions only) and policy
 *     (sessions snapshot the policy when they start) may change; new questions may be appended.
 * Anything else is refused with 409 and an explanation. Archived exams are read-only.
 */
import {
  assignRequestSchema,
  examInputSchema,
  TERMINAL_STATUSES,
  type AssignmentDTO,
  type ExamDTO,
  type ExamInput,
  type QuestionInput,
} from '@sp/shared';
import { and, desc, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getStaff, requireStaff, roleAtLeast } from '../../auth/staff.js';
import type { DbOrTx, Tx } from '../../db/index.js';
import { candidates, examSessions, exams, questions, type Exam, type Organization, type Question } from '../../db/schema.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { accessLinkFor, loadSessionSummaries } from '../../services/dto.js';
import { createExam, loadQuestions } from '../../services/exams.js';
import { mergePolicy } from '../../services/org.js';
import { createExamSession } from '../../services/session-actions.js';
import { idParam, loadOrgRow, sanitizePolicyInput } from './common.js';

const CHOICE_TYPES = new Set(['single_choice', 'multiple_choice']);
export const EXAM_SESSIONS_LIMIT = 5000;

type ExamStats = ExamDTO['stats'];
const ZERO_STATS: ExamStats = { assigned: 0, active: 0, completed: 0, flagged: 0 };

/* ------------------------------------------------------------------ mapping */

export function toExamDTO(exam: Exam, qs: Question[], stats: ExamStats, org: Pick<Organization, 'settings'> | null): ExamDTO {
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
  };
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
  const [qs, stats] = await Promise.all([loadQuestions(db, exam.id), loadExamStats(db, [exam.id])]);
  return toExamDTO(exam, qs, stats.get(exam.id) ?? { ...ZERO_STATS }, org);
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

async function hasStartedSessions(db: DbOrTx, examId: string): Promise<boolean> {
  const [r] = await db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.examId, examId), isNotNull(examSessions.startedAt)))
    .limit(1);
  return !!r;
}

/**
 * Apply a question list to an exam. `restricted` enforces the non-breaking rules (see file header).
 * Returns what changed.
 */
async function applyQuestions(tx: Tx, examId: string, existing: Question[], incoming: QuestionInput[], restricted: boolean, now: Date) {
  const byId = new Map(existing.map((q) => [q.id, q]));
  const kept = incoming.filter((q) => q.id && byId.has(q.id));
  if (restricted) {
    const keptIds = new Set(kept.map((q) => q.id));
    const removed = existing.filter((q) => !keptIds.has(q.id));
    if (removed.length) {
      throw conflict('question_removal_not_allowed', 'Questions cannot be removed once the exam is published or a candidate has started it, because existing answers refer to them. Edit the wording instead, or create a new exam.', {
        questionIds: removed.map((q) => q.id),
      });
    }
    const sortedExisting = [...existing].sort((a, b) => a.position - b.position);
    for (let i = 0; i < sortedExisting.length; i++) {
      if (incoming[i]?.id !== sortedExisting[i].id) {
        throw conflict('question_reorder_not_allowed', 'Existing questions cannot be reordered once the exam is published or a candidate has started it; new questions can only be added at the end.', {
          position: i,
        });
      }
    }
    for (const q of kept) {
      const cur = byId.get(q.id!)!;
      if (cur.type !== q.type) {
        throw conflict('question_type_change_not_allowed', 'A question’s type cannot change once the exam is published or a candidate has started it.', { questionId: cur.id, from: cur.type, to: q.type });
      }
      const newOpts = new Set(q.options.map((o) => o.id));
      const lost = (cur.options ?? []).filter((o) => !newOpts.has(o.id));
      if (lost.length) {
        throw conflict('option_removal_not_allowed', 'Answer options cannot be removed once the exam is published or a candidate has started it (existing answers may refer to them). You can correct their text or add options.', {
          questionId: cur.id,
          optionIds: lost.map((o) => o.id),
        });
      }
    }
  }

  const keptIds = new Set(kept.map((q) => q.id!));
  const toDelete = existing.filter((q) => !keptIds.has(q.id)).map((q) => q.id);
  if (toDelete.length) await tx.delete(questions).where(inArray(questions.id, toDelete));
  let changed = 0;
  let added = 0;
  for (let i = 0; i < incoming.length; i++) {
    const q = incoming[i];
    const fields = { position: i, type: q.type, prompt: q.prompt, options: q.options ?? [], correct: q.correct ?? [], points: q.points ?? 1, updatedAt: now };
    const cur = q.id ? byId.get(q.id) : undefined;
    if (cur) {
      const same =
        cur.position === i &&
        cur.type === q.type &&
        cur.prompt === q.prompt &&
        cur.points === fields.points &&
        JSON.stringify(cur.options ?? []) === JSON.stringify(fields.options) &&
        JSON.stringify(cur.correct ?? []) === JSON.stringify(fields.correct);
      if (!same) {
        await tx.update(questions).set(fields).where(eq(questions.id, cur.id));
        changed++;
      }
    } else {
      // New question: always a server-generated id (never trust a client id that is not ours).
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
    const [qs, stats] = await Promise.all([ids.length ? ctx.db.select().from(questions).where(inArray(questions.examId, ids)) : Promise.resolve([] as Question[]), loadExamStats(ctx.db, ids)]);
    const byExam = new Map<string, Question[]>();
    for (const q of qs) byExam.set(q.examId, [...(byExam.get(q.examId) ?? []), q]);
    return { items: list.map((e) => toExamDTO(e, byExam.get(e.id) ?? [], stats.get(e.id) ?? { ...ZERO_STATS }, org)) };
  });

  app.post('/exams', admin, async (req) => {
    const staff = getStaff(req);
    const org = await loadOrgRow(ctx, staff.orgId);
    const input = normaliseExamInput(examInputSchema.parse(req.body ?? {}), org);
    const now = ctx.now();
    const exam = await ctx.db.transaction(async (tx) => {
      const { exam: created } = await createExam(tx, staff.orgId, { ...input, questions: input.questions.map(({ id: _id, ...q }) => q) }, { createdBy: staff.id, status: 'draft', now });
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.created', targetType: 'exam', targetId: created.id, meta: { title: created.title, questions: input.questions.length }, ip: req.ip, at: now });
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
      const restricted = cur.status === 'published' || (await hasStartedSessions(tx, id));
      const existing = await loadQuestions(tx, id);
      const changes = await applyQuestions(tx, id, existing, input.questions, restricted, new Date(now));
      const [updated] = await tx
        .update(exams)
        .set({ title: input.title, description: input.description, instructions: input.instructions, durationSec: input.durationSec, policy: input.policy, updatedAt: new Date(now) })
        .where(eq(exams.id, id))
        .returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.updated', targetType: 'exam', targetId: id, meta: { restricted, questions: changes }, ip: req.ip, at: now });
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
      if (status === 'published') {
        // Re-validate what is stored (it may predate current validation rules).
        mergePolicy(org.settings?.defaultPolicy as Record<string, unknown> | undefined, cur.policy as Record<string, unknown>);
        const qs = await loadQuestions(tx, id);
        validateQuestions(qs.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options ?? [], correct: q.correct ?? [], points: q.points })));
      }
      const [updated] = await tx.update(exams).set({ status, updatedAt: new Date(now) }).where(eq(exams.id, id)).returning();
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action, targetType: 'exam', targetId: id, meta: { from: cur.status }, ip: req.ip, at: now });
      return updated;
    });
    return examDTO(ctx.db, exam, org);
  };
  app.post('/exams/:id/publish', admin, setStatus('published', 'exam.published'));
  app.post('/exams/:id/archive', admin, setStatus('archived', 'exam.archived'));

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

      const out: AssignmentDTO[] = [];
      let created = 0;
      for (const candidateId of requested) {
        const existing = existingByCandidate.get(candidateId);
        if (existing) {
          out.push({ sessionId: existing.id, candidateId, candidateName: names.get(candidateId)!, accessLink: accessLinkFor(ctx, existing) ?? '', existing: true });
          continue;
        }
        const s = await createExamSession(ctx, tx, { orgId: staff.orgId, examId: id, candidateId });
        out.push({ sessionId: s.session.id, candidateId, candidateName: names.get(candidateId)!, accessLink: s.accessLink, existing: false });
        created++;
      }
      await audit(tx, { orgId: staff.orgId, actorType: 'staff', actorId: staff.id, action: 'exam.assigned', targetType: 'exam', targetId: id, meta: { requested: requested.length, created, existing: requested.length - created }, ip: req.ip, at: now });
      return out;
    });
    for (const a of items) if (!a.existing) ctx.live.sessionChanged(a.sessionId, { orgId: staff.orgId });
    return { items };
  });
};
