/**
 * Privacy operations: the request register (deadlines, extensions, assignment, closing, encryption at rest, access),
 * the personal-data export (ZIP), erasure through a request, the candidate's withdrawal of consent, the retention
 * preview with the job's recorded runs, and the operational checks.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DEFAULT_PRIVACY_RESPONSE_DAYS, type OpsChecksDTO, type PrivacyRequestDTO, type PrivacyRequestsDTO, type RetentionPreviewDTO } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, candidates, evidence, examSessions, identityReferences, jobStatus, privacyRequests, webhookDeliveries } from '../src/db/schema.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { DAY_MS, runRetention } from '../src/services/retention.js';
import { clientEvent, json, MIN, otherOrg, screenshot, staffApi, type Api } from './admin/fixtures.js';
import { startedSession } from './flow.js';
import { createTestEnv, type TestEnv } from './helpers.js';
import { readZip } from './zip-reader.js';

let env: TestEnv;
let admin: Api;

const audits = (action: string, targetId?: string) =>
  env.ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), targetId ? eq(auditLog.targetId, targetId) : undefined));
const evidenceOf = (sessionId: string) => env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, sessionId));
const sessionRow = async (id: string) => (await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, id)))[0];

/** A candidate with a finished exam: check-in, an event with a screenshot, submitted. */
async function finished(name: string, opts: { submit?: boolean } = {}) {
  const cand = await env.newCandidate(name);
  const s = await env.newSession({ candidateId: cand.id });
  const c = await startedSession(env, env.candidateClient(s.token));
  env.clock.advance(MIN);
  const ev = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 10_000 });
  const shot = await screenshot(c, ev, env.clock.t - 15_000, { person: 'alice', faces: 2 });
  if (opts.submit !== false) json(await c.req('POST', '/api/candidate/submit'));
  return { cand, session: s, c, shot };
}

async function newRequest(body: Record<string, unknown>): Promise<PrivacyRequestDTO> {
  return json<PrivacyRequestDTO>(await admin.post('/privacy-requests', body));
}

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
});
afterAll(async () => env?.close());

