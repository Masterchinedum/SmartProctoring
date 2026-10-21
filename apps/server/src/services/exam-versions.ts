/**
 * Exam versions: immutable snapshots of an exam (db/schema.ts examVersions) — what candidates see (title,
 * instructions, questions, options) and how it is graded (answer keys, points), with the duration and the exam's own
 * rules.
 *
 *  - The `questions` table is the working copy staff edit. A published exam gets a new version whenever it is
 *    published or edited and its content differs from the current version (`recordExamVersion`, under the exam row
 *    lock, so version numbers never collide).
 *  - An attempt pins the exam's current version when it starts (`versionForStart`, session-state.ts startExam) and
 *    keeps it: questions served, answers accepted, grading and reports all read the pinned snapshot
 *    (`sessionExamContent`). Edits therefore only ever reach attempts that have not started yet.
 *  - Question ids stay stable across versions while a question keeps its type, so answers and analytics line up.
 */
import { createHash } from 'node:crypto';
import type { ExamVersionChangesDTO, ExamVersionExamField, ExamVersionQuestionDTO, ExamVersionQuestionField, ExamVersionReason, ProctoringPolicyInput } from '@sp/shared';
import { desc, eq, max } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/index.js';
import { examVersions, exams, questions, type Exam, type ExamSession, type ExamVersion, type Question } from '../db/schema.js';

export interface ExamSnapshot {
  title: string;
  description: string;
  instructions: string;
  durationSec: number;
  policy: ProctoringPolicyInput;
  questions: ExamVersionQuestionDTO[];
}

/** The snapshot of an exam row and its working-copy questions. */
export function snapshotOf(exam: Pick<Exam, 'title' | 'description' | 'instructions' | 'durationSec' | 'policy'>, qs: Question[]): ExamSnapshot {
  return {
    title: exam.title,
    description: exam.description,
    instructions: exam.instructions,
    durationSec: exam.durationSec,
    policy: (exam.policy ?? {}) as ProctoringPolicyInput,
    questions: [...qs]
      .sort((a, b) => a.position - b.position)
      .map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text })),
        correct: [...(q.correct ?? [])],
        points: q.points,
      })),
  };
}

export function versionSnapshot(v: Pick<ExamVersion, 'title' | 'description' | 'instructions' | 'durationSec' | 'policy' | 'questions'>): ExamSnapshot {
  return { title: v.title, description: v.description, instructions: v.instructions, durationSec: v.durationSec, policy: v.policy ?? {}, questions: v.questions ?? [] };
}

/** JSON with object keys sorted at every level: equal content always serialises (and hashes) the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function snapshotHash(s: ExamSnapshot): string {
  return createHash('sha256').update(canonicalJson(s)).digest('hex');
}

/** What `next` changes relative to `prev` (null: the first version, every question added). */
export function diffSnapshots(prev: ExamSnapshot | null, next: ExamSnapshot): ExamVersionChangesDTO {
  if (!prev) return { added: next.questions.map((q) => q.id), removed: [], changed: [], exam: [] };
  const prevById = new Map(prev.questions.map((q, i) => [q.id, { q, i }]));
  const nextIds = new Set(next.questions.map((q) => q.id));
  const added: string[] = [];
  const changed: ExamVersionChangesDTO['changed'] = [];
  next.questions.forEach((q, i) => {
    const before = prevById.get(q.id);
    if (!before) {
      added.push(q.id);
      return;
    }
    const fields: ExamVersionQuestionField[] = [];
    if (before.q.type !== q.type) fields.push('type');
    if (before.q.prompt !== q.prompt) fields.push('prompt');
    if (canonicalJson(before.q.options) !== canonicalJson(q.options)) fields.push('options');
    if (canonicalJson(before.q.correct) !== canonicalJson(q.correct)) fields.push('correct');
    if (before.q.points !== q.points) fields.push('points');
    if (before.i !== i) fields.push('position');
    if (fields.length) changed.push({ questionId: q.id, fields });
  });
  const removed = prev.questions.filter((q) => !nextIds.has(q.id)).map((q) => q.id);
  const exam: ExamVersionExamField[] = [];
  if (prev.title !== next.title) exam.push('title');
  if (prev.description !== next.description) exam.push('description');
  if (prev.instructions !== next.instructions) exam.push('instructions');
  if (prev.durationSec !== next.durationSec) exam.push('durationSec');
  if (canonicalJson(prev.policy) !== canonicalJson(next.policy)) exam.push('policy');
  return { added, removed, changed, exam };
}

