/**
 * Regression tests for the requirements-audit fixes on the identity side:
 *  P0-1 stale re-enrolment authorisation, P1-2 re-enrolment with liveness off, P1-4 report context for
 *  pause/reconnect mismatches, P2-3 ID-photo "could not verify" hold, P2-4 check-in observation with
 *  liveness off, P2-5 failed liveness that still shows a different person.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates, events, examSessions, identityReferences } from '../src/db/schema.js';
import { loadEventDTO } from '../src/services/dto.js';
import { idPhotoAad } from '../src/services/identity-common.js';
import { buildIdentityComparison } from '../src/services/reports-identity.js';
import { buildSessionReport } from '../src/services/reports.js';
import { holdSession, releaseHold } from '../src/services/session-actions.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { serializeEmbeddings } from '../src/vision/index.js';
import { consent, hb, runCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';
import { clientEvent } from './admin/fixtures.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const MIN = 60_000;
async function freshSession(policy?: Record<string, unknown>, candidateId?: string) {
  const examId = policy ? (await env.newExam({ policy })).exam.id : env.exam.id;
  const s = await env.newSession({ examId, candidateId });
  return { s, c: env.candidateClient(s.token) };
}
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt, events.firstReceivedAt);
const refsOf = async (id: string) => env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, id)).orderBy(identityReferences.version);
const actor = () => ({ id: env.users.admin.id, orgId: env.org.id });

describe('P0-1: a re-enrolment authorisation cannot outlive the hold it was given for', () => {
  it('repro: release reEnroll -> release again without check -> pause -> a different person resumes => mismatch, reference unchanged', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(MIN);
    await holdSession(env.ctx, s.id, actor(), 'checking');
    await releaseHold(env.ctx, s.id, actor(), { reEnroll: true, note: 'will re-enrol' });
    expect(await sessionRow(s.id)).toMatchObject({ status: 'on_hold', holdCanReverify: true, reEnrollAuthorized: true });
    // Staff change their mind and let the exam continue without any check: the authorisation is revoked.
    const rel = await releaseHold(env.ctx, s.id, actor(), { requireCheck: false });
    expect(rel.status).toBe('active');
    expect(await sessionRow(s.id)).toMatchObject({ reEnrollAuthorized: false, reEnrollAuthorizedBy: null });
    env.clock.advance(MIN);
    expect((await c.req('POST', '/api/candidate/pause', {})).json().outcome).toBe('paused');
    env.clock.advance(10 * MIN);
    const { start, complete } = await runCheck(env, c, 'resume', { spec: { person: 'impostor-p01' } });
    expect(start.frontalFramesRequired).toBe(3); // a comparison (resume), not an enrolment
    expect(complete!.outcome).toBe('held');
    expect(complete!.identity!.decision).toBe('mismatch');
    expect(complete!.state.session.hold!.reason).toBe('identity_mismatch');
    expect(await refsOf(s.id)).toHaveLength(1);
    const mm = (await eventsOf(s.id)).filter((e) => e.type === 'identity_mismatch');
    expect(mm).toHaveLength(1);
    expect(mm[0].details).toMatchObject({ purpose: 'resume', against: 'reference' });
  });

  it('a stale flag on the row is never honoured by resume / reconnect checks', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    // Simulate a flag left behind by any other path.
    await env.ctx.db.update(examSessions).set({ reEnrollAuthorized: true, reEnrollAuthorizedBy: env.users.admin.id }).where(eq(examSessions.id, s.id));
    await c.req('POST', '/api/candidate/pause', {});
    const { complete } = await runCheck(env, c, 'resume', { spec: { person: 'impostor-p01b' } });
    expect(complete!.outcome).toBe('held');
    expect(await refsOf(s.id)).toHaveLength(1);
    // reconnect: a new browser with a different person while active (flag still set on the row)
    const t = await freshSession();
    await startedSession(env, t.c);
    await env.ctx.db.update(examSessions).set({ reEnrollAuthorized: true, reEnrollAuthorizedBy: env.users.admin.id }).where(eq(examSessions.id, t.s.id));
    const other = t.c.withInstance(`inst-reconnect-${Date.now()}`);
    const rc = await runCheck(env, other, 'reconnect', { spec: { person: 'impostor-p01c' } });
    expect(rc.complete!.outcome).toBe('held');
    expect(await refsOf(t.s.id)).toHaveLength(1);
  });

  it('a new hold revokes an earlier re-enrolment authorisation', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await holdSession(env.ctx, s.id, actor());
    await releaseHold(env.ctx, s.id, actor(), { reEnroll: true });
    expect((await sessionRow(s.id)).reEnrollAuthorized).toBe(true);
    await holdSession(env.ctx, s.id, actor(), 'second thoughts');
    expect(await sessionRow(s.id)).toMatchObject({ reEnrollAuthorized: false, reEnrollAuthorizedBy: null, holdCanReverify: false });
  });

  it('an authorised re-enrolment of a person who does not match the old reference still records identity_mismatch (before/after images)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(5 * MIN);
    await runCheck(env, c, 'resume', { spec: { person: 'reenrol-new' } });
    expect((await sessionRow(s.id)).status).toBe('on_hold');
    env.clock.advance(3 * MIN);
    await releaseHold(env.ctx, s.id, actor(), { reEnroll: true, note: 'Verified by video call' });
    env.clock.advance(MIN);
    const { start, complete } = await runCheck(env, c, 'reverify', { spec: { person: 'reenrol-new' } });
    expect(start.frontalFramesRequired).toBe(5); // an authorised re-enrolment builds a gallery
    expect(complete!.outcome).toBe('passed');
    const refs = await refsOf(s.id);
    expect(refs).toHaveLength(2);
    expect(refs[1]).toMatchObject({ active: true, authorizedBy: env.users.admin.id });
    const mm = (await eventsOf(s.id)).filter((e) => e.type === 'identity_mismatch');
    expect(mm).toHaveLength(2); // the resume observation and the one at the re-enrolment
    const re = mm.find((e) => e.details.reEnrolled === true)!;
    expect(re).toBeDefined();
    expect(re).toMatchObject({ category: 'integrity', status: 'closed', source: 'server_identity' });
    expect(re.details).toMatchObject({ purpose: 'reverify', against: 'reference', referenceId: refs[0].id, newReferenceId: refs[1].id, authorizedBy: env.users.admin.id });
    expect(re.context).toMatchObject({ reEnrolled: true, trigger: 'reverify' });
    const dto = (await loadEventDTO(env.ctx.db, re.id))!;
    expect(dto.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe', 'identity_reference']));
    // The comparison view shows the reference that was in force (the original one), not the new one.
    const cmp = await buildIdentityComparison(env.ctx, env.org.id, re.id);
    expect(cmp.reference.purpose).toMatch(/^check-in reference; later replaced/);
    expect(cmp.probes.some((p) => p.check.decision === 'mismatch' && p.image != null)).toBe(true);
    const created = (await eventsOf(s.id)).filter((e) => e.type === 'reference_created').pop()!;
    expect(created.details).toMatchObject({ reEnrollment: true, decisionAgainstPrevious: 'mismatch', mismatchEventId: re.id });
    // Flag consumed; the session continues with the new reference.
    expect(await sessionRow(s.id)).toMatchObject({ status: 'active', reEnrollAuthorized: false });
    const report = await buildSessionReport(env.ctx, s.id, env.org.id);
    expect(report.identity.summary).toMatch(/At the re-enrolment authorised by an administrator at \d\d:\d\d UTC, the person enrolled did not match the previous identity reference/);
  });
});

describe('P1-2: authorised re-enrolment works with the liveness check turned off', () => {
  it('asks for enrolment frontal frames (5) and builds the new reference', async () => {
    const { s, c } = await freshSession({ identity: { liveness: 'off' } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const r1 = await runCheck(env, c, 'resume', { spec: { person: 'alice-glasses-off' } });
    expect(r1.start.liveness).toBeNull();
    expect(r1.start.frontalFramesRequired).toBe(3);
    expect(r1.complete!.outcome).toBe('held');
    await releaseHold(env.ctx, s.id, actor(), { reEnroll: true });
    const r2 = await runCheck(env, c, 'reverify', { spec: { person: 'alice-glasses-off' } });
    expect(r2.start.liveness).toBeNull();
    expect(r2.start.frontalFramesRequired).toBe(5);
    expect(r2.complete!.outcome, JSON.stringify(r2.complete)).toBe('passed');
    expect(await refsOf(s.id)).toHaveLength(2);
    // A reverify WITHOUT re-enrolment only compares (2 frames).
    await holdSession(env.ctx, s.id, actor());
    await releaseHold(env.ctx, s.id, actor(), { requireCheck: true });
    const r3 = await runCheck(env, c, 'reverify', { spec: { person: 'alice-glasses-off' } });
    expect(r3.start.frontalFramesRequired).toBe(3);
    expect(r3.complete!.outcome).toBe('passed');
  });
});

describe('P2-5: a failed liveness challenge still reports a clearly different person', () => {
  it('hold_for_review: identity_mismatch with before/after images, exam held', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(4 * MIN);
    const { complete } = await runCheck(env, c, 'resume', { spec: { person: 'impostor-p25' }, wrongTurns: true });
    expect(complete!.liveness!.passed).toBe(false);
    expect(complete!.outcome).toBe('held');
    expect(complete!.state.session.hold!.reason).toBe('identity_mismatch');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ purpose: 'resume', livenessPassed: false, against: 'reference' });
    const dto = (await loadEventDTO(env.ctx.db, mm.id))!;
    expect(dto.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe', 'identity_reference']));
  });

  it('flag_only: the observation is recorded and the live-person check must be repeated', async () => {
    const { s, c } = await freshSession({ identity: { onMismatch: 'flag_only' } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const { complete } = await runCheck(env, c, 'resume', { spec: { person: 'impostor-p25b' }, wrongTurns: true });
    expect(complete!.outcome).toBe('retry');
    expect((await eventsOf(s.id)).filter((e) => e.type === 'identity_mismatch')).toHaveLength(1);
    expect((await sessionRow(s.id)).status).toBe('paused');
  });

  it('the same person failing liveness is only asked to retry (no mismatch)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const { complete } = await runCheck(env, c, 'resume', { wrongTurns: true });
    expect(complete!.outcome).toBe('retry');
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
  });
});

describe('P2-3 / P2-4: check-in outcomes are described accurately', () => {
  it("required ID photo: an inconclusive comparison holds as 'id_photo_unverifiable' (not a mismatch)", async () => {
    const cand = await env.newCandidate('Unclear Photo');
    await env.ctx.db
      .update(candidates)
      .set({ idPhotoEmbedding: env.ctx.keyring.encrypt(serializeEmbeddings([FakeVisionService.embeddingFor('photo-p23')]), idPhotoAad(cand.id)), idPhotoApprovedAt: new Date(env.clock.t) })
      .where(eq(candidates.id, cand.id));
    const { s, c } = await freshSession({ identity: { idPhotoComparison: 'required' } }, cand.id);
    await consent(c);
    // Same person, but the comparison lands in the grey zone (e.g. an old photo / poor light).
    const r = await runCheck(env, c, 'initial', { spec: { person: 'photo-p23', similarity: 0.33 } });
    expect(r.complete!.idPhoto!.decision).toBe('inconclusive');
    expect(r.complete!.outcome).toBe('held');
    const hold = r.complete!.state.session.hold!;
    expect(hold.reason).toBe('id_photo_unverifiable');
    expect(hold.message).toMatch(/not a finding that you are a different person/);
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
    const report = await buildSessionReport(env.ctx, s.id, env.org.id);
    expect(report.observations.join('\n')).toMatch(/could not be compared dependably with the approved ID photo \(not evidence of a different person\)/);
  });

  it('checkin_completed says the live-person check is disabled when liveness is off', async () => {
    const off = await freshSession({ identity: { liveness: 'off' } });
    await startedSession(env, off.c);
    const evOff = (await eventsOf(off.s.id)).find((e) => e.type === 'checkin_completed')!;
    expect(evOff.observation).toBe('The camera readiness check was completed; the live-person check is disabled by the exam rules.');
    const on = await freshSession();
    await startedSession(env, on.c);
    const evOn = (await eventsOf(on.s.id)).find((e) => e.type === 'checkin_completed')!;
    expect(evOn.observation).toBe('The camera readiness and live-person checks were completed.');
  });
});

describe('P1-4: the report places a mismatch in its pause / reconnect context', () => {
  it('failed resume (held): "at the resume check after the pause", not an older multiple-people event or a bare time', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    env.clock.advance(5 * MIN);
    await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 40_000, endedAt: env.clock.t - 30_000, confidence: 0.9 });
    const pausedAt = env.clock.t;
    await c.req('POST', '/api/candidate/pause', { reason: 'break' });
    env.clock.advance(2 * MIN);
    expect((await runCheck(env, c, 'resume', { spec: { person: 'impostor-p14' } })).complete!.outcome).toBe('held');
    const report = await buildSessionReport(env.ctx, s.id, env.org.id);
    expect(report.identity.summary).toMatch(/^A different face may have appeared at the resume check after the pause that began at \d\d:\d\d UTC; this was held for review\.$/);
    expect(report.identity.summary).toContain(new Date(pausedAt).toISOString().slice(11, 16));
    expect(report.identity.summary).not.toMatch(/more than one person/);
  });

  it('flag_only resume and reconnect mismatches are described by their own check', async () => {
    const f = await freshSession({ identity: { onMismatch: 'flag_only' } });
    await startedSession(env, f.c);
    env.clock.advance(3 * MIN);
    await f.c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(MIN);
    expect((await runCheck(env, f.c, 'resume', { spec: { person: 'impostor-p14b' } })).complete!.outcome).toBe('passed');
    const rf = await buildSessionReport(env.ctx, f.s.id, env.org.id);
    expect(rf.identity.summary).toMatch(/^A different face may have appeared at the resume check after the pause that began at \d\d:\d\d UTC; this was flagged for review\.$/);

    const r = await freshSession();
    await startedSession(env, r.c);
    env.clock.advance(2 * MIN);
    await hb(r.c);
    env.clock.advance(3 * MIN); // browser gone for 3 minutes
    const other = r.c.withInstance(`inst-p14-${Date.now()}`);
    expect((await runCheck(env, other, 'reconnect', { spec: { person: 'impostor-p14c' } })).complete!.outcome).toBe('held');
    const rr = await buildSessionReport(env.ctx, r.s.id, env.org.id);
    expect(rr.identity.summary).toMatch(/^A different face may have appeared when the exam was reopened at \d\d:\d\d UTC; this was held for review\.$/);
  });
});

