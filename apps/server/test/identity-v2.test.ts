/**
 * Identity engine v2 (integration, FakeVisionService): adaptive checks with progress, enrolment gallery + baseline,
 * exam-start sampling and server-driven cadence, bursts, the evidence accumulator on real requests, new triggers,
 * and the staff identity self-test endpoint.
 */
import { randomUUID } from 'node:crypto';
import type { CheckFrameResponse, CompleteCheckResponse, HeartbeatResponse, IdentitySampleResponse, IdentityTestResponse, StartCheckResponse } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, events, evidence, examSessions, identityChecks, identityReferences, identitySampleFrames } from '../src/db/schema.js';
import { sweepOnce } from '../src/jobs/sweeper.js';
import { loadEventDTO } from '../src/services/dto.js';
import { buildIdentityComparison } from '../src/services/reports-identity.js';
import { SELFTEST_TTL_MS } from '../src/services/identity-selftest.js';
import { CALIBRATION } from '../src/vision/index.js';
import { json, staffApi } from './admin/fixtures.js';
import { burst, consent, hb, runCheck, sample, startCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

async function freshSession(policy?: Record<string, unknown>) {
  const examId = policy ? (await env.newExam({ policy })).exam.id : env.exam.id;
  const s = await env.newSession({ examId });
  return { s, c: env.candidateClient(s.token) };
}
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt);
const checksOf = async (id: string) => env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, id)).orderBy(identityChecks.at);
const ALICE = { person: 'alice' };
const MALLORY = { person: 'mallory' };

/** Started exam whose exam_start sample was taken (the evidence begins with a clean match). */
async function examWithStartSample(policy?: Record<string, unknown>) {
  const { s, c } = await freshSession(policy);
  await startedSession(env, c);
  const r = await burst(env, c, [ALICE, ALICE, ALICE], { trigger: 'exam_start' });
  expect(r.last.result.decision).toBe('match');
  return { s, c };
}

/* =================================================================== adaptive checks */

