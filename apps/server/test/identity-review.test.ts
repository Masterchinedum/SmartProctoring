/**
 * Identity engine: fixes from the round-2 code review (integration, FakeVisionService) — the evidence budget reserve
 * and burst images, the ID-photo comparison on poor frames, abandoned checks, late samples, erasure of undecided
 * burst-frame templates, atomic check-frame caps, server-derived vision priority and the sample watchdog.
 */
import { randomUUID } from 'node:crypto';
import type { HeartbeatResponse, IdentitySampleResponse, StartCheckResponse } from '@sp/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { candidates, checkFrames, checks, events, evidence, examSessions, identityChecks, identitySampleFrames } from '../src/db/schema.js';
import { sweepOnce } from '../src/jobs/sweeper.js';
import { idPhotoAad } from '../src/services/identity-common.js';
import { LATE_SAMPLE_MS } from '../src/services/identity-samples.js';
import { sessionEvidenceUsage, IDENTITY_SAMPLE_SHARE } from '../src/services/session-limits.js';
import { identityState } from '../src/services/session-state.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { serializeEmbeddings } from '../src/vision/index.js';
import { burst, consent, DEVICE, hb, runCheck, sample, startCheck, startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

async function freshSession(policy?: Record<string, unknown>, candidateId?: string, e: TestEnv = env) {
  const examId = policy ? (await e.newExam({ policy })).exam.id : e.exam.id;
  const s = await e.newSession({ examId, candidateId });
  return { s, c: e.candidateClient(s.token) };
}
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const eventsOf = async (id: string) => env.ctx.db.select().from(events).where(eq(events.sessionId, id)).orderBy(events.startedAt);
const checksOf = async (id: string) => env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, id)).orderBy(identityChecks.at, identityChecks.receivedAt);
const ALICE = { person: 'alice' };
const MALLORY = { person: 'mallory' };

async function examWithStartSample(policy?: Record<string, unknown>) {
  const { s, c } = await freshSession(policy);
  await startedSession(env, c);
  await burst(env, c, [ALICE, ALICE, ALICE], { trigger: 'exam_start' });
  return { s, c };
}

/* =================================================================== #1 evidence budget */

describe('evidence budget', () => {
  it('a decided burst keeps the images of its representative frame only; the other frames’ images are purged', async () => {
    const { s, c } = await examWithStartSample({ evidence: { keepMatchingIdentitySamples: true } });
    env.clock.advance(15_000);
    const r = await burst(env, c, [ALICE, ALICE, ALICE]);
    const frames = await env.ctx.db.select().from(identitySampleFrames).where(eq(identitySampleFrames.burstId, r.burstId));
    expect(frames).toHaveLength(3);
    expect(frames.filter((f) => f.probeEvidenceId || f.frameEvidenceId)).toHaveLength(1);
    const [row] = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.id, r.last.result.id));
    expect(row.probeEvidenceId).not.toBeNull();
    const kept = await env.ctx.db.select().from(evidence).where(and(eq(evidence.identityCheckId, row.id), isNull(evidence.purgedAt)));
    expect(kept).toHaveLength(2); // face crop + frame of the representative frame
    await vi.waitFor(async () => {
      const purged = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, s.id), eq(evidence.purgeReason, 'identity_burst_frame')));
      expect(purged.length).toBeGreaterThanOrEqual(4); // this burst's other two frames (and the exam_start burst's)
    });
  });

  it('identity samples may use only their share of the budget: a long session near the cap can still complete a resume check', async () => {
    const cap = 200;
    const capEnv = await createTestEnv({ env: { SESSION_MAX_EVIDENCE_ITEMS: String(cap) }, policy: { identity: { liveness: 'off' }, evidence: { keepMatchingIdentitySamples: true } } });
    try {
      const c = capEnv.candidateClient();
      await startedSession(capEnv, c);
      // A long exam: earlier samples' images up to just below the samples' share.
      const used = (await sessionEvidenceUsage(capEnv.ctx.db, capEnv.session.id)).items;
      const fill = Math.floor(cap * IDENTITY_SAMPLE_SHARE) - used - 4;
      const now = new Date(capEnv.clock.t);
      await capEnv.ctx.db.insert(evidence).values(
        Array.from({ length: fill }, () => ({
          id: randomUUID(),
          orgId: capEnv.org.id,
          sessionId: capEnv.session.id,
          candidateId: capEnv.candidate.id,
          kind: 'identity_probe' as const,
          reason: 'frame',
          capturedAt: now,
          storageKey: `test/${randomUUID()}`,
          byteSize: 100,
          sha256: '0'.repeat(64),
          keyId: 'k1',
        })),
      );
      // More samples: decided as always, their images stored only while the samples' share lasts.
      for (let i = 0; i < 4; i++) {
        capEnv.clock.advance(15_000);
        const r = await burst(capEnv, c, [ALICE, ALICE, ALICE], { trigger: i === 0 ? 'exam_start' : 'periodic' });
        expect(r.last.burst.complete).toBe(true);
      }
      await vi.waitFor(async () => expect((await sessionEvidenceUsage(capEnv.ctx.db, capEnv.session.id)).items).toBeLessThanOrEqual(cap * IDENTITY_SAMPLE_SHARE));
      // The genuine candidate pauses and resumes: the check's frames fit in the reserve.
      await c.req('POST', '/api/candidate/pause', {});
      const { complete } = await runCheck(capEnv, c, 'resume');
      expect(complete!.outcome, JSON.stringify(complete)).toBe('passed');
    } finally {
      await capEnv.close();
    }
  });
});

