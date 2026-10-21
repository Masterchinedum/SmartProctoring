/**
 * Behaviour at the face-analysis capacity limit (docs/PERFORMANCE.md §6–§7): what refused clients are told, the
 * health / readiness / capacity signals, admission at exam start and the load-aware sampling cadence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sample, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('a full face-analysis queue', () => {
  it('answers 503 vision_busy with the pool’s estimate as Retry-After; the same sample is taken once there is room', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    env.vision.busyNext(1, 7);
    const sampleId = crypto.randomUUID();
    const refused = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('7');
    expect(refused.json()).toMatchObject({ error: 'vision_busy', retryAfterSec: 7 });
    const retried = await sample(env, c, { person: 'alice' }, 'periodic', sampleId);
    expect(retried.statusCode).toBe(200);
  });
});