describe('adaptive checks', () => {
  it('initial: asks for an enrolment gallery, reports progress, stores a gallery with a genuine baseline', async () => {
    const { s, c } = await freshSession();
    await consent(c);
    const { start, complete, progress, frontalSent } = await runCheck(env, c, 'initial');
    expect(start).toMatchObject({ frontalFramesRequired: 5, maxFrontalFrames: 10 });
    expect(frontalSent).toBe(5);
    expect(progress).toMatchObject({ frontalAccepted: 6, frontalNeeded: 0, identity: null, canComplete: true }); // 5 frontal + the 'center' step
    expect(progress!.steps.every((x) => x.satisfied)).toBe(true);
    expect(complete!.outcome).toBe('passed');
    const [ref] = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, s.id));
    expect(ref.embeddingCount).toBeGreaterThanOrEqual(3);
    expect(ref.embeddingCount).toBeLessThanOrEqual(8);
    expect(ref.baseline).toMatchObject({ n: expect.any(Number), calibrationVersion: CALIBRATION.version });
    expect(ref.baseline!.mean).toBeGreaterThan(0.9); // the fake camera's frames of one person are identical
  });

  it('initial: unusable frames make the server ask for more (up to the maximum) and a clear enrolment then passes first time', async () => {
    const { c } = await freshSession();
    await consent(c);
    const dark = { person: 'alice', usable: false, issues: ['too_dark' as const] };
    const { complete, frontalSent, start } = await runCheck(env, c, 'initial', { frontal: [dark, dark, ALICE, dark, ALICE, ALICE, ALICE, ALICE] });
    expect(frontalSent).toBeGreaterThan(start.frontalFramesRequired);
    expect(complete!.outcome).toBe('passed');
    expect(complete!.attemptsRemaining).toBe(5);
  });

  it('resume: the genuine candidate with a few poor / dim frames passes on the first attempt', async () => {
    const { c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(3 * 60 * 60_000); // hours later, another room
    const dim = { person: 'alice', brightness: 45, similarity: 0.55 }; // 'fair' quality, lower score
    const blurry = { person: 'alice', usable: false, issues: ['blurry' as const] };
    const { complete, start } = await runCheck(env, c, 'resume', { frontal: [blurry, dim, { person: 'alice', similarity: 0.62 }, dim, dim] });
    expect(start.frontalFramesRequired).toBe(3);
    expect(complete!.outcome, JSON.stringify(complete)).toBe('passed');
    expect(complete!.identity!.decision).toBe('match');
    expect(complete!.identity!.confidence).toBeGreaterThan(0.9);
    expect(complete!.state.session.status).toBe('active');
  });

  it('resume: progress reports the running identity assessment and keeps asking while uncertain', async () => {
    const { c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const r = await startCheck(c, 'resume');
    const start = r.json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const nonce = start.liveness!.nonce;
    const send = async (spec: object) => (await c.jpeg(url, { yawDeg: 0, pitchDeg: 0, ...spec }, { step: 'frontal', capturedAt: env.clock.t, nonce })).json() as CheckFrameResponse;
    let fr = await send({ person: 'alice', usable: false, issues: ['blurry'] });
    expect(fr.progress).toMatchObject({ frontalAccepted: 0, identity: 'pending', canComplete: false });
    expect(fr.progress!.frontalNeeded).toBeGreaterThan(0);
    fr = await send(ALICE);
    fr = await send(ALICE);
    fr = await send(ALICE);
    expect(fr.progress).toMatchObject({ identity: 'likely_match', frontalNeeded: 0 });
    // liveness steps still open -> not yet complete
    expect(fr.progress!.canComplete).toBe(false);
    expect(fr.progress!.steps.map((x) => x.satisfied)).toEqual(start.liveness!.steps.map(() => false));
  });

  it('resume: a different person is held for review even when some frames are poor', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const poor = { person: 'mallory', brightness: 33 };
    const { complete } = await runCheck(env, c, 'resume', { spec: MALLORY, frontal: [poor, MALLORY, poor, MALLORY] });
    expect(complete!.outcome).toBe('held');
    expect(complete!.identity!.decision).toBe('mismatch');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ purpose: 'resume', against: 'reference', llrSum: expect.any(Number), posterior: expect.any(Number), calibrationVersion: CALIBRATION.version });
    expect(mm.confidence).toBeCloseTo(mm.details.posterior as number, 4);
    expect((mm.details.perFrame as unknown[]).length).toBeGreaterThanOrEqual(4);
    const dto = (await loadEventDTO(env.ctx.db, mm.id))!;
    expect(dto.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe', 'identity_reference']));
  });

  it('resume: frames that stay unusable after the adaptive collection => unable_to_verify + guidance (never a mismatch)', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const dark = { person: 'mallory', usable: false, issues: ['too_dark' as const] };
    const { complete, frontalSent } = await runCheck(env, c, 'resume', { spec: dark });
    expect(frontalSent).toBe(10);
    expect(complete!.outcome).toBe('retry');
    expect(complete!.identity!.decision).toBe('unable_to_verify');
    expect(complete!.guidance.join(' ')).toMatch(/dark/i);
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
  });

  it('liveness: a failed step is reported in progress and can be re-prompted within the challenge', async () => {
    const { c } = await freshSession();
    await consent(c);
    const start = (await startCheck(c, 'initial')).json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const nonce = start.liveness!.nonce;
    for (let i = 0; i < start.frontalFramesRequired; i++) await c.jpeg(url, { ...ALICE, yawDeg: 0 }, { step: 'frontal', capturedAt: env.clock.t, nonce });
    const pose = (a: string) => (a === 'turn_left' ? 22 : a === 'turn_right' ? -22 : 0);
    let last: CheckFrameResponse | null = null;
    for (const step of start.liveness!.steps) {
      const turn = step.action === 'turn_left' || step.action === 'turn_right';
      // The first attempt of each turn is too small; the server reports the step unsatisfied, the client re-prompts it.
      if (turn) {
        const weak = (await c.jpeg(url, { ...ALICE, yawDeg: pose(step.action) / 4 }, { step: step.index, capturedAt: env.clock.t, nonce })).json() as CheckFrameResponse;
        expect(weak.stepSatisfied).toBe(false);
        expect(weak.progress!.steps.find((x) => x.index === step.index)!.satisfied).toBe(false);
        expect(weak.progress!.canComplete).toBe(false);
        for (let k = 0; k < 2; k++) last = (await c.jpeg(url, { ...ALICE, yawDeg: pose(step.action) }, { step: step.index, capturedAt: env.clock.t, nonce })).json() as CheckFrameResponse;
        expect(last!.progress!.steps.find((x) => x.index === step.index)!.satisfied).toBe(true);
      } else {
        last = (await c.jpeg(url, { ...ALICE, yawDeg: 0 }, { step: step.index, capturedAt: env.clock.t, nonce })).json() as CheckFrameResponse;
      }
    }
    expect(last!.progress).toMatchObject({ canComplete: true, frontalNeeded: 0 });
    const done = (await c.req('POST', `/api/candidate/checks/${start.checkId}/complete`)).json() as CompleteCheckResponse;
    expect(done.outcome).toBe('passed');
    expect(done.liveness!.passed).toBe(true);
  });

  it('liveness: frames per step and per check stay capped', async () => {
    const { c } = await freshSession();
    await consent(c);
    const start = (await startCheck(c, 'initial')).json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const nonce = start.liveness!.nonce;
    const turn = start.liveness!.steps.find((x) => x.action === 'turn_left')!;
    const codes: number[] = [];
    for (let k = 0; k < 7; k++) codes.push((await c.jpeg(url, { ...ALICE, yawDeg: 1 }, { step: turn.index, capturedAt: env.clock.t, nonce })).statusCode);
    expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(codes[6]).toBe(429);
  });
});

