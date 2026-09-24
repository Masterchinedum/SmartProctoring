import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates, events, evidence, examSessions, identityChecks, identityReferences, sessionPeriods } from '../src/db/schema.js';
import { loadEventDTO, loadSessionSummary } from '../src/services/dto.js';
import { idPhotoAad } from '../src/services/identity-common.js';
import { extendSessionTime, holdSession, releaseHold, staffSubmit, terminateSession } from '../src/services/session-actions.js';
import { serializeEmbeddings } from '../src/vision/index.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { consent, hb, runCheck, sample, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

async function freshSession(policy?: Record<string, unknown>, candidateId?: string) {
  const examId = policy ? (await env.newExam({ policy })).exam.id : env.exam.id;
  const s = await env.newSession({ examId, candidateId });
  return { s, c: env.candidateClient(s.token) };
}
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt);
const actor = () => ({ id: env.users.admin.id, orgId: env.org.id });

describe('initial check', () => {
  it('rejects a failed liveness challenge (no head movement) and asks to retry', async () => {
    const { s, c } = await freshSession();
    await consent(c);
    const { complete } = await runCheck(env, c, 'initial', { wrongTurns: true });
    expect(complete!.outcome).toBe('retry');
    expect(complete!.liveness!.passed).toBe(false);
    expect(complete!.attemptsRemaining).toBe(4);
    expect(complete!.state.session).toMatchObject({ status: 'invited', requiredCheck: 'initial' });
    const refs = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, s.id));
    expect(refs).toHaveLength(0);
    // a subsequent good attempt passes
    const ok = await runCheck(env, c, 'initial');
    expect(ok.complete!.outcome).toBe('passed');
  });

  it('holds as identity_unverifiable after maxVerificationAttempts poor-quality attempts (quality-only attempts count half)', async () => {
    const { s, c } = await freshSession({ identity: { maxVerificationAttempts: 2 } });
    await consent(c);
    const dark = { person: 'alice', usable: false, issues: ['too_dark'] as const };
    // Image quality alone: lighting guidance and more tries (each counts QUALITY_RETRY_WEIGHT) before human review.
    for (const remaining of [2, 1, 1]) {
      const r = await runCheck(env, c, 'initial', { spec: { ...dark, issues: ['too_dark'] } });
      expect(r.complete!.outcome).toBe('retry');
      expect(r.complete!.attemptsRemaining).toBe(remaining);
      expect(r.complete!.guidance.join(' ')).toMatch(/dark/i);
    }
    const r2 = await runCheck(env, c, 'initial', { spec: { ...dark, issues: ['too_dark'] } });
    expect(r2.complete!.outcome).toBe('held');
    expect(r2.complete!.state.session.hold).toMatchObject({ reason: 'identity_unverifiable', canReverify: false });
    const evs = await eventsOf(s.id);
    const unv = evs.find((e) => e.type === 'identity_unverifiable')!;
    expect(unv.category).toBe('uncertain');
    expect(evs.map((e) => e.type)).not.toContain('identity_mismatch');
    // staff release (no reference yet) returns the candidate to the initial check
    await releaseHold(env.ctx, s.id, actor(), { note: 'Called candidate; lighting fixed' });
    const st = (await c.req('GET', '/api/candidate/session')).json();
    expect(st.session).toMatchObject({ status: 'invited', requiredCheck: 'initial' });
    const ok = await runCheck(env, c, 'initial');
    expect(ok.complete!.outcome).toBe('passed');
  });

  it('compares with the approved ID photo (advisory: flags a mismatch, required: holds)', async () => {
    const photoCand = await env.newCandidate('Photo Person');
    await env.ctx.db
      .update(candidates)
      .set({ idPhotoEmbedding: env.ctx.keyring.encrypt(serializeEmbeddings([FakeVisionService.embeddingFor('photo-owner')]), idPhotoAad(photoCand.id)), idPhotoApprovedAt: new Date(env.clock.t) })
      .where(eq(candidates.id, photoCand.id));
    // advisory: the live person is someone else -> neutral id_photo_compared + identity_mismatch (against id_photo), continues
    const a = await freshSession({ identity: { idPhotoComparison: 'advisory' } }, photoCand.id);
    await consent(a.c);
    const ra = await runCheck(env, a.c, 'initial', { spec: { person: 'someone-else' } });
    expect(ra.complete!.outcome).toBe('passed');
    expect(ra.complete!.idPhoto).toMatchObject({ decision: 'mismatch' });
    const evA = await eventsOf(a.s.id);
    expect(evA.find((e) => e.type === 'id_photo_compared')!.details).toMatchObject({ decision: 'mismatch' });
    const mm = evA.find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ against: 'id_photo' });
    // required: match passes, mismatch holds
    const b = await freshSession({ identity: { idPhotoComparison: 'required' } }, photoCand.id);
    await consent(b.c);
    const rb = await runCheck(env, b.c, 'initial', { spec: { person: 'someone-else' } });
    expect(rb.complete!.outcome).toBe('held');
    expect(rb.complete!.state.session.hold!.reason).toBe('id_photo_mismatch');
    const d = await freshSession({ identity: { idPhotoComparison: 'required' } }, photoCand.id);
    await consent(d.c);
    const rd = await runCheck(env, d.c, 'initial', { spec: { person: 'photo-owner' } });
    expect(rd.complete!.outcome).toBe('passed');
    expect(rd.complete!.idPhoto!.decision).toBe('match');
    // release of an id-photo hold (reference exists) without a fresh check -> ready
    await releaseHold(env.ctx, b.s.id, actor(), { requireCheck: false });
    expect((await sessionRow(b.s.id)).status).toBe('ready');
  });

  it('rejects frames with a wrong nonce and expired checks', async () => {
    const { c } = await freshSession();
    await consent(c);
    const r = await runCheck(env, c, 'initial', { noComplete: true });
    const url = `/api/candidate/checks/${r.start.checkId}/frames`;
    expect((await c.jpeg(url, { person: 'alice' }, { step: 'frontal', capturedAt: env.clock.t, nonce: 'wrong' })).statusCode).toBe(400);
    env.clock.advance(4 * 60_000);
    expect((await c.jpeg(url, { person: 'alice' }, { step: 'frontal', capturedAt: env.clock.t, nonce: r.start.liveness!.nonce })).statusCode).toBe(410);
    const done = await c.req('POST', `/api/candidate/checks/${r.start.checkId}/complete`);
    expect(done.statusCode).toBe(409);
  });
});