describe('check-frame images', () => {
  const frameImages = async (checkId: string) => {
    const frames = await env.ctx.db.select().from(checkFrames).where(eq(checkFrames.checkId, checkId));
    const ids = frames.flatMap((f) => [f.evidenceId, f.faceCropEvidenceId]).filter((x): x is string => !!x);
    return env.ctx.db.select().from(evidence).where(inArray(evidence.id, ids));
  };

  it('a check that passed with nothing to review keeps none of its frame images; the images kept as evidence stay', async () => {
    const { s, c } = await freshSession({ evidence: { keepMatchingIdentitySamples: true } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const r = await runCheck(env, c, 'resume');
    expect(r.complete!.outcome).toBe('passed');
    await vi.waitFor(async () => {
      const imgs = await frameImages(r.start.checkId);
      expect(imgs.length).toBeGreaterThan(4);
      expect(imgs.every((e) => e.purgedAt != null && e.purgeReason === 'check_passed')).toBe(true);
    });
    // The probe shown to staff (a copy) and the reference images are kept.
    const probe = await env.ctx.db.select().from(evidence).where(and(eq(evidence.identityCheckId, r.identity!.id), isNull(evidence.purgedAt)));
    expect(probe.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe']));
    const refs = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, s.id), eq(evidence.kind, 'identity_reference'), isNull(evidence.purgedAt)));
    expect(refs.length).toBeGreaterThan(0);
    // The initial (enrolment) check passed too: its frames are gone, the reference images are copies.
    const [initial] = await env.ctx.db.select().from(checks).where(and(eq(checks.sessionId, s.id), eq(checks.purpose, 'initial')));
    expect((await frameImages(initial.id)).every((e) => e.purgedAt != null)).toBe(true);
  });

  it('failed and flagged checks keep all their frame images', async () => {
    const { c } = await freshSession({ identity: { onMismatch: 'flag_only' } });
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    const dark = { person: 'alice', usable: false, issues: ['too_dark' as const] };
    const failed = await runCheck(env, c, 'resume', { spec: dark });
    expect(failed.complete!.outcome).toBe('retry');
    const flagged = await runCheck(env, c, 'resume', { spec: MALLORY });
    expect(flagged.complete!.outcome).toBe('passed'); // flag_only: the exam continues, the mismatch is recorded
    expect(flagged.identity!.decision).toBe('mismatch');
    await new Promise((r) => setTimeout(r, 50));
    for (const id of [failed.start.checkId, flagged.start.checkId]) {
      const imgs = await frameImages(id);
      expect(imgs.length).toBeGreaterThan(0);
      expect(imgs.every((e) => e.purgedAt == null)).toBe(true);
    }
  });
});

/* =================================================================== #2 ID photo on poor frames */