describe('privacy request register', () => {
  it('records a request with its legal deadline; what was asked is encrypted at rest and audited', async () => {
    const receivedAt = env.clock.t - 3 * DAY_MS;
    const r = await newRequest({ kind: 'access', subject: 'Alice Candidate <alice@candidate.example>', candidateId: env.candidate.id, channel: 'email', receivedAt, details: 'Please send me a copy of everything you hold about me.' });
    expect(r).toMatchObject({
      kind: 'access',
      status: 'open',
      source: 'staff',
      channel: 'email',
      candidate: { id: env.candidate.id, name: 'Alice Candidate' },
      receivedAt,
      dueAt: receivedAt + DEFAULT_PRIVACY_RESPONSE_DAYS * DAY_MS,
      overdue: false,
      extension: null,
      details: 'Please send me a copy of everything you hold about me.',
      assignee: { id: env.users.admin.id },
      createdBy: { id: env.users.admin.id },
    });
    const [row] = await env.ctx.db.select().from(privacyRequests).where(eq(privacyRequests.id, r.id));
    expect(row.detailsEnc).toBeInstanceOf(Buffer);
    expect(row.detailsEnc!.toString('latin1')).not.toContain('copy of everything');
    expect(await audits('privacy_request.created', r.id)).toHaveLength(1);
  });

  it('is for administrators and owners only, and scoped to the organisation', async () => {
    const reviewer = await staffApi(env, 'reviewer');
    expect((await reviewer.get('/privacy-requests')).statusCode).toBe(403);
    expect((await reviewer.post('/privacy-requests', { kind: 'other', subject: 'Someone' })).statusCode).toBe(403);
    const mine = await newRequest({ kind: 'other', subject: 'Mine' });
    const other = await otherOrg(env);
    const theirs = json<PrivacyRequestsDTO>(await other.api.get('/privacy-requests', { status: 'all' }));
    expect(theirs.items.some((i) => i.id === mine.id)).toBe(false);
    expect((await other.api.get(`/privacy-requests/${mine.id}`)).statusCode).toBe(404);
    expect((await other.api.put(`/privacy-requests/${mine.id}`, { status: 'in_progress' })).statusCode).toBe(404);
    // A candidate of another organisation cannot be linked.
    expect(json(await admin.post('/privacy-requests', { kind: 'access', subject: 'Xavier', candidateId: other.candidate.id }), 404)).toMatchObject({ error: 'candidate_not_found' });
    expect(json(await admin.post('/privacy-requests', { kind: 'access', subject: 'Later', receivedAt: env.clock.t + DAY_MS }), 400)).toMatchObject({ error: 'received_in_future' });
  });

  it('extends deadlines with a reason (only ever longer), assigns to administrators, and closes with a resolution', async () => {
    const r = await newRequest({ kind: 'rectification', subject: 'Bob Example' });
    const extended = json<PrivacyRequestDTO>(await admin.put(`/privacy-requests/${r.id}`, { extension: { days: 30, reason: 'Records are archived offsite and need retrieving.' } }));
    expect(extended.dueAt).toBe(r.receivedAt + (DEFAULT_PRIVACY_RESPONSE_DAYS + 30) * DAY_MS);
    expect(extended.extension).toEqual({ days: 30, reason: 'Records are archived offsite and need retrieving.' });
    expect(json(await admin.put(`/privacy-requests/${r.id}`, { extension: { days: 20, reason: 'Shorter than before, refused.' } }), 409)).toMatchObject({ error: 'extension_not_longer' });
    expect((await admin.put(`/privacy-requests/${r.id}`, { extension: { days: 61, reason: 'Beyond the legal maximum.' } })).statusCode).toBe(400);

    expect(json(await admin.put(`/privacy-requests/${r.id}`, { assigneeId: env.users.reviewer.id }), 400)).toMatchObject({ error: 'invalid_assignee' });
    expect(json<PrivacyRequestDTO>(await admin.put(`/privacy-requests/${r.id}`, { assigneeId: env.users.owner.id })).assignee).toMatchObject({ id: env.users.owner.id });

    // Completing needs a resolution note.
    expect((await admin.put(`/privacy-requests/${r.id}`, { status: 'completed' })).statusCode).toBe(400);
    const done = json<PrivacyRequestDTO>(await admin.put(`/privacy-requests/${r.id}`, { status: 'completed', resolutionNote: 'Name corrected on the candidate record.' }));
    expect(done).toMatchObject({ status: 'completed', closedAt: env.clock.t, closedBy: { id: env.users.admin.id }, resolutionNote: 'Name corrected on the candidate record.', overdue: false });
    expect(json(await admin.put(`/privacy-requests/${r.id}`, { extension: { days: 40, reason: 'A closed request has no deadline.' } }), 409)).toMatchObject({ error: 'invalid_state' });
    const reopened = json<PrivacyRequestDTO>(await admin.put(`/privacy-requests/${r.id}`, { status: 'in_progress' }));
    expect(reopened).toMatchObject({ status: 'in_progress', closedAt: null, closedBy: null });
    expect(await audits('privacy_request.completed', r.id)).toHaveLength(1);
    expect(await audits('privacy_request.reopened', r.id)).toHaveLength(1);
  });

  it('lists open requests by deadline with overdue and due-soon counts', async () => {
    const t0 = env.clock.t;
    const late = await newRequest({ kind: 'objection', subject: 'Overdue Person', receivedAt: t0 - 31 * DAY_MS });
    const soon = await newRequest({ kind: 'restriction', subject: 'Soon Person', receivedAt: t0 - 25 * DAY_MS });
    const list = json<PrivacyRequestsDTO>(await admin.get('/privacy-requests'));
    expect(list.items[0].id).toBe(late.id);
    expect(list.items.find((i) => i.id === late.id)?.overdue).toBe(true);
    expect(list.items.find((i) => i.id === soon.id)?.overdue).toBe(false);
    expect(list.counts.overdue).toBeGreaterThanOrEqual(1);
    expect(list.counts.dueSoon).toBeGreaterThanOrEqual(1);
    expect(list.items.every((i) => i.status === 'open' || i.status === 'in_progress')).toBe(true);
    const closed = json<PrivacyRequestsDTO>(await admin.get('/privacy-requests', { status: 'closed' }));
    expect(closed.items.every((i) => i.status === 'completed' || i.status === 'rejected')).toBe(true);
    const checks = json<OpsChecksDTO>(await admin.get('/ops/checks'));
    expect(checks.checks.find((c) => c.id === 'privacy_requests')).toMatchObject({ status: 'failing' });
    for (const r of [late, soon]) json(await admin.put(`/privacy-requests/${r.id}`, { status: 'rejected', resolutionNote: 'Test cleanup.' }));
  });
});

