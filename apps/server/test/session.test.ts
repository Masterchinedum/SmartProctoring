import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, evidence, examSessions, sessionPeriods } from '../src/db/schema.js';
import { sweepOnce } from '../src/jobs/sweeper.js';
import { readEvidence } from '../src/services/evidence.js';
import { decidePauseRequest } from '../src/services/session-actions.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { consent, hb, runCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

async function freshSession(policy?: Record<string, unknown>) {
  const examId = policy ? (await env.newExam({ policy })).exam.id : env.exam.id;
  const s = await env.newSession({ examId });
  const c = env.candidateClient(s.token);
  return { s, c };
}

const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const periodsOf = async (id: string) => env.ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, id)).orderBy(sessionPeriods.startedAt);
const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt);

function ev(over: Record<string, unknown> = {}) {
  return { id: randomUUID(), type: 'looking_away', phase: 'open', startedAt: env.clock.t, endedAt: null, confidence: 0.8, details: {}, version: 1, ...over };
}

describe('invite, consent, access', () => {
  it('rejects bad tokens and requires consent before the initial check', async () => {
    const bad = await env.app.inject({ method: 'GET', url: '/api/candidate/session', headers: { authorization: 'Bearer nope-nope-nope-nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const { c } = await freshSession();
    const st = (await c.req('GET', '/api/candidate/session')).json();
    expect(st.session.status).toBe('invited');
    expect(st.consent.accepted).toBe(false);
    expect(st.consent.notice.contact).toBe('privacy@test.example');
    expect(st.questions).toBeNull();
    const early = await c.req('POST', '/api/candidate/checks', { purpose: 'initial', clientInstanceId: c.instanceId, device: {} });
    expect(early.statusCode).toBe(409);
    const outdated = await c.req('POST', '/api/candidate/consent', { noticeVersion: '1999-01-01', accepted: true });
    expect(outdated.statusCode).toBe(409);
    const ok = await consent(c);
    expect(ok.consent.accepted).toBe(true);
    expect(ok.session.requiredCheck).toBe('initial');
    const pn = await env.app.inject({ method: 'GET', url: `/api/public/privacy-notice?token=${c.token}` });
    expect(pn.statusCode).toBe(200);
    expect(pn.json().retentionDays).toBe(30);
  });

  it('establishes the reference with liveness and records check-in timeline', async () => {
    const { s, c } = await freshSession();
    await consent(c);
    const { start, complete } = await runCheck(env, c, 'initial');
    expect(start.liveness!.steps[0].action).toBe('center');
    const actions = start.liveness!.steps.map((x) => x.action);
    expect(actions).toContain('turn_left');
    expect(actions).toContain('turn_right');
    expect(complete!.outcome).toBe('passed');
    expect(complete!.liveness!.passed).toBe(true);
    expect(complete!.state.session.status).toBe('ready');
    const evs = await eventsOf(s.id);
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['checkin_completed', 'reference_created']));
    const p = await periodsOf(s.id);
    expect(p[0].kind).toBe('check_in');
    expect(p[0].endedAt).not.toBeNull();
    // Questions hidden until start
    expect(complete!.state.questions).toBeNull();
    const started = (await c.req('POST', '/api/candidate/start')).json();
    expect(started.session.status).toBe('active');
    expect(started.session.timerRunning).toBe(true);
    expect(started.questions).toHaveLength(5);
  });
});

describe('answers', () => {
  it('saves answers idempotently with clientSeq conflict resolution and validates values', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    const q = env.questions;
    const put = (qi: number, value: unknown, seq: number) => c.req('PUT', `/api/candidate/answers/${q[qi].id}`, { value, clientSeq: seq, answeredAt: env.clock.t });
    expect((await put(0, 'a', 2)).json()).toEqual({ saved: true, applied: true, serverSeq: 2 });
    // older seq arrives late: not applied
    expect((await put(0, 'b', 1)).json()).toEqual({ saved: true, applied: false, serverSeq: 2 });
    expect((await put(0, 'b', 3)).json()).toMatchObject({ applied: true, serverSeq: 3 });
    expect((await put(0, 'zzz', 4)).statusCode).toBe(400); // not an option
    expect((await c.req('PUT', `/api/candidate/answers/${randomUUID()}`, { value: 'x', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(404);
    // another browser instance cannot write
    const other = c.withInstance('other-instance-1234');
    expect((await other.req('PUT', `/api/candidate/answers/${q[0].id}`, { value: 'a', clientSeq: 9, answeredAt: env.clock.t })).statusCode).toBe(409);
    const st = (await c.req('GET', '/api/candidate/session')).json();
    expect(st.answers.find((a: { questionId: string }) => a.questionId === q[0].id).value).toBe('b');
    void s;
  });

  it('grades on submit (single, multiple, short text, numeric; long text manual)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    const q = env.questions;
    const answers: [number, unknown][] = [
      [0, 'b'],
      [1, ['c', 'a']],
      [2, '  paris '],
      [3, 3.14],
      [4, 'Because...'],
    ];
    for (const [i, v] of answers) expect((await c.req('PUT', `/api/candidate/answers/${q[i].id}`, { value: v, clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(200);
    const sub = await c.req('POST', '/api/candidate/submit');
    expect(sub.json().session).toMatchObject({ status: 'submitted', endReason: 'candidate_submitted' });
    const row = await sessionRow(s.id);
    expect(row.score).toMatchObject({ points: 5, maxPoints: 10, autoGraded: false });
    // after submit: answers rejected, questions visible for review
    expect((await c.req('PUT', `/api/candidate/answers/${q[0].id}`, { value: 'a', clientSeq: 5, answeredAt: env.clock.t })).statusCode).toBe(409);
    expect(sub.json().questions).toHaveLength(5);
  });
});

describe('events', () => {
  it('upserts idempotently, applies newer versions only, takes category/title from the catalog', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(5_000);
    const e = ev({ type: 'multiple_people', observation: '  A second face was visible  ', details: { faces: 2 } });
    const r1 = await c.req('POST', '/api/candidate/events/batch', { events: [e] });
    expect(r1.json().results).toEqual([{ id: e.id, result: 'created' }]);
    expect((await c.req('POST', '/api/candidate/events/batch', { events: [e] })).json().results[0].result).toBe('stale');
    const v3 = { ...e, version: 3, phase: 'close', endedAt: env.clock.t + 4000 };
    const v2 = { ...e, version: 2, phase: 'update', details: { faces: 3 } };
    const r2 = await c.req('POST', '/api/candidate/events/batch', { events: [v3, v2] });
    expect(r2.json().results.map((x: { result: string }) => x.result)).toEqual(['updated', 'stale']);
    const [row] = await env.ctx.db.select().from(events).where(eq(events.id, e.id));
    expect(row).toMatchObject({ category: 'integrity', severity: 'high', title: 'More than one person in view', status: 'closed', version: 3, observation: 'A second face was visible' });
    expect(row.endedAt!.getTime()).toBe(v3.endedAt);
    // server-only types are rejected
    const bad = await c.req('POST', '/api/candidate/events/batch', { events: [ev({ type: 'identity_mismatch' }), ev({ type: 'reporting_interrupted' })] });
    expect(bad.json().results.every((x: { result: string; reason: string }) => x.result === 'rejected' && x.reason === 'not_client_reportable')).toBe(true);
    void s;
  });

  it('flags late delivery, rejects events before check-in, inside pauses and after the end', async () => {
    const { s, c } = await freshSession();
    await consent(c);
    const before = ev({ startedAt: env.clock.t - 60_000 });
    await runCheck(env, c, 'initial');
    await c.req('POST', '/api/candidate/start');
    env.clock.advance(60_000);
    const late = ev({ type: 'tab_hidden', phase: 'close', startedAt: env.clock.t - 50_000, endedAt: env.clock.t - 45_000 });
    const fresh = ev({ type: 'tab_hidden', phase: 'close', startedAt: env.clock.t - 3_000, endedAt: env.clock.t - 1_000 });
    const openOverPause = ev({ type: 'looking_away', startedAt: env.clock.t - 2_000 });
    const r = await c.req('POST', '/api/candidate/events/batch', { events: [before, late, fresh, openOverPause] });
    expect(r.json().results.map((x: { result: string; reason?: string }) => x.reason ?? x.result)).toEqual(['before_check_in', 'created', 'created', 'created']);
    const rows = await eventsOf(s.id);
    expect(rows.find((x) => x.id === late.id)!.deliveredLate).toBe(true);
    expect(rows.find((x) => x.id === fresh.id)!.deliveredLate).toBe(false);

    // Pause: open episode is cut at the pause start; events inside the pause are rejected.
    const pause = await c.req('POST', '/api/candidate/pause', { reason: 'bathroom' });
    expect(pause.json().outcome).toBe('paused');
    const pauseStart = env.clock.t;
    env.clock.advance(30_000);
    const inside = ev({ startedAt: env.clock.t - 10_000 });
    const closeLater = { ...openOverPause, version: 2, phase: 'close', endedAt: env.clock.t - 5_000 };
    const r2 = await c.req('POST', '/api/candidate/events/batch', { events: [inside, closeLater] });
    expect(r2.json().results.map((x: { result: string; reason?: string }) => x.reason ?? x.result)).toEqual(['during_unobserved_period', 'updated']);
    const cut = (await eventsOf(s.id)).find((x) => x.id === openOverPause.id)!;
    expect(cut.status).toBe('closed');
    expect(cut.endedAt!.getTime()).toBe(pauseStart);
    // evidence captured during the pause is dropped
    const evi = await c.jpeg(`/api/candidate/evidence/${randomUUID()}`, { person: 'alice' }, { capturedAt: env.clock.t - 1000 }, 'PUT');
    expect(evi.json()).toEqual({ stored: false, duplicate: false });
  });
});

describe('evidence', () => {
  it('stores screenshots encrypted at rest, idempotently, and links them to events (even if uploaded first)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(1000);
    const eventId = randomUUID();
    const evidenceId = randomUUID();
    const jpeg = Buffer.concat([FakeVisionService.encode({ person: 'alice', faces: 2 }), Buffer.alloc(2000, 7)]);
    const up = await c.jpeg(`/api/candidate/evidence/${evidenceId}`, jpeg, { eventId, capturedAt: env.clock.t, reason: 'onset' }, 'PUT');
    expect(up.json()).toEqual({ stored: true, duplicate: false });
    expect((await c.jpeg(`/api/candidate/evidence/${evidenceId}`, jpeg, { eventId, capturedAt: env.clock.t }, 'PUT')).json()).toEqual({ stored: true, duplicate: true });
    // not a JPEG
    const notJpeg = await env.app.inject({ method: 'PUT', url: `/api/candidate/evidence/${randomUUID()}`, headers: { authorization: `Bearer ${c.token}`, 'x-client-instance': c.instanceId, 'content-type': 'image/jpeg' }, payload: Buffer.from('GIF89a....') });
    expect(notJpeg.statusCode).toBe(415);
    // too large
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024 + 10)]);
    expect((await c.jpeg(`/api/candidate/evidence/${randomUUID()}`, big, {}, 'PUT')).statusCode).toBe(413);

    const [row] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, evidenceId));
    expect(row.kind).toBe('event_screenshot');
    const onDisk = readFileSync(env.storage.resolveKey(row.storageKey));
    expect(onDisk.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(onDisk.includes(Buffer.from('SPFAKE1'))).toBe(false);
    expect((await readEvidence(env.ctx, row))!.equals(jpeg)).toBe(true);
    // tampering is detected
    onDisk[onDisk.length - 1] ^= 0xff;
    await env.storage.put(row.storageKey, onDisk);
    await expect(readEvidence(env.ctx, row)).rejects.toThrow();

    // event arrives after its evidence
    await c.req('POST', '/api/candidate/events/batch', { events: [ev({ id: eventId, type: 'multiple_people' })] });
    const { loadEventDTO } = await import('../src/services/dto.js');
    const dto = await loadEventDTO(env.ctx.db, eventId);
    expect(dto!.evidence.map((e) => e.id)).toEqual([evidenceId]);
    expect(dto!.evidence[0].url).toBe(`/api/admin/evidence/${evidenceId}`);
    void s;
  });
});

describe('heartbeat, connectivity and clock', () => {
  it('times out to offline + reporting_interrupted; stops the clock when policy says so; recovers on return', async () => {
    const { s, c } = await freshSession({ connection: { disconnectTimerBehavior: 'stop', heartbeatTimeoutSec: 20 } });
    await startedSession(env, c);
    expect((await hb(c)).json()).toMatchObject({ status: 'active', timerRunning: true, commands: [] });
    const lastHb = env.clock.t;
    env.clock.advance(15_000);
    await sweepOnce(env.ctx);
    expect((await sessionRow(s.id)).connection).toBe('online');
    env.clock.advance(10_000);
    const r = await sweepOnce(env.ctx);
    expect(r.timedOut).toBe(1);
    let row = await sessionRow(s.id);
    expect(row.connection).toBe('offline');
    expect(row.runningSince).toBeNull();
    expect(row.reportingInterruptedSince!.getTime()).toBe(lastHb);
    const ri = (await eventsOf(s.id)).find((e) => e.type === 'reporting_interrupted')!;
    expect(ri.status).toBe('open');
    expect(ri.startedAt.getTime()).toBe(lastHb);
    const usedAtStop = row.usedMs;
    env.clock.advance(60_000);
    // Same (verified) browser returns: outage closes, clock restarts; buffered events keep their timestamps.
    const back = await hb(c);
    expect(back.json()).toMatchObject({ status: 'active', timerRunning: true });
    row = await sessionRow(s.id);
    expect(row.connection).toBe('online');
    expect(row.reportingInterruptedSince).toBeNull();
    expect(row.usedMs).toBe(usedAtStop);
    const closed = (await eventsOf(s.id)).find((e) => e.type === 'reporting_interrupted')!;
    expect(closed.status).toBe('closed');
    const buffered = ev({ type: 'tab_hidden', phase: 'close', startedAt: lastHb + 5_000, endedAt: lastHb + 9_000 });
    const br = await c.req('POST', '/api/candidate/events/batch', { events: [buffered] });
    expect(br.json().results[0].result).toBe('created');
    expect((await eventsOf(s.id)).find((e) => e.id === buffered.id)!.deliveredLate).toBe(true);
  });

  it('keeps the clock running during disconnects by default and reports outbox delays', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await hb(c);
    env.clock.advance(25_000);
    await sweepOnce(env.ctx);
    const row = await sessionRow(s.id);
    expect(row.connection).toBe('offline');
    expect(row.runningSince).not.toBeNull();
    const r = await hb(c, { outboxSize: 3, outboxOldestAt: env.clock.t - 40_000 });
    expect(r.statusCode).toBe(200);
    expect((await sessionRow(s.id)).reportingInterruptedSince!.getTime()).toBe(env.clock.t - 40_000);
    await hb(c, { outboxSize: 0, outboxOldestAt: null });
    expect((await sessionRow(s.id)).reportingInterruptedSince).toBeNull();
  });
});

