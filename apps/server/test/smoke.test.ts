import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers.js';
import { hb, startedSession } from './flow.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

it('smoke: invite -> consent -> check -> start -> answer -> heartbeat -> submit', async () => {
  const c = env.candidateClient();
  const s0 = await c.req('GET', '/api/candidate/session');
  expect(s0.statusCode, s0.body).toBe(200);
  expect(s0.json().session.requiredCheck).toBe(null);
  await startedSession(env, c);
  const st = (await c.req('GET', '/api/candidate/session')).json();
  expect(st.questions).toHaveLength(5);
  expect(JSON.stringify(st.questions)).not.toContain('correct');
  const q = st.questions[0];
  const a = await c.req('PUT', `/api/candidate/answers/${q.id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t });
  expect(a.statusCode, a.body).toBe(200);
  const h = await hb(c);
  expect(h.statusCode, h.body).toBe(200);
  const sub = await c.req('POST', '/api/candidate/submit');
  expect(sub.statusCode, sub.body).toBe(200);
  expect(sub.json().session.status).toBe('submitted');
});
