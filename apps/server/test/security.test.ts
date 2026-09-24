/**
 * Security regression tests (docs/SECURITY.md): instance-id disclosure, candidate rate-limit keys, JPEG
 * decompression bombs, TRUST_PROXY parsing, CSRF defence without an Origin header, and face-similarity
 * scores in the integration API.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { auditLog } from '../src/db/schema.js';
import { jpegDimensions } from '../src/lib/crypto.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { staffApi } from './admin/fixtures.js';
import { consent, sample, startedSession } from './flow.js';
import { createTestEnv, TEST_PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('X-Client-Instance of the verified browser', () => {
  it('is never disclosed to another holder of the link, who therefore cannot act as that browser', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    const own = await c.req('GET', '/api/candidate/session');
    expect(own.json().session.verifiedInstanceId).toBe(c.instanceId);

    const other = env.candidateClient(s.token, 'inst-someone-else-01');
    const seen = await other.req('GET', '/api/candidate/session');
    expect(seen.statusCode).toBe(200);
    expect(seen.json().session.verifiedInstanceId).toBeNull();
    expect(seen.json().questions).toBeNull();
    expect(JSON.stringify(seen.json())).not.toContain(c.instanceId);
    const noHeader = await env.app.inject({ method: 'GET', url: '/api/candidate/session', headers: { authorization: `Bearer ${s.token}` } });
    expect(noHeader.json().session.verifiedInstanceId).toBeNull();

    const answer = await other.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t });
    expect(answer.statusCode).toBe(409);
  });
});

describe('candidate rate limits', () => {
  it('are keyed by the token, not by the spelling of the Authorization header', async () => {
    const s = await env.newSession();
    const post = (authorization: string) =>
      env.app.inject({ method: 'POST', url: '/api/candidate/pause/cancel', headers: { authorization, 'x-client-instance': 'inst-ratelimit-01' } });
    for (let i = 0; i < 30; i++) expect((await post(`Bearer ${s.token}`)).statusCode).not.toBe(429);
    expect((await post(`Bearer ${s.token}`)).statusCode).toBe(429);
    for (const variant of [`Bearer  ${s.token}`, `bearer ${s.token}`, `BEARER\t${s.token} `]) {
      expect((await post(variant)).statusCode, variant).toBe(429);
    }
  });
});

describe('JPEG decompression bombs', () => {
  it('jpegDimensions reads the frame header without decoding', async () => {
    const small = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toBuffer();
    expect(jpegDimensions(small)).toEqual({ width: 320, height: 200 });
    const progressive = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg({ quality: 5, progressive: true }).toBuffer();
    expect(jpegDimensions(progressive)).toEqual({ width: 5000, height: 4000 });
    // Garbage and fill bytes between segments are skipped like libjpeg does.
    const padded = Buffer.concat([small.subarray(0, 2), Buffer.from([0x00, 0x13, 0x37, 0xff, 0xff]), small.subarray(3)]);
    expect(jpegDimensions(padded)).toEqual({ width: 320, height: 200 });
    expect(jpegDimensions(FakeVisionService.encode({ person: 'alice' }))).toBeNull();
    expect(jpegDimensions(Buffer.from('not a jpeg'))).toBeNull();
  });

  it('candidate uploads declaring more than 4K are refused before they reach the decoder', async () => {
    const s = await env.newSession();
    const c = env.candidateClient(s.token);
    await consent(c);
    const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: { r: 120, g: 110, b: 100 } } }).jpeg({ quality: 5, progressive: true }).toBuffer();
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const r = await c.jpeg(`/api/candidate/evidence/${randomUUID()}`, bomb, {}, 'PUT');
    expect(r.statusCode, r.body).toBe(413);
    expect(r.json().error).toBe('image_too_large');
    const sampleRes = await c.jpeg('/api/candidate/identity/sample', bomb, { sampleId: randomUUID(), trigger: 'periodic', capturedAt: env.clock.t });
    expect(sampleRes.statusCode).toBe(413);
    // Normal frames are unaffected.
    const ok = await c.jpeg(`/api/candidate/evidence/${randomUUID()}`, await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer(), {}, 'PUT');
    expect(ok.statusCode).not.toBe(413);
  });
});

describe('TRUST_PROXY', () => {
  const base = { NODE_ENV: 'production', EVIDENCE_KEY: Buffer.alloc(32, 1).toString('base64'), SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://proctor.example' };
  it('accepts proxy addresses, refuses hop counts, and warns about trusting every hop in production', () => {
    expect(loadConfig({ ...base }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8,127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
    expect(() => loadConfig({ ...base, TRUST_PROXY: '2' })).toThrow(/hop counts are not supported/);
    for (const v of ['true', '1']) {
      const all = loadConfig({ ...base, TRUST_PROXY: v });
      expect(all.trustProxy).toBe(true);
      expect(all.warnings.join(' ')).toMatch(/TRUST_PROXY=true/);
    }
    expect(loadConfig({ ...base, TRUST_PROXY: 'loopback' }).warnings.join(' ')).not.toMatch(/TRUST_PROXY/);
  });

  it('trusting the proxy address, a client-supplied X-Forwarded-For entry cannot choose the recorded address', async () => {
    const e = await createTestEnv({ env: { TRUST_PROXY: 'loopback' } });
    try {
      const res = await e.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.20' },
        payload: { email: 'owner@test.example', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
      const [row] = await e.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'auth.login_failed'), eq(auditLog.targetId, e.users.owner.id)));
      expect(row.ip).toBe('198.51.100.20');
    } finally {
      await e.close();
    }
  });
});

describe('CSRF without an Origin header', () => {
  it('refuses cross-site requests identified by Fetch Metadata or Referer, and still admits same-origin and non-browser clients', async () => {
    const admin = await staffApi(env, 'admin');
    const s = await env.newSession();
    const url = `/api/admin/sessions/${s.id}/notes`;
    const post = (headers: Record<string, string>) => admin.inject({ method: 'POST', url, headers, payload: { text: 'note' } });
    for (const site of ['cross-site', 'same-site']) {
      const r = await post({ 'sec-fetch-site': site });
      expect(r.statusCode, site).toBe(403);
      expect(r.json().error).toBe('bad_origin');
    }
    expect((await post({ referer: 'https://evil.example/page' })).statusCode).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({ origin: 'http://exam.test', 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({ referer: 'http://exam.test/admin/sessions' })).statusCode).toBe(200);
    expect((await post({})).statusCode).toBe(200);
  });

  it('logout refuses cross-site requests', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reviewer@test.example', password: TEST_PASSWORD } });
    const cookie = `sp_session=${res.cookies.find((c) => c.name === 'sp_session')!.value}`;
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, ...headers } });
      expect(out.statusCode).toBe(403);
    }
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: 'http://exam.test' } })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('integration API', () => {
  it('never returns face-similarity scores (events, report), while the staff report keeps them', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    for (let i = 0; i < 2; i++) {
      env.clock.advance(20_000);
      expect((await sample(env, c, { person: 'bob' })).statusCode).toBe(200);
    }
    const admin = await staffApi(env, 'admin');
    const staffReport = await admin.get(`/sessions/${s.id}/report`);
    expect(staffReport.body).toMatch(/similarity/i);

    const key = (await admin.post('/api-keys', { name: 'security-test' })).json().secret as string;
    const v1 = (url: string) => env.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${key}` } });
    const events = await v1(`/sessions/${s.id}/events`);
    expect(events.statusCode).toBe(200);
    const mismatch = events.json().items.find((e: { type: string }) => e.type === 'identity_mismatch');
    expect(mismatch).toBeTruthy();
    const report = await v1(`/sessions/${s.id}/report`);
    expect(report.statusCode).toBe(200);
    for (const body of [events.body, report.body]) {
      expect(body).not.toMatch(/"[A-Za-z]*[Ss]imilarity":\s*-?\d/);
      expect(body).not.toMatch(/similarity -?\d/i);
    }
    expect(report.json().notableEvents.some((e: { type: string }) => e.type === 'identity_mismatch')).toBe(true);
  });
});
