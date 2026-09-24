import { DEFAULT_POLICY, type ExamDTO, type ExamInput, type ProctoringPolicy, type QuestionType } from '@sp/shared';
import { normalizePolicy } from './policyForm';

/** Editable draft of an exam (form state) and its mapping to/from the API. */

export interface OptionDraft {
  id: string;
  text: string;
}

export interface QuestionDraft {
  /** Local React key (stable across reorders). */
  key: string;
  /** Server id for existing questions. */
  id?: string;
  type: QuestionType;
  prompt: string;
  options: OptionDraft[];
  /** single/multiple choice: option ids. short_text: accepted answers. numeric: [value]. long_text: []. */
  correct: string[];
  points: number;
}

export interface ExamDraft {
  title: string;
  description: string;
  instructions: string;
  /** Kept as text so the input can be edited freely. */
  durationMin: string;
  questions: QuestionDraft[];
  policy: ProctoringPolicy;
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  short_text: 'Short text',
  long_text: 'Long text (manually graded)',
  numeric: 'Numeric',
};

let keySeq = 0;
export function newKey(): string {
  keySeq += 1;
  return `q${Date.now().toString(36)}${keySeq}`;
}

export function isChoice(type: QuestionType): boolean {
  return type === 'single_choice' || type === 'multiple_choice';
}

/** Next free option id: a, b, c … z, then opt27, opt28 … */
export function nextOptionId(options: OptionDraft[]): string {
  const used = new Set(options.map((o) => o.id));
  for (let i = 0; i < 26; i++) {
    const id = String.fromCharCode(97 + i);
    if (!used.has(id)) return id;
  }
  let n = 27;
  while (used.has(`opt${n}`)) n++;
  return `opt${n}`;
}

export function newQuestion(type: QuestionType = 'single_choice'): QuestionDraft {
  return {
    key: newKey(),
    type,
    prompt: '',
    options: isChoice(type) ? [{ id: 'a', text: '' }, { id: 'b', text: '' }] : [],
    correct: [],
    points: 1,
  };
}

/** Switch a question's type, keeping what still makes sense. */
export function changeQuestionType(q: QuestionDraft, type: QuestionType): QuestionDraft {
  if (q.type === type) return q;
  if (isChoice(type)) {
    const options = q.options.length >= 2 ? q.options : [{ id: 'a', text: '' }, { id: 'b', text: '' }];
    const valid = q.correct.filter((c) => options.some((o) => o.id === c));
    const correct = isChoice(q.type) ? (type === 'single_choice' ? valid.slice(0, 1) : valid) : [];
    return { ...q, type, options, correct };
  }
  const keepText = q.type === 'short_text' && type === 'short_text';
  return { ...q, type, options: [], correct: keepText ? q.correct : [] };
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function examToDraft(exam: ExamDTO | null | undefined, defaultPolicy: ProctoringPolicy = DEFAULT_POLICY): ExamDraft {
  if (!exam) {
    return { title: '', description: '', instructions: '', durationMin: '60', questions: [], policy: normalizePolicy(defaultPolicy) };
  }
  return {
    title: exam.title,
    description: exam.description,
    instructions: exam.instructions,
    durationMin: String(Math.round((exam.durationSec / 60) * 100) / 100),
    policy: normalizePolicy(exam.policy),
    questions: exam.questions.map((q) => ({
      key: newKey(),
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      options: (q.options ?? []).map((o) => ({ ...o })),
      correct: [...(q.correct ?? [])],
      points: q.points ?? 1,
    })),
  };
}

/** Validation messages keyed by field ('title', 'durationMin', 'q:<index>'). Empty = valid. */
export function validateExamDraft(d: ExamDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.title.trim()) errors.title = 'Title is required';
  const minutes = Number(d.durationMin);
  if (!Number.isFinite(minutes) || d.durationMin.trim() === '') errors.durationMin = 'Enter the duration in minutes';
  else if (minutes < 1) errors.durationMin = 'At least 1 minute';
  else if (minutes > 24 * 60) errors.durationMin = 'At most 24 hours (1440 minutes)';
  d.questions.forEach((q, i) => {
    const e = questionError(q);
    if (e) errors[`q:${i}`] = e;
  });
  return errors;
}

export function questionError(q: QuestionDraft): string | null {
  if (!q.prompt.trim()) return 'Enter the question text';
  if (!Number.isFinite(q.points) || q.points < 0) return 'Points must be 0 or more';
  if (isChoice(q.type)) {
    if (q.options.length < 2) return 'Add at least two options';
    const ids = q.options.map((o) => o.id.trim());
    if (ids.some((id) => !id)) return 'Every option needs an id';
    if (new Set(ids).size !== ids.length) return 'Option ids must be unique';
    if (ids.some((id) => id.length > 50)) return 'Option ids must be at most 50 characters';
    if (q.options.some((o) => !o.text.trim())) return 'Every option needs text';
    const correct = q.correct.filter((c) => ids.includes(c));
    if (q.type === 'single_choice' && correct.length !== 1) return 'Mark exactly one correct option';
    if (q.type === 'multiple_choice' && correct.length < 1) return 'Mark at least one correct option';
  }
  if (q.type === 'numeric' && q.correct.length > 0 && q.correct[0].trim() !== '' && !Number.isFinite(Number(q.correct[0]))) {
    return 'The correct answer must be a number';
  }
  return null;
}

export function draftToExamInput(d: ExamDraft): ExamInput {
  const durationSec = Math.round(Number(d.durationMin) * 60);
  return {
    title: d.title.trim(),
    description: d.description,
    instructions: d.instructions,
    durationSec,
    policy: d.policy as unknown as Record<string, unknown>,
    questions: d.questions.map((q) => {
      const options = isChoice(q.type) ? q.options.map((o) => ({ id: o.id.trim(), text: o.text })) : [];
      let correct: string[];
      if (isChoice(q.type)) {
        const ids = options.map((o) => o.id);
        correct = q.correct.map((c) => c.trim()).filter((c) => ids.includes(c));
        if (q.type === 'single_choice') correct = correct.slice(0, 1);
      } else if (q.type === 'short_text') {
        correct = q.correct.map((c) => c.trim()).filter(Boolean);
      } else if (q.type === 'numeric') {
        const v = (q.correct[0] ?? '').trim();
        correct = v === '' ? [] : [String(Number(v))];
      } else {
        correct = [];
      }
      return { ...(q.id ? { id: q.id } : {}), type: q.type, prompt: q.prompt, options, correct, points: q.points };
    }),
  };
}

export function totalPoints(questions: QuestionDraft[]): number {
  return questions.reduce((s, q) => s + (Number.isFinite(q.points) ? q.points : 0), 0);
}
