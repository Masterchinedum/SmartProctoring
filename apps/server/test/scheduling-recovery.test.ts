/**
 * Roadmap #13 — scheduling windows, the per-exam resume policy and "reopen for recovery"
 * (services/scheduling.ts, services/recovery.ts).
 */
import { CHECK_IN_LEAD_MS, type AssignmentDTO, type CreatedApiKeyDTO, type CreatedWebhookDTO, type IntegrationSessionDTO, type SessionDetailDTO, type SessionReportDTO, type SessionSummaryDTO, type WebhookEnvelope } from '@sp/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, events, examSessions, sessionPeriods, sessionReviews, webhookDeliveries } from '../src/db/schema.js';
import { sweepOnce } from '../src/jobs/sweeper.js';
import { closeAbandonedSessions } from '../src/services/abandonment.js';
import { RECOVERY_MESSAGE } from '../src/services/recovery.js';
import { lockSessionReview } from '../src/services/review.js';
import { json, MIN, otherOrg, staffApi, type Api } from './admin/fixtures.js';
import { consent, hb, runCheck, startCheck, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';

const H = 3600_000;
const DAY = 24 * H;
let env: TestEnv;
let admin: Api;

beforeAll(async () => {
  env = await createTestEnv();
});
// Staff cookies expire after an hour of test-clock time: a fresh one per test (and after long clock jumps).
beforeEach(async () => {
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

const row = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = (id: string, type?: string) =>
  env.ctx.db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, id), type ? eq(events.type, type as never) : undefined))
    .orderBy(asc(events.startedAt));
const auditsOf = (id: string, action: string) =>
  env.ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetId, id), eq(auditLog.action, action)));
const tokenOf = (a: AssignmentDTO) => a.accessLink.split('/take/')[1];
const deliveries = async (webhookId: string) =>
  (await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId))).map((d) => d.payload as unknown as WebhookEnvelope);
const answer = (c: CandidateClient, questions: { id: string }[], idx: number, value: unknown, seq = 1) =>
  c.req('PUT', `/api/candidate/answers/${questions[idx].id}`, { value, clientSeq: seq, answeredAt: env.clock.t });

async function assign(examId: string, candidateId: string, window?: unknown) {
  return json<{ items: AssignmentDTO[] }>(await admin.post(`/exams/${examId}/assignments`, { candidateIds: [candidateId], ...(window !== undefined ? { window } : {}) })).items[0];
}

/* =================================================================== scheduling windows */

