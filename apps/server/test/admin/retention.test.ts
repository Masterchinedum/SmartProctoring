/**
 * Retention job: evidence purge after the (exam or organisation) evidence retention period, tombstones,
 * legal hold, event-metadata deletion, audit entries, idempotency, dry run and the cluster lock.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, checkFrames, events, evidence, examSessions, identityChecks, identityReferences, identitySampleFrames, sessionPeriods } from '../../src/db/schema.js';
import { DAY_MS, RETENTION_LOCK_KEY, runRetention, runRetentionExclusive, startRetentionScheduler } from '../../src/services/retention.js';
import { startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { clientEvent, json, screenshot, staffApi } from './fixtures.js';

let env: TestEnv;
const ids = { a: '', b: '', held: '', active: '' };
let endedAt = 0;
let screenshotB = '';

async function finishedSession(examId: string | undefined, name: string, submit = true) {
  const cand = await env.newCandidate(name);
  const s = await env.newSession({ examId, candidateId: cand.id });
  const c = await startedSession(env, env.candidateClient(s.token));
  env.clock.advance(60_000);
  const ev = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 10_000 });
  const shot = await screenshot(c, ev, env.clock.t - 15_000, { person: 'alice', faces: 2 });
  if (submit) json(await c.req('POST', '/api/candidate/submit'));
  return { id: s.id, shot };
}

/** A decided identity-sample burst frame with face geometry and an (already cleared on decision in production) embedding. */
async function addSampleFrame(sessionId: string) {
  const at = new Date(env.clock.t - 30_000);
  await env.ctx.db.insert(identitySampleFrames).values({
    sessionId,
    sampleId: `s-${sessionId.slice(0, 8)}`,
    burstId: `b-${sessionId.slice(0, 8)}`,
    burstIndex: 0,
    burstSize: 3,
    trigger: 'periodic',
    capturedAt: at,
    receivedAt: at,
    analysis: {
      faceCount: 1,
      quality: { faceCount: 1, detectionScore: 0.9, interEyePx: 60, faceWidthRatio: 0.3, brightness: 120, contrast: 40, sharpness: 300, yawDeg: 0, pitchDeg: 0, cutOff: false, issues: [], usable: true },
      pose: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
      dhash: '0000000000000000',
      imageBrightness: 120,
      width: 640,
      height: 480,
      box: { x: 200, y: 120, w: 200, h: 240 },
      landmarks: [{ x: 250, y: 200 }, { x: 350, y: 200 }, { x: 300, y: 250 }, { x: 260, y: 300 }, { x: 340, y: 300 }],
      score: 0.9,
    },
    similarity: 0.9,
    decision: 'match',
    llr: -4,
    embeddingEnc: Buffer.from([1, 2, 3]),
  });
}
const sampleFramesOf = (sessionId: string) => env.ctx.db.select().from(identitySampleFrames).where(eq(identitySampleFrames.sessionId, sessionId));

const evidenceOf = (sessionId: string) => env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, sessionId));
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];
const purgeAudits = (sessionId: string) => env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'retention.purge'), eq(auditLog.targetId, sessionId)));

beforeAll(async () => {
  env = await createTestEnv();
  const { exam: shortExam } = await env.newExam({ title: 'Short retention', policy: { retention: { evidenceDays: 7 } } });
  ids.a = (await finishedSession(undefined, 'Anna Default')).id;
  const b = await finishedSession(shortExam.id, 'Ben Short');
  ids.b = b.id;
  screenshotB = b.shot;
  ids.held = (await finishedSession(undefined, 'Hana Hold')).id;
  ids.active = (await finishedSession(undefined, 'Ivan Active', false)).id;
  endedAt = env.clock.t;
  for (const id of [ids.a, ids.b, ids.held]) await addSampleFrame(id);
  const admin = await staffApi(env, 'admin');
  json(await admin.post(`/sessions/${ids.held}/legal-hold`, { enabled: true }));
});
afterAll(async () => env?.close());