describe('pause and resume', () => {
  it('pauses immediately (timer stop), marks the pause unobserved and resumes after a matching check', async () => {
    const { s, c } = await freshSession({ pause: { timerBehavior: 'stop' } });
    await startedSession(env, c);
    env.clock.advance(60_000);
    const p = await c.req('POST', '/api/candidate/pause', { reason: 'Doorbell' });
    expect(p.json()).toMatchObject({ outcome: 'paused', state: { session: { status: 'paused', timerRunning: false, requiredCheck: 'resume', pauseCount: 1 } } });
    expect(p.json().state.questions).toBeNull();
    const remainingAtPause = p.json().state.session.remainingMs;
    env.clock.advance(2 * 3600_000); // hours later, other browser
    const c2 = c.withInstance('resume-instance-0001');
    const st = (await c2.req('GET', '/api/candidate/session')).json();
    expect(st.session).toMatchObject({ status: 'paused', requiredCheck: 'resume', remainingMs: remainingAtPause });
    const { complete } = await runCheck(env, c2, 'resume', { device: { cameraLabel: 'USB Camera', cameraIdHash: 'cam-hash-b', userAgent: 'other', screen: { width: 1, height: 1, isExtended: false } } });
    expect(complete!.outcome).toBe('passed');
    expect(complete!.identity!.decision).toBe('match');
    expect(complete!.state.session).toMatchObject({ status: 'active', timerRunning: true, requiredCheck: null });
    expect(complete!.state.questions).toHaveLength(5);
    const periods = await periodsOf(s.id);
    expect(periods.map((x) => x.kind)).toEqual(['check_in', 'active', 'paused', 'resume_check', 'active']);
    expect(periods[2].observed).toBe(false);
    const types = (await eventsOf(s.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session_paused', 'unobserved_period', 'identity_verified', 'session_resumed', 'camera_changed']));
    const unobs = (await eventsOf(s.id)).find((e) => e.type === 'unobserved_period')!;
    expect(unobs.category).toBe('neutral');
    expect(unobs.endedAt!.getTime() - unobs.startedAt.getTime()).toBeGreaterThanOrEqual(2 * 3600_000);
    // old instance is superseded
    const old = await hb(c);
    expect(old.json().commands.map((x: { kind: string }) => x.kind)).toContain('superseded');
  });

  it('with timerBehavior continue the clock keeps running while paused', async () => {
    const { s, c } = await freshSession({ pause: { timerBehavior: 'continue' } });
    await startedSession(env, c);
    const before = (await c.req('GET', '/api/candidate/session')).json().session.remainingMs;
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(120_000);
    const st = (await c.req('GET', '/api/candidate/session')).json();
    expect(st.session.timerRunning).toBe(true);
    expect(st.session.remainingMs).toBe(before - 120_000);
    void s;
  });

  it('requires a reason / approval per policy; staff decisions reach the candidate via heartbeat', async () => {
    const { s, c } = await freshSession({ pause: { requireReason: true, requireApproval: true, maxPauses: 1 } });
    await startedSession(env, c);
    expect((await c.req('POST', '/api/candidate/pause', {})).statusCode).toBe(400);
    const r = await c.req('POST', '/api/candidate/pause', { reason: 'Need water' });
    expect(r.json()).toMatchObject({ outcome: 'pending_approval', state: { session: { status: 'active', pauseRequest: { status: 'pending', reason: 'Need water' } } } });
    const reqId = r.json().state.session.pauseRequest.id;
    expect((await eventsOf(s.id)).map((e) => e.type)).toContain('pause_requested');
    // deny
    await decidePauseRequest(env.ctx, s.id, reqId, false, { id: env.users.reviewer.id, orgId: env.org.id }, 'Please wait 10 min');
    let h = (await hb(c)).json();
    expect(h.commands).toEqual([{ kind: 'pause_denied', note: 'Please wait 10 min' }]);
    expect((await hb(c)).json().commands).toEqual([]); // delivered once
    // approve a second request
    const r2 = await c.req('POST', '/api/candidate/pause', { reason: 'Need water now' });
    await decidePauseRequest(env.ctx, s.id, r2.json().state.session.pauseRequest.id, true, env.users.reviewer.id);
    h = (await hb(c)).json();
    expect(h.status).toBe('paused');
    expect(h.commands).toEqual([{ kind: 'pause_approved' }]);
    const pausedEv = (await eventsOf(s.id)).find((e) => e.type === 'session_paused')!;
    expect(pausedEv.details).toMatchObject({ reason: 'Need water now', approvedBy: env.users.reviewer.id });
    // maxPauses reached after resume
    await runCheck(env, c, 'resume');
    const denied = (await c.req('POST', '/api/candidate/pause', { reason: 'again' })).json();
    expect(denied.outcome).toBe('denied');
  });

  it('cancels a pending request', async () => {
    const { s, c } = await freshSession({ pause: { requireApproval: true } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', { reason: 'x' });
    const st = (await c.req('POST', '/api/candidate/pause/cancel')).json();
    expect(st.session.pauseRequest.status).toBe('cancelled');
    void s;
  });

  it('holds for staff approval when the pause exceeded maxPauseDurationSec', async () => {
    const { s, c } = await freshSession({ pause: { maxPauseDurationSec: 600 } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(3600_000);
    const { complete } = await runCheck(env, c, 'resume');
    expect(complete!.outcome).toBe('held');
    expect(complete!.state.session.hold).toMatchObject({ reason: 'pause_limit', canReverify: false });
    expect(complete!.state.session.timerRunning).toBe(false);
    const row = await sessionRow(s.id);
    expect(row.status).toBe('on_hold');
  });
});

describe('expiry', () => {
  it('auto-submits when the clock runs out (sweeper), recording the exact expiry time', async () => {
    const { exam } = await env.newExam({ durationSec: 120 });
    const s = await env.newSession({ examId: exam.id });
    const c = env.candidateClient(s.token);
    await startedSession(env, c);
    const startedAt = env.clock.t;
    const q = env.questions; // answers for a different exam's questions are rejected
    expect((await c.req('PUT', `/api/candidate/answers/${q[0].id}`, { value: 'b', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(404);
    env.clock.advance(125_000);
    const r = await sweepOnce(env.ctx);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    const row = await sessionRow(s.id);
    expect(row).toMatchObject({ status: 'submitted', endReason: 'time_expired', usedMs: 120_000 });
    expect(row.endedAt!.getTime()).toBeLessThanOrEqual(startedAt + 120_000 + 1000);
    const types = (await eventsOf(s.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session_expired', 'session_submitted']));
    const h = (await hb(c)).json();
    expect(h.commands).toEqual([{ kind: 'submitted', reason: 'time_expired' }]);
    expect(row.score).not.toBeNull();
  });
});

describe('multiple instances / reconnect', () => {
  it('a second browser supersedes the first, must pass a reconnect check, and the gap is an unobserved disconnected period', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await hb(c);
    env.clock.advance(5_000);
    const c2 = c.withInstance('second-device-9999');
    const st = (await c2.req('GET', '/api/candidate/session')).json();
    expect(st.session.requiredCheck).toBe('reconnect');
    expect(st.questions).toBeNull();
    expect((await c2.req('PUT', `/api/candidate/answers/${env.questions[0].id}`, { value: 'a', clientSeq: 1, answeredAt: env.clock.t })).statusCode).toBe(409);
    const { complete } = await runCheck(env, c2, 'reconnect');
    expect(complete!.outcome).toBe('passed');
    expect(complete!.state.questions).toHaveLength(5);
    // same device: could be a reload, so nothing is recorded until the old window shows it is still open
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('multiple_instances');
    // the old instance: superseded on heartbeat, data rejected with 409 superseded
    const h = (await hb(c)).json();
    expect(h.commands.map((x: { kind: string }) => x.kind)).toEqual(['superseded']);
    const mi = (await eventsOf(s.id)).filter((e) => e.type === 'multiple_instances');
    expect(mi).toHaveLength(1);
    expect(mi[0].details).toMatchObject({ previousInstanceId: c.instanceId, newInstanceId: c2.instanceId });
    await hb(c);
    expect((await eventsOf(s.id)).filter((e) => e.type === 'multiple_instances')).toHaveLength(1);
    expect(h.requiredCheck).toBe('reconnect');
    const rej = await c.req('POST', '/api/candidate/events/batch', { events: [ev()] });
    expect(rej.statusCode).toBe(409);
    expect(rej.json().error).toBe('superseded');
    const kinds = (await periodsOf(s.id)).map((p) => p.kind);
    expect(kinds).toEqual(['check_in', 'active', 'disconnected', 'resume_check', 'active']);
    const row = await sessionRow(s.id);
    expect(row.verifiedInstanceId).toBe(c2.instanceId);
  });

  it('after a browser crash (heartbeat timeout) the reconnect closes reporting_interrupted', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await hb(c);
    env.clock.advance(60_000);
    await sweepOnce(env.ctx);
    const c2 = c.withInstance('after-crash-instance');
    const { complete } = await runCheck(env, c2, 'reconnect');
    expect(complete!.outcome).toBe('passed');
    const ri = (await eventsOf(s.id)).find((e) => e.type === 'reporting_interrupted')!;
    expect(ri.status).toBe('closed');
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('multiple_instances');
    const disc = (await periodsOf(s.id)).find((p) => p.kind === 'disconnected')!;
    expect(disc.endedAt!.getTime() - disc.startedAt.getTime()).toBeGreaterThanOrEqual(60_000);
    const row = await sessionRow(s.id);
    expect(row.connection).toBe('online');
    expect(row.reportingInterruptedSince).toBeNull();
  });
});

describe('periods & events consistency', () => {
  it('drops events of a session from another session id', async () => {
    const a = await freshSession();
    const b = await freshSession();
    await startedSession(env, a.c);
    await startedSession(env, b.c);
    const e = ev();
    await a.c.req('POST', '/api/candidate/events/batch', { events: [e] });
    const r = await b.c.req('POST', '/api/candidate/events/batch', { events: [{ ...e, version: 5 }] });
    expect(r.json().results[0]).toMatchObject({ result: 'rejected', reason: 'id_conflict' });
    const rows = await env.ctx.db.select().from(events).where(and(eq(events.id, e.id)));
    expect(rows[0].sessionId).toBe(a.s.id);
  });
});

describe('multiple instances on another device', () => {
  it('records multiple_instances immediately when a different device takes over a live session', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await hb(c);
    env.clock.advance(3_000);
    const phone = c.withInstance('phone-instance-0001');
    const { complete } = await runCheck(env, phone, 'reconnect', { device: { cameraLabel: 'Front Camera', cameraIdHash: 'cam-phone', userAgent: 'Mobile Safari', screen: { width: 390, height: 844, isExtended: false } } });
    expect(complete!.outcome).toBe('passed');
    const mi = (await eventsOf(s.id)).filter((e) => e.type === 'multiple_instances');
    expect(mi).toHaveLength(1);
    expect(mi[0]).toMatchObject({ category: 'integrity', details: { detectedBy: 'different_device', userAgent: 'Mobile Safari' } });
    await hb(c); // old window still open: no duplicate
    expect((await eventsOf(s.id)).filter((e) => e.type === 'multiple_instances')).toHaveLength(1);
  });
});

describe('late delivery across a pause', () => {
  it('accepts answers and identity samples captured before the pause, refuses later ones', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(30_000);
    const answeredBefore = env.clock.t - 5_000;
    const capturedBefore = env.clock.t - 4_000;
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(10_000);
    const q = env.questions[2].id;
    const ok = await c.req('PUT', `/api/candidate/answers/${q}`, { value: 'Paris', clientSeq: 1, answeredAt: answeredBefore });
    expect(ok.json()).toMatchObject({ applied: true });
    const tooLate = await c.req('PUT', `/api/candidate/answers/${q}`, { value: 'Lyon', clientSeq: 2, answeredAt: env.clock.t });
    expect(tooLate.statusCode).toBe(409);
    const smp = await c.jpeg('/api/candidate/identity/sample', { person: 'alice' }, { sampleId: randomUUID(), trigger: 'periodic', capturedAt: capturedBefore });
    expect(smp.statusCode, smp.body).toBe(200);
    expect(smp.json()).toMatchObject({ status: 'paused', result: { decision: 'match' } });
    const inside = await c.jpeg('/api/candidate/identity/sample', { person: 'alice' }, { sampleId: randomUUID(), trigger: 'periodic', capturedAt: env.clock.t });
    expect(inside.statusCode).toBe(409);
    void s;
  });
});
