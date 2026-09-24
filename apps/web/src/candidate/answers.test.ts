import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerStore, isAnswered, normaliseAnswer } from './answers';
import { Outbox } from './outbox';

let n = 0;
const openBox = () => Outbox.open({ namespace: `answers-${++n}`, memory: true });

describe('normaliseAnswer / isAnswered', () => {
  it('normalises values per question type', () => {
    expect(normaliseAnswer('numeric', ' 3,5 ')).toBe(3.5);
    expect(normaliseAnswer('numeric', '')).toBeNull();
    expect(normaliseAnswer('numeric', 'abc')).toBeNull();
    expect(normaliseAnswer('multiple_choice', ['b', 'a', 'b'])).toEqual(['a', 'b']);
    expect(normaliseAnswer('single_choice', '')).toBeNull();
    expect(normaliseAnswer('short_text', 'x')).toBe('x');
  });
  it('detects answered values', () => {
    expect(isAnswered('  ')).toBe(false);
    expect(isAnswered([])).toBe(false);
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(0)).toBe(true);
    expect(isAnswered(['a'])).toBe(true);
  });
});

describe('AnswerStore', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('debounces edits and saves with strictly increasing clientSeq', async () => {
    const box = await openBox();
    const put = vi.spyOn(box, 'putAnswer');
    const store = new AnswerStore(box, { debounceMs: 600 });
    await store.restore([{ questionId: 'q0', value: 'x', clientSeq: 4, savedAt: 1 }]);
    store.set('q1', 'a');
    store.set('q1', 'ab');
    store.set('q1', 'abc');
    expect(store.get('q1')).toBe('abc'); // UI sees the value immediately
    await vi.advanceTimersByTimeAsync(599);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatchObject({ questionId: 'q1', value: 'abc', clientSeq: 5 });

    store.set('q2', 1);
    store.set('q1', 'abcd');
    await store.flushPending();
    const seqs = put.mock.calls.map((c) => c[0].clientSeq);
    expect(seqs).toEqual([5, 6, 7]);
    expect(store.hasUnsavedEdits()).toBe(false);
  });

  it('restores answers: newer local edits win over older server values and are re-queued', async () => {
    const box = await openBox();
    // Local mirror from before the reload: q1 newer & undelivered, q2 older than the server, q3 local only (delivered)
    await box.putAnswer({ questionId: 'q1', value: 'local-new', clientSeq: 9, answeredAt: 90 });
    await box.rememberDeliveredAnswer({ questionId: 'q2', value: 'local-old', clientSeq: 2, answeredAt: 20 });
    await box.rememberDeliveredAnswer({ questionId: 'q3', value: 'only-local', clientSeq: 3, answeredAt: 30 });
    const store = new AnswerStore(box);
    await store.restore([
      { questionId: 'q1', value: 'server-old', clientSeq: 5, savedAt: 50 },
      { questionId: 'q2', value: 'server-new', clientSeq: 6, savedAt: 60 },
    ]);
    expect(store.get('q1')).toBe('local-new');
    expect(store.get('q2')).toBe('server-new');
    expect(store.get('q3')).toBe('only-local');
    expect(store.currentSeq).toBeGreaterThanOrEqual(10);
    const pending = (await box.getAnswers()).filter((a) => a.pending).map((a) => a.questionId).sort();
    expect(pending).toEqual(['q1', 'q3']);
  });

  it('continues numbering above the server sequence after a reload on a new device', async () => {
    const box = await openBox();
    const store = new AnswerStore(box, { debounceMs: 10 });
    await store.restore([{ questionId: 'q1', value: 'a', clientSeq: 41, savedAt: 1 }]);
    store.set('q1', 'b');
    await store.flushPending();
    const [rec] = await box.getAnswers();
    expect(rec.clientSeq).toBe(42);
    expect(rec.value).toBe('b');
  });

  it('counts answered questions', async () => {
    const box = await openBox();
    const store = new AnswerStore(box);
    await store.restore(null);
    store.set('a', 'x');
    store.set('b', '');
    store.set('c', ['o1']);
    expect(store.answeredCount(['a', 'b', 'c', 'd'])).toBe(2);
    store.dispose();
  });
});
