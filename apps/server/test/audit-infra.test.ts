/**
 * Regression tests for the requirements-audit fixes on the delivery / staff side:
 *  P0-3 access tokens never logged, P1-1 episodes of a replaced browser instance, P2-6 evidence event
 *  scoping, P2-7 per-session storage caps, P2-8 access link exposure + WebSocket re-validation,
 *  P2-11 session notes in real time.
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { EventUpsert, LiveMessage, SessionDetailDTO, SessionSummaryDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { events, evidence, identityChecks, sessionPeriods, staffUsers } from '../src/db/schema.js';
import { appLoggerOptions, redactUrl } from '../src/lib/log-redact.js';
import { LIVE_REVALIDATION, WS_CLOSE_UNAUTHORIZED } from '../src/realtime/live-route.js';
import { loadEventDTO } from '../src/services/dto.js';
import { sessionEvidenceUsage } from '../src/services/session-limits.js';
import { consent, hb, runCheck, sample, startCheck, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';
import { clientEvent, json, MIN, staffApi, type Api } from './admin/fixtures.js';

let env: TestEnv;
let reviewer: Api;
let admin: Api;
beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

const eventRow = async (id: string) => (await env.ctx.db.select().from(events).where(eq(events.id, id)))[0];
const putShot = (c: CandidateClient, q: Record<string, string | number>, spec = { person: 'alice' }) => c.jpeg(`/api/candidate/evidence/${randomUUID()}`, spec, q, 'PUT');

describe('P0-3: candidate access tokens never reach the logs', () => {
  it('redacts /take/<token> paths and token query parameters', () => {
    expect(redactUrl('/take/AbC_123-xyz')).toBe('/take/[redacted]');
    expect(redactUrl('/take/AbC_123-xyz/?x=1#f')).toBe('/take/[redacted]/?x=1#f');
    expect(redactUrl('/api/public/privacy-notice?token=secret&x=1')).toBe('/api/public/privacy-notice?token=[redacted]&x=1');
    expect(redactUrl('/assets/app.js')).toBe('/assets/app.js');
  });

  it('logs requests without the bearer token (web app route, query parameter, Authorization header)', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await buildApp({
      config: env.config,
      database: env.ctx.database,
      vision: env.vision,
      storage: env.storage,
      now: env.clock.now,
      migrate: false,
      jobs: false,
      bootstrap: false,
      serveWeb: false,
      logger: { ...appLoggerOptions('info'), stream },
    });
    try {
      const token = env.session.token;
      await app.inject({ method: 'GET', url: `/take/${token}` });
      await app.inject({ method: 'GET', url: `/api/public/privacy-notice?token=${token}` });
      await app.inject({ method: 'GET', url: '/api/candidate/session', headers: { authorization: `Bearer ${token}`, 'x-client-instance': 'inst-log-test' } });
      const all = lines.join('');
      expect(all).toContain('/take/[redacted]');
      expect(all).toContain('token=[redacted]');
      expect(all).not.toContain(token);
    } finally {
      await app.close();
    }
  });
});

describe('P1-1: episodes of a replaced browser instance', () => {
  it('are closed at the gap start by the reconnect, and late updates from its outbox are clamped there', async () => {
    const s = await env.newSession();
    const a = env.candidateClient(s.token, `inst-A-${randomUUID().slice(0, 8)}`);
    await startedSession(env, a);
    env.clock.advance(MIN);
    const tabId = await clientEvent(a, { type: 'tab_hidden', startedAt: env.clock.t - 10_000, endedAt: null, confidence: 1 });
    const lookId = await clientEvent(a, { type: 'looking_away', startedAt: env.clock.t - 5_000, endedAt: null });
    // A server-owned open event (identical identity samples => camera_feed_suspect) must not be touched.
    for (let i = 0; i < 3; i++) {
      env.clock.advance(10_000);
      expect((await sample(env, a, { person: 'alice', dhash: 'feedfeedfeedfeed' })).statusCode).toBe(200);
    }
    env.clock.advance(5_000);
    json(await hb(a));
    const gapStart = env.clock.t;
    env.clock.advance(3 * MIN); // the first browser crashed
    const b = a.withInstance(`inst-B-${randomUUID().slice(0, 8)}`);
    const checkStart = env.clock.t;
    expect((await runCheck(env, b, 'reconnect')).complete!.outcome).toBe('passed');

    for (const id of [tabId, lookId]) {
      const e = await eventRow(id);
      expect(e).toMatchObject({ status: 'closed' });
      expect(e.endedAt!.getTime()).toBe(gapStart);
      expect(e.details).toMatchObject({ closedBy: 'instance_replaced', replacedByInstanceId: b.instanceId });
    }
    const suspect = (await env.ctx.db.select().from(events).where(and(eq(events.sessionId, s.id), eq(events.type, 'camera_feed_suspect'))))[0];
    expect(suspect.status).toBe('open');
    const disc = (await env.ctx.db.select().from(sessionPeriods).where(and(eq(sessionPeriods.sessionId, s.id), eq(sessionPeriods.kind, 'disconnected'))))[0];
    expect(disc.startedAt.getTime()).toBe(gapStart);
    expect(disc.endedAt!.getTime()).toBe(checkStart);

    // The new page flushes the old page's outbox: a close far after the gap and a never-delivered open episode.
    env.clock.advance(30_000);
    const tab = await eventRow(tabId);
    const fromA = randomUUID();
    const ownB = randomUUID();
    const batch: EventUpsert[] = [
      { id: tabId, type: 'tab_hidden', phase: 'close', startedAt: tab.startedAt.getTime(), endedAt: env.clock.t, confidence: 1, details: {}, version: 2, clientInstanceId: a.instanceId },
      { id: fromA, type: 'multiple_people', phase: 'open', startedAt: gapStart - 2_000, endedAt: null, confidence: 0.9, details: {}, version: 1, clientInstanceId: a.instanceId },
      { id: ownB, type: 'looking_away', phase: 'open', startedAt: env.clock.t - 1_000, endedAt: null, confidence: 0.8, details: {}, version: 1, clientInstanceId: b.instanceId },
    ];
    const res = json(await b.req('POST', '/api/candidate/events/batch', { events: batch }));
    expect(res.results.map((r: { result: string }) => r.result)).toEqual(['updated', 'created', 'created']);
    const tab2 = await eventRow(tabId);
    expect(tab2.endedAt!.getTime()).toBe(gapStart);
    expect(tab2.details).toMatchObject({ endClampedBy: 'instance_replaced' });
    const late = await eventRow(fromA);
    expect(late.status).toBe('closed');
    expect(late.endedAt!.getTime()).toBe(gapStart);
    expect((await eventRow(ownB)).status).toBe('open');
  });
});

describe('P2-6: screenshots link only to events of the uploading session', () => {
  it('another session cannot attach evidence to, or use up the quota of, someone else’s event', async () => {
    const sa = await env.newSession();
    const ca = await startedSession(env, env.candidateClient(sa.token));
    const sb = await env.newSession();
    const cb = await startedSession(env, env.candidateClient(sb.token));
    env.clock.advance(10_000);
    const evB = await clientEvent(cb, { type: 'phone_detected', startedAt: env.clock.t - 2_000, endedAt: env.clock.t });
    for (let i = 0; i < 6; i++) expect(json(await putShot(ca, { eventId: evB, capturedAt: env.clock.t, reason: 'onset' })).stored).toBe(true);
    const aRows = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, sa.id), eq(evidence.kind, 'event_screenshot')));
    expect(aRows).toHaveLength(6);
    expect(aRows.every((r) => r.eventId == null)).toBe(true);
    // B's own quota is intact and its event shows only its own screenshot.
    expect(json(await putShot(cb, { eventId: evB, capturedAt: env.clock.t, reason: 'onset' })).stored).toBe(true);
    const dto = (await loadEventDTO(env.ctx.db, evB))!;
    expect(dto.evidence).toHaveLength(1);
  });
});

describe('P2-8: the access link is not broadcast', () => {
  it('is only in the admin session detail and the admin exam-assignment list', async () => {
    const s = await env.newSession();
    const got: LiveMessage[] = [];
    const off = env.ctx.bus.subscribe(env.org.id, (m) => got.push(m));
    const c = env.candidateClient(s.token);
    await consent(c);
    env.ctx.live.sessionChanged(s.id);
    await new Promise((r) => setTimeout(r, 1200));
    off();
    const live = got.filter((m): m is Extract<LiveMessage, { type: 'session' }> => m.type === 'session' && m.session.id === s.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((m) => m.session.accessLink === null)).toBe(true);

    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`)).summary.accessLink).toBe(s.link);
    expect(json<SessionDetailDTO>(await reviewer.get(`/sessions/${s.id}`)).summary.accessLink).toBeNull();
    const list = json<{ items: SessionSummaryDTO[] }>(await admin.get('/sessions', { limit: 200 }));
    expect(list.items.find((x) => x.id === s.id)!.accessLink).toBeNull();
    const dash = json<{ sessions: SessionSummaryDTO[] }>(await admin.get('/dashboard'));
    expect(dash.sessions.every((x) => x.accessLink === null)).toBe(true);
    expect(json<{ items: SessionSummaryDTO[] }>(await admin.get(`/exams/${env.exam.id}/sessions`)).items.find((x) => x.id === s.id)!.accessLink).toBe(s.link);
    expect(json<{ items: SessionSummaryDTO[] }>(await reviewer.get(`/exams/${env.exam.id}/sessions`)).items.find((x) => x.id === s.id)!.accessLink).toBeNull();
    // Action results are summaries for any staff role: no link.
    expect(json<SessionSummaryDTO>(await reviewer.post(`/sessions/${s.id}/hold`, { note: 'x' })).accessLink).toBeNull();
  });
});

describe('P2-8: the staff WebSocket re-validates the staff session', () => {
  const saved = { ...LIVE_REVALIDATION };
  afterEach(() => Object.assign(LIVE_REVALIDATION, saved));

  async function openSocket(port: number, cookie: string) {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/live`, { headers: { cookie } });
    const msgs: LiveMessage[] = [];
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        msgs.push(JSON.parse(String(d)));
        resolve();
      });
      ws.on('error', reject);
    });
    return { ws, msgs, closed };
  }

  it('closes the socket with 4401 after logout (checked before the next broadcast) and after the user is disabled (periodic check)', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as { port: number }).port;
    LIVE_REVALIDATION.onBroadcastAfterMs = 0;

    const cookieA = await env.login('reviewer');
    const cookieB = await env.login('admin');
    const A = await openSocket(port, cookieA);
    const B = await openSocket(port, cookieB);
    expect(A.msgs[0].type).toBe('hello');
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: cookieA } })).statusCode).toBe(200);
    env.ctx.bus.publish(env.org.id, { type: 'hello', serverTime: 42 });
    expect(await A.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    // The other (still valid) socket received the broadcast and stays open.
    await new Promise((r) => setTimeout(r, 200));
    expect(B.msgs.some((m) => m.type === 'hello' && m.serverTime === 42)).toBe(true);
    expect(B.ws.readyState).toBe(B.ws.OPEN);
    B.ws.close();

    // Periodic re-validation: no broadcast needed.
    LIVE_REVALIDATION.onBroadcastAfterMs = 60_000;
    LIVE_REVALIDATION.periodicMs = 100;
    const [temp] = await env.ctx.db
      .insert(staffUsers)
      .values({ orgId: env.org.id, email: `ws-${randomUUID().slice(0, 8)}@test.example`, name: 'WS Reviewer', role: 'reviewer', passwordHash: env.users.reviewer.passwordHash, createdAt: new Date(env.clock.t), updatedAt: new Date(env.clock.t) })
      .returning();
    const tempApi = await staffApi(env, temp);
    const C = await openSocket(port, tempApi.cookie);
    await env.ctx.db.update(staffUsers).set({ disabled: true }).where(eq(staffUsers.id, temp.id));
    expect(await C.closed).toBe(WS_CLOSE_UNAUTHORIZED);
  });
});

describe('P2-11: session notes are pushed in real time', () => {
  it('publishes a note message (and a session refresh) to the organisation', async () => {
    const got: LiveMessage[] = [];
    const off = env.ctx.bus.subscribe(env.org.id, (m) => got.push(m));
    const note = json(await reviewer.post(`/sessions/${env.session.id}/notes`, { text: 'Spoke to the invigilator.' }));
    await new Promise((r) => setTimeout(r, 1200));
    off();
    const msg = got.find((m) => m.type === 'note') as Extract<LiveMessage, { type: 'note' }> | undefined;
    expect(msg).toMatchObject({ sessionId: env.session.id, note: { id: note.id, text: 'Spoke to the invigilator.', authorName: 'Test reviewer' } });
    expect(got.some((m) => m.type === 'session' && m.session.id === env.session.id)).toBe(true);
  });
});

describe('P2-7: per-session storage caps', () => {
  let capEnv: TestEnv;
  beforeAll(async () => {
    capEnv = await createTestEnv({ env: { SESSION_MAX_EVIDENCE_ITEMS: '20', SESSION_MAX_CHECKS_PER_HOUR: '3' } });
  });
  afterAll(async () => capEnv?.close());

  it('refuses screenshots beyond their share of the budget (413 storage_limit), keeps deciding identity samples within theirs, leaves check frames headroom, then refuses them at the cap', async () => {
    expect(capEnv.config.sessionLimits).toMatchObject({ maxEvidenceItems: 20, maxEvidenceBytes: 300 * 1024 * 1024, maxChecksPerHour: 3 });
    const s = capEnv.session;
    const c = await startedSession(capEnv, capEnv.candidateClient(s.token));
    capEnv.clock.advance(10_000);
    let refused: { statusCode: number; json(): { error: string; message: string } } | null = null;
    for (let i = 0; i < 25 && !refused; i++) {
      const r = await putShot(c, { capturedAt: capEnv.clock.t, reason: 'onset' });
      if (r.statusCode !== 200) refused = r;
    }
    expect(refused!.statusCode).toBe(413);
    expect(refused!.json()).toMatchObject({ error: 'storage_limit' });
    expect(refused!.json().message).toMatch(/storage limit for this exam session/);
    expect((await sessionEvidenceUsage(capEnv.ctx.db, s.id)).items).toBeLessThanOrEqual(16); // 80 % of 20

    // Identity samples keep being compared and decided; their images are dropped once the budget is full.
    let skipped = false;
    for (let i = 0; i < 6 && !skipped; i++) {
      capEnv.clock.advance(15_000);
      const r = await sample(capEnv, c, { person: 'alice', usable: false, issues: ['blurry'] });
      expect(r.statusCode, r.body).toBe(200);
      const [row] = await capEnv.ctx.db.select().from(identityChecks).where(eq(identityChecks.id, r.json().result.id));
      expect(row.decision).toBe('unable_to_verify');
      skipped = (row.context as Record<string, unknown>).evidenceSkipped === 'storage_limit';
    }
    expect(skipped).toBe(true);
    expect((await sessionEvidenceUsage(capEnv.ctx.db, s.id)).items).toBeLessThanOrEqual(18); // 90 % of 20

    // Check frames: the rest of the budget is theirs; at the hard cap a clear error.
    await c.req('POST', '/api/candidate/pause', {});
    const st = await startCheck(c, 'resume');
    expect(st.statusCode).toBe(200);
    const codes: { statusCode: number; error?: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const fr = await c.jpeg(`/api/candidate/checks/${st.json().checkId}/frames`, { person: 'alice' }, { step: 'frontal', capturedAt: capEnv.clock.t, nonce: st.json().liveness?.nonce ?? '' });
      codes.push({ statusCode: fr.statusCode, error: fr.statusCode === 200 ? undefined : fr.json().error });
    }
    expect(codes[0].statusCode).toBe(200);
    expect(codes.at(-1)).toEqual({ statusCode: 413, error: 'storage_limit' });
    expect((await sessionEvidenceUsage(capEnv.ctx.db, s.id)).items).toBeLessThanOrEqual(20);
  });

  it('caps the bytes stored per session', async () => {
    const s = await capEnv.newSession();
    const c = await startedSession(capEnv, capEnv.candidateClient(s.token));
    const lim = capEnv.ctx.config.sessionLimits;
    const saved = lim.maxEvidenceBytes;
    try {
      lim.maxEvidenceBytes = (await sessionEvidenceUsage(capEnv.ctx.db, s.id)).bytes + 10;
      const r = await putShot(c, { capturedAt: capEnv.clock.t });
      expect(r.statusCode).toBe(413);
      expect(r.json().error).toBe('storage_limit');
    } finally {
      lim.maxEvidenceBytes = saved;
    }
  });

  it('limits the checks started per session per hour (429 too_many_checks)', async () => {
    const s = await capEnv.newSession();
    const c = capEnv.candidateClient(s.token);
    await consent(c);
    for (let i = 0; i < 3; i++) expect((await startCheck(c, 'initial')).statusCode).toBe(200);
    const r = await startCheck(c, 'initial');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: 'too_many_checks' });
    capEnv.clock.advance(61 * MIN);
    expect((await startCheck(c, 'initial')).statusCode).toBe(200);
  });
});
