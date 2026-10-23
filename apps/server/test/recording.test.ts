/**
 * Exam recording (policy.recording; services/recordings.ts): the notice and consent, segment uploads (policy, control,
 * idempotency, pauses, the per-session cap, late uploads after the end, consent withdrawal), storage as encrypted
 * evidence in the organisation's location, the staff list and media (Range, audit), and the evidence life cycle —
 * retention, legal hold, the personal-data export, erasure, storage:move and rekey — on recordings.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIVACY_NOTICE_VERSION, RECORDING_NOTICE_VERSION, type CandidateSessionState, type RecordingSegmentUploadResponse, type SessionRecordingDTO } from '@sp/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, evidence, examSessions, recordingSegments, type EvidenceRow } from '../src/db/schema.js';
import { createKeyring, keyIdFor, sha256Hex } from '../src/lib/crypto.js';
import { FsStorage } from '../src/lib/storage.js';
import { readEvidence, storageFor } from '../src/services/evidence.js';
import { rekeyAll } from '../src/services/rekey.js';
import { DAY_MS, runRetention } from '../src/services/retention.js';
import { sessionEvidenceUsage } from '../src/services/session-limits.js';
import { moveOrgEvidence } from '../src/services/storage-move.js';
import { clientEvent, json, MIN, otherOrg, staffApi, type Api } from './admin/fixtures.js';
import { consent, runCheck, startedSession } from './flow.js';
import { createTestEnv, type CandidateClient, type TestEnv } from './helpers.js';
import { readZip } from './zip-reader.js';

const RECORDING_POLICY = { recording: { enabled: true } };

/** A WebM-looking body (EBML header + random bytes: random data does not compress, so it shows encryption too). */
const webm = (n = 2000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(n)]);

interface SegmentQuery {
  stream: 'camera' | 'screen';
  seq: number;
  startedAt: number;
  durationMs?: number;
  instance?: string;
}

function upload(env: TestEnv, c: CandidateClient, q: SegmentQuery, body: Buffer = webm(), type = 'video/webm;codecs=vp8,opus') {
  const query: Record<string, string> = { stream: q.stream, seq: String(q.seq), startedAt: String(q.startedAt), durationMs: String(q.durationMs ?? 30_000) };
  if (q.instance) query.instance = q.instance;
  return env.app.inject({
    method: 'POST',
    url: '/api/candidate/recordings/segments',
    query,
    headers: { authorization: `Bearer ${c.token}`, 'x-client-instance': c.instanceId, 'content-type': type },
    payload: body,
  });
}

