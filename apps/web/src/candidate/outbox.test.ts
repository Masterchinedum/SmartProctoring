import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventUpsert, IdentitySampleResponse } from '@sp/shared';
import { CandidateApiError } from './api';
import { Outbox, type OutboxSender } from './outbox';

let ns = 0;
const nextNs = () => `test-${Date.now()}-${++ns}`;

function ev(id: string, version: number, extra: Partial<EventUpsert> = {}): EventUpsert {
  return {
    id,
    type: 'candidate_absent',
    phase: version === 1 ? 'open' : 'update',
    startedAt: 1000,
    endedAt: null,
    confidence: 0.8,
    details: {},
    version,
    ...extra,
  };
}

const sampleResponse: IdentitySampleResponse = {
  result: { id: 'r', trigger: 'periodic', decision: 'match', similarity: 0.7, confidence: 0.9, quality: null, guidance: [], at: 1 },
  followUpInMs: null,
  status: 'active',
  hold: null,
};

function makeSender(overrides: Partial<Record<keyof OutboxSender, (...args: never[]) => unknown>> = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];
  const sender: OutboxSender = {
    saveAnswer: vi.fn(async (...args: unknown[]) => {
      calls.push({ kind: 'answer', args });
      if (overrides.saveAnswer) return (overrides.saveAnswer as (...a: unknown[]) => never)(...args);
      return { saved: true, applied: true, serverSeq: 1 };
    }),
    sendEvents: vi.fn(async (...args: unknown[]) => {
      calls.push({ kind: 'events', args });
      if (overrides.sendEvents) return (overrides.sendEvents as (...a: unknown[]) => never)(...args);
      const events = args[0] as EventUpsert[];
      return { results: events.map((e) => ({ id: e.id, result: 'created' as const })) };
    }),
    uploadEvidence: vi.fn(async (...args: unknown[]) => {
      calls.push({ kind: 'evidence', args });
      if (overrides.uploadEvidence) return (overrides.uploadEvidence as (...a: unknown[]) => never)(...args);
      return { stored: true, duplicate: false };
    }),
    identitySample: vi.fn(async (...args: unknown[]) => {
      calls.push({ kind: 'sample', args });
      if (overrides.identitySample) return (overrides.identitySample as (...a: unknown[]) => never)(...args);
      return sampleResponse;
    }),
  };
  return { sender, calls };
}