describe('evidence retention', () => {
  it('does nothing before any retention period has passed', async () => {
    env.clock.set(endedAt + 6 * DAY_MS);
    const s = await runRetention(env.ctx);
    expect(s).toMatchObject({ sessionsEvidencePurged: 0, evidenceItemsPurged: 0, sessionsEventMetadataPurged: 0, failures: [] });
  });

  it('purges a session after its exam’s evidence period: blobs deleted, tombstones, templates cleared, audited', async () => {
    const before = await evidenceOf(ids.b);
    expect(before.length).toBeGreaterThan(2);
    const files = before.map((e) => env.storage.resolveKey(e.storageKey));
    expect(files.every((f) => existsSync(f))).toBe(true);

    env.clock.set(endedAt + 7 * DAY_MS + 1000);
    const s = await runRetention(env.ctx);
    expect(s.sessionsEvidencePurged).toBe(1);
    expect(s.evidenceItemsPurged).toBe(before.length);
    expect(s.sessions.map((x) => x.sessionId)).toEqual([ids.b]);

    expect(files.some((f) => existsSync(f))).toBe(false);
    const after = await evidenceOf(ids.b);
    expect(after).toHaveLength(before.length); // tombstones remain
    expect(after.every((e) => e.purgedAt?.getTime() === env.clock.t && e.purgeReason === 'retention')).toBe(true);
    const refs = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, ids.b));
    expect(refs.every((r) => r.embeddingsEnc === null && r.purgedAt != null)).toBe(true);
    const frames = await env.ctx.db.select().from(checkFrames).where(eq(checkFrames.sessionId, ids.b));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.embeddingEnc === null && !('landmarks' in f.analysis) && !('box' in f.analysis))).toBe(true);
    // Identity-sample burst frames lose embeddings and face geometry with the images; their metadata stays until phase 2.
    const sf = await sampleFramesOf(ids.b);
    expect(sf).toHaveLength(1);
    expect(sf.every((f) => f.embeddingEnc === null && !('landmarks' in f.analysis) && !('box' in f.analysis) && f.similarity === 0.9)).toBe(true);
    expect((await sampleFramesOf(ids.held))[0].analysis.landmarks).not.toBeNull();
    expect((await sessionRow(ids.b)).evidencePurgedAt?.getTime()).toBe(env.clock.t);
    const audits = await purgeAudits(ids.b);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', orgId: env.org.id, targetType: 'session' });
    expect(audits[0].meta).toMatchObject({ evidence: { itemsPurged: before.length }, eventMetadata: null });

    // Other sessions are untouched (default 30 days; active session never ended).
    for (const id of [ids.a, ids.held, ids.active]) expect((await evidenceOf(id)).every((e) => e.purgedAt == null)).toBe(true);

    // Staff see a 410 for the image and a tombstone in the event; the report says so.
    const reviewer = await staffApi(env, 'reviewer');
    expect((await reviewer.get(`/evidence/${screenshotB}`)).statusCode).toBe(410);
    const evs = json(await reviewer.get(`/sessions/${ids.b}/events`, { type: 'multiple_people' })).items;
    expect(evs[0].evidence[0]).toMatchObject({ id: screenshotB, available: false, purgedAt: env.clock.t });
    const report = json(await reviewer.get(`/sessions/${ids.b}/report`));
    expect(report.limitations.join('\n')).toMatch(/deleted on .* under the retention policy; the event records remain/);
  });

  it('is idempotent', async () => {
    const s = await runRetention(env.ctx);
    expect(s).toMatchObject({ sessionsEvidencePurged: 0, evidenceItemsPurged: 0 });
    expect(await purgeAudits(ids.b)).toHaveLength(1);
  });

  it('uses the organisation default and respects legal hold', async () => {
    env.clock.set(endedAt + 30 * DAY_MS + 1000);
    const s = await runRetention(env.ctx);
    expect(s.sessions.map((x) => x.sessionId)).toEqual([ids.a]);
    expect(s.skippedLegalHold).toBe(1);
    expect((await evidenceOf(ids.a)).every((e) => e.purgeReason === 'retention')).toBe(true);
    const held = await evidenceOf(ids.held);
    expect(held.every((e) => e.purgedAt == null && existsSync(env.storage.resolveKey(e.storageKey)))).toBe(true);
    expect((await sessionRow(ids.held)).evidencePurgedAt).toBeNull();
    expect((await evidenceOf(ids.active)).every((e) => e.purgedAt == null)).toBe(true);
  });
});