const state = async (c: CandidateClient) => json<CandidateSessionState>(await c.req('GET', '/api/candidate/session'));
const evidenceRow = async (env: TestEnv, id: string): Promise<EvidenceRow> => (await env.ctx.db.select().from(evidence).where(eq(evidence.id, id)))[0];
const segmentRows = (env: TestEnv, sessionId: string) => env.ctx.db.select().from(recordingSegments).where(eq(recordingSegments.sessionId, sessionId));
const audits = (env: TestEnv, action: string) => env.ctx.db.select().from(auditLog).where(eq(auditLog.action, action));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe('exam recording', () => {
  let env: TestEnv;
  let admin: Api;
  let reviewer: Api;

  beforeAll(async () => {
    env = await createTestEnv({ policy: RECORDING_POLICY });
  });
  // Staff cookies expire after an hour of test-clock time; tests move the clock by days.
  beforeEach(async () => {
    admin = await staffApi(env, 'admin');
    reviewer = await staffApi(env, 'reviewer');
  });
  afterAll(async () => env?.close());

  /** A new session of `examId` (default: the recording exam) for a new candidate, started. */
  async function started(name: string, examId?: string) {
    const cand = await env.newCandidate(name);
    const s = await env.newSession({ candidateId: cand.id, examId });
    const c = await startedSession(env, env.candidateClient(s.token));
    return { cand, s, c };
  }

  it('an exam without recording keeps the notice it had and refuses segments', async () => {
    const { exam } = await env.newExam({ policy: {} });
    const cand = await env.newCandidate('Nora Norecord');
    const s = await env.newSession({ candidateId: cand.id, examId: exam.id });
    const c = env.candidateClient(s.token);
    const notice = (await state(c)).consent.notice;
    expect(notice.version).toBe(PRIVACY_NOTICE_VERSION);
    expect(notice.recording).toBeUndefined();
    expect(notice.notStored).toContain('No continuous video or audio recording.');
    expect(notice.notStored).toContain('No screen recording, and no monitoring of other applications, other monitors or other devices.');
    await startedSession(env, c);
    expect(json(await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t }), 409)).toMatchObject({ error: 'recording_not_enabled' });
    // The browser never reports recording events for it either.
    const res = json(
      await c.req('POST', '/api/candidate/events/batch', {
        events: [{ id: crypto.randomUUID(), type: 'screen_share_stopped', phase: 'open', startedAt: env.clock.t, endedAt: null, confidence: 1, details: {}, version: 1, clientInstanceId: c.instanceId }],
      }),
    );
    expect(res.results[0]).toMatchObject({ result: 'rejected', reason: 'disabled_by_policy' });
  });

  it('shows the recording notice, which must be the one accepted, before anything is recorded', async () => {
    const cand = await env.newCandidate('Rita Recorded');
    const s = await env.newSession({ candidateId: cand.id });
    const c = env.candidateClient(s.token);
    const notice = (await state(c)).consent.notice;
    expect(notice.version).toBe(RECORDING_NOTICE_VERSION);
    expect(notice.recording).toEqual({ camera: true, audio: true, screen: true });
    expect(notice.monitored[0]).toMatch(/The whole exam is recorded: your webcam video, the sound from your microphone and your entire screen/);
    expect(notice.stored.join(' ')).toMatch(/The recording of your exam/);
    expect(notice.notStored).not.toContain('No continuous video or audio recording.');
    expect(notice.sections.find((x) => x.heading === 'How long it is kept')!.body).toMatch(/The recording of your exam is kept in the same place as these images and deleted at the same time: 30 days/);
    expect(notice.sections.find((x) => x.heading === 'Who can see your data')!.body).toMatch(/watch the recording/);
    // Accepting the notice without recording does not count.
    expect(json(await c.req('POST', '/api/candidate/consent', { noticeVersion: PRIVACY_NOTICE_VERSION, accepted: true }), 409)).toMatchObject({ error: 'notice_outdated', details: { currentVersion: RECORDING_NOTICE_VERSION } });
    await consent(c);
    const after = await state(c);
    expect(after.consent.accepted).toBe(true);
    const [row] = await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, s.id));
    expect(row.consentNoticeVersion).toBe(RECORDING_NOTICE_VERSION);
  });

  it('a consent given before recording was turned on does not cover it: the candidate agrees again before the start', async () => {
    const cand = await env.newCandidate('Carl Changed');
    const s = await env.newSession({ candidateId: cand.id });
    const c = env.candidateClient(s.token);
    await consent(c);
    expect((await runCheck(env, c, 'initial')).complete!.outcome).toBe('passed');
    // As if the candidate had agreed while the exam did not record yet.
    await env.ctx.db.update(examSessions).set({ consentNoticeVersion: PRIVACY_NOTICE_VERSION }).where(eq(examSessions.id, s.id));
    expect((await state(c)).consent.accepted).toBe(false);
    expect(json(await c.req('POST', '/api/candidate/start'), 409)).toMatchObject({ error: 'consent_required' });
    await consent(c);
    expect((await state(c)).consent.accepted).toBe(true);
    expect(json(await c.req('POST', '/api/candidate/start')).session.status).toBe('active');
  });

  it('stores segments as encrypted evidence; idempotent re-uploads; staff list and play them (Range), every view audited', async () => {
    const { s, c } = await started('Sam Segments');
    env.clock.advance(30_000);
    const t0 = env.clock.t - 30_000;
    const body = webm(5000);
    const first = json<RecordingSegmentUploadResponse>(await upload(env, c, { stream: 'camera', seq: 0, startedAt: t0, durationMs: 30_000 }, body));
    expect(first).toMatchObject({ stored: true, duplicate: false });
    expect(json(await upload(env, c, { stream: 'camera', seq: 0, startedAt: t0 }, body))).toEqual({ stored: true, duplicate: true, segmentId: first.segmentId });
    json(await upload(env, c, { stream: 'screen', seq: 0, startedAt: t0 + 200, durationMs: 29_500 }, webm(3000), 'video/webm;codecs=vp9'));
    // Safari records MP4: accepted and kept as such.
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), randomBytes(1000)]);
    json(await upload(env, c, { stream: 'camera', seq: 1, startedAt: t0 + 30_000, durationMs: 1000 }, mp4, 'video/mp4'));

    const segs = await segmentRows(env, s.id);
    expect(segs.map((x) => [x.stream, x.seq]).sort()).toEqual([['camera', 0], ['camera', 1], ['screen', 0]]);
    const cam0 = segs.find((x) => x.stream === 'camera' && x.seq === 0)!;
    expect(cam0).toMatchObject({ durationMs: 30_000, mimeType: 'video/webm;codecs=vp8,opus', byteSize: body.length, clientInstanceId: c.instanceId, orgId: env.org.id });
    const row = await evidenceRow(env, cam0.evidenceId);
    expect(row).toMatchObject({ kind: 'recording', reason: 'camera', contentType: 'video/webm', byteSize: body.length, sha256: sha256Hex(body), storageLocation: null, sessionId: s.id, eventId: null });
    // Encrypted at rest exactly like images: the file is not the recording; it decrypts back to it.
    const stored = await env.storage.get(row.storageKey);
    expect(stored!.includes(body.subarray(100, 400))).toBe(false);
    expect((await readEvidence(env.ctx, row))!.equals(body)).toBe(true);
    expect((await evidenceRow(env, segs.find((x) => x.seq === 1)!.evidenceId)).contentType).toBe('video/mp4');
    // Recordings never take room from the images' budget.
    expect((await sessionEvidenceUsage(env.ctx.db, s.id)).bytes).toBeLessThan(body.length);

    // Staff: the list (metadata only) and the media.
    const list = json<SessionRecordingDTO>(await reviewer.get(`/sessions/${s.id}/recordings`));
    expect(list.segments).toHaveLength(3);
    expect(list.segments[0]).toMatchObject({ id: cam0.id, stream: 'camera', seq: 0, startedAt: t0, durationMs: 30_000, endedAt: t0 + 30_000, available: true, deletedAt: null });
    expect(list.streams.camera).toMatchObject({ segments: 2, durationMs: 31_000, firstAt: t0 });
    expect(list.streams.screen).toMatchObject({ segments: 1, durationMs: 29_500 });
    const viewsBefore = (await audits(env, 'recording.view')).length;
    const full = await reviewer.get(`/recordings/${cam0.id}/media`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/webm');
    expect(full.headers['content-length']).toBe(String(body.length));
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toMatch(/no-store/);
    expect(full.rawPayload.equals(body)).toBe(true);
    const part = await reviewer.inject({ method: 'GET', url: `/api/admin/recordings/${cam0.id}/media`, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${body.length}`);
    expect(part.rawPayload.equals(body.subarray(0, 100))).toBe(true);
    const tail = await reviewer.inject({ method: 'GET', url: `/api/admin/recordings/${cam0.id}/media`, headers: { range: 'bytes=4000-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(body.subarray(4000))).toBe(true);
    expect((await reviewer.inject({ method: 'GET', url: `/api/admin/recordings/${cam0.id}/media`, headers: { range: `bytes=${body.length + 10}-` } })).statusCode).toBe(416);
    // A view is a request for the start (or all) of a part, not every seek.
    const views = (await audits(env, 'recording.view')).slice(viewsBefore);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ actorType: 'staff', actorId: env.users.reviewer.id, targetType: 'session', targetId: s.id, meta: { segmentId: cam0.id, stream: 'camera', seq: 0, available: true } });
    // The evidence URL serves it as video too.
    const asEvidence = await reviewer.get(`/evidence/${row.id}`);
    expect(asEvidence.statusCode).toBe(200);
    expect(asEvidence.headers['content-type']).toBe('video/webm');
    // Other organisations see nothing.
    const other = await otherOrg(env);
    expect((await other.api.get(`/recordings/${cam0.id}/media`)).statusCode).toBe(404);
    expect((await other.api.get(`/sessions/${s.id}/recordings`)).statusCode).toBe(404);

    // The session page and the report say what was recorded; the integration API report does not carry it.
    const detail = json(await reviewer.get(`/sessions/${s.id}`));
    expect(detail.recording).toEqual({ segments: 3, available: 3, cameraMs: 31_000, screenMs: 29_500, bytes: body.length + 3004 + mp4.length, deletedAt: null, deletedBecause: null });
    const report = json(await reviewer.get(`/sessions/${s.id}/report`));
    expect(report.recording).toMatchObject({ segments: 3 });
    expect(report.observations).toContain('The exam was recorded: 31s of webcam video and 30s of the screen (3 parts).');
    const apiKey = json(await admin.post('/api-keys', { name: 'Recording LMS' })).secret as string;
    const v1 = await env.app.inject({ method: 'GET', url: `/api/v1/sessions/${s.id}/report`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(v1.statusCode, v1.body).toBe(200);
    expect(v1.json()).not.toHaveProperty('recording');

    const metrics = await env.ctx.metrics.registry.getSingleMetricAsString('sp_recording_segments_total');
    expect(metrics).toMatch(/sp_recording_segments_total\{stream="camera"\} 2/);
  });

  it('refuses what is not a recording, a browser not in control, and parts started while the exam was paused', async () => {
    const { c } = await started('Petra Paused');
    env.clock.advance(MIN);
    expect(json(await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t - 1000 }, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), 415)).toMatchObject({ error: 'invalid_recording' });
    const asJpeg = await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t }, webm(), 'image/jpeg');
    expect(asJpeg.statusCode, asJpeg.body).toBe(415);
    const asText = await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t }, webm(), 'application/xml');
    expect(asText.statusCode, asText.body).toBe(415);
    expect((await upload(env, c, { stream: 'webcam' as 'camera', seq: 0, startedAt: env.clock.t })).statusCode).toBe(400);
    // Another browser holding the link (the exam is in control elsewhere).
    expect(json(await upload(env, c.withInstance(`inst-${randomBytes(6).toString('hex')}`), { stream: 'camera', seq: 0, startedAt: env.clock.t }), 409)).toMatchObject({ error: 'superseded' });
    expect((await env.app.inject({ method: 'POST', url: '/api/candidate/recordings/segments', query: { stream: 'camera', seq: '0', startedAt: '1', durationMs: '1' }, headers: { 'content-type': 'video/webm' }, payload: webm() })).statusCode).toBe(401);

    const beforePause = env.clock.t - 10_000;
    json(await c.req('POST', '/api/candidate/pause', {}));
    env.clock.advance(20_000);
    // Started inside the pause: dropped (nothing is recorded while paused). Started before it: still accepted.
    expect(json(await upload(env, c, { stream: 'camera', seq: 7, startedAt: env.clock.t - 5000 }))).toEqual({ stored: false, duplicate: false, segmentId: null, reason: 'during_unobserved_period' });
    expect(json(await upload(env, c, { stream: 'camera', seq: 6, startedAt: beforePause, durationMs: 9000 }))).toMatchObject({ stored: true });
    expect(json(await upload(env, c, { stream: 'camera', seq: 8, startedAt: 1000 }))).toMatchObject({ stored: false, reason: 'before_start' });
  });

  it('caps the recording of one session (413 recording_limit)', async () => {
    const { s, c } = await started('Lena Limit');
    const saved = env.ctx.config.recording.maxSessionBytes;
    env.ctx.config.recording.maxSessionBytes = 10_000;
    try {
      json(await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t }, webm(6000)));
      expect(json(await upload(env, c, { stream: 'screen', seq: 0, startedAt: env.clock.t }, webm(6000)), 413)).toMatchObject({ error: 'recording_limit' });
      expect(await segmentRows(env, s.id)).toHaveLength(1);
    } finally {
      env.ctx.config.recording.maxSessionBytes = saved;
    }
    // A body over the per-request limit never reaches the service.
    expect((await upload(env, c, { stream: 'camera', seq: 9, startedAt: env.clock.t }, webm(17 * 1024 * 1024))).statusCode).toBe(413);
  });

  it('after the exam: late parts from the last verified browser (also after a reload) for the grace period only', async () => {
    const { s, c } = await started('Leo Late');
    env.clock.advance(MIN);
    const during = env.clock.t - 20_000;
    json(await c.req('POST', '/api/candidate/submit'));
    env.clock.advance(10 * MIN);
    expect(json(await upload(env, c, { stream: 'camera', seq: 0, startedAt: during }))).toMatchObject({ stored: true });
    // A page reopened after submitting uploads what the previous page queued, as that page.
    const reloaded = c.withInstance(`inst-${randomBytes(6).toString('hex')}`);
    expect(json(await upload(env, reloaded, { stream: 'screen', seq: 0, startedAt: during, instance: c.instanceId }))).toMatchObject({ stored: true });
    expect(json(await upload(env, reloaded, { stream: 'screen', seq: 1, startedAt: during }), 409)).toMatchObject({ error: 'recording_closed' });
    expect(json(await upload(env, c, { stream: 'camera', seq: 1, startedAt: env.clock.t }))).toMatchObject({ stored: false, reason: 'after_end' });
    expect((await segmentRows(env, s.id)).map((x) => x.clientInstanceId)).toEqual([c.instanceId, c.instanceId]);
    env.clock.advance(env.ctx.config.recording.lateUploadMs);
    expect(json(await upload(env, c, { stream: 'camera', seq: 2, startedAt: during }), 409)).toMatchObject({ error: 'recording_closed' });
  });

  it('a consent withdrawal deletes the recording at once and refuses what arrives later', async () => {
    const { s, c } = await started('Wendy Withdraws');
    env.clock.advance(MIN);
    const seg = json<RecordingSegmentUploadResponse>(await upload(env, c, { stream: 'camera', seq: 0, startedAt: env.clock.t - 30_000 }));
    const [row] = await env.ctx.db.select({ e: evidence }).from(recordingSegments).innerJoin(evidence, eq(evidence.id, recordingSegments.evidenceId)).where(eq(recordingSegments.id, seg.segmentId!));
    expect(existsSync(env.storage.resolveKey(row.e.storageKey))).toBe(true);
    json(await c.req('POST', '/api/candidate/consent/withdraw', { confirm: true }));
    const after = await evidenceRow(env, row.e.id);
    expect(after).toMatchObject({ purgeReason: 'consent_withdrawn' });
    expect(existsSync(env.storage.resolveKey(row.e.storageKey))).toBe(false);
    expect(json(await upload(env, c, { stream: 'camera', seq: 1, startedAt: env.clock.t - 10_000 }), 409)).toMatchObject({ error: 'recording_closed' });
    const list = json<SessionRecordingDTO>(await reviewer.get(`/sessions/${s.id}/recordings`));
    expect(list.segments[0]).toMatchObject({ available: false, deletedBecause: 'consent_withdrawn' });
    expect(json(await reviewer.get(`/recordings/${seg.segmentId}/media`), 410)).toMatchObject({ error: 'evidence_purged' });
  });

  it('retention deletes recordings with the other evidence (not under legal hold); the export and erasure include them', async () => {
    const a = await started('Ada Archive');
    const h = await started('Hal Held');
    env.clock.advance(MIN);
    const bodies = [webm(4000), webm(3000)];
    json(await upload(env, a.c, { stream: 'camera', seq: 0, startedAt: env.clock.t - 40_000, durationMs: 20_000 }, bodies[0]));
    json(await upload(env, a.c, { stream: 'screen', seq: 0, startedAt: env.clock.t - 39_000, durationMs: 20_000 }, bodies[1], 'video/webm'));
    json(await upload(env, h.c, { stream: 'camera', seq: 0, startedAt: env.clock.t - 40_000 }));
    json(await a.c.req('POST', '/api/candidate/submit'));
    json(await h.c.req('POST', '/api/candidate/submit'));
    json(await admin.post(`/sessions/${h.s.id}/legal-hold`, { enabled: true }));

    // The retention preview counts the recording parts apart from the images.
    const preview = json(await admin.get('/retention/preview', { days: 31 }));
    expect(preview.days.reduce((n: number, d: { recordings: number }) => n + d.recordings, 0)).toBeGreaterThanOrEqual(2);
    expect(preview.legalHolds.find((x: { sessionId: string }) => x.sessionId === h.s.id)).toMatchObject({ recordings: 1 });

    // Personal-data export: the recording as playable files, with an index.
    const req = json<{ id: string }>(await admin.post('/privacy-requests', { kind: 'access', subject: 'Ada Archive', candidateId: a.cand.id }));
    const zip = readZip((await admin.get(`/privacy-requests/${req.id}/export`)).rawPayload);
    const files = [...zip.keys()];
    const recs = files.filter((n) => /\/recordings\/.+-(camera|screen)-0000\.webm$/.test(n));
    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((n) => sha256Hex(zip.get(n)!.data)))).toEqual(new Set(bodies.map(sha256Hex)));
    expect(recs.every((n) => zip.get(n)!.method === 0)).toBe(true);
    const index = JSON.parse(zip.get(files.find((n) => n.endsWith('/recording.json'))!)!.data.toString('utf8'));
    expect(index.map((p: { stream: string; durationMs: number }) => [p.stream, p.durationMs])).toEqual([
      ['camera', 20_000],
      ['screen', 20_000],
    ]);
    expect(index[0].file).toMatch(/^recordings\/.+-camera-0000\.webm$/);
    const readme = zip.get('README.txt')!.data.toString('utf8');
    expect(readme).toContain('recordings/');
    expect(readme).toContain('Recording parts included: 2.');
    const [exported] = (await audits(env, 'privacy_request.exported')).filter((x) => x.targetId === req.id);
    expect(exported.meta).toMatchObject({ recordingParts: 2, recordingPartsAlreadyDeleted: 0 });

    // Retention 31 days later: Ada's recording is deleted (files gone, tombstones kept); Hal's is kept under the hold.
    const aRows = await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, a.s.id), eq(evidence.kind, 'recording')));
    expect(aRows).toHaveLength(2);
    const summary = await runRetention(env.ctx, { now: env.clock.t + 31 * DAY_MS });
    expect(summary.failures).toEqual([]);
    for (const r of aRows) {
      expect((await evidenceRow(env, r.id)).purgeReason).toBe('retention');
      expect(existsSync(env.storage.resolveKey(r.storageKey))).toBe(false);
    }
    const listA = json<SessionRecordingDTO>(await reviewer.get(`/sessions/${a.s.id}/recordings`));
    expect(listA.segments.every((x) => !x.available && x.deletedBecause === 'retention')).toBe(true);
    expect(json(await reviewer.get(`/sessions/${a.s.id}`)).recording).toMatchObject({ segments: 2, available: 0, deletedBecause: 'retention' });
    const listH = json<SessionRecordingDTO>(await reviewer.get(`/sessions/${h.s.id}/recordings`));
    expect(listH.segments.every((x) => x.available)).toBe(true);

    // Erasure (the hold lifted): the recording's files and records are gone with the candidate.
    json(await admin.post(`/sessions/${h.s.id}/legal-hold`, { enabled: false }));
    const hRows = await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, h.s.id));
    const hFiles = hRows.filter((r) => r.kind === 'recording').map((r) => env.storage.resolveKey(r.storageKey));
    expect(hFiles.every((f) => existsSync(f))).toBe(true);
    const erase = json<{ id: string }>(await admin.post('/privacy-requests', { kind: 'erasure', subject: 'Hal Held', candidateId: h.cand.id }));
    json(await admin.post(`/privacy-requests/${erase.id}/erase`, { confirm: true }));
    expect(hFiles.filter((f) => existsSync(f))).toEqual([]);
    expect(await segmentRows(env, h.s.id)).toEqual([]);
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, h.s.id))).toEqual([]);
  });

  it('records the screen-share and recording events of an exam that records', async () => {
    const { s, c } = await started('Sid Share');
    env.clock.advance(MIN);
    await clientEvent(c, { type: 'screen_share_stopped', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 5000 });
    await clientEvent(c, { type: 'recording_interrupted', startedAt: env.clock.t - 3000, endedAt: env.clock.t - 3000, details: { stream: 'microphone', reason: 'mic_unavailable' } });
    const events = json(await reviewer.get(`/sessions/${s.id}/events`)).items as { type: string; category: string; severity: string; source: string }[];
    expect(events.find((e) => e.type === 'screen_share_stopped')).toMatchObject({ category: 'integrity', severity: 'low', source: 'client_browser' });
    expect(events.find((e) => e.type === 'recording_interrupted')).toMatchObject({ category: 'technical', severity: 'low' });
  });
});

describe('exam recording in the organisation’s storage location: storage:move and rekey', () => {
  let env: TestEnv;
  let euDir: string;
  let eu: FsStorage;

  beforeAll(async () => {
    euDir = mkdtempSync(join(tmpdir(), 'sp-evidence-eu-rec-'));
    tempDirs.push(euDir);
    env = await createTestEnv({
      policy: RECORDING_POLICY,
      env: { STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: euDir, STORAGE_LOCATION_EU_LABEL: 'EU (Frankfurt)' },
    });
    eu = new FsStorage(euDir);
  });
  afterAll(async () => env?.close());

  it('stores recordings where the organisation keeps its evidence; storage:move and rekey cover them', async () => {
    json(await (await staffApi(env, 'owner')).put('/settings', { evidenceLocation: 'eu' }));
    const c = await startedSession(env, env.candidateClient(env.session.token));
    env.clock.advance(MIN);
    const body = webm(4000);
    const seg = json<RecordingSegmentUploadResponse>(await upload(env, c, { stream: 'screen', seq: 0, startedAt: env.clock.t - 30_000 }, body));
    const [s] = await env.ctx.db.select().from(recordingSegments).where(eq(recordingSegments.id, seg.segmentId!));
    const row = await evidenceRow(env, s.evidenceId);
    expect(row.storageLocation).toBe('eu');
    expect(existsSync(eu.resolveKey(row.storageKey))).toBe(true);
    expect(existsSync(env.storage.resolveKey(row.storageKey))).toBe(false);
    const reviewer = await staffApi(env, 'reviewer');
    expect((await reviewer.get(`/recordings/${s.id}/media`)).rawPayload.equals(body)).toBe(true);

    // The passed check's frames are deleted after its response (after commit): let that finish before moving.
    await vi.waitFor(
      async () => {
        const live = await env.ctx.db.select().from(evidence).where(and(eq(evidence.orgId, env.org.id), isNull(evidence.purgedAt)));
        for (const r of live) expect(await storageFor(env.ctx, r).get(r.storageKey), r.id).not.toBeNull();
      },
      { timeout: 15_000, interval: 50 },
    );
    // storage:move back to the default location: copied, verified, switched; still playable.
    const ctx = { database: env.ctx.database, db: env.ctx.db, storage: env.ctx.storage, storageLocations: env.ctx.storageLocations, keyring: env.ctx.keyring, now: env.clock.now, log: env.ctx.log };
    const moved = await moveOrgEvidence(ctx, { orgId: env.org.id, to: 'default' });
    expect(moved.failures).toEqual([]);
    const afterMove = await evidenceRow(env, row.id);
    expect(afterMove.storageLocation).toBeNull();
    expect(existsSync(eu.resolveKey(row.storageKey))).toBe(false);
    expect(existsSync(env.storage.resolveKey(afterMove.storageKey))).toBe(true);
    expect((await reviewer.get(`/recordings/${s.id}/media`)).rawPayload.equals(body)).toBe(true);

    // rekey after a key rotation: the recording is re-encrypted with the new key, then back.
    const K1 = Buffer.alloc(32, 7);
    const K2 = randomBytes(32);
    const rekey = await rekeyAll({ ...ctx, keyring: createKeyring(K2, [K1]) }, { only: ['evidence_blobs'] });
    expect(rekey.failures).toEqual([]);
    const rekeyed = await evidenceRow(env, row.id);
    expect(rekeyed.keyId).toBe(keyIdFor(K2));
    expect((await readEvidence({ storage: env.ctx.storage, storageLocations: env.ctx.storageLocations, keyring: createKeyring(K2) }, rekeyed))!.equals(body)).toBe(true);
    expect((await rekeyAll({ ...ctx, keyring: createKeyring(K1, [K2]) }, { only: ['evidence_blobs'] })).failures).toEqual([]);
    expect((await reviewer.get(`/recordings/${s.id}/media`)).rawPayload.equals(body)).toBe(true);
  });
});