const jpeg = () => new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe.each([
  ['indexeddb', false],
  ['memory', true],
])('Outbox (%s)', (_name, memory) => {
  let box: Outbox;
  beforeEach(async () => {
    box = await Outbox.open({ namespace: nextNs(), memory });
  });
  afterEach(() => box.close());

  it('uses the requested backend', () => {
    expect(box.storage).toBe(memory ? 'memory' : 'indexeddb');
  });

  it('keeps only the highest version of an event', async () => {
    await box.putEvent(ev('11111111-1111-4111-8111-111111111111', 2));
    await box.putEvent(ev('11111111-1111-4111-8111-111111111111', 1));
    await box.putEvent(ev('11111111-1111-4111-8111-111111111111', 3, { phase: 'close', endedAt: 5000 }));
    await box.putEvent(ev('11111111-1111-4111-8111-111111111111', 2));
    const pending = await box.pendingEvents();
    expect(pending).toHaveLength(1);
    expect(pending[0].upsert.version).toBe(3);
    expect(pending[0].upsert.phase).toBe('close');
    expect(box.stats().size).toBe(1);
  });

  it('keeps the highest clientSeq per answer and tracks pending answers', async () => {
    expect(await box.putAnswer({ questionId: 'q1', value: 'a', clientSeq: 2, answeredAt: 10 })).toBe(true);
    expect(await box.putAnswer({ questionId: 'q1', value: 'old', clientSeq: 1, answeredAt: 5 })).toBe(false);
    expect(await box.putAnswer({ questionId: 'q2', value: ['x'], clientSeq: 3, answeredAt: 11 })).toBe(true);
    const answers = await box.getAnswers();
    expect(answers.find((a) => a.questionId === 'q1')?.value).toBe('a');
    expect(box.stats().pendingAnswers).toBe(2);
  });

  it('delivers answers, then events, then evidence, then samples, and empties the queue', async () => {
    const onSampleResult = vi.fn();
    box.close();
    box = await Outbox.open({ namespace: nextNs(), memory, onSampleResult });
    await box.putSample({ id: 's1', trigger: 'periodic', capturedAt: 50, jpeg: jpeg() });
    await box.putEvidence({ id: 'e1', eventId: '22222222-2222-4222-8222-222222222222', capturedAt: 40, reason: 'onset', jpeg: jpeg() });
    await box.putEvent(ev('22222222-2222-4222-8222-222222222222', 1));
    await box.putAnswer({ questionId: 'q1', value: 'a', clientSeq: 1, answeredAt: 10 });
    expect(box.stats().size).toBe(4);

    const { sender, calls } = makeSender();
    const res = await box.flushOnce(sender);
    expect(res.remaining).toBe(0);
    expect(calls.map((c) => c.kind)).toEqual(['answer', 'events', 'evidence', 'sample']);
    expect(onSampleResult).toHaveBeenCalledWith(expect.objectContaining({ id: 's1', trigger: 'periodic', capturedAt: 50 }), sampleResponse);
    // The evidence body is the original JPEG bytes and the original timestamps are preserved.
    const evCall = calls.find((c) => c.kind === 'evidence')!;
    expect(new Uint8Array(evCall.args[1] as ArrayBuffer)).toEqual(jpeg());
    expect(evCall.args[2]).toEqual({ eventId: '22222222-2222-4222-8222-222222222222', capturedAt: 40, reason: 'onset' });
    // Answer mirror remains for restore, but no longer pending.
    const answers = await box.getAnswers();
    expect(answers).toHaveLength(1);
    expect(answers[0].pending).toBe(false);
    expect(box.stats()).toMatchObject({ size: 0, oldestAt: null });
  });

  it('keeps items on network failure and reports failingSince', async () => {
    await box.putEvent(ev('33333333-3333-4333-8333-333333333333', 1));
    const { sender } = makeSender({
      sendEvents: () => {
        throw new CandidateApiError(0, 'network_error', 'offline');
      },
    });
    box.start(sender);
    await expect(box.flush()).rejects.toThrow('offline');
    expect(box.stats().size).toBe(1);
    expect(box.stats().failingSince).not.toBeNull();
    box.stop();
  });

  it('drops permanently rejected items but keeps going', async () => {
    const onDropped = vi.fn();
    box.close();
    box = await Outbox.open({ namespace: nextNs(), memory, onDropped });
    await box.putAnswer({ questionId: 'bad', value: 'a', clientSeq: 1, answeredAt: 10 });
    await box.putAnswer({ questionId: 'good', value: 'b', clientSeq: 2, answeredAt: 11 });
    const { sender } = makeSender({
      saveAnswer: (qid: never) => {
        if ((qid as unknown as string) === 'bad') throw new CandidateApiError(400, 'validation_failed', 'bad');
        return { saved: true, applied: true, serverSeq: 2 };
      },
    });
    const res = await box.flushOnce(sender);
    expect(res.remaining).toBe(0);
    expect(onDropped).toHaveBeenCalledWith('answer', 'bad', 'bad');
  });

  it('isolates an invalid event when a batch is refused', async () => {
    await box.putEvent(ev('44444444-4444-4444-8444-444444444444', 1));
    await box.putEvent(ev('55555555-5555-4555-8555-555555555555', 1));
    const sendEvents = (events: never) => {
      const list = events as unknown as EventUpsert[];
      if (list.some((e) => e.id.startsWith('4444'))) throw new CandidateApiError(400, 'validation_failed', 'invalid');
      return { results: list.map((e) => ({ id: e.id, result: 'created' })) };
    };
    const { sender, calls } = makeSender({ sendEvents });
    const res = await box.flushOnce(sender);
    expect(res.remaining).toBe(0);
    expect(calls.filter((c) => c.kind === 'events')).toHaveLength(3); // batch + 2 singles
  });

  it('does not delete a newer event version queued while an older one was in flight', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    await box.putEvent(ev(id, 1));
    const { sender } = makeSender({
      sendEvents: async (events: never) => {
        await box.putEvent(ev(id, 2));
        return { results: (events as unknown as EventUpsert[]).map((e) => ({ id: e.id, result: 'created' })) };
      },
    });
    await box.flushOnce(sender);
    const pending = await box.pendingEvents();
    expect(pending.map((p) => p.upsert.version)).toEqual([2]);
  });

  it('keeps the newer answer when it changes during delivery', async () => {
    await box.putAnswer({ questionId: 'q', value: 'a', clientSeq: 1, answeredAt: 1 });
    const { sender } = makeSender({
      saveAnswer: async () => {
        await box.putAnswer({ questionId: 'q', value: 'b', clientSeq: 2, answeredAt: 2 });
        return { saved: true, applied: true, serverSeq: 1 };
      },
    });
    await box.flushOnce(sender);
    expect(box.stats().pendingAnswers).toBe(1);
    const [a] = await box.getAnswers();
    expect(a).toMatchObject({ value: 'b', clientSeq: 2, pending: true });
  });

  it('stops and reports fatal errors (superseded)', async () => {
    const onFatal = vi.fn();
    box.close();
    box = await Outbox.open({ namespace: nextNs(), memory, onFatal });
    await box.putEvent(ev('77777777-7777-4777-8777-777777777777', 1));
    const { sender } = makeSender({
      sendEvents: () => {
        throw new CandidateApiError(409, 'superseded', 'another browser');
      },
    });
    box.start(sender);
    await expect(box.flush()).rejects.toThrow();
    expect(onFatal).toHaveBeenCalledWith('superseded');
    expect(box.stats().size).toBe(1);
  });

  it('waits for the event before uploading its evidence', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    await box.putEvent(ev(id, 1));
    await box.putEvidence({ id: 'ev1', eventId: id, capturedAt: 1, reason: 'onset', jpeg: jpeg() });
    let failEvents = true;
    const { sender, calls } = makeSender({
      sendEvents: (events: never) => {
        if (failEvents) throw new CandidateApiError(503, 'unavailable', 'down');
        return { results: (events as unknown as EventUpsert[]).map((e) => ({ id: e.id, result: 'created' })) };
      },
    });
    await expect(box.flushOnce(sender)).rejects.toThrow('down');
    expect(calls.some((c) => c.kind === 'evidence')).toBe(false);
    failEvents = false;
    await box.flushOnce(sender);
    expect(calls.filter((c) => c.kind === 'evidence')).toHaveLength(1);
    expect(box.stats().size).toBe(0);
  });

  it('caps stored evidence by dropping the oldest screenshots', async () => {
    const onDropped = vi.fn();
    box.close();
    box = await Outbox.open({ namespace: nextNs(), memory, maxEvidence: 2, onDropped });
    for (let i = 0; i < 4; i++) await box.putEvidence({ id: `e${i}`, eventId: 'x', capturedAt: i, reason: 'periodic', jpeg: jpeg() });
    expect(box.stats().size).toBe(2);
    expect(onDropped).toHaveBeenCalledTimes(2);
    expect(onDropped.mock.calls.map((c) => c[1])).toEqual(['e0', 'e1']);
  });

  it('flushNow waits for delivery within the time limit', async () => {
    await box.putAnswer({ questionId: 'q', value: 'a', clientSeq: 1, answeredAt: 1 });
    let attempt = 0;
    const { sender } = makeSender({
      saveAnswer: () => {
        attempt++;
        if (attempt < 2) throw new CandidateApiError(0, 'network_error', 'offline');
        return { saved: true, applied: true, serverSeq: 1 };
      },
    });
    box.start(sender);
    const ok = await box.flushNow(3000, 'answers');
    expect(ok).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(2);
    box.stop();
  });

  it('flushNow gives up after the time limit without throwing', async () => {
    await box.putAnswer({ questionId: 'q', value: 'a', clientSeq: 1, answeredAt: 1 });
    const { sender } = makeSender({
      saveAnswer: () => {
        throw new CandidateApiError(0, 'network_error', 'offline');
      },
    });
    box.start(sender);
    const t0 = Date.now();
    const ok = await box.flushNow(400);
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    box.stop();
  });
});

