import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, examInputSchema, type ExamDTO } from '@sp/shared';
import { changeQuestionType, draftToExamInput, examToDraft, moveItem, newQuestion, nextOptionId, questionError, totalPoints, validateExamDraft } from './examForm';
import { setPath } from './policyForm';

const exam: ExamDTO = {
  id: 'e1',
  title: 'Algebra',
  description: 'd',
  instructions: 'i',
  durationSec: 5400,
  status: 'draft',
  policy: setPath(DEFAULT_POLICY, 'pause.requireApproval', true),
  questions: [
    { id: 'q1', type: 'single_choice', prompt: '2+2?', options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }], correct: ['b'], points: 2 },
    { id: 'q2', type: 'numeric', prompt: 'pi to 2dp', options: [], correct: ['3.14'], points: 1 },
  ],
  createdAt: 1,
  updatedAt: 2,
  stats: { assigned: 0, active: 0, completed: 0, flagged: 0 },
};

describe('exam draft mapping', () => {
  it('round-trips an existing exam', () => {
    const d = examToDraft(exam);
    expect(d.durationMin).toBe('90');
    expect(d.policy.pause.requireApproval).toBe(true);
    const input = draftToExamInput(d);
    expect(input.durationSec).toBe(5400);
    expect(input.questions).toEqual([
      { id: 'q1', type: 'single_choice', prompt: '2+2?', options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }], correct: ['b'], points: 2 },
      { id: 'q2', type: 'numeric', prompt: 'pi to 2dp', options: [], correct: ['3.14'], points: 1 },
    ]);
    expect(examInputSchema.safeParse(input).success).toBe(true);
  });

  it('starts new exams from the given default policy', () => {
    const d = examToDraft(null, setPath(DEFAULT_POLICY, 'browser.requireFullscreen', false));
    expect(d.policy.browser.requireFullscreen).toBe(false);
    expect(d.questions).toEqual([]);
    expect(validateExamDraft(d)).toEqual({ title: 'Title is required' });
  });

  it('normalizes answers per question type', () => {
    const d = examToDraft(null);
    d.title = 'T';
    d.durationMin = '1.5';
    d.questions = [
      { ...newQuestion('multiple_choice'), prompt: 'p', options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], correct: ['a', 'b', 'ghost'] },
      { ...newQuestion('short_text'), prompt: 'p', correct: [' Paris ', '', 'paris'] },
      { ...newQuestion('numeric'), prompt: 'p', correct: [' 42.0 '] },
      { ...newQuestion('long_text'), prompt: 'p', correct: ['ignored'] },
    ];
    const input = draftToExamInput(d);
    expect(input.durationSec).toBe(90);
    expect(input.questions.map((q) => q.correct)).toEqual([['a', 'b'], ['Paris', 'paris'], ['42'], []]);
    expect(input.questions[1].options).toEqual([]);
    expect(input.questions.every((q) => !('id' in q))).toBe(true);
    expect(examInputSchema.safeParse(input).success).toBe(true);
  });
});

describe('question validation', () => {
  it('requires prompt, options, unique ids and correct answers', () => {
    const q = newQuestion('single_choice');
    expect(questionError(q)).toBe('Enter the question text');
    q.prompt = 'p';
    expect(questionError(q)).toBe('Every option needs text');
    q.options = [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }];
    expect(questionError(q)).toBe('Option ids must be unique');
    q.options = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
    expect(questionError(q)).toBe('Mark exactly one correct option');
    q.correct = ['b'];
    expect(questionError(q)).toBeNull();
    expect(questionError({ ...q, type: 'multiple_choice', correct: [] })).toBe('Mark at least one correct option');
    expect(questionError({ ...newQuestion('numeric'), prompt: 'p', correct: ['abc'] })).toBe('The correct answer must be a number');
    expect(questionError({ ...newQuestion('long_text'), prompt: 'p', points: -1 })).toBe('Points must be 0 or more');
  });

  it('validates duration bounds', () => {
    const d = { ...examToDraft(null), title: 'x' };
    expect(validateExamDraft({ ...d, durationMin: '0.5' }).durationMin).toBe('At least 1 minute');
    expect(validateExamDraft({ ...d, durationMin: '2000' }).durationMin).toMatch(/At most/);
    expect(validateExamDraft({ ...d, durationMin: '' }).durationMin).toBeDefined();
    expect(validateExamDraft({ ...d, durationMin: '45' })).toEqual({});
  });
});

describe('editor helpers', () => {
  it('generates option ids', () => {
    expect(nextOptionId([])).toBe('a');
    expect(nextOptionId([{ id: 'a', text: '' }, { id: 'c', text: '' }])).toBe('b');
    const full = Array.from({ length: 26 }, (_, i) => ({ id: String.fromCharCode(97 + i), text: '' }));
    expect(nextOptionId(full)).toBe('opt27');
  });

  it('changes question types sensibly', () => {
    const single = { ...newQuestion('multiple_choice'), options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], correct: ['a', 'b'] };
    expect(changeQuestionType(single, 'single_choice').correct).toEqual(['a']);
    const text = changeQuestionType(single, 'short_text');
    expect(text.options).toEqual([]);
    expect(text.correct).toEqual([]);
    expect(changeQuestionType(text, 'multiple_choice').options).toHaveLength(2);
  });

  it('moves items and totals points', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 5)).toEqual([1, 2, 3]);
    expect(totalPoints([{ ...newQuestion(), points: 2 }, { ...newQuestion(), points: NaN }])).toBe(2);
  });
});