describe('scheduling windows', () => {
  it('assignment sets a window; the check-in may begin 30 minutes early, the start only inside it; an exam in progress is never cut off', async () => {
    const t = env.clock.t;
    const cand = await env.newCandidate('Wendy Window');
    const bad = await admin.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [cand.id], window: { startsAt: t + 2 * H, endsAt: t + H } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/close after it opens/);
    const window = { startsAt: t + H, endsAt: t + H + 10 * MIN };
    const a = await assign(env.exam.id, cand.id, window);
    expect(a).toMatchObject({ existing: false, window });
    // Assigning again: the unfinished session keeps its own window.
    expect(await assign(env.exam.id, cand.id, { startsAt: t + 5 * H, endsAt: t + 6 * H })).toMatchObject({ sessionId: a.sessionId, existing: true, window });
    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${a.sessionId}`)).summary.window).toEqual(window);

    const c = env.candidateClient(tokenOf(a));
    expect((await c.req('GET', '/api/candidate/session')).json().session.window).toEqual(window);
    await consent(c); // reading the privacy notice is never restricted
    const early = await startCheck(c, 'initial');
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'exam_window_not_open', details: { window, checkInFrom: window.startsAt - CHECK_IN_LEAD_MS } });

    env.clock.set(window.startsAt - 20 * MIN); // check-in time
    expect((await runCheck(env, c, 'initial')).complete!.outcome).toBe('passed');
    const notYet = await c.req('POST', '/api/candidate/start');
    expect(notYet.statusCode).toBe(409);
    expect(notYet.json().error).toBe('exam_window_not_open');

    env.clock.set(window.startsAt + MIN);
    const started = await c.req('POST', '/api/candidate/start');
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json().session.status).toBe('active');

    // Past the closing time the exam simply continues: answers, heartbeats, submission.
    env.clock.set(window.endsAt + 15 * MIN);
    expect((await hb(c)).json().status).toBe('active');
    expect((await answer(c, env.questions, 0, 'b')).statusCode).toBe(200);
    expect((await c.req('POST', '/api/candidate/submit')).statusCode).toBe(200);
    expect(await row(a.sessionId)).toMatchObject({ status: 'submitted', endReason: 'candidate_submitted' });

    // Another candidate of that window who checked in but never started: refused once it closed.
    admin = await staffApi(env, 'admin');
    const late = await assign(env.exam.id, (await env.newCandidate('Larry Late')).id, { startsAt: env.clock.t - H, endsAt: env.clock.t + 10 * MIN });
    const lc = env.candidateClient(tokenOf(late));
    await consent(lc);
    expect((await runCheck(env, lc, 'initial')).complete!.outcome).toBe('passed');
    env.clock.advance(11 * MIN);
    const closed = await lc.req('POST', '/api/candidate/start');
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ error: 'exam_window_closed', details: { window: late.window } });
    expect((await lc.req('GET', '/api/candidate/session')).json().session.status).toBe('ready');
    // ... and an invitation whose window closed cannot begin the check-in either.
    const missed = await assign(env.exam.id, (await env.newCandidate('Mia Missed')).id, { startsAt: env.clock.t - 2 * H, endsAt: env.clock.t + 5 * MIN });
    env.clock.advance(6 * MIN);
    const mc = env.candidateClient(tokenOf(missed));
    await consent(mc);
    expect((await startCheck(mc, 'initial')).json().error).toBe('exam_window_closed');
  });

  it('reschedules a session that has not started (audited, timeline, webhook); refused once started or ended, across organisations and for reviewers', async () => {
    const hook = json<CreatedWebhookDTO>(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.rescheduled'] }));
    const s = await env.newSession({ candidateId: (await env.newCandidate('Ray Reschedule')).id });
    const t = env.clock.t;
    const window = { startsAt: t + DAY, endsAt: t + DAY + 2 * H };
    const res = json<SessionSummaryDTO>(await admin.post(`/sessions/${s.id}/reschedule`, { window, note: 'Moved to Tuesday (illness)' }));
    expect(res.window).toEqual(window);
    const [ev] = await eventsOf(s.id, 'session_rescheduled');
    expect(ev).toMatchObject({ category: 'neutral', source: 'staff' });
    expect(ev.details).toMatchObject({ window, previousWindow: null, note: 'Moved to Tuesday (illness)', by: admin.user.id, via: 'staff_app' });
    expect(await auditsOf(s.id, 'session.rescheduled')).toHaveLength(1);
    const [payload] = (await deliveries(hook.webhook.id)).filter((p) => p.data.sessionId === s.id);
    expect(payload).toMatchObject({ type: 'session.rescheduled', data: { status: 'invited', window, previousWindow: null } });
    expect(JSON.stringify(payload)).not.toContain('illness'); // the staff note stays in the staff app

    // The same window again records nothing; clearing it is a change.
    json(await admin.post(`/sessions/${s.id}/reschedule`, { window }));
    expect(await eventsOf(s.id, 'session_rescheduled')).toHaveLength(1);
    expect(json<SessionSummaryDTO>(await admin.post(`/sessions/${s.id}/reschedule`, { window: { startsAt: null, endsAt: null } })).window).toBeNull();
    expect(await eventsOf(s.id, 'session_rescheduled')).toHaveLength(2);

    const past = await admin.post(`/sessions/${s.id}/reschedule`, { window: { startsAt: t - 2 * H, endsAt: t - H } });
    expect(past.statusCode).toBe(400);
    expect(past.json().message).toMatch(/already passed/);
    expect((await (await staffApi(env, 'reviewer')).post(`/sessions/${s.id}/reschedule`, { window })).statusCode).toBe(403);
    expect((await (await otherOrg(env)).api.post(`/sessions/${s.id}/reschedule`, { window })).statusCode).toBe(404);

    await startedSession(env, env.candidateClient(s.token));
    const started = await admin.post(`/sessions/${s.id}/reschedule`, { window });
    expect(started.statusCode).toBe(409);
    expect(started.json().error).toBe('already_started');
    json(await admin.post(`/sessions/${s.id}/terminate`, { reason: 'test' }));
    expect((await admin.post(`/sessions/${s.id}/reschedule`, { window })).json().error).toBe('invalid_state');
  });

  it('integration API: a window on assignment (ISO 8601 or epoch ms), on sessions, and PUT /sessions/:id/window', async () => {
    const key = json<CreatedApiKeyDTO>(await admin.post('/api-keys', { name: 'LMS scheduling' })).secret;
    const v1 = (method: InjectOptions['method'], url: string, body?: unknown) =>
      env.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${key}` }, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) });
    const cand = await env.newCandidate('Ingrid Integration');
    const startsAt = env.clock.t + 3 * DAY;
    const res = await v1('POST', `/exams/${env.exam.id}/assignments`, { externalIds: [cand.externalId], window: { startsAt: new Date(startsAt).toISOString(), endsAt: startsAt + 4 * H } });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().items[0];
    expect(a.window).toEqual({ startsAt, endsAt: startsAt + 4 * H });
    expect((await v1('GET', `/sessions/${a.sessionId}`)).json<IntegrationSessionDTO>().window).toEqual(a.window);
    expect((await v1('POST', `/exams/${env.exam.id}/assignments`, { externalIds: [cand.externalId], window: { startsAt: 'next tuesday' } })).statusCode).toBe(400);

    const moved = await v1('PUT', `/sessions/${a.sessionId}/window`, { window: { startsAt: startsAt + DAY, endsAt: startsAt + DAY + H } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<IntegrationSessionDTO>().window).toEqual({ startsAt: startsAt + DAY, endsAt: startsAt + DAY + H });
    const [entry] = await auditsOf(a.sessionId, 'api.session.rescheduled');
    expect(entry).toMatchObject({ actorType: 'api_key', meta: { apiKey: 'LMS scheduling' } });
    const [ev] = await eventsOf(a.sessionId, 'session_rescheduled');
    expect(ev.details).toMatchObject({ via: 'integration_api' });
  });
});

