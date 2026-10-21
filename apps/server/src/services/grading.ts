import type { AnswerValue, ExamVersionQuestionDTO, QuestionType } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { answers, type ExamSession, type SessionScore } from '../db/schema.js';
import { sessionExamContent } from './exam-versions.js';

export function normalizeText(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim().replace(/\s+/g, '').replace(/,(?=\d{3}\b)/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t.replace(',', '.'))) return null;
    const n = Number(t.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Grade one answer. Returns null for types that need manual grading (long_text) or when no correct
 * answer is configured.
 *  - single_choice: exact option id
 *  - multiple_choice: set equality of option ids
 *  - short_text: case/whitespace-insensitive match against any accepted answer
 *  - numeric: |value - correct| <= max(1e-9, 1e-6 * |correct|) (or an explicit tolerance "value±tol" / "value|tol")
 */
export function isAnswerCorrect(type: QuestionType, correct: string[], value: AnswerValue | undefined): boolean | null {
  if (type === 'long_text') return null;
  if (!correct || correct.length === 0) return null;
  if (value == null) return false;
  switch (type) {
    case 'single_choice': {
      const v = Array.isArray(value) ? (value.length === 1 ? value[0] : null) : String(value);
      return v != null && v === correct[0];
    }
    case 'multiple_choice': {
      const v = Array.isArray(value) ? value.map(String) : [String(value)];
      const a = new Set(v);
      const b = new Set(correct);
      return a.size === b.size && [...a].every((x) => b.has(x));
    }
    case 'short_text': {
      if (typeof value !== 'string' && typeof value !== 'number') return false;
      const v = normalizeText(String(value));
      return v.length > 0 && correct.some((c) => normalizeText(c) === v);
    }
    case 'numeric': {
      const v = toNumber(value);
      if (v == null) return false;
      return correct.some((c) => {
        const [base, tolStr] = c.split(/±|\|/);
        const target = toNumber(base);
        if (target == null) return false;
        const tol = tolStr != null ? (toNumber(tolStr) ?? 0) : Math.max(1e-9, 1e-6 * Math.abs(target));
        return Math.abs(v - target) <= Math.abs(tol) + 1e-12;
      });
    }
    default:
      return null;
  }
}

/**
 * Score answers against questions (the attempt's version, or another version's keys for a regrade). long_text
 * questions count in maxPoints but need manual grading.
 */
export function scoreAnswers(
  qs: Pick<ExamVersionQuestionDTO, 'id' | 'type' | 'correct' | 'points'>[],
  answerValues: ReadonlyMap<string, AnswerValue | null | undefined>,
  now: number,
  keysVersionId: string | null,
): SessionScore {
  let points = 0;
  let maxPoints = 0;
  let autoGraded = true;
  const perQuestion: SessionScore['perQuestion'] = [];
  for (const q of qs) {
    maxPoints += q.points;
    const correct = isAnswerCorrect(q.type, q.correct ?? [], answerValues.get(q.id) ?? undefined);
    if (correct == null) autoGraded = false;
    const p = correct ? q.points : 0;
    points += p;
    perQuestion.push({ questionId: q.id, points: p, maxPoints: q.points, correct });
  }
  return { points: Math.round(points * 1000) / 1000, maxPoints, autoGraded, gradedAt: now, perQuestion, keysVersionId };
}

export async function sessionAnswerValues(db: DbOrTx, sessionId: string): Promise<Map<string, AnswerValue | null>> {
  const ans = await db.select().from(answers).where(eq(answers.sessionId, sessionId));
  return new Map(ans.map((a) => [a.questionId, a.value]));
}

/** Auto-grade a session with the answer keys of the exam version it is pinned to (services/exam-versions.ts). */
export async function gradeSession(db: DbOrTx, session: Pick<ExamSession, 'id' | 'examId' | 'examVersionId'>, now: number): Promise<SessionScore> {
  const { version, snapshot } = await sessionExamContent(db, session);
  return scoreAnswers(snapshot.questions, await sessionAnswerValues(db, session.id), now, version?.id ?? null);
}
