import { describe, expect, it } from 'vitest';
import type { ExamVersionSummaryDTO } from '@sp/shared';
import { changesScoring, describeChanges, exportFileName, formatAnswerKey, formatScore, readExamFile, regradeSources } from './examVersions';

const none = { added: [], removed: [], changed: [], exam: [] };

function version(number: number, finished: number, over: Partial<ExamVersionSummaryDTO> = {}): ExamVersionSummaryDTO {
  return {
    id: `v${number}`,
    number,
    createdAt: number,
    reason: 'edited',
    createdBy: null,
    contentHash: 'h',
    changes: none,
    questionCount: 2,
    totalPoints: 3,
    sessions: { started: finished, finished },
    current: false,
    ...over,
  };
}

describe('describeChanges', () => {
  it('summarises the first version by its question count', () => {
    expect(describeChanges({ ...none, added: ['a', 'b'] }, { first: true })).toEqual(['First version · 2 questions']);
  });

  it('puts scoring changes first and names exam-level fields in words', () => {
    const lines = describeChanges({
      added: ['n'],
      removed: [],
      changed: [
        { questionId: 'a', fields: ['correct'] },
        { questionId: 'b', fields: ['prompt', 'points'] },
      ],
      exam: ['durationSec', 'policy'],
    });
    expect(lines).toEqual(['Answer key changed on 1 question', 'Points changed on 1 question', '1 question added', 'Wording changed on 1 question', 'Changed duration, proctoring rules']);
  });

  it('reports a pure reorder, but not the position shifts caused by added or removed questions', () => {
    expect(describeChanges({ ...none, changed: [{ questionId: 'a', fields: ['position'] }] })).toEqual(['Questions reordered']);
    expect(describeChanges({ ...none, removed: ['x'], changed: [{ questionId: 'a', fields: ['position'] }] })).toEqual(['1 question removed']);
    expect(describeChanges(none)).toEqual([]);
  });

  it('flags versions that changed scoring', () => {
    expect(changesScoring({ ...none, changed: [{ questionId: 'a', fields: ['prompt'] }] })).toBe(false);
    expect(changesScoring({ ...none, changed: [{ questionId: 'a', fields: ['points'] }] })).toBe(true);
  });
});

describe('regradeSources', () => {
  it('offers older versions that have finished attempts', () => {
    const vs = [version(4, 0), version(3, 2), version(2, 0), version(1, 5)];
    expect(regradeSources(vs, vs[0]).map((v) => v.number)).toEqual([3, 1]);
    expect(regradeSources(vs, vs[1]).map((v) => v.number)).toEqual([1]);
    expect(regradeSources(vs, vs[3])).toEqual([]);
  });
});

describe('formatting', () => {
  const choice = { type: 'single_choice' as const, options: [{ id: 'a', text: 'Paris' }, { id: 'b', text: 'Lyon' }] };
  it('renders answer keys in words', () => {
    expect(formatAnswerKey(choice, ['b'])).toBe('Lyon');
    expect(formatAnswerKey(choice, ['zz'])).toBe('zz');
    expect(formatAnswerKey({ type: 'short_text', options: [] }, ['colour', 'color'])).toBe('colour · color');
    expect(formatAnswerKey({ type: 'long_text', options: [] }, [])).toBe('Graded manually');
    expect(formatAnswerKey(undefined, [])).toBe('No key');
  });

  it('formats scores and file names', () => {
    expect(formatScore({ points: 2.5, maxPoints: 4 })).toBe('2.5 / 4');
    expect(formatScore({ points: 1 / 3, maxPoints: 1 })).toBe('0.33 / 1');
    expect(exportFileName('Algèbre — Final (2026)!', 3)).toBe('algebre-final-2026-v3.exam.json');
    expect(exportFileName('!!!')).toBe('exam.exam.json');
  });
});

describe('readExamFile', () => {
  const file = (text: string) => new Blob([text], { type: 'application/json' });
  it('accepts an export and reports its title and size', async () => {
    const r = await readExamFile(file(JSON.stringify({ format: 'smartproctoring.exam', formatVersion: 1, exam: { title: 'Algebra', questions: [{}, {}] } })));
    expect(r).toMatchObject({ ok: true, title: 'Algebra', questions: 2 });
  });

  it('explains what is wrong with other files', async () => {
    expect(await readExamFile(file('not json'))).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
    expect(await readExamFile(file('{"title":"x"}'))).toMatchObject({ ok: false, error: expect.stringContaining('not a SmartProctoring exam export') });
    expect(await readExamFile(file('{"format":"smartproctoring.exam","formatVersion":2}'))).toMatchObject({ ok: false, error: expect.stringContaining('format version 2') });
    expect(await readExamFile(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]))).toMatchObject({ ok: false, error: expect.stringContaining('larger than 5 MB') });
  });
});
