import { describe, expect, it } from 'vitest';
import { CandidateApiError } from '../api';
import { FRAME_MAX_BUSY_WAIT_MS, frameSendRetry, GUIDANCE_CONNECTION_FAILED, GUIDANCE_CONNECTION_RETRY, GUIDANCE_SERVER_BUSY, GUIDANCE_SERVER_STILL_BUSY, type FrameSendState } from './sendRetry';

const busy = (retryAfterSec: number | null) => new CandidateApiError(503, 'vision_busy', 'The server is busy analysing images.', undefined, retryAfterSec == null ? null : retryAfterSec * 1000);
const offline = () => new CandidateApiError(0, 'network_error', 'Could not reach the server.');
const fresh = (): FrameSendState => ({ networkFailures: 0, busyWaitedMs: 0 });

describe('frameSendRetry', () => {
  it('tells a busy server apart from a connection problem and waits as long as the server asks, spread', () => {
    const s = fresh();
    expect(frameSendRetry(busy(6), s, () => 0)).toEqual({ retry: true, delayMs: 6000, guidance: GUIDANCE_SERVER_BUSY });
    expect(frameSendRetry(busy(6), s, () => 1)).toEqual({ retry: true, delayMs: 9000, guidance: GUIDANCE_SERVER_BUSY });
    expect(frameSendRetry(busy(null), s, () => 0)).toMatchObject({ retry: true, delayMs: 1000 }); // no Retry-After: 1 s
    expect(s.networkFailures).toBe(0);
    expect(GUIDANCE_SERVER_BUSY).not.toMatch(/internet|connection/i);
  });

  it('a rate-limited answer (429) is also "busy", not a connection problem', () => {
    const r = frameSendRetry(new CandidateApiError(429, 'rate_limited', 'slow down'), fresh(), () => 0);
    expect(r).toMatchObject({ retry: true, guidance: GUIDANCE_SERVER_BUSY });
  });

  it('gives a frame up after a bounded wait for a busy server, with neutral wording (the check sends another frame)', () => {
    const s = fresh();
    let r = frameSendRetry(busy(30), s, () => 0.9);
    while (r.retry) r = frameSendRetry(busy(30), s, () => 0.9);
    expect(r).toEqual({ retry: false, guidance: GUIDANCE_SERVER_STILL_BUSY });
    expect(s.busyWaitedMs).toBeGreaterThanOrEqual(FRAME_MAX_BUSY_WAIT_MS);
  });

  it('keeps the connection-problem path: 3 retries 1, 2, 3 s apart, then "check your internet connection"', () => {
    const s = fresh();
    expect([1, 2, 3].map(() => frameSendRetry(offline(), s))).toEqual([1000, 2000, 3000].map((delayMs) => ({ retry: true, delayMs, guidance: GUIDANCE_CONNECTION_RETRY })));
    expect(frameSendRetry(offline(), s)).toEqual({ retry: false, guidance: GUIDANCE_CONNECTION_FAILED });
  });

  it('busy answers do not use up the connection retries', () => {
    const s = fresh();
    for (let i = 0; i < 5; i++) frameSendRetry(busy(1), s, () => 0);
    expect(frameSendRetry(offline(), s)).toMatchObject({ retry: true, guidance: GUIDANCE_CONNECTION_RETRY });
  });
});
