import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentityCheckTrigger, IdentitySampleResponse } from '@sp/shared';
import { BURST_TIMEOUT_MS, BurstSampler, burstEligible, RequestBudget, SERVER_REQUEST_FORCE_MS, type BurstFrame, type SamplerDeps } from './sampler';

type Q = { trigger: IdentityCheckTrigger; capturedAt?: number; burstId?: string; burstIndex?: number; burstSize?: number };

function response(over: Partial<IdentitySampleResponse> = {}): IdentitySampleResponse {
  return {
    result: { id: 'r', trigger: 'periodic', usable: true, guidance: [], at: 1 },
    followUpInMs: null,
    status: 'active',
    hold: null,
    ...over,
  };
}

function setup(over: Partial<SamplerDeps> = {}, budget?: RequestBudget) {
  let mono = 0;
  let n = 0;
  const sent: { frame: BurstFrame; q: Q }[] = [];
  const failed: { frame: BurstFrame; q: Q }[] = [];
  const responses: { res: IdentitySampleResponse; final: boolean }[] = [];
  const done: unknown[] = [];
  const deps: SamplerDeps = {
    burstSize: 3,
    uuid: () => `id-${++n}`,
    now: () => 1_700_000_000_000 + mono,
    mono: () => mono,
    send: vi.fn(async (frame: BurstFrame, q: Q) => {
      sent.push({ frame, q });
      return response();
    }),
    onSendFailed: vi.fn(async (frame: BurstFrame, q: Q) => {
      failed.push({ frame, q });
      return 'queued' as const;
    }),
    onResponse: (res, final) => responses.push({ res, final }),
    onBurstDone: (r) => done.push(r),
    ...over,
  };
  const s = new BurstSampler(deps, budget);
  const blob = () => Promise.resolve(new Blob([new Uint8Array([0xff, 0xd8, n])], { type: 'image/jpeg' }));
  /** One analysed frame at +ms: offer it and add it when wanted. */
  const frame = async (advanceMs: number, eligible = true, capturable = eligible) => {
    mono += advanceMs;
    s.tick();
    if (s.wantsFrame(eligible, capturable)) await s.addFrame(blob(), deps.now());
  };
  return { s, deps, sent, failed, responses, done, frame, advance: (ms: number) => (mono += ms) };
}

afterEach(() => vi.useRealTimers());