describe('resume identity comparison', () => {
  it('different person after a pause => identity_mismatch with before/after evidence and context, exam on hold (clock stopped)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(60_000);
    await c.req('POST', '/api/candidate/pause', { reason: 'break' });
    env.clock.advance(20 * 60_000);
    const { complete } = await runCheck(env, c, 'resume', { spec: { person: 'mallory' } });
    expect(complete!.outcome).toBe('held');
    expect(complete!.identity!.decision).toBe('mismatch');
    expect(complete!.state.session.hold).toMatchObject({ reason: 'identity_mismatch' });
    expect(complete!.state.session.timerRunning).toBe(false);
    expect(complete!.state.questions).toBeNull();
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm).toMatchObject({ category: 'integrity', severity: 'high', source: 'server_identity' });
    expect(mm.observation).toMatch(/may have appeared after the pause/);
    expect(mm.context).toMatchObject({ precededBy: expect.arrayContaining(['pause']), pauseDurationMs: 20 * 60_000 });
    const dto = (await loadEventDTO(env.ctx.db, mm.id))!;
    const kinds = dto.evidence.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['identity_probe', 'identity_reference']));
    const periods = await env.ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, s.id)).orderBy(sessionPeriods.startedAt);
    expect(periods.map((p) => p.kind)).toEqual(['check_in', 'active', 'paused', 'resume_check', 'on_hold']);
    // The candidate cannot continue on their own
    expect((await c.req('POST', '/api/candidate/checks', { purpose: 'reverify', clientInstanceId: c.instanceId, device: {} })).statusCode).toBe(409);
    const h = (await hb(c)).json();
    expect(h.commands.map((x: { kind: string }) => x.kind)).toContain('hold');
  });

  it('unable to verify on resume => retry with guidance (never a mismatch), then hold after the attempt limit', async () => {
    const { s, c } = await freshSession({ identity: { maxVerificationAttempts: 2 } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const blurry = { person: 'alice', usable: false, issues: ['blurry' as const] };
    for (let i = 0; i < 3; i++) {
      const r1 = await runCheck(env, c, 'resume', { spec: blurry });
      expect(r1.complete!.outcome).toBe('retry');
      expect(r1.complete!.identity!.decision).toBe('unable_to_verify');
      expect(r1.complete!.guidance.join(' ')).toMatch(/blurry/i);
    }
    const r2 = await runCheck(env, c, 'resume', { spec: blurry });
    expect(r2.complete!.outcome).toBe('held');
    expect(r2.complete!.state.session.hold!.reason).toBe('identity_unverifiable');
    const types = (await eventsOf(s.id)).map((e) => e.type);
    expect(types).toContain('identity_unverifiable');
    expect(types).not.toContain('identity_mismatch');
  });

  it('flag_only policy records the mismatch and lets the exam continue', async () => {
    const { s, c } = await freshSession({ identity: { onMismatch: 'flag_only' } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const { complete } = await runCheck(env, c, 'resume', { spec: { person: 'mallory' } });
    expect(complete!.outcome).toBe('passed');
    expect(complete!.state.session.status).toBe('active');
    expect((await eventsOf(s.id)).map((e) => e.type)).toContain('identity_mismatch');
  });

  it('staff release with a required check and authorised re-enrolment creates a new reference (old kept, audited)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    await runCheck(env, c, 'resume', { spec: { person: 'alice-new-look' } });
    expect((await sessionRow(s.id)).status).toBe('on_hold');
    const sum = await releaseHold(env.ctx, s.id, actor(), { requireCheck: true, reEnroll: true, note: 'Verified by video call' });
    expect(sum.hold).toMatchObject({ canReverify: true });
    const h = (await hb(c)).json();
    expect(h.commands.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['hold_released', 'require_check']));
    expect(h.requiredCheck).toBe('reverify');
    const { complete } = await runCheck(env, c, 'reverify', { spec: { person: 'alice-new-look' } });
    expect(complete!.outcome).toBe('passed');
    expect(complete!.state.session.status).toBe('active');
    const refs = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, s.id)).orderBy(identityReferences.version);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ active: false, supersededReason: 're_enrollment_authorized', supersededBy: env.users.admin.id });
    expect(refs[1]).toMatchObject({ active: true, authorizedBy: env.users.admin.id });
    // new reference is used afterwards
    env.clock.advance(30_000);
    const r = (await sample(env, c, { person: 'alice-new-look' })).json();
    expect(r.result.decision).toBe('match');
    const types = (await eventsOf(s.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['hold_released', 'reference_created']));
  });

  it('without re-enrolment the reference is immutable: a reverify with the new face is still a mismatch', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    await runCheck(env, c, 'resume', { spec: { person: 'bob' } });
    await releaseHold(env.ctx, s.id, actor(), { requireCheck: true });
    const { complete } = await runCheck(env, c, 'reverify', { spec: { person: 'bob' } });
    expect(complete!.outcome).toBe('held');
    const refs = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, s.id));
    expect(refs).toHaveLength(1);
    // and the original person passes the reverify
    await releaseHold(env.ctx, s.id, actor(), { requireCheck: true });
    const ok = await runCheck(env, c, 'reverify', { spec: { person: 'alice' } });
    expect(ok.complete!.outcome).toBe('passed');
    expect(ok.complete!.state.session.status).toBe('active');
    expect(ok.complete!.state.session.timerRunning).toBe(true);
  });
});