describe('ID-photo comparison on poor-quality check-in frames', () => {
  it('a very low score in poor light is flagged for review — advisory: uncertain event with both images; required: hold', async () => {
    const cand = await env.newCandidate('Photo Dim');
    await env.ctx.db
      .update(candidates)
      .set({ idPhotoEmbedding: env.ctx.keyring.encrypt(serializeEmbeddings([FakeVisionService.embeddingFor('photo-of-someone')]), idPhotoAad(cand.id)), idPhotoApprovedAt: new Date(env.clock.t) })
      .where(eq(candidates.id, cand.id));
    const dim = { person: 'dim-candidate', brightness: 40 }; // usable, 'poor' (dim room)

    const a = await freshSession({ identity: { idPhotoComparison: 'advisory' } }, cand.id);
    await consent(a.c);
    const ra = await runCheck(env, a.c, 'initial', { spec: dim });
    expect(ra.complete!.outcome).toBe('passed'); // advisory: the exam may start ...
    expect(ra.idPhoto!).toMatchObject({ decision: 'inconclusive' }); // ... never "a different person" in poor light
    const evA = await eventsOf(a.s.id);
    expect(evA.map((e) => e.type)).not.toContain('identity_mismatch');
    expect(evA.find((e) => e.type === 'id_photo_compared')!.details).toMatchObject({ decision: 'inconclusive', needsHumanReview: true });
    const unv = evA.find((e) => e.type === 'identity_unverifiable')!; // ... but staff see it
    expect(unv).toMatchObject({ category: 'uncertain' });
    expect(unv.details).toMatchObject({ against: 'id_photo', reason: 'id_photo_low_similarity_poor_quality', needsHumanReview: true, quality: { bucket: 'poor' } });
    const imgs = await env.ctx.db.select().from(evidence).where(eq(evidence.eventId, unv.id));
    expect(imgs.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_probe']));
    const photoRow = (await checksOf(a.s.id)).find((x) => x.trigger === 'id_photo')!;
    expect(photoRow).toMatchObject({ decision: 'inconclusive', eventId: unv.id });

    const b = await freshSession({ identity: { idPhotoComparison: 'required' } }, cand.id);
    await consent(b.c);
    const rb = await runCheck(env, b.c, 'initial', { spec: dim });
    expect(rb.complete!.outcome).toBe('held');
    expect(rb.complete!.state.session.hold!.reason).toBe('id_photo_unverifiable');
    const held = (await eventsOf(b.s.id)).find((e) => e.type === 'session_held')!;
    expect(held.details).toMatchObject({ reason: 'id_photo_unverifiable', needsHumanReview: true, lowSimilarityPoorQuality: true });

    // In good light the same comparison is a mismatch, as before.
    const g = await freshSession({ identity: { idPhotoComparison: 'advisory' } }, cand.id);
    await consent(g.c);
    const rg = await runCheck(env, g.c, 'initial', { spec: { person: 'dim-candidate' } });
    expect(rg.idPhoto!).toMatchObject({ decision: 'mismatch' });
  });
});

/* =================================================================== #3b abandoned checks */

describe('abandoned checks', () => {
  async function pausedExam(policy?: Record<string, unknown>) {
    const { s, c } = await freshSession(policy);
    await startedSession(env, c);
    await c.req('POST', '/api/candidate/pause', {});
    return { s, c };
  }

  it('a check abandoned while it pointed to a different person counts as a full failed attempt, recorded', async () => {
    const { s, c } = await pausedExam({ identity: { maxVerificationAttempts: 3 } });
    const first = await runCheck(env, c, 'resume', { spec: MALLORY, noComplete: true });
    // The candidate starts over (e.g. reloads the page) instead of completing it.
    const next = (await startCheck(c, 'resume')).json() as StartCheckResponse;
    expect(next.attemptsRemaining).toBe(2);
    const [old] = await env.ctx.db.select().from(checks).where(eq(checks.id, first.start.checkId));
    expect(old.status).toBe('retry');
    expect(old.result).toMatchObject({ _meta: { qualityOnly: false, abandoned: 'superseded' } });
    const row = (await checksOf(s.id)).find((x) => x.checkId === first.start.checkId)!;
    expect(row).toMatchObject({ trigger: 'resume', decision: 'mismatch' });
    expect(row.context).toMatchObject({ abandoned: 'superseded', evidence: { status: 'likely_mismatch' } });
    expect((await sessionRow(s.id)).status).toBe('paused');
  });

  it('abandoning a check of the genuine candidate, or one with only unusable frames, costs nothing', async () => {
    const { s, c } = await pausedExam({ identity: { maxVerificationAttempts: 3 } });
    const genuine = await runCheck(env, c, 'resume', { spec: ALICE, noComplete: true });
    const dark = { person: 'alice', usable: false, issues: ['too_dark' as const] };
    expect(((await startCheck(c, 'resume')).json() as StartCheckResponse).attemptsRemaining).toBe(3);
    const [g] = await env.ctx.db.select().from(checks).where(eq(checks.id, genuine.start.checkId));
    expect(g.status).toBe('expired');
    const unusable = await runCheck(env, c, 'resume', { spec: dark, noComplete: true, ignoreProgress: true });
    expect(((await startCheck(c, 'resume')).json() as StartCheckResponse).attemptsRemaining).toBe(3);
    const [u] = await env.ctx.db.select().from(checks).where(eq(checks.id, unusable.start.checkId));
    expect(u.status).toBe('expired');
    expect((await checksOf(s.id)).filter((x) => x.context?.abandoned)).toHaveLength(0);
  });

  it('an expired check trending "different person" is counted by the sweeper; with no attempts left the exam is held for review', async () => {
    const { s, c } = await pausedExam({ identity: { maxVerificationAttempts: 1 } });
    const r = await runCheck(env, c, 'resume', { spec: MALLORY, noComplete: true });
    env.clock.advance(4 * 60_000); // past the check's expiry
    const swept = await sweepOnce(env.ctx);
    expect(swept.checksExpired).toBeGreaterThanOrEqual(1);
    const [row] = await env.ctx.db.select().from(checks).where(eq(checks.id, r.start.checkId));
    expect(row.status).toBe('retry');
    const sess = await sessionRow(s.id);
    expect(sess.status).toBe('on_hold');
    expect(sess.holdReason).toBe('identity_unverifiable');
    const unv = (await eventsOf(s.id)).find((e) => e.type === 'identity_unverifiable')!;
    expect(unv.details).toMatchObject({ lastReason: 'abandoned', abandoned: 'expired', purpose: 'resume' });
    expect(unv.observation).toMatch(/not finished/);
    // Nothing to start any more: the session waits for review.
    expect((await startCheck(c, 'resume')).statusCode).toBe(409);
  });
});

/* =================================================================== #9 late / out-of-order samples */

describe('late samples', () => {
  it('a sample captured before the current period, or long before it arrived, is recorded only', async () => {
    const { s, c } = await examWithStartSample();
    const before = identityState(await sessionRow(s.id)).evidence;
    // Captured three minutes ago (an outbox backlog): recorded, no live evidence, no escalation.
    const old = await c.jpeg('/api/candidate/identity/sample', MALLORY, { sampleId: randomUUID(), trigger: 'track_break', capturedAt: env.clock.t - LATE_SAMPLE_MS - 60_000 });
    expect(old.statusCode, old.body).toBe(200);
    const [row] = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.id, (old.json() as IdentitySampleResponse).result.id));
    expect(row.context).toMatchObject({ recordOnly: true });
    const after = identityState(await sessionRow(s.id)).evidence;
    expect(after.window).toEqual(before.window);
    // Captured before the exam was resumed: recorded only.
    await c.req('POST', '/api/candidate/pause', {});
    env.clock.advance(60_000);
    expect((await runCheck(env, c, 'resume')).complete!.outcome).toBe('passed');
    const pre = await c.jpeg('/api/candidate/identity/sample', MALLORY, { sampleId: randomUUID(), trigger: 'periodic', capturedAt: env.clock.t - 50_000 });
    const [preRow] = await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.id, (pre.json() as IdentitySampleResponse).result.id));
    expect(preRow.context).toMatchObject({ recordOnly: true });
    expect((await eventsOf(s.id)).map((e) => e.type)).not.toContain('identity_mismatch');
  });
});