describe('BurstSampler', () => {
  it('captures burstSize distinct analysed frames ≥ 150 ms apart and sends them in order with one burstId', async () => {
    const t = setup();
    t.s.request('track_break');
    await t.frame(0);
    await t.frame(100); // too soon after the first burst frame
    await t.frame(100);
    await t.frame(200);
    expect(t.sent.map((x) => x.q)).toEqual([
      { trigger: 'track_break', capturedAt: expect.any(Number), burstId: 'id-1', burstIndex: 0, burstSize: 3 },
      { trigger: 'track_break', capturedAt: expect.any(Number), burstId: 'id-1', burstIndex: 1, burstSize: 3 },
      { trigger: 'track_break', capturedAt: expect.any(Number), burstId: 'id-1', burstIndex: 2, burstSize: 3 },
    ]);
    const at = t.sent.map((x) => x.q.capturedAt!);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(150);
    expect(new Set(t.sent.map((x) => x.frame.sampleId)).size).toBe(3);
    expect(t.responses.map((r) => r.final)).toEqual([false, false, true]);
    expect(t.done).toHaveLength(1);
    expect(t.s.busy).toBe(false);
  });

  it('only uses frames with exactly one usable face; after the timeout it sends what it has', async () => {
    const t = setup();
    t.s.request('periodic');
    await t.frame(0, false); // no burst starts without a usable frame
    expect(t.s.busy).toBe(false);
    await t.frame(200, true);
    await t.frame(200, false);
    await t.frame(200, false);
    await t.frame(BURST_TIMEOUT_MS, false);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].q).toMatchObject({ burstIndex: 0, burstSize: 1 });
  });

  it('a SERVER request is honoured without a qualifying frame once it waited SERVER_REQUEST_FORCE_MS', async () => {
    const t = setup();
    t.s.serverRequest({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    await t.frame(0, false, true); // no usable face (hidden / several faces): keeps waiting for a while
    await t.frame(SERVER_REQUEST_FORCE_MS / 2, false, true);
    expect(t.s.busy).toBe(false);
    await t.frame(SERVER_REQUEST_FORCE_MS, false, true); // waited long enough: taken from whatever the camera shows
    await t.frame(200, false, true);
    await t.frame(200, false, true);
    expect(t.sent.map((x) => x.q.trigger)).toEqual(['server_request', 'server_request', 'server_request']);
  });

  it('an engine / routine request still waits for a qualifying frame; nothing is taken from a camera that cannot be captured', async () => {
    const t = setup();
    t.s.request('periodic');
    await t.frame(0, false, true);
    await t.frame(SERVER_REQUEST_FORCE_MS * 2, false, true);
    expect(t.s.busy).toBe(false);
    const t2 = setup();
    t2.s.serverRequest({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    await t2.frame(SERVER_REQUEST_FORCE_MS * 2, false, false);
    expect(t2.s.busy).toBe(false);
    expect(t2.s.pendingTrigger()).toBe('server_request');
  });

  it('when no frame could be captured the trigger waits for the next opportunity', async () => {
    const t2 = setup();
    t2.s.request('face_return');
    t2.s.wantsFrame(true); // burst started…
    await t2.s.addFrame(Promise.resolve(null), 0); // … but the capture failed
    t2.advance(BURST_TIMEOUT_MS + 1);
    t2.s.tick();
    expect(t2.sent).toHaveLength(0);
    expect(t2.s.pendingTrigger()).toBe('face_return');
  });

  it('keeps the most important waiting trigger (a quick-swap trigger beats a routine one)', async () => {
    const t = setup();
    t.s.request('periodic');
    t.s.request('track_break');
    t.s.request('face_return');
    expect(t.s.pendingTrigger()).toBe('track_break');
  });

  it('takes one exam_start burst per run: the server asking again (heartbeats) is deduplicated', async () => {
    const t = setup();
    t.s.request('exam_start', 'host');
    t.s.serverRequest({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    for (let i = 0; i < 4; i++) await t.frame(200);
    t.s.serverRequest({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    for (let i = 0; i < 4; i++) await t.frame(200);
    expect(t.sent.filter((x) => x.q.trigger === 'exam_start')).toHaveLength(3);
    expect(new Set(t.sent.map((x) => x.q.burstId)).size).toBe(1);
  });

  it('schedules a server request after inMs and does not stack it on a burst in progress', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.s.serverRequest({ trigger: 'server_request', inMs: 1500, burstSize: 3 });
    expect(t.s.pendingTrigger()).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(t.s.pendingTrigger()).toBe('server_request');
    await t.frame(0);
    expect(t.s.busy).toBe(true);
    t.s.serverRequest({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    await t.frame(200);
    await t.frame(200);
    expect(t.sent.filter((x) => x.q.trigger === 'server_request')).toHaveLength(3);
    expect(t.s.pendingTrigger()).toBeNull();
  });

  it('respects the request budget (server rate limit): a burst waits until all its frames fit', async () => {
    const t = setup({}, new RequestBudget(4, 10_000));
    t.s.request('periodic');
    for (let i = 0; i < 4; i++) await t.frame(200);
    expect(t.sent).toHaveLength(3);
    t.s.request('track_break');
    await t.frame(200);
    expect(t.s.busy).toBe(false); // only 1 request left in this minute
    expect(t.s.pendingTrigger()).toBe('track_break');
    t.advance(10_000);
    for (let i = 0; i < 4; i++) await t.frame(200);
    expect(t.sent).toHaveLength(6);
    expect(t.sent[5].q.trigger).toBe('track_break');
  });

  it('offline: the failed frame and the rest of its burst are queued with the burst metadata', async () => {
    const t = setup({
      send: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    t.s.request('appearance_change');
    for (let i = 0; i < 4; i++) await t.frame(200);
    expect(t.failed.map((f) => f.q)).toEqual([
      expect.objectContaining({ trigger: 'appearance_change', burstId: 'id-1', burstIndex: 0, burstSize: 3 }),
      expect.objectContaining({ trigger: 'appearance_change', burstId: 'id-1', burstIndex: 1, burstSize: 3 }),
      expect.objectContaining({ trigger: 'appearance_change', burstId: 'id-1', burstIndex: 2, burstSize: 3 }),
    ]);
  });

  it('a hold reported by any frame wins: no burst decision is taken from the other frames', async () => {
    const t = setup({
      send: vi.fn(async (frame: BurstFrame, q: Q) => {
        void frame;
        return response(q.burstIndex === 0 ? { status: 'on_hold' } : {});
      }),
    });
    t.s.request('periodic');
    for (let i = 0; i < 4; i++) await t.frame(200);
    expect(t.responses[0].res.status).toBe('on_hold');
    expect(t.responses).toHaveLength(1);
    expect(t.done).toHaveLength(0);
  });

  it('sends the frames concurrently; the answer that completes the burst is the decision, whatever its index', async () => {
    const resolvers: ((r: IdentitySampleResponse) => void)[] = [];
    const t = setup({ send: vi.fn(() => new Promise<IdentitySampleResponse>((r) => resolvers.push(r))) });
    t.s.request('appearance_change');
    await t.frame(200);
    await t.frame(200);
    const sending = t.frame(200); // completes the burst: resolves once the server answered
    await vi.waitFor(() => expect(t.deps.send).toHaveBeenCalledTimes(3)); // all in flight at once
    const burst = (received: number, complete: boolean) => ({ id: 'id-1', received, size: 3, complete });
    resolvers[2](response({ burst: burst(1, false) }));
    resolvers[0](response({ burst: burst(2, false) }));
    resolvers[1](response({ burst: burst(3, true), nextSampleInMs: 2500 }));
    await sending;
    expect(t.done).toHaveLength(1);
    expect(t.responses.map((r) => r.final)).toEqual([false, false, true]);
    expect(t.s.last?.response?.nextSampleInMs).toBe(2500);
  });

  it('dropPending forgets a waiting routine sample (the server rescheduled it)', () => {
    const t = setup();
    t.s.request('periodic');
    t.s.dropPending('track_break');
    expect(t.s.pendingTrigger()).toBe('periodic');
    t.s.dropPending('periodic');
    expect(t.s.pendingTrigger()).toBeNull();
  });

  it('a burst size of 1 sends plain samples (no burst parameters)', async () => {
    const t = setup({ burstSize: 1 });
    t.s.request('periodic');
    await t.frame(0);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].q).toEqual({ trigger: 'periodic', capturedAt: expect.any(Number) });
  });

  it('stop() drops pending work and scheduled requests', () => {
    vi.useFakeTimers();
    const t = setup();
    t.s.serverRequest({ trigger: 'server_request', inMs: 1000, burstSize: 3 });
    t.s.request('periodic');
    t.s.stop();
    vi.advanceTimersByTime(2000);
    expect(t.s.pendingTrigger()).toBeNull();
    expect(t.s.wantsFrame(true)).toBe(false);
  });
});

describe('burstEligible', () => {
  const f = (over = {}) => ({ box: { x: 0.3, y: 0.2, w: 0.3, h: 0.4 }, score: 0.9, yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0, visibility: 0.9, cutOff: false, ...over });
  it('needs exactly one plausible face, not cut off, not badly obstructed — dim is fine', () => {
    expect(burstEligible([f()])).not.toBeNull();
    expect(burstEligible([f({ brightness: 30, visibility: 0.35 })])).not.toBeNull();
    expect(burstEligible([])).toBeNull();
    expect(burstEligible([f(), f({ box: { x: 0.7, y: 0.2, w: 0.2, h: 0.3 } })])).toBeNull();
    expect(burstEligible([f({ cutOff: true })])).toBeNull();
    expect(burstEligible([f({ visibility: 0.2 })])).toBeNull();
  });
});
