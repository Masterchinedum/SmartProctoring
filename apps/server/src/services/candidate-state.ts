import { END_REASONS, type CandidateAnswerDTO, type CandidateQuestionDTO, type CandidateSessionState, type EndReason } from '@sp/shared';
import { and, desc, eq, gte } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { answers, candidates, examSessions, exams, organizations, pauseRequests, questions, sessionPeriods, type ExamSession } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { ms, remainingMs, toHoldDTO, toPauseRequestDTO } from './dto.js';
import { identitySampleRequest } from './identity-evidence.js';
import { noticeFor } from './privacy.js';
import { effectivePolicy, requiredCheckFor } from './session-state.js';

export const SUPERSEDED_MESSAGE =
  'This exam is now open in another browser window or device. Continue there, or reload this page to take over (a camera and identity check is required).';

/** True when this browser instance is the one allowed to send exam data. */
export function instanceInControl(s: Pick<ExamSession, 'activeInstanceId' | 'verifiedInstanceId'>, instanceId: string | null): boolean {
  return !!instanceId && instanceId === s.activeInstanceId && instanceId === s.verifiedInstanceId;
}

/** Throws 409 superseded / check_required unless this instance is in control. */
export function assertInControl(s: ExamSession, instanceId: string): void {
  if (s.activeInstanceId && s.activeInstanceId !== instanceId) throw conflict('superseded', SUPERSEDED_MESSAGE);
  if (s.verifiedInstanceId !== instanceId) {
    throw conflict('check_required', 'Complete the camera and identity check in this browser before continuing.', { requiredCheck: requiredCheckFor(s, instanceId) });
  }
}

/** GET /api/candidate/session payload. Questions/answers only for the in-control instance of an active exam (or after submission). */
export async function buildCandidateState(ctx: Pick<Ctx, 'now'>, db: DbOrTx, sessionId: string, instanceId: string | null): Promise<CandidateSessionState> {
  const rows = await db
    .select({ session: examSessions, exam: exams, org: organizations, candidate: candidates })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .leftJoin(organizations, eq(organizations.id, examSessions.orgId))
    .where(eq(examSessions.id, sessionId));
  const row = rows[0];
  if (!row) throw notFound('Session not found', 'session_not_found');
  const { session: s, exam, org, candidate } = row;
  const now = ctx.now();
  const policy = effectivePolicy(s, exam, org);
  const qs = await db.select().from(questions).where(eq(questions.examId, exam.id)).orderBy(questions.position);

  const showQuestions = (s.status === 'active' && instanceInControl(s, instanceId)) || s.status === 'submitted';
  let qDTO: CandidateQuestionDTO[] | null = null;
  let aDTO: CandidateAnswerDTO[] | null = null;
  if (showQuestions) {
    qDTO = qs.map((q, i) => ({ id: q.id, index: i, type: q.type, prompt: q.prompt, options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text })), points: q.points }));
    const ans = await db.select().from(answers).where(eq(answers.sessionId, s.id));
    aDTO = ans.map((a) => ({ questionId: a.questionId, value: a.value ?? null, clientSeq: a.clientSeq, savedAt: a.savedAt.getTime() }));
  }

  // Pause request to show: pending, or decided during the current exam period.
  let pauseRequest = null;
  const [latestReq] = await db.select().from(pauseRequests).where(eq(pauseRequests.sessionId, s.id)).orderBy(desc(pauseRequests.requestedAt)).limit(1);
  if (latestReq) {
    if (latestReq.status === 'pending') pauseRequest = toPauseRequestDTO(latestReq);
    else {
      const [activePeriod] = await db
        .select({ startedAt: sessionPeriods.startedAt })
        .from(sessionPeriods)
        .where(and(eq(sessionPeriods.sessionId, s.id), eq(sessionPeriods.kind, 'active'), gte(sessionPeriods.startedAt, new Date(0))))
        .orderBy(desc(sessionPeriods.startedAt))
        .limit(1);
      if (activePeriod && latestReq.requestedAt >= activePeriod.startedAt) pauseRequest = toPauseRequestDTO(latestReq);
    }
  }

  return {
    serverTime: now,
    session: {
      id: s.id,
      status: s.status,
      // Housekeeping end reasons (e.g. 'abandoned') are not part of the candidate contract: the candidate sees a terminated exam.
      endReason: s.endReason && (END_REASONS as readonly string[]).includes(s.endReason) ? (s.endReason as EndReason) : null,
      remainingMs: remainingMs(s, now),
      timerRunning: s.runningSince != null,
      durationMs: s.durationMs,
      currentQuestionIndex: s.currentQuestionIndex,
      pauseCount: s.pauseCount,
      requiredCheck: requiredCheckFor(s, instanceId),
      // Only ever echoed back to the verified instance itself: the id works as the in-control browser's credential
      // (X-Client-Instance), so disclosing it to another holder of the link would let them skip the reconnect check.
      verifiedInstanceId: instanceId && s.verifiedInstanceId === instanceId ? s.verifiedInstanceId : null,
      hold: toHoldDTO(s),
      pauseRequest,
      identitySample: instanceInControl(s, instanceId) ? identitySampleRequest(s.status, s.identityState, policy.identity.burstSize, now) : null,
    },
    exam: {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      instructions: exam.instructions,
      durationSec: Math.round(s.durationMs / 1000),
      questionCount: qs.length,
      policy,
    },
    candidate: { id: candidate.id, name: candidate.name, hasIdPhoto: !!candidate.idPhotoEmbedding },
    consent: {
      accepted: s.consentAcceptedAt != null,
      acceptedAt: ms(s.consentAcceptedAt),
      notice: noticeFor(org, policy, candidate),
    },
    questions: qDTO,
    answers: aDTO,
  };
}