/* =================================================================== #7 undecided burst-frame templates */

describe('templates of bursts that will never be decided', () => {
  it('are erased when the burst is dropped (pause, end) and by the sweeper for any session', async () => {
    const undecided = async (sid: string) =>
      env.ctx.db.select().from(identitySampleFrames).where(and(eq(identitySampleFrames.sessionId, sid), isNull(identitySampleFrames.identityCheckId), isNotNull(identitySampleFrames.embeddingEnc)));
    // pause
    const a = await examWithStartSample();
    env.clock.advance(15_000);
    await burst(env, a.c, [ALICE, ALICE, ALICE], { omit: [2] });
    expect(await undecided(a.s.id)).toHaveLength(2);
    await a.c.req('POST', '/api/candidate/pause', {});
    expect(await undecided(a.s.id)).toHaveLength(0);
    // the end of the exam
    const b = await examWithStartSample();
    env.clock.advance(15_000);
    await burst(env, b.c, [ALICE, ALICE, ALICE], { omit: [1] });
    expect(await undecided(b.s.id)).toHaveLength(2);
    expect((await b.c.req('POST', '/api/candidate/submit', {})).statusCode).toBe(200);
    expect(await undecided(b.s.id)).toHaveLength(0);
    // the sweeper, for a session that is no longer active (a path that dropped the burst without erasing)
    const d = await examWithStartSample();
    env.clock.advance(15_000);
    await burst(env, d.c, [ALICE, ALICE, ALICE], { omit: [0] });
    await env.ctx.db.update(examSessions).set({ status: 'paused' }).where(eq(examSessions.id, d.s.id));
    env.clock.advance(31_000);
    await sweepOnce(env.ctx);
    expect(await undecided(d.s.id)).toHaveLength(0);
  });
});