describe('mid-exam identity samples', () => {
  it('one mismatch asks for a follow-up; the second confirms => identity_mismatch (open) + hold', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(30_000);
    const m1 = (await sample(env, c, { person: 'mallory' }, 'face_return')).json();
    expect(m1.result.decision).toBe('mismatch');
    expect(m1.followUpInMs).toBeGreaterThan(0);
    expect(m1.status).toBe('active');
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
    env.clock.advance(4_000);
    const m2 = (await sample(env, c, { person: 'mallory' }, 'follow_up')).json();
    expect(m2.status).toBe('on_hold');
    expect(m2.hold.reason).toBe('identity_mismatch');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.observation).toMatch(/left and returned/);
    expect(mm.details).toMatchObject({ samples: 2, against: 'reference' });
    expect(mm.context).toMatchObject({ precededBy: expect.arrayContaining(['face_absence']) });
    const dto = (await loadEventDTO(env.ctx.db, mm.id))!;
    expect(dto.evidence.filter((e) => e.kind === 'identity_probe').length).toBeGreaterThanOrEqual(2);
    expect(dto.evidence.some((e) => e.kind === 'identity_reference')).toBe(true);
    // idempotent replay
    const again = await c.jpeg('/api/candidate/identity/sample', { person: 'alice' }, { sampleId: m1.result.id ? (await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.id, m1.result.id)))[0].sampleId! : '', trigger: 'periodic', capturedAt: env.clock.t });
    expect(again.json().result.id).toBe(m1.result.id);
    const sum = (await loadSessionSummary(env.ctx, env.ctx.db, s.id))!;
    expect(sum.identity.lastDecision).toBe('mismatch');
    expect(sum.counts.integrity).toBeGreaterThanOrEqual(1);
  });

  it('flag_only: event stays open while mismatches continue and closes after two matches', async () => {
    const { s, c } = await freshSession({ identity: { onMismatch: 'flag_only' } });
    await startedSession(env, c);
    for (let i = 0; i < 3; i++) {
      env.clock.advance(5_000);
      await sample(env, c, { person: 'mallory' });
    }
    let mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.status).toBe('open');
    expect(mm.details).toMatchObject({ samples: 3 });
    env.clock.advance(5_000);
    const one = (await sample(env, c, { person: 'alice' })).json();
    expect(one.followUpInMs).toBeGreaterThan(0);
    mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.status).toBe('open');
    env.clock.advance(5_000);
    await sample(env, c, { person: 'alice' });
    mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.status).toBe('closed');
    expect((await sessionRow(s.id)).status).toBe('active');
  });

  it('unable-to-verify streak => identity_unverifiable (uncertain, never mismatch), closed by the next match', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    const dark = { person: 'alice', usable: false, issues: ['too_dark' as const] };
    for (let i = 0; i < 3; i++) {
      env.clock.advance(10_000);
      const r = (await sample(env, c, dark)).json();
      expect(r.result.decision).toBe('unable_to_verify');
      expect(r.result.guidance.join(' ')).toMatch(/dark/i);
    }
    // grey zone counts as uncertain too
    env.clock.advance(10_000);
    expect((await sample(env, c, { person: 'alice', similarity: 0.33 })).json().result.decision).toBe('inconclusive');
    let evs = await eventsOf(s.id);
    const unv = evs.find((e) => e.type === 'identity_unverifiable')!;
    expect(unv).toMatchObject({ category: 'uncertain', status: 'open' });
    expect(evs.map((e) => e.type)).not.toContain('identity_mismatch');
    expect((await sessionRow(s.id)).status).toBe('active');
    env.clock.advance(10_000);
    await sample(env, c, { person: 'alice' });
    evs = await eventsOf(s.id);
    expect(evs.find((e) => e.type === 'identity_unverifiable')!.status).toBe('closed');
  });

  it('identical frames across samples => camera_feed_suspect (server_identity)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    for (let i = 0; i < 3; i++) {
      env.clock.advance(30_000);
      await sample(env, c, { person: 'alice', dhash: 'abcdefabcdef0123' });
    }
    const sus = (await eventsOf(s.id)).find((e) => e.type === 'camera_feed_suspect')!;
    expect(sus).toMatchObject({ source: 'server_identity', status: 'open' });
    expect(sus.details).toMatchObject({ signal: 'identical_identity_samples' });
    env.clock.advance(30_000);
    await sample(env, c, { person: 'alice' });
    expect((await eventsOf(s.id)).find((e) => e.type === 'camera_feed_suspect')!.status).toBe('closed');
  });

  it('stores probe images only for non-matching samples by default', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(30_000);
    await sample(env, c, { person: 'alice' });
    const probes = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, s.id), eq(evidence.kind, 'identity_probe')));
    expect(probes).toHaveLength(0);
    env.clock.advance(30_000);
    await sample(env, c, { person: 'alice', usable: false, issues: ['blurry'] });
    const probes2 = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, s.id), eq(evidence.kind, 'identity_probe')));
    expect(probes2.length).toBeGreaterThan(0);
  });

  it('samples from a superseded instance are refused; samples outside an active exam are refused', async () => {
    const { s, c } = await freshSession();
    await consent(c);
    expect((await sample(env, c, { person: 'alice' })).statusCode).toBe(409);
    await runCheck(env, c, 'initial');
    await c.req('POST', '/api/candidate/start');
    const other = c.withInstance('intruder-instance-01');
    expect((await sample(env, other, { person: 'alice' })).statusCode).toBe(409);
    void s;
  });
});

