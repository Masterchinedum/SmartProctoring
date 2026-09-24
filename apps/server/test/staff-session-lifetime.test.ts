/** Security review #12: shorter staff session defaults (60 min idle / 12 h absolute), still overridable. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('staff session lifetime', () => {
  it('defaults to 60 minutes idle and 12 hours absolute; env overrides still apply', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.staffSessionIdleMs).toBe(60 * 60_000);
    expect(c.staffSessionMaxMs).toBe(12 * 3_600_000);
    const o = loadConfig({ NODE_ENV: 'test', STAFF_SESSION_IDLE_MIN: '15', STAFF_SESSION_MAX_HOURS: '8' });
    expect(o.staffSessionIdleMs).toBe(15 * 60_000);
    expect(o.staffSessionMaxMs).toBe(8 * 3_600_000);
  });

  describe('enforcement', () => {
    let env: TestEnv;
    beforeAll(async () => {
      env = await createTestEnv();
    });
    afterAll(async () => {
      await env?.close();
    });
    const me = (cookie: string) => env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    it('signs out after an hour without activity', async () => {
      const cookie = await env.login('reviewer');
      env.clock.advance(59 * 60_000);
      expect((await me(cookie)).statusCode).toBe(200);
      env.clock.advance(61 * 60_000);
      expect((await me(cookie)).statusCode).toBe(401);
    });

    it('ends even an active session after 12 hours', async () => {
      const cookie = await env.login('reviewer');
      const start = env.clock.t;
      while (env.clock.t - start < 12 * 3_600_000 - 30 * 60_000) {
        env.clock.advance(30 * 60_000);
        expect((await me(cookie)).statusCode).toBe(200);
      }
      env.clock.set(start + 12 * 3_600_000 + 1000);
      expect((await me(cookie)).statusCode).toBe(401);
    });
  });
});
