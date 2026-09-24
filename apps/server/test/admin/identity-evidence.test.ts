/**
 * Staff API: identity comparison view (possible person swap, unable-to-verify, ID-photo mismatch) and
 * evidence image access (audited, org-scoped, 410 once purged). Data is produced by driving the real
 * candidate API with FakeVisionService frames.
 */
import { DEFAULT_IDENTITY_THRESHOLDS as T, type IdentityComparisonDTO, type SessionReportDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, events, evidence } from '../../src/db/schema.js';
import { purgeSessionEvidence } from '../../src/services/evidence.js';
import { consent, DEVICE, runCheck, sample, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { json, MIN, otherOrg, staffApi, type Api } from './fixtures.js';

let env: TestEnv;
let reviewer: Api;
let admin: Api;

beforeAll(async () => {
  env = await createTestEnv();
  reviewer = await staffApi(env, 'reviewer');
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

const eventOf = async (sessionId: string, type: string) => (await env.ctx.db.select().from(events).where(and(eq(events.sessionId, sessionId), eq(events.type, type as never))))[0];

describe('possible person swap after a resume', () => {
  let sessionId: string;
  let mismatchId: string;
  let cmp: IdentityComparisonDTO;

  beforeAll(async () => {
    const c = await startedSession(env);
    sessionId = env.session.id;
    env.clock.advance(MIN);
    expect(json(await sample(env, c, { person: 'alice' })).result.decision).toBe('match');
    expect(json(await c.req('POST', '/api/candidate/pause', { reason: 'Break' })).outcome).toBe('paused');
    env.clock.advance(20 * MIN);
    // Resumes in a darker room with another camera: context only.
    const resumed = await runCheck(env, c, 'resume', { spec: { person: 'alice', brightness: 60 }, device: { ...DEVICE, cameraLabel: 'USB Camera', cameraIdHash: 'cam-hash-b' } });
    expect(resumed.complete!.outcome).toBe('passed');
    env.clock.advance(30_000);
    const s1 = json(await sample(env, c, { person: 'bob', brightness: 60 }));
    expect(s1.result.decision).toBe('mismatch');
    env.clock.advance(4_000);
    const s2 = json(await sample(env, c, { person: 'bob', brightness: 60 }, 'follow_up'));
    expect(s2.status).toBe('on_hold');
    mismatchId = (await eventOf(sessionId, 'identity_mismatch')).id;
    cmp = json(await reviewer.get(`/identity/compare/${mismatchId}`));
  });

  it('returns the reference that was active, the later probes and the last clean match', () => {
    expect(cmp.eventId).toBe(mismatchId);
    expect(cmp.reference.purpose).toBe('check-in reference');
    expect(cmp.reference.images.length).toBeGreaterThan(0);
    expect(cmp.reference.images.every((i) => i.available && i.url.startsWith('/api/admin/evidence/'))).toBe(true);
    const decisions = cmp.probes.map((p) => `${p.check.trigger}:${p.check.decision}`);
    expect(decisions).toEqual(['resume:match', 'periodic:mismatch', 'follow_up:mismatch']);
    expect(cmp.probes.slice(1).every((p) => p.image != null && p.image.kind === 'identity_probe')).toBe(true);
    const ats = cmp.probes.map((p) => p.check.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(cmp.reference.createdAt).toBeLessThan(ats[0]);
  });

  it('reports the similarity range of the later images against the organisation thresholds', () => {
    expect(cmp.similarity).toEqual({ min: 0, max: 0, thresholds: { match: T.match, mismatch: T.mismatch } });
  });

  it('includes the surrounding timeline: pause, resume, camera change, hold', () => {
    const labels = cmp.surrounding.map((i) => (i.kind === 'period' ? `period:${i.period.kind}` : i.kind === 'event' ? `event:${i.event.type}` : `check:${i.check.trigger}`));
    expect(labels).toEqual(expect.arrayContaining(['period:paused', 'event:session_resumed', 'event:camera_changed', 'event:identity_mismatch', 'event:session_held', 'check:resume']));
    const ev = cmp.surrounding.find((i) => i.kind === 'event' && i.event.type === 'identity_mismatch');
    expect(ev).toBeDefined();
    // everything within +/- 10 minutes of the event start (spans overlapping the window count)
    const start = (ev as { at: number }).at;
    for (const i of cmp.surrounding) {
      const end = i.kind === 'period' ? (i.period.endedAt ?? Infinity) : i.kind === 'event' ? (i.event.endedAt ?? Infinity) : i.at;
      expect(i.at).toBeLessThanOrEqual(start + 10 * MIN);
      expect(end).toBeGreaterThanOrEqual(start - 10 * MIN);
    }
  });

  it('describes environment differences as context only', () => {
    const notes = cmp.environmentNotes.join('\n');
    expect(notes).toMatch(/different camera was in use .*USB Camera/);
    expect(notes).toMatch(/darker in the later images/);
    expect(notes).toMatch(/lighting .*differed/i);
    for (const n of cmp.environmentNotes) {
      expect(n).not.toMatch(/cheat|imposter|impostor|fraud/i);
      if (/different person/.test(n)) expect(n).toMatch(/not evidence of a different person/);
    }
  });

  it('summarises the swap observationally in the report', async () => {
    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${sessionId}/report`));
    expect(r.identity.summary).toMatch(/^A different face may have appeared after the resume at \d\d:\d\d UTC with a different camera; this was held for review\.$/);
    expect(r.identity.mismatches).toBe(2);
    expect(r.notableEvents[0].type).toBe('identity_mismatch');
    expect(r.observations.join('\n')).toMatch(/on hold from .* because a possible different person was observed; it is still on hold\./);
    const tz = json<SessionReportDTO>(await reviewer.get(`/sessions/${sessionId}/report`, { tz: 'Europe/Berlin' }));
    expect(tz.identity.summary).toMatch(/after the resume at \d\d:\d\d (CEST|GMT\+2)/);
  });

  it('serves evidence images decrypted, uncached and audited; 410 once purged', async () => {
    const img = cmp.probes[1].image!;
    const res = await reviewer.get(`/evidence/${img.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const views = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'evidence.view'), eq(auditLog.targetId, img.id)));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ actorType: 'staff', actorId: env.users.reviewer.id, orgId: env.org.id });
    expect(views[0].meta).toMatchObject({ kind: 'identity_probe', sessionId, available: true });

    // Stored encrypted: the blob on disk is not the JPEG.
    const [row] = await env.ctx.db.select().from(evidence).where(eq(evidence.id, img.id));
    const blob = await env.storage.get(row.storageKey);
    expect(blob!.subarray(0, 4).toString()).toBe('SPE1');

    // Another organisation's staff cannot read it (and nothing is audited for them as a view of our data).
    const other = await otherOrg(env);
    expect((await other.api.get(`/evidence/${img.id}`)).statusCode).toBe(404);

    await purgeSessionEvidence(env.ctx, env.ctx.db, sessionId, 'retention');
    const gone = await reviewer.get(`/evidence/${img.id}`);
    expect(gone.statusCode).toBe(410);
    expect(gone.headers['cache-control']).toBe('private, no-store');
    expect(gone.json()).toMatchObject({ error: 'evidence_purged' });
    expect(gone.json().message).toMatch(/deleted .* under the retention policy/);
    const after = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'evidence.view'), eq(auditLog.targetId, img.id)));
    expect(after).toHaveLength(2);
    expect(after.map((a) => a.meta.available).sort()).toEqual([false, true]);

    // The comparison still works and shows tombstones.
    const again = json<IdentityComparisonDTO>(await reviewer.get(`/identity/compare/${mismatchId}`));
    expect(again.reference.images.every((i) => !i.available && i.purgedAt != null)).toBe(true);
  });
});

