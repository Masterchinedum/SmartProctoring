import type { ExamVersionChangesDTO, ExamVersionQuestionDTO, ExamVersionReason, ExamVersionSummaryDTO } from '@sp/shared';
import { downloadText } from './download';
import { pluralize } from './format';

/** Exam versions in the staff UI: labels, change summaries, answer-key text and export downloads. */

export const VERSION_REASON_LABEL: Record<ExamVersionReason, string> = {
  published: 'Published',
  edited: 'Edited while published',
  started: 'Started before publishing',
  migrated: 'Content at upgrade',
};

/** One line per kind of change, most consequential first ("Answer key changed on 1 question", …). Empty: no changes. */
export function describeChanges(c: ExamVersionChangesDTO, opts: { first?: boolean } = {}): string[] {
  if (opts.first) return [`First version · ${pluralize(c.added.length, 'question')}`];
  const out: string[] = [];
  const count = (field: string) => c.changed.filter((x) => (x.fields as string[]).includes(field)).length;
  const keys = count('correct');
  const points = count('points');
  if (keys) out.push(`Answer key changed on ${pluralize(keys, 'question')}`);
  if (points) out.push(`Points changed on ${pluralize(points, 'question')}`);
  if (c.added.length) out.push(`${pluralize(c.added.length, 'question')} added`);
  if (c.removed.length) out.push(`${pluralize(c.removed.length, 'question')} removed`);
  const prompt = count('prompt');
  const options = count('options');
  if (prompt) out.push(`Wording changed on ${pluralize(prompt, 'question')}`);
  if (options) out.push(`Options changed on ${pluralize(options, 'question')}`);
  if (count('position') && !c.added.length && !c.removed.length) out.push('Questions reordered');
  const EXAM_FIELD_LABEL: Record<string, string> = { title: 'title', description: 'description', instructions: 'instructions', durationSec: 'duration', policy: 'proctoring rules' };
  if (c.exam.length) out.push(`Changed ${c.exam.map((f) => EXAM_FIELD_LABEL[f] ?? f).join(', ')}`);
  return out;
}

/** Whether a version changed answer keys or points — what a regrade of earlier attempts would act on. */
export function changesScoring(c: ExamVersionChangesDTO): boolean {
  return c.changed.some((x) => x.fields.includes('correct') || x.fields.includes('points'));
}

/**
 * Versions whose attempts could be regraded with `keys`: older versions with finished attempts. A regrade only takes
 * over keys and points of questions both versions share, so any older version is a candidate.
 */
export function regradeSources(versions: ExamVersionSummaryDTO[], keys: ExamVersionSummaryDTO): ExamVersionSummaryDTO[] {
  return versions.filter((v) => v.id !== keys.id && v.number < keys.number && v.sessions.finished > 0);
}

/** An answer key in words: option texts for choice questions, the accepted answers otherwise. */
export function formatAnswerKey(q: Pick<ExamVersionQuestionDTO, 'type' | 'options'> | undefined, correct: string[]): string {
  if (!correct.length) return q?.type === 'long_text' ? 'Graded manually' : 'No key';
  if (q && (q.type === 'single_choice' || q.type === 'multiple_choice')) {
    return correct.map((id) => q.options.find((o) => o.id === id)?.text ?? id).join(' · ');
  }
  return correct.join(' · ');
}

export function formatScore(s: { points: number; maxPoints: number }): string {
  const pts = (n: number) => String(Math.round(n * 100) / 100);
  return `${pts(s.points)} / ${pts(s.maxPoints)}`;
}

/** A safe download file name from an exam title (mirrors the server's Content-Disposition name). */
export function exportFileName(title: string, version?: number | null): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `${slug || 'exam'}${version != null ? `-v${version}` : ''}.exam.json`;
}

/** Save a JSON document as a file in the browser. */
export function downloadJson(doc: unknown, filename: string): void {
  downloadText(`${JSON.stringify(doc, null, 2)}\n`, filename, 'application/json');
}

/** Largest exam document the import accepts (the server's body limit). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function blobText(b: Blob): Promise<string> {
  if (typeof b.text === 'function') return b.text();
  // Older engines (and jsdom) have no Blob.text().
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(b);
  });
}

/** Read and minimally check an exam file before upload; the server validates it fully. */
export async function readExamFile(file: Blob): Promise<{ ok: true; doc: unknown; title: string; questions: number } | { ok: false; error: string }> {
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: 'This file is larger than 5 MB — it is not an exported exam.' };
  let doc: unknown;
  try {
    doc = JSON.parse(await blobText(file));
  } catch {
    return { ok: false, error: 'This file is not valid JSON. Choose a file exported from SmartProctoring (…exam.json).' };
  }
  const d = doc as { format?: unknown; formatVersion?: unknown; exam?: { title?: unknown; questions?: unknown } } | null;
  if (!d || typeof d !== 'object' || d.format !== 'smartproctoring.exam') {
    return { ok: false, error: 'This file is not a SmartProctoring exam export.' };
  }
  if (d.formatVersion !== 1) return { ok: false, error: `This export uses format version ${String(d.formatVersion)}, which this server does not support.` };
  const title = typeof d.exam?.title === 'string' ? d.exam.title : '';
  const questions = Array.isArray(d.exam?.questions) ? d.exam.questions.length : 0;
  return { ok: true, doc, title, questions };
}
