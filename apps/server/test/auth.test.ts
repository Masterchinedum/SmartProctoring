import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireStaff } from '../src/auth/staff.js';
import { createTestEnv, TEST_PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
  // A protected probe route per role (registered before ready in real apps; inject works after ready via a child instance)
});
afterAll(async () => env?.close());

describe('staff auth', () => {
  it('rejects bad credentials and unknown users without leaking which', async () => {
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@test.example', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const unknown = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@test.example', password: 'nope' } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().message).toBe(bad.json().message);
  });

  it('logs in, returns {user, org}, sets an httpOnly signed cookie; /me works; logout revokes', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'Reviewer@Test.Example', password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.role).toBe('reviewer');
    expect(body.org).toEqual({ id: env.org.id, name: 'Test University' });
    const c = res.cookies.find((x) => x.name === 'sp_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    const cookie = `sp_session=${c.value}`;
    const me = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('reviewer@test.example');

    // tampered cookie
    const tampered = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookie.slice(0, -2) + 'xx' } });
    expect(tampered.statusCode).toBe(401);

    const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const after = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('expires idle sessions', async () => {
    const cookie = await env.login('admin');
    env.clock.advance(env.config.staffSessionIdleMs + 1000);
    const me = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('enforces role hierarchy via requireStaff', async () => {
    const { buildApp } = await import('../src/app.js');
    void buildApp;
    const pre = requireStaff('admin');
    const reviewerCookie = await env.login('reviewer');
    const ownerCookie = await env.login('owner');
    const mkReq = (cookie: string) => {
      const [name, value] = cookie.split('=');
      return {
        method: 'GET',
        headers: {},
        cookies: { [name]: value },
        unsignCookie: (v: string) => env.app.unsignCookie(v),
        server: env.app,
        ip: '127.0.0.1',
        staff: null,
        protocol: 'http',
      } as never;
    };
    await expect(pre.call(env.app as never, mkReq(reviewerCookie), {} as never)).rejects.toMatchObject({ statusCode: 403 });
    await expect(pre.call(env.app as never, mkReq(ownerCookie), {} as never)).resolves.toBeUndefined();
  });

  it('refuses cross-origin state-changing staff requests', async () => {
    const cookie = await env.login('owner');
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/password', headers: { cookie, origin: 'https://evil.example' }, payload: { currentPassword: 'x', newPassword: 'yyyyyyyyyyyy' } });
    expect(res.statusCode).toBe(403);
  });

  it('health endpoint', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: 'ok' });
    expect(res.headers['content-security-policy']).toContain("'wasm-unsafe-eval'");
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });
});