/* =================================================================== exam start + cadence */

describe('exam start sampling and server-driven cadence', () => {
  it('/start asks for an exam_start burst at once; heartbeats repeat it until a sample arrives', async () => {
    const { c } = await freshSession();
    await consent(c);
    await runCheck(env, c, 'initial');
    const st = (await c.req('POST', '/api/candidate/start')).json();
    expect(st.session.identitySample).toEqual({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    env.clock.advance(2_000);
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toEqual({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    const r = await burst(env, c, [ALICE, ALICE, ALICE], { trigger: 'exam_start' });
    expect(r.last).toMatchObject({ burst: { complete: true, received: 3, size: 3 }, nextSampleInMs: 6_000, evidence: { state: 'consistent' } });
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toBeNull();
    // after the start-up window: the periodic interval
    env.clock.advance(181_000);
    const later = (await burst(env, c, [ALICE, ALICE, ALICE])).last as IdentitySampleResponse;
    expect(later.nextSampleInMs).toBe(15_000);
    expect(later.followUpInMs).toBeNull();
  });

  it('a passed resume check makes the client take an exam_start burst (complete response + heartbeat)', async () => {
    const { c } = await examWithStartSample();
    await c.req('POST', '/api/candidate/pause', {});
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toBeNull();
    const { complete } = await runCheck(env, c, 'resume');
    expect(complete!.state.session.identitySample).toEqual({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toMatchObject({ trigger: 'exam_start' });
  });

  it('a person swap right after the exam starts is caught within two bursts (suspect => fast server_request sample)', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(6_000);
    const first = (await burst(env, c, [MALLORY, MALLORY, MALLORY], { trigger: 'track_break' })).last as IdentitySampleResponse;
    expect(first.status).toBe('active');
    expect(first.evidence!.state).toBe('suspect');
    expect(first.nextSampleInMs).toBe(2_500);
    expect(first.followUpInMs).toBe(2_500);
    // The client is late: the heartbeat repeats the request.
    env.clock.advance(7_000);
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toEqual({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    const second = (await burst(env, c, [MALLORY, MALLORY, MALLORY], { trigger: 'server_request' })).last as IdentitySampleResponse;
    expect(second.status).toBe('on_hold');
    expect(second.hold!.reason).toBe('identity_mismatch');
    const mm = (await eventsOf(s.id)).find((e) => e.type === 'identity_mismatch')!;
    expect(mm).toMatchObject({ category: 'integrity', severity: 'high', source: 'server_identity', status: 'closed' });
    expect(mm.details).toMatchObject({ against: 'reference', samples: 2, triggers: expect.arrayContaining(['track_break', 'server_request']), baseline: expect.objectContaining({ n: expect.any(Number) }) });
    expect(mm.confidence).toBe(mm.details.posterior);
    expect(mm.confidence!).toBeGreaterThan(0.5);
    expect((mm.details.perSample as { similarity: number; llr: number }[]).every((x) => x.llr > 0 && x.similarity < 0.3)).toBe(true);
    expect(mm.observation).toMatch(/briefly left the camera view/);
    const dto = (await loadEventDTO(env.ctx.db, mm.id))!;
    expect(dto.evidence.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe', 'identity_reference']));
    // The staff comparison view: reference images vs the (burst) probes behind the event, with the timeline around it.
    const cmp = await buildIdentityComparison(env.ctx, env.org.id, mm.id);
    expect(cmp.reference.images.length).toBeGreaterThan(0);
    const probes = cmp.probes.filter((p) => p.check.decision === 'mismatch');
    expect(probes.length).toBe(2);
    expect(probes.every((p) => p.image != null)).toBe(true);
    expect(probes.map((p) => p.check.trigger)).toEqual(['track_break', 'server_request']);
    expect(cmp.probes.some((p) => p.check.decision === 'match' && p.check.trigger === 'exam_start')).toBe(true);
  });

  it('the genuine candidate in a lighting dip is never flagged; evidence clears when the light returns', async () => {
    const { s, c } = await examWithStartSample({ identity: { onMismatch: 'flag_only' } });
    const dim = { person: 'alice', brightness: 33, similarity: 0.45 };
    const dark = { person: 'alice', usable: false, issues: ['too_dark' as const] };
    for (let i = 0; i < 6; i++) {
      env.clock.advance(15_000);
      await burst(env, c, i % 2 ? [dim, dark, dim] : [dim, dim, dim]);
    }
    env.clock.advance(15_000);
    const back = (await burst(env, c, [ALICE, ALICE, ALICE])).last as IdentitySampleResponse;
    expect(back.evidence!.state).toBe('consistent');
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
    expect((await sessionRow(s.id)).status).toBe('active');
  });
});

/* =================================================================== calibration v2: poor light, normalisation context */

describe('poor light and per-session normalisation', () => {
  const DARK_MALLORY = { person: 'mallory', brightness: 40 }; // usable, but 'poor' (dim room)

  it('a face that does not match seen only in poor light is suspected, never confirmed: uncertain observation, lighting guidance, faster samples', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(6_000);
    const first = (await burst(env, c, [DARK_MALLORY, DARK_MALLORY, DARK_MALLORY], { trigger: 'track_break' })).last as IdentitySampleResponse;
    expect(first.result.decision).toBe('inconclusive'); // poor frames are never labelled "mismatch"
    expect(first.evidence!.state).toBe('suspect');
    expect(first.nextSampleInMs).toBe(2_500);
    expect(first.result.guidance.join(' ')).toMatch(/light/i);
    for (let i = 0; i < 3; i++) {
      env.clock.advance(2_500);
      const more = (await burst(env, c, [DARK_MALLORY, DARK_MALLORY, DARK_MALLORY], { trigger: 'server_request' })).last as IdentitySampleResponse;
      expect(more.status).toBe('active');
      expect(more.evidence!.state).toBe('suspect');
    }
    let evs = await eventsOf(s.id);
    expect(evs.map((e) => e.type)).not.toContain('identity_mismatch');
    const unv = evs.find((e) => e.type === 'identity_unverifiable')!;
    expect(unv).toMatchObject({ category: 'uncertain', status: 'open' });
    expect(unv.details).toMatchObject({ reason: 'poor_light_suspect', poorLightSuspect: true });
    expect(((await hb(c)).json() as HeartbeatResponse).status).toBe('active');
    // A fair / good frame of the same face decides.
    env.clock.advance(2_500);
    const lit = (await burst(env, c, [MALLORY, MALLORY, MALLORY], { trigger: 'server_request' })).last as IdentitySampleResponse;
    expect(lit.status).toBe('on_hold');
    evs = await eventsOf(s.id);
    expect(evs.find((e) => e.type === 'identity_mismatch')).toBeDefined();
  });

  it('resume: a different face seen only in poor light is not held — retry with lighting guidance', async () => {
    const { s, c } = await freshSession();
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const { complete } = await runCheck(env, c, 'resume', { spec: DARK_MALLORY });
    expect(complete!.outcome).toBe('retry');
    expect(complete!.identity!.decision).toBe('inconclusive');
    expect(complete!.guidance.join(' ')).toMatch(/light/i);
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
  });

  it('after a resume, mid-exam samples use the relaxed normalisation (another room, light or camera is possible)', async () => {
    const a = await examWithStartSample();
    const b = await examWithStartSample();
    await b.c.req('POST', '/api/candidate/pause', {});
    expect((await runCheck(env, b.c, 'resume')).complete!.outcome).toBe('passed');
    await burst(env, b.c, [ALICE, ALICE, ALICE], { trigger: 'exam_start' });
    expect((await sessionRow(a.s.id)).identityState.normalisation ?? 'continuous').toBe('continuous');
    expect((await sessionRow(b.s.id)).identityState.normalisation).toBe('relaxed');
    const llrOf = async (sid: string) => ((await checksOf(sid)).pop()!.context as unknown as { evidence: { llr: number } }).evidence.llr;
    const lowish = { person: 'alice', similarity: 0.4 };
    env.clock.advance(15_000);
    await sample(env, a.c, lowish);
    await sample(env, b.c, lowish);
    // Same session: 0.40 is a clear drop from the enrolment level; after a resume it is within the cross-day drift.
    expect(await llrOf(a.s.id)).toBeGreaterThan(1);
    expect(await llrOf(b.s.id)).toBeLessThan(0);
  });
});

/* =================================================================== bursts */

describe('bursts', () => {
  it('in order: intermediate frames are answered per frame, the last frame decides ONE sample', async () => {
    const { s, c } = await examWithStartSample();
    const before = (await checksOf(s.id)).length;
    env.clock.advance(15_000);
    const r = await burst(env, c, [ALICE, ALICE, ALICE]);
    expect(r.responses[0]).toMatchObject({ burst: { received: 1, size: 3, complete: false }, nextSampleInMs: null, result: { decision: 'match' } });
    expect(r.responses[1].burst).toMatchObject({ received: 2, complete: false });
    expect(r.last).toMatchObject({ burst: { id: r.burstId, received: 3, size: 3, complete: true }, result: { decision: 'match' } });
    const rows = await checksOf(s.id);
    expect(rows.length).toBe(before + 1);
    expect(rows[rows.length - 1].context).toMatchObject({ burst: { id: r.burstId, size: 3, received: 3, consistent: true } });
    const frames = await env.ctx.db.select().from(identitySampleFrames).where(and(eq(identitySampleFrames.sessionId, s.id), eq(identitySampleFrames.burstId, r.burstId)));
    expect(frames).toHaveLength(3);
    expect(frames.every((f) => f.embeddingEnc == null && f.identityCheckId === rows[rows.length - 1].id)).toBe(true);
    // A clean match keeps no face images.
    const probes = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, s.id), eq(evidence.kind, 'identity_probe')));
    expect(probes).toHaveLength(0);
  });

  it('out of order: completes when all indexes arrived; replays are idempotent; a late duplicate has no effect', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(15_000);
    const r = await burst(env, c, [MALLORY, MALLORY, MALLORY], { order: [2, 0, 1], trigger: 'track_break' });
    expect(r.responses.map((x) => x.burst.complete)).toEqual([false, false, true]);
    expect(r.last.result.decision).toBe('mismatch');
    expect(r.last.evidence.state).toBe('suspect');
    const n = (await checksOf(s.id)).length;
    const [frame] = await env.ctx.db.select().from(identitySampleFrames).where(and(eq(identitySampleFrames.burstId, r.burstId), eq(identitySampleFrames.burstIndex, 0)));
    const replay = await c.jpeg('/api/candidate/identity/sample', MALLORY, { sampleId: frame.sampleId, trigger: 'periodic', capturedAt: env.clock.t, burstId: r.burstId, burstIndex: 0, burstSize: 3 });
    expect(replay.json().result.id).toBe(frame.id);
    const late = await burst(env, c, [MALLORY, MALLORY, MALLORY], { burstId: r.burstId, omit: [0, 1] });
    expect(late.last.burst.complete).toBe(true);
    expect((await checksOf(s.id)).length).toBe(n);
    expect((await sessionRow(s.id)).status).toBe('active');
  });

  it('incomplete: decided on the frames received after ~3 s (sweeper, or the next sample)', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(15_000);
    const r = await burst(env, c, [MALLORY, MALLORY, MALLORY], { omit: [2], trigger: 'track_break' });
    expect(r.last.burst).toMatchObject({ received: 2, complete: false });
    const n = (await checksOf(s.id)).length;
    env.clock.advance(1_000);
    expect((await sweepOnce(env.ctx)).burstsDecided).toBe(0);
    env.clock.advance(3_000);
    expect((await sweepOnce(env.ctx)).burstsDecided).toBe(1);
    const rows = await checksOf(s.id);
    expect(rows.length).toBe(n + 1);
    expect(rows[rows.length - 1]).toMatchObject({ sampleId: `burst:${r.burstId}`, decision: 'mismatch' });
    expect(rows[rows.length - 1].context).toMatchObject({ burst: { received: 2, size: 3 } });
    expect((await sessionRow(s.id)).identityState.evidence!.state).toBe('suspect');
    // The next incomplete burst is decided by the following sample, which then confirms.
    env.clock.advance(2_500);
    const r2 = await burst(env, c, [MALLORY, MALLORY, MALLORY], { omit: [1, 2], trigger: 'server_request' });
    env.clock.advance(4_000);
    const next = (await sample(env, c, MALLORY, 'server_request')).json() as IdentitySampleResponse;
    expect(next.status).toBe('on_hold');
    const all = await checksOf(s.id);
    expect(all.some((x) => x.sampleId === `burst:${r2.burstId}`)).toBe(true);
  });

  it('frames of two different people in one burst are judged per frame (median), not averaged', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(15_000);
    const r = await burst(env, c, [ALICE, MALLORY, MALLORY]);
    expect(r.last.result.decision).toBe('mismatch');
    const rows = await checksOf(s.id);
    expect(rows[rows.length - 1].context).toMatchObject({ burst: { consistent: false } });
  });
});

/* =================================================================== triggers */

describe('triggers', () => {
  it('accepts exam_start, track_break, appearance_change and server_request; rejects unknown triggers', async () => {
    const { c } = await examWithStartSample();
    for (const t of ['exam_start', 'track_break', 'appearance_change', 'server_request']) {
      env.clock.advance(5_000);
      const r = await sample(env, c, ALICE, t);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().result.trigger).toBe(t);
    }
    expect((await sample(env, c, ALICE, 'teleport')).statusCode).toBe(400);
  });

  it('a track break drops earlier genuine evidence and weighs the new sample more than a routine one', async () => {
    const a = await examWithStartSample();
    const b = await examWithStartSample();
    for (const x of [a, b]) {
      env.clock.advance(5_000);
      await sample(env, x.c, { person: 'alice', similarity: 0.55 }); // a mild genuine sample
    }
    env.clock.advance(5_000);
    const routine = (await sample(env, a.c, MALLORY, 'periodic')).json() as IdentitySampleResponse;
    const afterBreak = (await sample(env, b.c, MALLORY, 'track_break')).json() as IdentitySampleResponse;
    expect(afterBreak.evidence!.swapProbability).toBeGreaterThan(routine.evidence!.swapProbability);
  });
});

