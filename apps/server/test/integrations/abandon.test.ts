/**
 * Abandoned-session hygiene: sessions that never end (invited, ready, paused, on hold, or active with the
 * clock stopped) are closed after the organisation's abandonAfterDays without activity, so retention applies.
 */
import type { CreatedWebhookDTO, SessionDetailDTO, SessionReportDTO, WebhookEnvelope } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answers, auditLog, events, examSessions, evidence, webhookDeliveries } from '../../src/db/schema.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { closeAbandonedSessions } from '../../src/services/abandonment.js';
import { runRetention } from '../../src/services/retention.js';
import { json, MIN, staffApi } from '../admin/fixtures.js';
import { consent, hb, runCheck, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

const DAY = 24 * 3600_000;
let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const row = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];

describe('abandoned sessions', () => {
  it('closes invited, ready, paused, on-hold and clock-stopped active sessions after abandonAfterDays; keeps answers; retention then applies', async () => {
    const admin = await staffApi(env, 'admin');
    json(await admin.put('/settings', { abandonAfterDays: 10 }));
    const hook = json<CreatedWebhookDTO>(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.terminated'] }));

    const invited = await env.newSession();
    const ready = await env.newSession();
    const rc = env.candidateClient(ready.token);
    await consent(rc);
    expect((await runCheck(env, rc, 'initial')).complete!.outcome).toBe('passed');
    const paused = await env.newSession();
    const pc = await startedSession(env, env.candidateClient(paused.token));
    const q = env.questions[0];
    expect((await pc.req('PUT', `/api/candidate/answers/${q.id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(200);
    expect((await pc.req('POST', '/api/candidate/pause', { reason: 'break' })).json().outcome).toBe('paused');
    const held = await env.newSession();
    await startedSession(env, env.candidateClient(held.token));
    json(await admin.post(`/sessions/${held.id}/hold`, { note: 'check later' }));
    // Active with the clock stopped by a disconnect (policy 'stop'): it can never run out on its own.
    const { exam: stopExam } = await env.newExam({ policy: { connection: { disconnectTimerBehavior: 'stop' } } });
    const stopped = await env.newSession({ examId: stopExam.id });
    const sc = await startedSession(env, env.candidateClient(stopped.token));
    expect((await hb(sc)).statusCode).toBe(200);
    env.clock.advance(MIN);
    await sweepOnce(env.ctx);
    expect(await row(stopped.id)).toMatchObject({ status: 'active', connection: 'offline', runningSince: null });
    // Active with a running clock is never touched here (time expiry handles it).
    const running = await env.newSession();
    await startedSession(env, env.candidateClient(running.token));

    // 9 days later: nothing is old enough.
    env.clock.advance(9 * DAY);
    expect((await closeAbandonedSessions(env.ctx)).closed).toBe(0);
    // Activity (a staff action) restarts the count for the held session.
    json(await (await staffApi(env, 'admin')).post(`/sessions/${held.id}/legal-hold`, { enabled: false }));
    env.clock.advance(1 * DAY + MIN);
    const recent = await env.newSession(); // brand new invitation
    const r = await closeAbandonedSessions(env.ctx);
    // (env.session is the seeded invitation from createTestEnv: also untouched for > 10 days.)
    expect(r.sessionIds.sort()).toEqual([env.session.id, invited.id, ready.id, paused.id, stopped.id].sort());
    expect((await row(held.id)).status).toBe('on_hold');
    expect((await row(running.id)).status).toBe('active');
    expect((await row(recent.id)).status).toBe('invited');
    expect((await closeAbandonedSessions(env.ctx)).closed).toBe(0); // idempotent

    for (const id of r.sessionIds) {
      const s = await row(id);
      expect(s).toMatchObject({ status: 'terminated', endReason: 'abandoned', score: null });
      expect(s.endedAt?.getTime()).toBe(env.clock.t);
      const [ev] = await env.ctx.db.select().from(events).where(and(eq(events.sessionId, id), eq(events.type, 'session_terminated')));
      expect(ev).toMatchObject({ category: 'neutral', source: 'server_system', status: 'closed' });
      expect(ev.details).toMatchObject({ reason: 'abandoned_after_inactivity', inactiveDays: 10 });
      expect(ev.observation).toMatch(/closed automatically after 10 days without activity/);
      expect(ev.observation).not.toMatch(/administrator/);
      const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'session.abandoned'), eq(auditLog.targetId, id)));
      expect(a).toMatchObject({ actorType: 'system' });
    }
    expect((await env.ctx.db.select().from(events).where(and(eq(events.sessionId, paused.id), eq(events.type, 'unobserved_period')))).length).toBeGreaterThan(0);
    // Answers are kept (no score is implied).
    expect(await env.ctx.db.select().from(answers).where(eq(answers.sessionId, paused.id))).toHaveLength(1);

    // Staff views: endReason 'abandoned'; the report explains it neutrally; the candidate sees a closed exam.
    const staff = await staffApi(env, 'reviewer');
    const detail = json<SessionDetailDTO>(await staff.get(`/sessions/${paused.id}`));
    expect(detail.summary).toMatchObject({ status: 'terminated', endReason: 'abandoned' });
    expect(detail.score).toBeNull();
    const report = json<SessionReportDTO>(await staff.get(`/sessions/${paused.id}/report`));
    expect(report.observations.join(' ')).toMatch(/closed automatically after a long period without activity/);
    const st = (await env.candidateClient(paused.token).req('GET', '/api/candidate/session')).json();
    expect(st.session).toMatchObject({ status: 'terminated', endReason: null });

    // Webhook: session.terminated with the structured reason.
    const payloads = (await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.webhook.id))).map((d) => d.payload as unknown as WebhookEnvelope);
    expect(payloads.filter((p) => p.type === 'session.terminated').map((p) => p.data.sessionId).sort()).toEqual([...r.sessionIds].sort());
    expect(payloads[0].data).toMatchObject({ status: 'terminated', endReason: 'abandoned', reason: 'abandoned_after_inactivity' });

    // The hold is closed once it, too, has had no activity for 10 days.
    env.clock.advance(10 * DAY);
    // (`recent` is exactly 10 days old now: not yet "older than" the limit.)
    expect((await closeAbandonedSessions(env.ctx)).sessionIds).toEqual([held.id]);
    expect(await row(held.id)).toMatchObject({ status: 'terminated', endReason: 'abandoned' });

    // Retention now applies from the end time: check-in evidence of the ready session is purged.
    expect((await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, ready.id))).some((e) => e.purgedAt == null)).toBe(true);
    env.clock.advance(31 * DAY);
    await runRetention(env.ctx);
    const ev = await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, ready.id));
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.purgedAt != null)).toBe(true);
  });

  it('validates abandonAfterDays', async () => {
    const admin = await staffApi(env, 'admin');
    expect((await admin.put('/settings', { abandonAfterDays: 0 })).statusCode).toBe(400);
    expect((await admin.put('/settings', { abandonAfterDays: 1.5 })).statusCode).toBe(400);
    expect(json(await admin.put('/settings', { abandonAfterDays: 45 })).abandonAfterDays).toBe(45);
  });
});
