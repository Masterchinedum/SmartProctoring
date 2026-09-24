/**
 * Email alerts (fake SMTP transport): settings, per-session throttling / digest, toggles, retries, test email,
 * and the "SMTP not configured" behaviour.
 */
import type { IntegrationStatusDTO, OrgSettingsDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, emailAlerts } from '../../src/db/schema.js';
import { MemoryMailer } from '../../src/lib/mailer.js';
import { EMAIL_THROTTLE_MS, sendDueEmailAlerts } from '../../src/services/email-alerts.js';
import { clientEvent, json, MIN, staffApi, type Api } from '../admin/fixtures.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

let env: TestEnv;
let admin: Api;
const mailer = new MemoryMailer('SmartProctoring <alerts@test.example>');

beforeAll(async () => {
  env = await createTestEnv({ mailer });
});
afterAll(async () => env?.close());
beforeEach(async () => {
  admin = await staffApi(env, 'admin');
});

const itemsOf = (sessionId: string) => env.ctx.db.select().from(emailAlerts).where(eq(emailAlerts.sessionId, sessionId)).orderBy(emailAlerts.occurredAt);

describe('email alert settings', () => {
  it('reports SMTP availability and stores normalised recipients and toggles', async () => {
    expect(json<IntegrationStatusDTO>(await admin.get('/integrations/status'))).toMatchObject({ email: { available: true, from: 'SmartProctoring <alerts@test.example>' }, apiBaseUrl: 'http://exam.test/api/v1' });
    const initial = json<OrgSettingsDTO>(await admin.get('/settings'));
    expect(initial).toMatchObject({ alertRecipients: [], emailAlerts: { holds: true, pauseRequests: true, highSeverity: true }, abandonAfterDays: 30 });
    const s = json<OrgSettingsDTO>(await admin.put('/settings', { alertRecipients: [' Proctors@Test.example ', 'ops@test.example', 'proctors@test.example'], emailAlerts: { pauseRequests: false } }));
    expect(s.alertRecipients).toEqual(['proctors@test.example', 'ops@test.example']);
    expect(s.emailAlerts).toEqual({ holds: true, pauseRequests: false, highSeverity: true });
    expect((await admin.put('/settings', { alertRecipients: ['not-an-email'] })).statusCode).toBe(400);
    expect((await admin.put('/settings', { alertRecipients: Array.from({ length: 21 }, (_, i) => `u${i}@test.example`) })).statusCode).toBe(400);
    const [a] = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'settings.updated'));
    expect((a.meta as { fields: string[] }).fields).toEqual(expect.arrayContaining(['alertRecipients', 'emailAlerts']));
    json(await admin.put('/settings', { emailAlerts: { pauseRequests: true } }));
  });

  it('sends a test email to the recipients (or a given address) and audits it', async () => {
    const before = mailer.sent.length;
    expect(json(await admin.post('/email-alerts/test', {}))).toEqual({ ok: true, recipients: ['proctors@test.example', 'ops@test.example'] });
    expect(json(await admin.post('/email-alerts/test', { to: 'Someone@Test.example' })).recipients).toEqual(['someone@test.example']);
    expect(mailer.sent.length).toBe(before + 2);
    expect(mailer.sent.at(-2)!).toMatchObject({ to: ['proctors@test.example', 'ops@test.example'], subject: '[SmartProctoring] Test email for Test University' });
    mailer.failNext = 1;
    const failed = await admin.post('/email-alerts/test', {});
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('email_failed');
    const audits = await env.ctx.db.select().from(auditLog).where(eq(auditLog.action, 'email.test_sent'));
    expect(audits).toHaveLength(2);
    expect((await (await staffApi(env, 'reviewer')).post('/email-alerts/test', {})).statusCode).toBe(403);
  });
});

