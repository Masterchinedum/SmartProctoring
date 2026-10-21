/**
 * Regrade (POST /api/admin/exams/:id/regrade): re-score the finished attempts pinned to one exam version with the
 * answer keys and points of another (typically a later version that corrected a wrong key).
 *
 * What the candidates saw — prompts, options, the question set — stays that of their own version; only the keys and
 * points of questions that exist in both versions with the same type are taken over. Only attempts whose score changes
 * are written (so repeating a regrade changes nothing): each gets a neutral "Score regraded" timeline entry with the
 * score before and after (which also reaches integrations as the `session.regraded` webhook), its score keeps the
 * history of regrades, and the action is audit-logged. Without `apply` nothing is written: the same computation is
 * returned as a preview. Attempts still in progress on the version are counted, not regraded (they have no score yet).
 */
import type { RegradeRequest, RegradeResultDTO } from '@sp/shared';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { candidates, examSessions, type ExamVersion, type SessionScore } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { canonicalJson, loadVersion } from './exam-versions.js';
import { scoreAnswers, sessionAnswerValues } from './grading.js';
import { withSession } from './session-state.js';

/** Finished attempts a regrade covers at most in one request. */
export const REGRADE_MAX_SESSIONS = 5000;

/** The question set of `source` with the keys / points of `keys` where the same question (id and type) exists there. */
export function regradeQuestions(source: Pick<ExamVersion, 'questions'>, keys: Pick<ExamVersion, 'questions'>) {
  const byId = new Map(keys.questions.map((q) => [q.id, q]));
  const changed: RegradeResultDTO['changedQuestions'] = [];
  const questions = source.questions.map((q) => {
    const k = byId.get(q.id);
    if (!k || k.type !== q.type) return q;
    if (canonicalJson(k.correct) !== canonicalJson(q.correct) || k.points !== q.points) {
      changed.push({ questionId: q.id, prompt: q.prompt, correct: { from: q.correct, to: k.correct }, points: { from: q.points, to: k.points } });
    }
    return { ...q, correct: k.correct, points: k.points };
  });
  return { questions, changed };
}

export async function regradeExam(
  ctx: Ctx,
  actor: { id: string; orgId: string; ip: string | null },
  examId: string,
  req: RegradeRequest,
): Promise<RegradeResultDTO> {
  const [source, keys] = await Promise.all([loadVersion(ctx.db, req.sessionsOnVersionId), loadVersion(ctx.db, req.keysFromVersionId)]);
  for (const [v, field] of [
    [source, 'sessionsOnVersionId'],
    [keys, 'keysFromVersionId'],
  ] as const) {
    if (!v || v.examId !== examId || v.orgId !== actor.orgId) throw notFound(`Exam version not found (${field})`, 'exam_version_not_found');
  }
  const { questions, changed } = regradeQuestions(source!, keys!);

  const rows = await ctx.db
    .select({ id: examSessions.id, score: examSessions.score, candidateName: candidates.name })
    .from(examSessions)
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .where(and(eq(examSessions.examVersionId, source!.id), inArray(examSessions.status, ['submitted', 'terminated']), isNotNull(examSessions.score)))
    .limit(REGRADE_MAX_SESSIONS + 1);
  if (rows.length > REGRADE_MAX_SESSIONS) {
    throw validationFailed(`More than ${REGRADE_MAX_SESSIONS} attempts are pinned to this version; regrade is limited to that many at once.`);
  }
  const [{ inProgress }] = await ctx.db
    .select({ inProgress: sql<number>`count(*)::int` })
    .from(examSessions)
    .where(and(eq(examSessions.examVersionId, source!.id), notInArray(examSessions.status, ['submitted', 'terminated'])));

  const now = ctx.now();
  const sessions: RegradeResultDTO['sessions'] = [];
  for (const r of rows) {
    const after = scoreAnswers(questions, await sessionAnswerValues(ctx.db, r.id), now, keys!.id);
    const before = { points: r.score!.points, maxPoints: r.score!.maxPoints };
    sessions.push({ sessionId: r.id, candidateName: r.candidateName, before, after: { points: after.points, maxPoints: after.maxPoints }, changed: scoreDiffers(r.score!, after) });
  }
  const toWrite = sessions.filter((s) => s.changed);
  if (!req.apply || toWrite.length === 0) return { applied: false, changedQuestions: changed, sessions, inProgress };

  for (const r of toWrite) {
    await withSession(ctx, r.sessionId, async (m) => {
      const before = m.session.score;
      if (!before) return; // reopened meanwhile (cannot happen today: finished attempts stay finished)
      const after = scoreAnswers(questions, await sessionAnswerValues(m.tx, m.session.id), m.now, keys!.id);
      const previous = { points: before.points, maxPoints: before.maxPoints };
      if (!scoreDiffers(before, after)) return; // regraded concurrently
      m.set({
        score: {
          ...after,
          regrades: [...(before.regrades ?? []), { at: m.now, by: actor.id, reason: req.reason, keysFromVersionId: keys!.id, keysFromVersion: keys!.number, previous }],
        },
      });
      await m.addEvent({
        type: 'score_regraded',
        source: 'staff',
        observation: `An administrator regraded the exam with the answer keys of version ${keys!.number} (score ${fmt(previous)} → ${fmt(after)}).`,
        details: { keysFromVersion: keys!.number, keysFromVersionId: keys!.id, before: previous, after: { points: after.points, maxPoints: after.maxPoints }, reason: req.reason, by: actor.id },
      });
      await audit(m.tx, { orgId: m.session.orgId, actorType: 'staff', actorId: actor.id, action: 'session.regraded', targetType: 'session', targetId: m.session.id, meta: { examId, keysFromVersion: keys!.number, before: previous, after: { points: after.points, maxPoints: after.maxPoints } }, ip: actor.ip, at: m.now });
    });
  }
  await audit(ctx.db, {
    orgId: actor.orgId,
    actorType: 'staff',
    actorId: actor.id,
    action: 'exam.regraded',
    targetType: 'exam',
    targetId: examId,
    meta: { sessionsOnVersion: source!.number, keysFromVersion: keys!.number, sessions: toWrite.length, unchanged: rows.length - toWrite.length, questions: changed.map((c) => c.questionId), reason: req.reason },
    ip: actor.ip,
    at: now,
  });
  return { applied: true, changedQuestions: changed, sessions, inProgress };
}

/** Whether a regrade changes anything a reader of the score sees: the total, or any question's result. */
export function scoreDiffers(a: SessionScore, b: SessionScore): boolean {
  if (a.points !== b.points || a.maxPoints !== b.maxPoints || a.perQuestion.length !== b.perQuestion.length) return true;
  const byId = new Map(a.perQuestion.map((q) => [q.questionId, q]));
  return b.perQuestion.some((q) => {
    const o = byId.get(q.questionId);
    return !o || o.points !== q.points || o.maxPoints !== q.maxPoints || o.correct !== q.correct;
  });
}

function fmt(s: { points: number; maxPoints: number }): string {
  return `${s.points}/${s.maxPoints}`;
}