/* =================================================================== #11 check-frame caps, vision priority */

describe('resource limits', () => {
  it('frame caps hold under concurrent uploads', async () => {
    const { c } = await freshSession();
    await consent(c);
    const start = (await startCheck(c, 'initial', DEVICE)).json() as StartCheckResponse;
    const url = `/api/candidate/checks/${start.checkId}/frames`;
    const turn = start.liveness!.steps.find((x) => x.action === 'turn_left')!;
    const codes = await Promise.all(Array.from({ length: 10 }, () => c.jpeg(url, { ...ALICE, yawDeg: 1 }, { step: turn.index, capturedAt: env.clock.t, nonce: start.liveness!.nonce }).then((r) => r.statusCode)));
    expect(codes.filter((x) => x === 200)).toHaveLength(6);
    expect(codes.filter((x) => x === 429)).toHaveLength(4);
  });

  it('vision priority comes from server state, not from the trigger the client chose', async () => {
    const { c } = await examWithStartSample();
    // Start-up window, exam-start sample received: routine samples wait behind check-in frames.
    env.clock.advance(6_000);
    const k = env.vision.calls.length;
    await sample(env, c, ALICE, 'periodic');
    expect(env.vision.calls.slice(k).map((x) => x.opts.priority)).toEqual(['background']);
    env.clock.advance(200_000); // past the start-up window
    await sample(env, c, ALICE, 'periodic');
    env.clock.advance(15_000); // the evidence is consistent, nothing requested, nothing overdue
    const n = env.vision.calls.length;
    await sample(env, c, ALICE, 'track_break'); // an "urgent" label the server was not waiting for
    expect(env.vision.calls.slice(n).map((x) => x.opts.priority)).toEqual(['background']);
    // The server waits for a sample (its watchdog asked): interactive, whatever the label.
    env.clock.advance(60_000);
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toMatchObject({ trigger: 'server_request' });
    const m = env.vision.calls.length;
    await sample(env, c, ALICE, 'periodic');
    expect(env.vision.calls.slice(m).map((x) => x.opts.priority)).toEqual(['interactive']);
  });
});

/* =================================================================== #12 sample watchdog */

describe('sample watchdog', () => {
  it('asks for a sample when none came for 3 intervals, then records an uncertain observation; the next sample closes it', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(200_000); // periodic interval (15 s) from now on
    await sample(env, c, ALICE);
    env.clock.advance(30_000);
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample ?? null).toBeNull();
    env.clock.advance(20_000); // 50 s > 3 x 15 s
    expect(((await hb(c)).json() as HeartbeatResponse).identitySample).toEqual({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    expect((await eventsOf(s.id)).filter((e) => e.type === 'identity_unverifiable')).toHaveLength(0);
    env.clock.advance(45_000); // 95 s > 6 x 15 s: the requests went unanswered
    await hb(c);
    const unv = (await eventsOf(s.id)).find((e) => e.type === 'identity_unverifiable')!;
    expect(unv).toMatchObject({ category: 'uncertain', status: 'open' });
    expect(unv.details).toMatchObject({ reason: 'no_samples' });
    await hb(c); // not opened twice
    expect((await eventsOf(s.id)).filter((e) => e.type === 'identity_unverifiable')).toHaveLength(1);
    await sample(env, c, ALICE, 'server_request');
    const closed = (await eventsOf(s.id)).find((e) => e.id === unv.id)!;
    expect(closed).toMatchObject({ status: 'closed' });
    expect(closed.details).toMatchObject({ closedBy: 'sample_received' });
    expect(identityState(await sessionRow(s.id)).openNoSamplesEventId ?? null).toBeNull();
  });

  it('no observation while the browser is not reporting (a reporting outage explains the gap)', async () => {
    const { s, c } = await examWithStartSample();
    env.clock.advance(200_000);
    await hb(c, { outboxSize: 5, outboxOldestAt: env.clock.t - 60_000 });
    expect((await eventsOf(s.id)).filter((e) => e.type === 'identity_unverifiable')).toHaveLength(0);
  });
});