describe('Outbox persistence (IndexedDB)', () => {
  it('survives a reload: queued items and the answer mirror are restored', async () => {
    const namespace = nextNs();
    const a = await Outbox.open({ namespace });
    await a.putEvent(ev('99999999-9999-4999-8999-999999999999', 4));
    await a.putAnswer({ questionId: 'q1', value: 42, clientSeq: 7, answeredAt: 123 });
    await a.putEvidence({ id: 'ev', eventId: '99999999-9999-4999-8999-999999999999', capturedAt: 9, reason: 'onset', jpeg: jpeg() });
    const before = a.stats();
    a.close();

    const b = await Outbox.open({ namespace });
    expect(b.storage).toBe('indexeddb');
    const after = b.stats();
    expect(after.size).toBe(3);
    expect(after.oldestAt).toBe(before.oldestAt);
    const answers = await b.getAnswers();
    expect(answers[0]).toMatchObject({ questionId: 'q1', value: 42, clientSeq: 7, pending: true });
    b.close();
  });
});

describe('Outbox worker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off exponentially (1 s -> 30 s) and retries immediately when back online', async () => {
    const box = await Outbox.open({ namespace: nextNs(), memory: true });
    let online = false;
    const attempts: number[] = [];
    const { sender } = makeSender({
      sendEvents: (events: never) => {
        attempts.push(Date.now());
        if (!online) throw new CandidateApiError(0, 'network_error', 'offline');
        return { results: (events as unknown as EventUpsert[]).map((e) => ({ id: e.id, result: 'created' })) };
      },
    });
    await box.putEvent(ev('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1));
    box.start(sender);
    // First attempt immediately, then 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s ...
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(30_000);
    const gaps = attempts.slice(1).map((t, i) => Math.round((t - attempts[i]) / 1000));
    expect(gaps.slice(0, 7)).toEqual([1, 2, 4, 8, 16, 30, 30]);

    const before = attempts.length;
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(5);
    expect(attempts.length).toBe(before + 1);
    expect(box.stats().size).toBe(0);
    box.close();
  });

  it('does not deliver while the gate is closed', async () => {
    const box = await Outbox.open({ namespace: nextNs(), memory: true });
    const { sender, calls } = makeSender();
    let open = false;
    await box.putAnswer({ questionId: 'q', value: 'x', clientSeq: 1, answeredAt: 1 });
    box.start(sender, () => open);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
    open = true;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toHaveLength(1);
    box.close();
  });
});