describe('identity could not be verified', () => {
  it('is presented as uncertain with quality context, never as a different person', async () => {
    const cand = await env.newCandidate('Uma Unclear');
    const s = await env.newSession({ candidateId: cand.id });
    const c = await startedSession(env, env.candidateClient(s.token));
    for (let i = 0; i < 3; i++) {
      env.clock.advance(10_000);
      expect(json(await sample(env, c, { person: 'alice', usable: false, issues: ['too_dark'], brightness: 25 })).result.decision).toBe('unable_to_verify');
    }
    const ev = await eventOf(s.id, 'identity_unverifiable');
    expect(ev.category).toBe('uncertain');
    const cmp = json<IdentityComparisonDTO>(await reviewer.get(`/identity/compare/${ev.id}`));
    expect(cmp.reference.purpose).toBe('check-in reference');
    expect(cmp.probes.filter((p) => p.check.decision === 'unable_to_verify').length).toBeGreaterThanOrEqual(1);
    expect(cmp.similarity.thresholds).toEqual({ match: T.match, mismatch: T.mismatch });
    expect(cmp.environmentNotes.join(' ')).toMatch(/not clear enough for a dependable comparison \(too dark\); “unable to verify” results are not evidence of a different person/);

    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${s.id}/report`));
    expect(r.identity.mismatches).toBe(0);
    expect(r.identity.unableToVerify).toBe(3);
    expect(r.identity.summary).toMatch(/identity could not be verified at .* because the image was not clear enough, which is not evidence of a different person\.$/);
    expect(r.identity.summary).not.toMatch(/different face may have appeared/);
    expect(r.observations.join('\n')).not.toMatch(/different face may have appeared/);
  });
});

describe('ID photo mismatch at check-in', () => {
  it('compares against the approved ID photo uploaded through the admin API', async () => {
    const created = json(await admin.post('/candidates', { name: 'Ivy Photo', email: 'ivy@candidate.example', externalId: 'IVY-1' }));
    const up = json(await admin.jpeg(`/candidates/${created.id}/id-photo`, { person: 'photo-owner' }));
    expect(up.accepted).toBe(true);
    const { exam } = await env.newExam({ title: 'Photo Exam', policy: { identity: { idPhotoComparison: 'advisory' } } });
    const assigned = json(await admin.post(`/exams/${exam.id}/assignments`, { candidateIds: [created.id] }));
    const token = assigned.items[0].accessLink.split('/take/')[1];
    const c = env.candidateClient(token);
    await consent(c);
    const chk = await runCheck(env, c, 'initial', { spec: { person: 'someone-else' } });
    expect(chk.complete!.outcome).toBe('passed');
    expect(chk.complete!.idPhoto).toMatchObject({ decision: 'mismatch' });
    const ev = await eventOf(assigned.items[0].sessionId, 'identity_mismatch');
    const cmp = json<IdentityComparisonDTO>(await reviewer.get(`/identity/compare/${ev.id}`));
    expect(cmp.reference.purpose).toBe('approved ID photo');
    expect(cmp.reference.images).toHaveLength(1);
    expect(cmp.reference.images[0].kind).toBe('id_photo');
    expect(cmp.similarity.thresholds).toEqual({ match: T.idPhotoMatch, mismatch: T.idPhotoMismatch });
    expect(cmp.probes.map((p) => p.check.trigger)).toEqual(['id_photo']);
    expect(cmp.similarity.min).toBe(0);
    const img = await reviewer.get(`/evidence/${cmp.reference.images[0].id}`);
    expect(img.statusCode).toBe(200);

    const r = json<SessionReportDTO>(await reviewer.get(`/sessions/${assigned.items[0].sessionId}/report`));
    expect(r.identity.summary).toBe('The person at check-in may not match the approved ID photo (similarity 0.00); this was flagged for review.');
    expect(r.identity.idPhoto).toMatchObject({ decision: 'mismatch' });
  });

  it("keeps the compared photo as the session's evidence: listed with the event, kept when the photo on file changes, purged with the session (e2e 16/17)", async () => {
    const created = json(await admin.post('/candidates', { name: 'Jo Photo', externalId: 'JO-1' }));
    expect(json(await admin.jpeg(`/candidates/${created.id}/id-photo`, { person: 'photo-owner-2' })).accepted).toBe(true);
    const { exam } = await env.newExam({ title: 'Photo Exam 2', policy: { identity: { idPhotoComparison: 'advisory' } } });
    const assigned = json(await admin.post(`/exams/${exam.id}/assignments`, { candidateIds: [created.id] }));
    const sessionId: string = assigned.items[0].sessionId;
    const c = env.candidateClient(assigned.items[0].accessLink.split('/take/')[1]);
    await consent(c);
    expect((await runCheck(env, c, 'initial', { spec: { person: 'someone-else-2' } })).complete!.idPhoto).toMatchObject({ decision: 'mismatch' });
    const ev = await eventOf(sessionId, 'identity_mismatch');

    // Listed with its event (staff event drawer), as this session's evidence.
    const listed = json<{ items: { id: string; evidence: { id: string; kind: string }[] }[] }>(await reviewer.get(`/sessions/${sessionId}/events`)).items.find((e) => e.id === ev.id)!;
    expect(listed.evidence.map((x) => x.kind)).toContain('id_photo');
    const [copy] = await env.ctx.db.select().from(evidence).where(and(eq(evidence.eventId, ev.id), eq(evidence.kind, 'id_photo')));
    expect(copy.sessionId).toBe(sessionId);
    expect(listed.evidence.find((x) => x.kind === 'id_photo')!.id).toBe(copy.id);

    // Replacing, then removing the photo on file keeps the exact photo that was compared.
    expect(json(await admin.jpeg(`/candidates/${created.id}/id-photo`, { person: 'photo-owner-2' })).accepted).toBe(true);
    expect((await reviewer.get(`/evidence/${copy.id}`)).statusCode).toBe(200);
    const cmp = json<IdentityComparisonDTO>(await reviewer.get(`/identity/compare/${ev.id}`));
    expect(cmp.reference.images.map((i) => i.id)).toEqual([copy.id]);
    expect(cmp.reference.purpose).toBe('approved ID photo');
    expect((await admin.del(`/candidates/${created.id}/id-photo`)).statusCode).toBe(200);
    expect((await reviewer.get(`/evidence/${copy.id}`)).statusCode).toBe(200);

    // The session's evidence purge (retention) deletes it with the session's other images.
    await purgeSessionEvidence(env.ctx, env.ctx.db, sessionId, 'retention');
    expect((await reviewer.get(`/evidence/${copy.id}`)).statusCode).toBe(410);
  });
});