describe('event metadata retention', () => {
  it('dry run reports without deleting', async () => {
    env.clock.set(endedAt + 365 * DAY_MS + 1000);
    const s = await runRetention(env.ctx, { dryRun: true });
    expect(s.dryRun).toBe(true);
    expect(s.sessions.map((x) => x.sessionId).sort()).toEqual([ids.a, ids.b].sort());
    expect(s.eventsDeleted).toBeGreaterThan(0);
    expect((await env.ctx.db.select().from(events).where(eq(events.sessionId, ids.a))).length).toBeGreaterThan(0);
    expect(await purgeAudits(ids.a)).toHaveLength(1);
  });

  it('deletes events, identity checks, frames and tombstones after eventRetentionDays; keeps the session record', async () => {
    const s = await runRetention(env.ctx);
    expect(s.sessionsEventMetadataPurged).toBe(2);
    for (const id of [ids.a, ids.b]) {
      expect(await env.ctx.db.select().from(events).where(eq(events.sessionId, id))).toHaveLength(0);
      expect(await env.ctx.db.select().from(identityChecks).where(eq(identityChecks.sessionId, id))).toHaveLength(0);
      expect(await env.ctx.db.select().from(checkFrames).where(eq(checkFrames.sessionId, id))).toHaveLength(0);
      expect(await sampleFramesOf(id)).toHaveLength(0);
      expect(await evidenceOf(id)).toHaveLength(0);
      expect((await env.ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, id))).length).toBeGreaterThan(0);
      expect((await sessionRow(id)).status).toBe('submitted');
      const audits = await purgeAudits(id);
      expect(audits).toHaveLength(2);
      expect(audits.find((a) => a.meta.eventMetadata != null)!.meta.eventMetadata).toMatchObject({ events: expect.any(Number), identityChecks: expect.any(Number) });
    }
    // legal hold and the unfinished session keep everything
    expect((await env.ctx.db.select().from(events).where(eq(events.sessionId, ids.held))).length).toBeGreaterThan(0);
    expect(await sampleFramesOf(ids.held)).toHaveLength(1);
    expect((await env.ctx.db.select().from(events).where(eq(events.sessionId, ids.active))).length).toBeGreaterThan(0);
    // the report still renders from what remains
    const reviewer = await staffApi(env, 'reviewer');
    const r = json(await reviewer.get(`/sessions/${ids.a}/report`));
    expect(r.periods.length).toBeGreaterThan(0);
    expect(r.notableEvents).toHaveLength(0);
    expect((await runRetention(env.ctx)).sessionsEventMetadataPurged).toBe(0);
  });

  it('purges everything in one run once a legal hold is lifted (one audit entry)', async () => {
    const admin = await staffApi(env, 'admin');
    json(await admin.post(`/sessions/${ids.held}/legal-hold`, { enabled: false }));
    const s = await runRetention(env.ctx);
    expect(s.sessions).toEqual([expect.objectContaining({ sessionId: ids.held, evidencePurged: expect.any(Number), eventMetadata: expect.objectContaining({ events: expect.any(Number) }) })]);
    expect(await evidenceOf(ids.held)).toHaveLength(0);
    const audits = await purgeAudits(ids.held);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta.evidence).not.toBeNull();
    expect(audits[0].meta.eventMetadata).not.toBeNull();
    const remaining = await env.ctx.db.select().from(evidence).where(isNull(evidence.purgedAt));
    expect(remaining.every((e) => e.sessionId === ids.active || e.sessionId == null)).toBe(true);
  });
});

describe('exclusive runs and scheduler', () => {
  it('skips the run while another instance holds the lock', async () => {
    const client = await env.ctx.database.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [RETENTION_LOCK_KEY]);
      expect(await runRetentionExclusive(env.ctx)).toBeNull();
      await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]);
    } finally {
      client.release();
    }
    expect(await runRetentionExclusive(env.ctx)).toMatchObject({ failures: [] });
  });

  it('scheduler runs on demand and stops cleanly', async () => {
    const sched = startRetentionScheduler(env.ctx, { initialDelayMs: 60_000 });
    const [a, b] = await Promise.all([sched.runNow(), sched.runNow()]);
    expect(a).toBe(b); // concurrent calls share one run
    expect(a).toMatchObject({ failures: [] });
    await sched.stop();
    expect(await sched.runNow()).toBeNull();
  });
});