/* =================================================================== resume policy */

describe('resume policy', () => {
  it('maxReconnects + hold: passed reconnect checks during the exam count (not before it); the next one is held; a release gives the allowance again', async () => {
    const { exam } = await env.newExam({ policy: { resume: { maxReconnects: 1 } } });
    const s = await env.newSession({ examId: exam.id, candidateId: (await env.newCandidate('Rita Reconnect')).id });
    const c = env.candidateClient(s.token);
    await consent(c);
    expect((await runCheck(env, c, 'initial')).complete!.outcome).toBe('passed');
    // A reload on the ready screen is not an interruption of the exam.
    const c1 = c.withInstance('reload-before-start');
    expect((await runCheck(env, c1, 'reconnect')).complete!.outcome).toBe('passed');
    expect((await c1.req('POST', '/api/candidate/start')).statusCode).toBe(200);
    expect((await row(s.id)).reconnectCount).toBe(0);

    const c2 = c.withInstance('reconnect-number-one');
    expect((await runCheck(env, c2, 'reconnect')).complete!.outcome).toBe('passed');
    expect((await row(s.id)).reconnectCount).toBe(1);
    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`)).summary.reconnectCount).toBe(1);

    const c3 = c.withInstance('reconnect-number-two');
    const refused = await startCheck(c3, 'reconnect');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'resume_limit_reached', message: expect.stringMatching(/more often than the exam rules allow \(1 time\)/) });
    expect(await row(s.id)).toMatchObject({ status: 'on_hold', holdReason: 'resume_limit', runningSince: null });
    const [held] = await eventsOf(s.id, 'session_held');
    expect(held.details).toMatchObject({ reason: 'resume_limit', limit: 'reconnects', reconnects: 1, maxReconnects: 1, onLimit: 'hold' });
    expect(held.observation).toMatch(/put on hold for staff review/);
    const st = (await c3.req('GET', '/api/candidate/session')).json();
    expect(st.session).toMatchObject({ status: 'on_hold', requiredCheck: null, hold: { reason: 'resume_limit', canReverify: false } });

    json(await admin.post(`/sessions/${s.id}/release`, { requireCheck: true }));
    expect((await row(s.id)).reconnectCount).toBe(0);
    expect((await runCheck(env, c3, 'reverify')).complete!.outcome).toBe('passed');
    expect((await row(s.id)).status).toBe('active');
    const c4 = c.withInstance('reconnect-after-release');
    expect((await runCheck(env, c4, 'reconnect')).complete!.outcome).toBe('passed');
    expect((await row(s.id)).reconnectCount).toBe(1);
  });

  it("maxReconnects 0 + onLimit 'end': the first reconnection ends and submits the exam; the candidate is told why; the webhook says which limit", async () => {
    const hook = json<CreatedWebhookDTO>(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.submitted'] }));
    const { exam, questions } = await env.newExam({ policy: { resume: { maxReconnects: 0, onLimit: 'end' } } });
    const s = await env.newSession({ examId: exam.id, candidateId: (await env.newCandidate('Ed Ended')).id });
    const c = await startedSession(env, env.candidateClient(s.token));
    expect((await answer(c, questions, 0, 'b')).statusCode).toBe(200);
    const c2 = c.withInstance('first-reconnection-ends');
    const refused = await startCheck(c2, 'reconnect');
    expect(refused.json()).toMatchObject({ error: 'resume_limit_reached', message: expect.stringMatching(/has ended and your saved answers were submitted/) });
    const r = await row(s.id);
    expect(r).toMatchObject({ status: 'submitted', endReason: 'resume_limit' });
    expect(r.score?.points).toBe(1);
    const [sub] = await eventsOf(s.id, 'session_submitted');
    expect(sub.details).toMatchObject({ endReason: 'resume_limit', limit: 'reconnects', maxReconnects: 0 });
    expect(sub.observation).toMatch(/exam ended and the saved answers were submitted/);
    expect((await c2.req('GET', '/api/candidate/session')).json().session).toMatchObject({ status: 'submitted', endReason: 'resume_limit' });
    const [payload] = (await deliveries(hook.webhook.id)).filter((p) => p.data.sessionId === s.id);
    expect(payload.data).toMatchObject({ status: 'submitted', endReason: 'resume_limit', reason: 'too_many_reconnects', score: { points: 1 } });
    const report = json<SessionReportDTO>(await admin.get(`/sessions/${s.id}/report`));
    expect(report.observations.join(' ')).toMatch(/ended under the exam’s resume rules/);
  });

  it('maxOfflineMinutes: the sweeper holds an exam disconnected too long — not a paused one, not one without a limit; counted from when the exam last continued; also enforced when the candidate returns', async () => {
    const { exam } = await env.newExam({ policy: { resume: { maxOfflineMinutes: 5 } } });
    const offline = await env.newSession({ examId: exam.id, candidateId: (await env.newCandidate('Olga Offline')).id });
    const oc = await startedSession(env, env.candidateClient(offline.token));
    const paused = await env.newSession({ examId: exam.id, candidateId: (await env.newCandidate('Paula Paused')).id });
    const pc = await startedSession(env, env.candidateClient(paused.token));
    expect((await pc.req('POST', '/api/candidate/pause', { reason: 'break' })).json().outcome).toBe('paused');
    const unlimited = await env.newSession({ candidateId: (await env.newCandidate('Uma Unlimited')).id });
    const uc = await startedSession(env, env.candidateClient(unlimited.token));
    await hb(oc);
    await hb(uc);

    env.clock.advance(4 * MIN);
    expect((await sweepOnce(env.ctx)).resumeLimits).toBe(0);
    expect(await row(offline.id)).toMatchObject({ status: 'active', connection: 'offline' });
    env.clock.advance(2 * MIN);
    expect((await sweepOnce(env.ctx)).resumeLimits).toBe(1);
    expect(await row(offline.id)).toMatchObject({ status: 'on_hold', holdReason: 'resume_limit' });
    const [held] = await eventsOf(offline.id, 'session_held');
    expect(held.details).toMatchObject({ reason: 'resume_limit', limit: 'offline', maxOfflineMinutes: 5 });
    expect((held.details as { offlineMs: number }).offlineMs).toBeGreaterThan(5 * MIN);
    expect((await row(offline.id)).holdMessage).toMatch(/disconnected for longer than the exam rules allow \(5 min\)/);
    expect((await row(paused.id)).status).toBe('paused');
    expect(await row(unlimited.id)).toMatchObject({ status: 'active', connection: 'offline' });

    // Released without a new check: the time counts again from the release, not from the old heartbeat.
    json(await admin.post(`/sessions/${offline.id}/release`, { requireCheck: false }));
    expect((await sweepOnce(env.ctx)).resumeLimits).toBe(0);
    expect((await row(offline.id)).status).toBe('active');
    env.clock.advance(6 * MIN);
    await sweepOnce(env.ctx);
    expect((await row(offline.id)).status).toBe('on_hold');

    // Coming back after too long, before the sweeper noticed: applied when the reconnect check would start.
    const { exam: endExam } = await env.newExam({ policy: { resume: { maxOfflineMinutes: 5, onLimit: 'end' } } });
    const gone = await env.newSession({ examId: endExam.id, candidateId: (await env.newCandidate('Gil Gone')).id });
    const gc = await startedSession(env, env.candidateClient(gone.token));
    await hb(gc);
    env.clock.advance(7 * MIN);
    const back = await startCheck(gc.withInstance('back-after-seven-min'), 'reconnect');
    expect(back.json().error).toBe('resume_limit_reached');
    expect(await row(gone.id)).toMatchObject({ status: 'submitted', endReason: 'resume_limit' });
    const [sub] = await eventsOf(gone.id, 'session_submitted');
    expect(sub.details).toMatchObject({ limit: 'offline', maxOfflineMinutes: 5 });
  });
});

/* =================================================================== reopen for recovery */

describe('reopen for recovery', () => {
  it('reopens an exam whose time ran out: minutes required, a fresh identity check, answers kept, the clock continues; audited, on the timeline, webhook, report', async () => {
    const hook = json<CreatedWebhookDTO>(await admin.post('/webhooks', { url: 'http://127.0.0.1:9/hook', events: ['session.reopened'] }));
    const { exam, questions } = await env.newExam({ durationSec: 600 });
    const s = await env.newSession({ examId: exam.id, candidateId: (await env.newCandidate('Rob Recovery')).id });
    const c = await startedSession(env, env.candidateClient(s.token));
    expect((await answer(c, questions, 0, 'b')).statusCode).toBe(200);
    env.clock.advance(11 * MIN);
    expect((await sweepOnce(env.ctx)).expired).toBeGreaterThanOrEqual(1);
    const ended = await row(s.id);
    expect(ended).toMatchObject({ status: 'submitted', endReason: 'time_expired' });
    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`)).reopen).toMatchObject({ allowed: true, started: true, remainingMs: 0 });

    expect((await (await staffApi(env, 'reviewer')).post(`/sessions/${s.id}/reopen`, { reason: 'Power cut at the centre' })).statusCode).toBe(403);
    const noTime = await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Power cut at the centre' });
    expect(noTime.statusCode).toBe(409);
    expect(noTime.json().error).toBe('no_time_left');
    expect((await admin.post(`/sessions/${s.id}/reopen`, { reason: 'x' })).statusCode).toBe(400);

    env.clock.advance(30 * MIN);
    const reopenedAt = env.clock.t;
    const res = json<SessionSummaryDTO>(await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Power cut at the centre', addMinutes: 5 }));
    expect(res).toMatchObject({ status: 'on_hold', endReason: null, endedAt: null, hold: { reason: 'recovery', canReverify: true }, remainingMs: 5 * MIN, timerRunning: false });
    const r = await row(s.id);
    expect(r).toMatchObject({ score: null, durationMs: 15 * MIN, reconnectCount: 0, holdMessage: RECOVERY_MESSAGE });
    const [ev] = await eventsOf(s.id, 'session_reopened');
    expect(ev).toMatchObject({ category: 'neutral', source: 'staff' });
    expect(ev.details).toMatchObject({ reason: 'Power cut at the centre', addMinutes: 5, started: true, previousStatus: 'submitted', previousEndReason: 'time_expired', previousScore: { points: 1 }, by: admin.user.id });
    expect(ev.observation).toMatch(/after the exam time had run out/);
    expect((await auditsOf(s.id, 'session.reopened'))[0]).toMatchObject({ actorType: 'staff', actorId: admin.user.id, meta: { addMinutes: 5, previousEndReason: 'time_expired' } });
    const [payload] = (await deliveries(hook.webhook.id)).filter((p) => p.data.sessionId === s.id);
    expect(payload).toMatchObject({ type: 'session.reopened', data: { status: 'on_hold', endReason: null, reason: 'time_expired', addedMinutes: 5 } });
    expect(JSON.stringify(payload)).not.toContain('Power cut');
    // Retention never purges a reopened exam (it has no end time any more).
    expect(r.endedAt).toBeNull();

    // The candidate (any browser) must pass a fresh identity check first.
    const c2 = c.withInstance('recovery-browser-01');
    const st = (await c2.req('GET', '/api/candidate/session')).json();
    expect(st.session).toMatchObject({ status: 'on_hold', requiredCheck: 'reverify', endReason: null, hold: { reason: 'recovery', canReverify: true, message: RECOVERY_MESSAGE } });
    expect(st.questions).toBeNull();
    env.clock.advance(2 * MIN);
    const { complete } = await runCheck(env, c2, 'reverify');
    expect(complete!.outcome).toBe('passed');
    expect(complete!.state.session).toMatchObject({ status: 'active', timerRunning: true });
    expect(complete!.state.session.remainingMs).toBeGreaterThan(4 * MIN);
    expect(complete!.state.answers!.find((x) => x.questionId === questions[0].id)).toMatchObject({ value: 'b' });
    const periods = await env.ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, s.id)).orderBy(asc(sessionPeriods.startedAt));
    const hold = periods.find((p) => p.kind === 'on_hold' && p.reason === 'recovery')!;
    expect(hold.startedAt.getTime()).toBe(ended.endedAt!.getTime());
    expect(hold.endedAt!.getTime()).toBeGreaterThanOrEqual(reopenedAt);
    expect(periods.map((p) => p.kind).slice(-3)).toEqual(['on_hold', 'resume_check', 'active']);

    expect((await answer(c2, questions, 2, 'Paris')).statusCode).toBe(200);
    expect((await c2.req('POST', '/api/candidate/submit')).statusCode).toBe(200);
    expect(await row(s.id)).toMatchObject({ status: 'submitted', endReason: 'candidate_submitted', score: expect.objectContaining({ points: 2 }) });
    const report = json<SessionReportDTO>(await admin.get(`/sessions/${s.id}/report`));
    expect(report.observations.join(' ')).toMatch(/reopened the exam for recovery at .* \(it had been submitted automatically when the exam time ran out\) and added 5 minutes/);
    expect(report.observations.join(' ')).not.toContain('Power cut');

    // Now submitted by the candidate: not reopenable.
    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${s.id}`)).reopen).toMatchObject({ allowed: false, code: 'candidate_submitted' });
    expect((await admin.post(`/sessions/${s.id}/reopen`, { reason: 'Second try please', addMinutes: 5 })).json().error).toBe('candidate_submitted');
  });

  it('refuses an exam in progress, purged evidence, a completed review and a withdrawn consent; a session that never started returns to the check-in', async () => {
    const reason = { reason: 'Technical problem at the centre', addMinutes: 10 };
    const s = await env.newSession({ candidateId: (await env.newCandidate('Ned Notyet')).id });
    const c = await startedSession(env, env.candidateClient(s.token));
    expect((await admin.post(`/sessions/${s.id}/reopen`, reason)).json().error).toBe('not_ended');
    json(await admin.post(`/sessions/${s.id}/terminate`, { reason: 'Fire alarm' }));
    await env.ctx.db.update(examSessions).set({ evidencePurgedAt: new Date(env.clock.t) }).where(eq(examSessions.id, s.id));
    const purged = await admin.post(`/sessions/${s.id}/reopen`, reason);
    expect(purged.statusCode).toBe(409);
    expect(purged.json()).toMatchObject({ error: 'evidence_purged', message: expect.stringMatching(/retention policy/) });
    await env.ctx.db.update(examSessions).set({ evidencePurgedAt: null }).where(eq(examSessions.id, s.id));
    const sessionRow = await row(s.id);
    await lockSessionReview(env.ctx.db, sessionRow, env.clock.t);
    await env.ctx.db.update(sessionReviews).set({ state: 'resolved', outcome: 'no_concerns', resolvedAt: new Date(env.clock.t) }).where(eq(sessionReviews.sessionId, s.id));
    expect((await admin.post(`/sessions/${s.id}/reopen`, reason)).json().error).toBe('review_resolved');
    await env.ctx.db.update(sessionReviews).set({ state: 'open', outcome: null, resolvedAt: null }).where(eq(sessionReviews.sessionId, s.id));
    expect((await (await otherOrg(env)).api.post(`/sessions/${s.id}/reopen`, reason)).statusCode).toBe(404);
    // Staff termination is reopenable (e.g. ended by mistake): the reconnect allowance starts again.
    expect(json<SessionSummaryDTO>(await admin.post(`/sessions/${s.id}/reopen`, reason))).toMatchObject({ status: 'on_hold', hold: { reason: 'recovery' } });
    expect((await runCheck(env, c, 'reverify')).complete!.outcome).toBe('passed');

    const w = await env.newSession({ candidateId: (await env.newCandidate('Will Withdrew')).id });
    const wc = await startedSession(env, env.candidateClient(w.token));
    expect((await wc.req('POST', '/api/candidate/consent/withdraw', { confirm: true })).statusCode).toBe(200);
    expect((await admin.post(`/sessions/${w.id}/reopen`, reason)).json().error).toBe('consent_withdrawn');

    const never = await env.newSession({ candidateId: (await env.newCandidate('Nora Never')).id });
    json(await admin.post(`/sessions/${never.id}/terminate`, { reason: 'Assigned by mistake' }));
    expect(json<SessionDetailDTO>(await admin.get(`/sessions/${never.id}`)).reopen).toMatchObject({ allowed: true, started: false });
    expect(json<SessionSummaryDTO>(await admin.post(`/sessions/${never.id}/reopen`, { reason: 'Needed after all' }))).toMatchObject({ status: 'invited', endReason: null, hold: null });
    const nc = env.candidateClient(never.token);
    await consent(nc);
    expect((await runCheck(env, nc, 'initial')).complete!.outcome).toBe('passed');
    expect((await nc.req('POST', '/api/candidate/start')).statusCode).toBe(200);
  });
});

/* =================================================================== housekeeping */

describe('abandoned-session housekeeping and windows', () => {
  it('counts inactivity from the end of the window at the earliest', async () => {
    const e2 = await createTestEnv();
    try {
      const a2 = await staffApi(e2, 'admin');
      json(await a2.put('/settings', { abandonAfterDays: 10 }));
      const cand = await e2.newCandidate('Fran Future');
      const t = e2.clock.t;
      const [future] = json<{ items: AssignmentDTO[] }>(await a2.post(`/exams/${e2.exam.id}/assignments`, { candidateIds: [cand.id], window: { startsAt: t + 20 * DAY, endsAt: t + 21 * DAY } })).items;
      e2.clock.advance(15 * DAY);
      // The seeded invitation (no window) is closed; the scheduled one is not, although nobody touched it for 15 days.
      expect((await closeAbandonedSessions(e2.ctx)).sessionIds).toEqual([e2.session.id]);
      e2.clock.set(t + 21 * DAY + 9 * DAY);
      expect((await closeAbandonedSessions(e2.ctx)).closed).toBe(0);
      e2.clock.set(t + 21 * DAY + 10 * DAY + MIN);
      expect((await closeAbandonedSessions(e2.ctx)).sessionIds).toEqual([future.sessionId]);
    } finally {
      await e2.close();
    }
  });
});