/* =================================================================== staff self-test */

describe('staff identity self-test', () => {
  const url = (testId: string, mode: string) => `/tools/identity-test?testId=${testId}&mode=${mode}`;

  it('enrol, probe the same and another person, reset — nothing stored, use audit-logged', async () => {
    const api = await staffApi(env, 'reviewer');
    const testId = randomUUID();
    const evidenceBefore = (await env.ctx.db.select().from(evidence)).length;
    const unusable = json<IdentityTestResponse>(await api.jpeg(url(testId, 'enroll'), { person: 'staff-a', usable: false, issues: ['too_dark'] }, 'POST'));
    expect(unusable).toMatchObject({ testId, mode: 'enroll', enrolledFrames: 0, similarity: null, decision: null });
    expect(unusable.guidance.join(' ')).toMatch(/dark/i);
    for (let i = 1; i <= 3; i++) expect(json<IdentityTestResponse>(await api.jpeg(url(testId, 'enroll'), { person: 'staff-a' }, 'POST')).enrolledFrames).toBe(i);
    const same = json<IdentityTestResponse>(await api.jpeg(url(testId, 'probe'), { person: 'staff-a', similarity: 0.7 }, 'POST'));
    expect(same).toMatchObject({ mode: 'probe', decision: 'match', enrolledFrames: 3, evidence: { state: 'consistent' } });
    expect(same.similarity).toBeCloseTo(0.7, 3);
    expect(same.llr!).toBeLessThan(0);
    expect(same.quality!.usable).toBe(true);
    expect(same.timingsMs.analyze).toBeGreaterThanOrEqual(0);
    // Another person: evidence builds up sample by sample (the genuine probe before it still counts in the window).
    const other1 = json<IdentityTestResponse>(await api.jpeg(url(testId, 'probe'), { person: 'staff-b' }, 'POST'));
    expect(other1).toMatchObject({ decision: 'mismatch' });
    expect(other1.llr!).toBeGreaterThan(0);
    expect(other1.evidence!.state).not.toBe('consistent');
    const other2 = json<IdentityTestResponse>(await api.jpeg(url(testId, 'probe'), { person: 'staff-b' }, 'POST'));
    expect(other2.evidence!.state).toBe('suspect');
    const other3 = json<IdentityTestResponse>(await api.jpeg(url(testId, 'probe'), { person: 'staff-b' }, 'POST'));
    expect(other3.evidence).toMatchObject({ state: 'confirmed_mismatch', samples: 4 });
    expect(other3.evidence!.swapProbability).toBeGreaterThan(0.5);
    // family-like score between the thresholds: inconclusive label but evidence
    const grey = json<IdentityTestResponse>(await api.jpeg(url(testId, 'probe'), { person: 'staff-a', similarity: 0.36 }, 'POST'));
    expect(grey.decision).toBe('inconclusive');
    expect(grey.llr!).toBeGreaterThan(0);
    expect(json<IdentityTestResponse>(await api.post(url(testId, 'reset')))).toMatchObject({ mode: 'reset', enrolledFrames: 0 });
    expect((await api.jpeg(url(testId, 'probe'), { person: 'staff-a' }, 'POST')).statusCode).toBe(409);
    expect((await env.ctx.db.select().from(evidence)).length).toBe(evidenceBefore);
    const audits = await env.ctx.db.select().from(auditLog).where(eq(auditLog.targetId, testId));
    expect(audits.map((a) => a.action).sort()).toEqual(['tools.identity_test', 'tools.identity_test_reset']);
    expect(JSON.stringify(audits)).not.toMatch(/similarity|llr/);
  });

  it('galleries are per staff user and expire after 15 minutes', async () => {
    const reviewer = await staffApi(env, 'reviewer');
    const admin = await staffApi(env, 'admin');
    const testId = randomUUID();
    json(await reviewer.jpeg(url(testId, 'enroll'), { person: 'staff-c' }, 'POST'));
    expect((await admin.jpeg(url(testId, 'probe'), { person: 'staff-c' }, 'POST')).json()).toMatchObject({ error: 'not_enrolled' });
    json(await reviewer.jpeg(url(testId, 'probe'), { person: 'staff-c' }, 'POST'));
    env.clock.advance(SELFTEST_TTL_MS + 1_000);
    const fresh = await staffApi(env, 'reviewer');
    expect((await fresh.jpeg(url(testId, 'probe'), { person: 'staff-c' }, 'POST')).statusCode).toBe(409);
  });

  it('requires a staff login, a JPEG body and a valid test id / mode', async () => {
    const testId = randomUUID();
    const anon = await env.app.inject({ method: 'POST', url: `/api/admin${url(testId, 'enroll')}`, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    expect(anon.statusCode).toBe(401);
    const api = await staffApi(env, 'reviewer');
    expect((await api.post(url(testId, 'enroll'), { not: 'an image' })).statusCode).toBe(415);
    expect((await api.jpeg(url('nope', 'enroll'), { person: 'x' }, 'POST')).statusCode).toBe(400);
    expect((await api.jpeg(url(testId, 'explode'), { person: 'x' }, 'POST')).statusCode).toBe(400);
  });
});