export function isUnchanged(c: ExamVersionChangesDTO): boolean {
  return !c.added.length && !c.removed.length && !c.changed.length && !c.exam.length;
}

/**
 * Versions never change once written, so a version read once can be served from memory by id (answers are saved,
 * and questions served, many times per attempt). Bounded; oldest entries are evicted first.
 */
const VERSION_CACHE_MAX = 256;
const versionCache = new Map<string, ExamVersion>();

export async function loadVersion(db: DbOrTx, id: string): Promise<ExamVersion | null> {
  const hit = versionCache.get(id);
  if (hit) return hit;
  const [v] = await db.select().from(examVersions).where(eq(examVersions.id, id));
  if (!v) return null;
  if (versionCache.size >= VERSION_CACHE_MAX) versionCache.delete(versionCache.keys().next().value!);
  versionCache.set(id, v);
  return v;
}

export async function listVersions(db: DbOrTx, examId: string): Promise<ExamVersion[]> {
  return db.select().from(examVersions).where(eq(examVersions.examId, examId)).orderBy(desc(examVersions.number));
}

/**
 * Write a new version of `exam` from its working copy when the content differs from the current version (else return
 * the current one). The caller must hold the exam row lock (SELECT … FOR UPDATE), which serialises version numbers, or
 * have created the exam in the same transaction.
 */
export async function recordExamVersion(tx: DbOrTx, exam: Exam, opts: { reason: ExamVersionReason; by: string | null; now: number }): Promise<{ version: ExamVersion; created: boolean }> {
  const qs = await tx.select().from(questions).where(eq(questions.examId, exam.id));
  const snap = snapshotOf(exam, qs);
  const current = exam.currentVersionId ? await loadVersion(tx, exam.currentVersionId) : null;
  const changes = diffSnapshots(current ? versionSnapshot(current) : null, snap);
  if (current && isUnchanged(changes)) return { version: current, created: false };
  const [{ latest }] = await tx.select({ latest: max(examVersions.number) }).from(examVersions).where(eq(examVersions.examId, exam.id));
  const [version] = await tx
    .insert(examVersions)
    .values({
      examId: exam.id,
      orgId: exam.orgId,
      number: (latest ?? 0) + 1,
      ...snap,
      contentHash: snapshotHash(snap),
      changes,
      reason: opts.reason,
      createdBy: opts.by,
      createdAt: new Date(opts.now),
    })
    .returning();
  await tx.update(exams).set({ currentVersionId: version.id }).where(eq(exams.id, exam.id));
  exam.currentVersionId = version.id;
  return { version, created: true };
}

/**
 * The version an attempt starting now is pinned to: the exam's current version. Published (and archived) exams are
 * versioned on every edit, so their current version is up to date and the common path takes no lock — a synchronised
 * start of many candidates does not queue on the exam row. A draft started directly (the seed script, tests) may have
 * changed since its last version: it is versioned now, under the exam row lock, when its content differs.
 */
export async function versionForStart(tx: Tx, examId: string, now: number): Promise<ExamVersion> {
  const [cur] = await tx.select({ id: exams.currentVersionId, status: exams.status }).from(exams).where(eq(exams.id, examId));
  if (cur?.id && cur.status !== 'draft') {
    const v = await loadVersion(tx, cur.id);
    if (v) return v;
  }
  const [exam] = await tx.select().from(exams).where(eq(exams.id, examId)).for('update');
  return (await recordExamVersion(tx, exam, { reason: 'started', by: null, now })).version;
}

/**
 * What an attempt sees: its pinned version; before it starts, the exam's current version (or, for an exam never
 * published, the working copy). `version` is null only in that last case.
 */
export async function sessionExamContent(db: DbOrTx, session: Pick<ExamSession, 'examId' | 'examVersionId'>, exam?: Exam): Promise<{ version: ExamVersion | null; snapshot: ExamSnapshot }> {
  const versionId = session.examVersionId ?? exam?.currentVersionId ?? (await db.select({ id: exams.currentVersionId }).from(exams).where(eq(exams.id, session.examId)))[0]?.id ?? null;
  const version = versionId ? await loadVersion(db, versionId) : null;
  if (version) return { version, snapshot: versionSnapshot(version) };
  const row = exam ?? (await db.select().from(exams).where(eq(exams.id, session.examId)))[0];
  const qs = await db.select().from(questions).where(eq(questions.examId, session.examId));
  return { version: null, snapshot: snapshotOf(row, qs) };
}

export function totalPoints(qs: Pick<ExamVersionQuestionDTO, 'points'>[]): number {
  return qs.reduce((s, q) => s + q.points, 0);
}