describe('personal-data export', () => {
  it('streams a ZIP with the records and decrypted images, without credentials or answer keys; recorded and audited', async () => {
    const { cand, session, shot } = await finished('Erin Export');
    const shotRow = (await evidenceOf(session.id)).find((e) => e.id === shot)!;
    const r = await newRequest({ kind: 'access', subject: 'Erin Export', candidateId: cand.id });
    const res = await admin.get(`/privacy-requests/${r.id}/export`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="personal-data-Erin-Export-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(res.headers['cache-control']).toContain('no-store');
    const zip = readZip(res.rawPayload);
    const names = [...zip.keys()];
    expect(names).toContain('README.txt');
    expect(names).toContain('candidate.json');
    const folder = names.find((n) => n.endsWith('/session.json'))!.replace(/\/session\.json$/, '');
    expect(folder).toMatch(/^sessions\/01 Sample Exam \(\d{4}-\d{2}-\d{2}\)$/);
    for (const f of ['answers.json', 'events.json', 'identity-checks.json']) expect(names).toContain(`${folder}/${f}`);

    const candidateJson = JSON.parse(zip.get('candidate.json')!.data.toString('utf8'));
    expect(candidateJson.candidate).toMatchObject({ id: cand.id, name: 'Erin Export' });
    expect(candidateJson.sessions).toHaveLength(1);
    const sessionJson = JSON.parse(zip.get(`${folder}/session.json`)!.data.toString('utf8'));
    expect(sessionJson.report.session.accessLink).toBeNull();
    expect(sessionJson.report.identity.versions).toBeUndefined();
    expect(sessionJson.consent).toMatchObject({ privacyNoticeVersion: expect.any(String), acceptedAt: expect.any(String) });
    const answersJson = JSON.parse(zip.get(`${folder}/answers.json`)!.data.toString('utf8'));
    expect(answersJson).toHaveLength(5);
    expect(JSON.stringify(answersJson)).not.toContain('"correct"');
    const eventsJson = JSON.parse(zip.get(`${folder}/events.json`)!.data.toString('utf8'));
    const withShot = eventsJson.find((e: { evidence: { id: string }[] }) => e.evidence.some((x) => x.id === shot));
    const file = withShot.evidence.find((x: { id: string }) => x.id === shot).file as string;
    expect(file).toMatch(/^images\/.+-screenshot-[0-9a-f]{8}\.jpg$/);
    // The image is the one the candidate's browser uploaded, decrypted.
    const img = zip.get(`${folder}/${file}`)!;
    expect(img.method).toBe(0); // stored, not deflated
    expect(createHash('sha256').update(img.data).digest('hex')).toBe(shotRow.sha256);
    expect(FakeVisionService.decode(img.data)).toMatchObject({ person: 'alice', faces: 2 });
    expect(zip.get('README.txt')!.data.toString('utf8')).toContain('Personal data held about Erin Export');

    const after = json<PrivacyRequestDTO>(await admin.get(`/privacy-requests/${r.id}`));
    expect(after.exportedAt).toBe(env.clock.t);
    const [a] = await audits('privacy_request.exported', r.id);
    expect(a.meta).toMatchObject({ candidateId: cand.id, sessions: 1 });
    expect((a.meta as { images: number }).images).toBeGreaterThan(1);
  });

  it('lists images already deleted instead of including them; refuses a request without a candidate', async () => {
    const { cand, session } = await finished('Pia Purged');
    env.clock.advance(31 * DAY_MS);
    await runRetention(env.ctx);
    expect((await sessionRow(session.id)).evidencePurgedAt).not.toBeNull();
    admin = await staffApi(env, 'admin');
    const r = await newRequest({ kind: 'access', subject: 'Pia Purged', candidateId: cand.id });
    const zip = readZip((await admin.get(`/privacy-requests/${r.id}/export`)).rawPayload);
    expect([...zip.keys()].some((n) => n.endsWith('.jpg'))).toBe(false);
    const readme = zip.get('README.txt')!.data.toString('utf8');
    expect(readme).toContain('Images already deleted');
    expect(readme).toContain('(retention)');
    const loose = await newRequest({ kind: 'access', subject: 'No record' });
    expect(json(await admin.get(`/privacy-requests/${loose.id}/export`), 409)).toMatchObject({ error: 'no_candidate' });
  });
});

describe('erasure through a request', () => {
  it('erases the candidate and their records; the request keeps who it was about', async () => {
    const { cand, session, c } = await finished('Ed Erase', { submit: false });
    const access = await newRequest({ kind: 'access', subject: 'Ed Erase', candidateId: cand.id });
    expect(json(await admin.post(`/privacy-requests/${access.id}/erase`, { confirm: true }), 409)).toMatchObject({ error: 'not_an_erasure_request' });
    const r = await newRequest({ kind: 'erasure', subject: 'Ed Erase <ed@candidate.example>', candidateId: cand.id });
    expect((await admin.post(`/privacy-requests/${r.id}/erase`, {})).statusCode).toBe(400); // confirm required
    expect(json(await admin.post(`/privacy-requests/${r.id}/erase`, { confirm: true }), 409)).toMatchObject({ error: 'candidate_has_open_sessions' });
    json(await c.req('POST', '/api/candidate/submit'));
    json(await admin.post(`/sessions/${session.id}/legal-hold`, { enabled: true }));
    expect(json(await admin.post(`/privacy-requests/${r.id}/erase`, { confirm: true }), 409)).toMatchObject({ error: 'candidate_under_legal_hold' });
    json(await admin.post(`/sessions/${session.id}/legal-hold`, { enabled: false }));

    const files = (await evidenceOf(session.id)).filter((e) => !e.purgedAt).map((e) => env.storage.resolveKey(e.storageKey));
    expect(files.length).toBeGreaterThan(0);
    const out = json(await admin.post(`/privacy-requests/${r.id}/erase`, { confirm: true }));
    expect(out).toMatchObject({ sessionsDeleted: 1, request: { id: r.id, candidate: null, subject: 'Ed Erase <ed@candidate.example>', erasedAt: env.clock.t } });
    expect(out.evidencePurged).toBe(files.length);
    expect(files.some((f) => existsSync(f))).toBe(false);
    expect(await env.ctx.db.select().from(candidates).where(eq(candidates.id, cand.id))).toHaveLength(0);
    expect(await sessionRow(session.id)).toBeUndefined();
    const [del] = await audits('candidate.deleted', cand.id);
    expect(del.meta).toMatchObject({ privacyRequestId: r.id, sessionsDeleted: 1 });
    expect(await audits('privacy_request.erased', r.id)).toHaveLength(1);
    // The access request outlives the candidate too.
    expect(json<PrivacyRequestDTO>(await admin.get(`/privacy-requests/${access.id}`))).toMatchObject({ candidate: null, subject: 'Ed Erase' });
    expect(json(await admin.post(`/privacy-requests/${r.id}/erase`, { confirm: true }), 409)).toMatchObject({ error: 'no_candidate' });
  });
});

describe('consent withdrawal (candidate)', () => {
  it('ends the exam without a score, deletes its face images and templates, and opens a register entry', async () => {
    const hook = json(await admin.post('/webhooks', { url: 'https://hooks.example.com/sp', events: ['session.terminated'], description: 'withdrawal test' }));
    const { cand, session, c, shot } = await finished('Wanda Withdraw', { submit: false });
    const live = (await evidenceOf(session.id)).filter((e) => !e.purgedAt);
    const files = live.map((e) => env.storage.resolveKey(e.storageKey));
    expect(files.length).toBeGreaterThan(1);

    const res = await c.req('POST', '/api/candidate/consent/withdraw', { confirm: true, reason: 'I do not want to be filmed.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().session).toMatchObject({ status: 'terminated', endReason: 'candidate_withdrew' });
    const s = await sessionRow(session.id);
    expect(s).toMatchObject({ status: 'terminated', endReason: 'candidate_withdrew', score: null });
    expect(s.evidencePurgedAt?.getTime()).toBe(env.clock.t);
    expect(files.some((f) => existsSync(f))).toBe(false);
    const after = await evidenceOf(session.id);
    expect(after.every((e) => e.purgedAt)).toBe(true);
    // The passed check-in's surplus frame images are deleted after its commit, in the background (checks.ts
    // purgePassedCheckImages): that may still happen after `live` was read. Everything else goes for the withdrawal.
    const reasons = after.filter((e) => live.some((l) => l.id === e.id)).map((e) => (e.kind === 'liveness_frame' && e.purgeReason === 'check_passed' ? 'consent_withdrawn' : e.purgeReason));
    expect(new Set(reasons)).toEqual(new Set(['consent_withdrawn']));
    const refs = await env.ctx.db.select().from(identityReferences).where(eq(identityReferences.sessionId, session.id));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.embeddingsEnc === null && r.purgedAt != null)).toBe(true);

    const list = json<PrivacyRequestsDTO>(await admin.get('/privacy-requests', { candidateId: cand.id }));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: 'consent_withdrawal', status: 'open', source: 'candidate', channel: 'candidate_app', sessionId: session.id, createdBy: null, assignee: null });
    expect(list.items[0].details).toContain('face images and templates were deleted');
    expect(list.items[0].details).toContain('Reason given by the candidate: I do not want to be filmed.');
    const [a] = await audits('candidate.consent_withdrawn', session.id);
    expect(a).toMatchObject({ actorType: 'candidate' });

    // Images still in the browser's outbox are not kept; nor is a second withdrawal possible.
    const late = await c.jpeg(`/api/candidate/evidence/${randomUUID()}`, { person: 'alice' }, { capturedAt: env.clock.t - 1000, reason: 'onset' }, 'PUT');
    expect(late.json()).toMatchObject({ stored: false });
    expect(json(await c.req('POST', '/api/candidate/consent/withdraw', { confirm: true }), 409)).toMatchObject({ error: 'invalid_state' });
    // The timeline says what happened; integrations get the structured reason only (never the candidate's words).
    const timeline = json(await admin.get(`/sessions/${session.id}/events`));
    expect(timeline.items.find((e: { type: string }) => e.type === 'session_terminated')).toMatchObject({ source: 'server_system', details: { reason: 'consent_withdrawn' } });
    const payloads = (await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.webhook.id))).map((d) => d.payload as { type: string; data: Record<string, unknown> });
    expect(payloads.find((p) => p.type === 'session.terminated' && p.data.sessionId === session.id)?.data).toMatchObject({ status: 'terminated', endReason: 'candidate_withdrew', reason: 'consent_withdrawn' });
    expect(JSON.stringify(payloads)).not.toContain('filmed');
    json(await admin.del(`/webhooks/${hook.webhook.id}`));
    void shot;
  });

  it('keeps the images under legal hold and says so; refuses without consent or confirmation', async () => {
    const { session, c } = await finished('Hal Held', { submit: false });
    json(await admin.post(`/sessions/${session.id}/legal-hold`, { enabled: true }));
    const live = (await evidenceOf(session.id)).filter((e) => !e.purgedAt).length;
    expect((await c.req('POST', '/api/candidate/consent/withdraw', {})).statusCode).toBe(400);
    json(await c.req('POST', '/api/candidate/consent/withdraw', { confirm: true }));
    expect((await evidenceOf(session.id)).filter((e) => !e.purgedAt)).toHaveLength(live);
    expect((await sessionRow(session.id)).evidencePurgedAt).toBeNull();
    const [req] = await env.ctx.db.select().from(privacyRequests).where(eq(privacyRequests.sessionId, session.id));
    expect(json<PrivacyRequestDTO>(await admin.get(`/privacy-requests/${req.id}`)).details).toContain('legal hold');

    const fresh = await env.newSession({ candidateId: (await env.newCandidate('Nora NoConsent')).id });
    expect(json(await env.candidateClient(fresh.token).req('POST', '/api/candidate/consent/withdraw', { confirm: true }), 409)).toMatchObject({ error: 'consent_not_given' });
  });
});

