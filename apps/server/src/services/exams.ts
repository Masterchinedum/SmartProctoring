import type { ExamInput, QuestionInput } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { exams, questions, type Exam, type Question } from '../db/schema.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function questionRow(examId: string, q: QuestionInput, position: number, now: Date) {
  return {
    ...(q.id && UUID_RE.test(q.id) ? { id: q.id } : {}),
    examId,
    position,
    type: q.type,
    prompt: q.prompt,
    options: q.options ?? [],
    correct: q.correct ?? [],
    points: q.points ?? 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Insert an exam and its questions (positions follow array order). */
export async function createExam(db: DbOrTx, orgId: string, input: ExamInput, opts: { createdBy?: string | null; status?: Exam['status']; now?: number } = {}): Promise<{ exam: Exam; questions: Question[] }> {
  const now = new Date(opts.now ?? Date.now());
  const [exam] = await db
    .insert(exams)
    .values({
      orgId,
      title: input.title,
      description: input.description ?? '',
      instructions: input.instructions ?? '',
      durationSec: input.durationSec,
      policy: input.policy ?? {},
      status: opts.status ?? 'draft',
      createdBy: opts.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const qs = input.questions?.length ? await db.insert(questions).values(input.questions.map((q, i) => questionRow(exam.id, q, i, now))).returning() : [];
  return { exam, questions: qs.sort((a, b) => a.position - b.position) };
}

export async function loadQuestions(db: DbOrTx, examId: string): Promise<Question[]> {
  return db.select().from(questions).where(eq(questions.examId, examId)).orderBy(questions.position);
}