describe('staff session actions', () => {
  it('manual hold / release without check / extend / staff submit / terminate', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    const held = await holdSession(env.ctx, s.id, { id: env.users.reviewer.id, orgId: env.org.id }, 'Checking something');
    expect(held).toMatchObject({ status: 'on_hold', timerRunning: false, hold: { reason: 'staff' } });
    await expect(holdSession(env.ctx, s.id, { id: env.users.reviewer.id, orgId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
    const rel = await releaseHold(env.ctx, s.id, actor(), { requireCheck: false });
    expect(rel).toMatchObject({ status: 'active', timerRunning: true, hold: null });
    // the same browser continues without a check
    expect((await c.req('GET', '/api/candidate/session')).json().session.requiredCheck).toBeNull();
    const before = rel.remainingMs;
    const ext = await extendSessionTime(env.ctx, s.id, 15, env.users.admin.id, 'Accommodation');
    expect(ext.remainingMs).toBe(before + 15 * 60_000);
    expect((await eventsOf(s.id)).find((e) => e.type === 'time_extended')!.details).toMatchObject({ minutes: 15, note: 'Accommodation' });
    const sub = await staffSubmit(env.ctx, s.id, actor(), 'Candidate asked by phone');
    expect(sub).toMatchObject({ status: 'submitted', endReason: 'staff_submitted' });
    const cmds = (await hb(c)).json().commands;
    expect(cmds.map((x: { kind: string }) => x.kind)).toEqual(['hold', 'hold_released', 'submitted']);
    expect(cmds[2]).toEqual({ kind: 'submitted', reason: 'staff_submitted' });
    const t = await freshSession();
    await startedSession(env, t.c);
    const term = await terminateSession(env.ctx, t.s.id, actor(), 'Rules violation confirmed by reviewer');
    expect(term).toMatchObject({ status: 'terminated', endReason: 'staff_terminated' });
    expect((await hb(t.c)).json().commands[0]).toMatchObject({ kind: 'terminated' });
  });
});

describe('realtime', () => {
  it('publishes events and throttled session summaries to the org channel', async () => {
    const got: { type: string }[] = [];
    const off = env.ctx.bus.subscribe(env.org.id, (m) => got.push(m));
    const { c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/events/batch', { events: [{ id: randomUUID(), type: 'phone_detected', phase: 'open', startedAt: env.clock.t, endedAt: null, confidence: 0.9, details: {}, version: 1 }] });
    await new Promise((r) => setTimeout(r, 1500));
    off();
    const types = new Set(got.map((m) => m.type));
    expect(types.has('event')).toBe(true);
    expect(types.has('session')).toBe(true);
    const phone = got.find((m) => m.type === 'event' && (m as unknown as { event: { type: string } }).event.type === 'phone_detected') as unknown as { candidateName: string; examTitle: string };
    expect(phone.candidateName).toBe('Alice Candidate');
    expect(phone.examTitle).toBeTruthy();
  });

  it('serves the WebSocket only to logged-in staff', async () => {
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = env.app.server.address() as { port: number };
    const { WebSocket } = await import('ws');
    const unauth = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/admin/live`);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
    });
    expect(unauth).toBe(401);
    const cookie = await env.login('reviewer');
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/api/admin/live`, { headers: { cookie } });
      ws.on('message', (d) => {
        resolve(JSON.parse(String(d)));
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(first.type).toBe('hello');
  });
});