describe('retention preview and job health', () => {
  it('shows what is due, what is overdue, legal holds and the recorded runs', async () => {
    const env2 = await createTestEnv();
    try {
      const a2 = await staffApi(env2, 'admin');
      const prev = env;
      env = env2;
      const { session } = await finished('Rita Retention');
      const held = await finished('Lena LegalHold');
      env = prev;
      json(await a2.post(`/sessions/${held.session.id}/legal-hold`, { enabled: true }));
      const endedAt = (await env2.ctx.db.select().from(examSessions).where(eq(examSessions.id, session.id)))[0].endedAt!.getTime();

      let p = json<RetentionPreviewDTO>(await a2.get('/retention/preview', { days: 31 }));
      const dueDate = new Date(endedAt + 30 * DAY_MS).toISOString().slice(0, 10);
      expect(p.days).toEqual([{ date: dueDate, sessions: 1, evidenceItems: expect.any(Number) }]);
      expect(p.days[0].evidenceItems).toBeGreaterThan(1);
      expect(p.overdue).toEqual({ sessions: 0, evidenceItems: 0, oldestDueAt: null });
      expect(p.legalHolds).toEqual([expect.objectContaining({ sessionId: held.session.id, candidateName: 'Lena LegalHold', examTitle: 'Sample Exam' })]);
      expect(p.job).toMatchObject({ lastStartedAt: null, lastSuccessAt: null, stale: true });
      expect(json<OpsChecksDTO>(await a2.get('/ops/checks')).checks.find((c) => c.id === 'retention_job')).toMatchObject({ status: 'warning' });

      // Past the date and the job has not run: overdue (and failing after a day).
      env2.clock.set(endedAt + 32 * DAY_MS);
      const a3 = await staffApi(env2, 'admin');
      p = json<RetentionPreviewDTO>(await a3.get('/retention/preview'));
      expect(p.overdue).toMatchObject({ sessions: 1, oldestDueAt: endedAt + 30 * DAY_MS });
      expect(p.days).toEqual([]);
      expect(json<OpsChecksDTO>(await a3.get('/ops/checks')).checks.find((c) => c.id === 'retention_overdue')).toMatchObject({ status: 'failing' });

      await runRetention(env2.ctx);
      p = json<RetentionPreviewDTO>(await a3.get('/retention/preview'));
      expect(p.overdue.sessions).toBe(0);
      expect(p.job).toMatchObject({ lastStartedAt: env2.clock.t, lastFinishedAt: env2.clock.t, lastSuccessAt: env2.clock.t, lastError: null, stale: false });
      expect(p.job.lastSummary).toMatchObject({ sessionsEvidencePurged: 1, skippedLegalHold: 1, failures: 0 });
      const checks = json<OpsChecksDTO>(await a3.get('/ops/checks')).checks;
      expect(checks.find((c) => c.id === 'retention_job')).toMatchObject({ status: 'ok' });
      expect(checks.find((c) => c.id === 'retention_overdue')).toMatchObject({ status: 'ok' });
      expect(checks.map((c) => c.id)).toEqual(['retention_job', 'retention_overdue', 'privacy_requests', 'capacity', 'webhooks', 'email_alerts']);

      // Stale after 3 hours without a successful run; a run that fails as a whole is recorded with its error.
      env2.clock.advance(4 * 3600_000);
      const failingDb = new Proxy(env2.ctx.db, {
        get(target, prop, receiver) {
          if (prop === 'select') return () => { throw new Error('database unavailable'); };
          return Reflect.get(target, prop, receiver);
        },
      });
      await expect(runRetention({ ...env2.ctx, db: failingDb })).rejects.toThrow('database unavailable');
      const [js] = await env2.ctx.db.select().from(jobStatus).where(eq(jobStatus.name, 'retention'));
      expect(js).toMatchObject({ lastError: 'database unavailable' });
      expect(js.lastSuccessAt?.getTime()).toBe(env2.clock.t - 4 * 3600_000);
      const a4 = await staffApi(env2, 'admin');
      p = json<RetentionPreviewDTO>(await a4.get('/retention/preview'));
      expect(p.job).toMatchObject({ lastError: 'database unavailable', stale: true, lastStartedAt: env2.clock.t });
      expect(json<OpsChecksDTO>(await a4.get('/ops/checks')).checks.find((c) => c.id === 'retention_job')).toMatchObject({ status: 'failing' });
      // A dry run is not a run.
      await runRetention(env2.ctx, { dryRun: true });
      expect((await env2.ctx.db.select().from(jobStatus).where(eq(jobStatus.name, 'retention')))[0].lastError).toBe('database unavailable');
      expect((await a4.get('/retention/preview', { days: 91 })).statusCode).toBe(400);
      expect((await (await staffApi(env2, 'reviewer')).get('/retention/preview')).statusCode).toBe(403);
    } finally {
      await env2.close();
    }
  });
});