describe('alert emails', () => {
  it('sends the first alert right away and digests a burst into at most one email per session per 5 minutes', async () => {
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    const sentBefore = mailer.sent.length;
    const t0 = env.clock.t;
    const multi = await clientEvent(c, { type: 'multiple_people', startedAt: t0 - 10_000, endedAt: null, confidence: 0.9 });
    await clientEvent(c, { type: 'looking_away', startedAt: t0 - 8_000, endedAt: t0 - 2_000 }); // low: no email
    expect((await itemsOf(s.id)).map((i) => i.kind)).toEqual(['high_severity']);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 1, itemsSent: 1 });
    const first = mailer.sent.at(-1)!;
    expect(first.to).toEqual(['proctors@test.example', 'ops@test.example']);
    expect(first.subject).toBe(`[SmartProctoring] More than one person in view: ${env.candidate.name} — Sample Exam`);
    expect(first.text).toContain(`http://exam.test/admin/sessions/${s.id}`);
    expect(first.text).toContain('More than one person was visible in the camera view.');
    expect(first.text).toMatch(/observations for human review, not conclusions/);
    expect(first.html).toContain(`href="http://exam.test/admin/sessions/${s.id}"`);
    expect(first.html).not.toMatch(/<img|data:image|cid:/i);
    expect(first.text).not.toMatch(/cheat|fraud|violation/i);

    // Burst within the 5-minute window: a phone, a hold (identity review) and a pause request.
    env.clock.advance(MIN);
    await clientEvent(c, { type: 'phone_detected', startedAt: env.clock.t - 5_000, endedAt: env.clock.t - 1_000, confidence: 0.8 });
    env.clock.advance(20_000);
    json(await admin.post(`/sessions/${s.id}/hold`, { note: 'looking into it' }));
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 0, deferred: 1 });
    env.clock.advance(MIN);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 0 }); // still inside the window
    expect(mailer.sent.length).toBe(sentBefore + 1);
    // Replays of an already-alerted episode never enqueue again.
    await c.req('POST', '/api/candidate/events/batch', { events: [{ id: multi, type: 'multiple_people', phase: 'close', startedAt: t0 - 10_000, endedAt: t0, confidence: 0.9, details: {}, version: 2 }] });
    expect((await itemsOf(s.id)).filter((i) => i.eventId === multi)).toHaveLength(1);

    env.clock.set(t0 + EMAIL_THROTTLE_MS);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 1, itemsSent: 2 });
    const digest = mailer.sent.at(-1)!;
    expect(digest.subject).toBe(`[SmartProctoring] 2 alerts: ${env.candidate.name} — Sample Exam`);
    expect(digest.text).toMatch(/Phone visible[\s\S]*Exam on hold: The exam was put on hold because a staff member placed it on hold\./);
    expect(mailer.sent.length).toBe(sentBefore + 2);
    expect((await itemsOf(s.id)).every((i) => i.status === 'sent')).toBe(true);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 0 });
  });

  it('throttles per session (another session is not delayed), respects the toggles and retries SMTP failures', async () => {
    const { exam } = await env.newExam({ policy: { pause: { requireApproval: true } } });
    const a = await env.newSession({ examId: exam.id });
    const b = await env.newSession({ examId: exam.id });
    await startedSession(env, env.candidateClient(a.token));
    const cb = await startedSession(env, env.candidateClient(b.token));
    json(await admin.post(`/sessions/${a.id}/hold`, {}));
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 1 });
    env.clock.advance(10_000);
    expect((await cb.req('POST', '/api/candidate/pause', { reason: 'network issues at home' })).json().outcome).toBe('pending_approval');
    const n = mailer.sent.length;
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 1 }); // session b: its first email
    expect(mailer.sent.at(-1)!.text).toContain('The candidate requested a pause (reason given: “network issues at home”). It needs approval in the staff app');
    expect(mailer.sent.length).toBe(n + 1);

    // Toggle high-severity alerts off: new high events are not queued; holds still are.
    json(await admin.put('/settings', { emailAlerts: { highSeverity: false } }));
    await clientEvent(cb, { type: 'phone_detected', startedAt: env.clock.t - 3_000, endedAt: env.clock.t - 1_000 });
    expect((await itemsOf(b.id)).map((i) => i.kind)).toEqual(['pause_request']);
    expect((await itemsOf(a.id)).map((i) => i.kind)).toEqual(['hold']);
    json(await admin.put('/settings', { emailAlerts: { highSeverity: true } }));

    // SMTP failure: retried after 1 minute, then sent.
    env.clock.advance(EMAIL_THROTTLE_MS);
    json(await admin.post(`/sessions/${b.id}/hold`, {}));
    mailer.failNext = 1;
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 0 });
    const [pending] = (await itemsOf(b.id)).filter((i) => i.kind === 'hold');
    expect(pending).toMatchObject({ status: 'pending', attempts: 1 });
    expect(pending.lastError).toMatch(/SMTP unavailable/);
    expect(pending.nextAttemptAt.getTime()).toBe(env.clock.t + MIN);
    env.clock.advance(MIN);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 1, itemsSent: 1 });
    expect((await itemsOf(b.id)).find((i) => i.id === pending.id)).toMatchObject({ status: 'sent', attempts: 2 });

    // No recipients: queued alerts are skipped (not sent later by surprise).
    json(await admin.put('/settings', { alertRecipients: [] }));
    const c = await env.newSession();
    json(await admin.post(`/sessions/${c.id}/hold`, {}));
    expect(await itemsOf(c.id)).toHaveLength(0); // nothing is queued without recipients
    json(await admin.put('/settings', { alertRecipients: ['proctors@test.example'] }));
    await env.ctx.db.update(emailAlerts).set({ status: 'pending', nextAttemptAt: new Date(env.clock.t) }).where(and(eq(emailAlerts.sessionId, b.id), eq(emailAlerts.kind, 'hold')));
    json(await admin.put('/settings', { alertRecipients: [] }));
    env.clock.advance(EMAIL_THROTTLE_MS);
    expect(await sendDueEmailAlerts(env.ctx)).toMatchObject({ emails: 0, skippedItems: 1 });
  });
});

describe('without SMTP', () => {
  it('shows email alerts as unavailable, refuses the test email and queues nothing', async () => {
    const plain = await createTestEnv();
    try {
      const adm = await staffApi(plain, 'admin');
      expect(json<IntegrationStatusDTO>(await adm.get('/integrations/status')).email).toEqual({ available: false, from: null });
      const r = await adm.post('/email-alerts/test', {});
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('smtp_not_configured');
      json(await adm.put('/settings', { alertRecipients: ['a@test.example'] }));
      json(await adm.post(`/sessions/${plain.session.id}/hold`, {}));
      expect(await plain.ctx.db.select().from(emailAlerts)).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });
});
