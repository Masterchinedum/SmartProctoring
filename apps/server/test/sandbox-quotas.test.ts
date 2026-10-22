/**
 * Sandbox organisations and per-tenant quotas (roadmap #15): the organisation kind (operator-only, shown to staff and
 * candidates, `sandbox: true` in webhooks, marked alert emails), the quotas (exams, candidates, exam sessions per UTC
 * calendar month) enforced on every creation path of the staff app and the integration API — also under concurrency —,
 * the usage shown in Settings, the operator service and CLI (org:create / org:set / org:list / sandbox:purge), and the
 * sandbox clean-up (only sandbox organisations, legal hold kept, blobs deleted in their storage location, audited,
 * recorded in job_status, idempotent).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CreatedApiKeyDTO, CreatedWebhookDTO, ExamDTO, OpsChecksDTO, OrgUsageDTO, QuotaExceededDetails, StaffOrgDTO } from '@sp/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, candidates, evidence, examSessions, jobStatus, organizations, orgUsage, staffUsers, webhookDeliveries, webhooks, type Organization } from '../src/db/schema.js';
import { composeAlertEmail } from '../src/services/email-alerts.js';
import { effectiveQuotas, quotaPressure } from '../src/services/quotas.js';
import { runSandboxPurge, runSandboxPurgeExclusive, SANDBOX_PURGE_JOB, SANDBOX_PURGE_LOCK_KEY } from '../src/services/sandbox-purge.js';
import { createExamSession } from '../src/services/session-actions.js';
import { createOrganizationWithOwner, TenancyError, updateOrganizationTenancy } from '../src/services/tenancy.js';
import { createPingDelivery } from '../src/services/webhooks.js';
import { clientEvent, json, MIN, screenshot, staffApi, type Api } from './admin/fixtures.js';
import { startedSession } from './flow.js';
import { createTestEnv, SAMPLE_EXAM, type TestEnv } from './helpers.js';

const DAY = 24 * 3600_000;
const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
};

let env: TestEnv;
let euDir = '';
let defaultDir = '';

beforeAll(async () => {
  euDir = tempDir('sp-sandbox-eu-');
  env = await createTestEnv({ env: { STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: euDir, STORAGE_LOCATION_EU_LABEL: 'EU (Frankfurt)' } });
  defaultDir = (env.config.storageLocations[0].storage as { dir: string }).dir;
});
afterAll(async () => {
  await env?.close();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

let orgSeq = 0;
/** A new organisation with its owner (through the operator service) and a staff API client for that owner. */
async function newOrg(kind: 'sandbox' | 'production', quotas: Parameters<typeof createOrganizationWithOwner>[1]['quotas'] = {}) {
  orgSeq++;
  const r = await createOrganizationWithOwner(env.ctx, { name: `Org ${orgSeq} ${kind}`, kind, ownerEmail: `owner${orgSeq}-${kind}@org.example`, quotas });
  const [owner] = await env.ctx.db.select().from(staffUsers).where(eq(staffUsers.id, r.owner.id));
  const api = () => staffApi(env, owner);
  return { org: r.org, owner, api, temporaryPassword: r.temporaryPassword };
}

const v1 = (key: string, method: InjectOptions['method'], url: string, body?: unknown) =>
  env.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${key}` }, ...(body !== undefined ? { payload: body as InjectOptions['payload'] } : {}) });

async function apiKey(api: Api): Promise<string> {
  return json<CreatedApiKeyDTO>(await api.post('/api-keys', { name: `key-${Math.random().toString(36).slice(2, 8)}` })).secret;
}

async function publishedExam(api: Api, title = 'Quota exam'): Promise<ExamDTO> {
  const exam = json<ExamDTO>(await api.post('/exams', { ...SAMPLE_EXAM, title }));
  return json<ExamDTO>(await api.post(`/exams/${exam.id}/publish`));
}

async function newCandidate(api: Api, name: string): Promise<string> {
  return json<{ id: string }>(await api.post('/candidates', { name })).id;
}

function quotaError(res: { statusCode: number; json(): unknown }, quota: QuotaExceededDetails['quota']) {
  expect(res.statusCode).toBe(409);
  const body = res.json() as { error: string; message: string; details: QuotaExceededDetails };
  expect(body.error).toBe('quota_exceeded');
  expect(body.details.quota).toBe(quota);
  return body;
}

const orgRow = async (id: string): Promise<Organization> => (await env.ctx.db.select().from(organizations).where(eq(organizations.id, id)))[0];

/* =================================================================== kind */

describe('organisation kind', () => {
  it('existing and default organisations are production without limits; staff cannot change kind or quotas', async () => {
    const owner = await staffApi(env, 'owner');
    expect(env.org.kind).toBe('production');
    expect(effectiveQuotas(env.org)).toEqual({ exams: null, candidates: null, sessionsPerMonth: null });
    const me = env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: owner.cookie } });
    expect((await me).json().org).toEqual({ id: env.org.id, name: 'Test University', kind: 'production', sandbox: null } satisfies StaffOrgDTO);
    const usage = json<OrgUsageDTO>(await owner.get('/usage'));
    expect(usage).toMatchObject({ kind: 'production', sandbox: null, period: { month: '2026-09' } });
    expect(usage.quotas.map((q) => [q.quota, q.limit, q.level])).toEqual([
      ['exams', null, 'ok'],
      ['candidates', null, 'ok'],
      ['sessionsPerMonth', null, 'ok'],
    ]);
    // Settings ignore kind / quotas from staff.
    json(await owner.put('/settings', { kind: 'sandbox', quotas: { candidates: 1 }, sandboxPurgeDays: 1 }));
    const after = await orgRow(env.org.id);
    expect(after).toMatchObject({ kind: 'production', quotas: {}, sandboxPurgeDays: null });
    expect((await (await staffApi(env, 'reviewer')).get('/usage')).statusCode).toBe(403);
  });

  it('a sandbox is marked for staff, candidates, webhooks and alert emails', async () => {
    const s = await newOrg('sandbox');
    const api = await s.api();
    const me = await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: api.cookie } });
    expect(me.json().org).toEqual({ id: s.org.id, name: s.org.name, kind: 'sandbox', sandbox: { purgeAfterDays: 14 } });
    const usage = json<OrgUsageDTO>(await api.get('/usage'));
    expect(usage.kind).toBe('sandbox');
    expect(usage.sandbox).toEqual({ purgeAfterDays: 14 });
    expect(usage.quotas.map((q) => [q.quota, q.limit])).toEqual([
      ['exams', 5],
      ['candidates', 50],
      ['sessionsPerMonth', 100],
    ]);

    // The candidate app says it is a practice environment; a production exam does not.
    const exam = await publishedExam(api);
    const cand = await newCandidate(api, 'Sandy Candidate');
    const [a] = json<{ items: { accessLink: string; sessionId: string }[] }>(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: [cand] })).items;
    const token = a.accessLink.split('/take/')[1];
    expect(json(await env.candidateClient(token).req('GET', '/api/candidate/session')).sandbox).toBe(true);
    expect(json(await env.candidateClient().req('GET', '/api/candidate/session')).sandbox).toBe(false);

    // Webhooks: `sandbox: true` in the envelope of a ping and of a session notification.
    const hook = json<CreatedWebhookDTO>(await api.post('/webhooks', { url: 'https://hooks.example.test/sp', events: ['session.held'] }));
    const [hookRow] = await env.ctx.db.select().from(webhooks).where(eq(webhooks.id, hook.webhook.id));
    const pingId = await createPingDelivery(env.ctx, hookRow, { id: s.owner.id, name: s.owner.name });
    const [ping] = await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pingId));
    expect(ping.payload).toMatchObject({ type: 'ping', sandbox: true });
    await startedSession(env, env.candidateClient(token));
    json(await (await s.api()).post(`/sessions/${a.sessionId}/hold`, { note: 'checking' }));
    const held = await env.ctx.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, hook.webhook.id), eq(webhookDeliveries.eventType, 'session.held')));
    expect(held).toHaveLength(1);
    expect(held[0].payload).toMatchObject({ type: 'session.held', sandbox: true, orgId: s.org.id });

    // Production envelopes carry no sandbox field.
    const owner = await staffApi(env, 'owner');
    const prodHook = json<CreatedWebhookDTO>(await owner.post('/webhooks', { url: 'https://hooks.example.test/prod', events: ['session.held'] }));
    const [prodRow] = await env.ctx.db.select().from(webhooks).where(eq(webhooks.id, prodHook.webhook.id));
    const prodPing = await createPingDelivery(env.ctx, prodRow, { id: env.users.owner.id, name: 'Owner' });
    const [pp] = await env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, prodPing));
    expect(pp.payload).not.toHaveProperty('sandbox');

    // Alert emails say so in the subject and first line.
    const ctxMail = { orgName: s.org.name, sessionId: a.sessionId, candidate: { name: 'Sandy', externalId: null }, exam: { title: exam.title }, staffUrl: 'http://exam.test/admin/sessions/x' };
    const mail = composeAlertEmail({ ...ctxMail, sandbox: true }, [{ title: 'Exam on hold', observation: 'The exam was put on hold.', occurredAt: new Date(env.clock.t) }], ['a@b.example']);
    expect(mail.subject).toBe(`[SmartProctoring sandbox] Exam on hold: Sandy — ${exam.title}`);
    expect(mail.text.split('\n')[0]).toBe('This alert comes from a sandbox organisation: test data, not real candidates.');
    expect(mail.html).toContain('Sandbox:');
    const prodMail = composeAlertEmail(ctxMail, [{ title: 'Exam on hold', observation: 'x', occurredAt: new Date(env.clock.t) }], ['a@b.example']);
    expect(prodMail.subject.startsWith('[SmartProctoring] ')).toBe(true);
    expect(prodMail.text).not.toContain('sandbox organisation');
  });
});

/* =================================================================== operator service */

describe('operator: create and change organisations', () => {
  it('creates an organisation with its owner (temporary password shown once), audited', async () => {
    const s = await newOrg('sandbox', { candidates: 7, sessionsPerMonth: null });
    expect(s.temporaryPassword).toMatch(/^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
    expect(s.owner).toMatchObject({ role: 'owner', orgId: s.org.id });
    expect(effectiveQuotas(s.org)).toEqual({ exams: 5, candidates: 7, sessionsPerMonth: null });
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: s.owner.email, password: s.temporaryPassword } });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json().org).toMatchObject({ kind: 'sandbox' });
    const audits = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.orgId, s.org.id), eq(auditLog.actorType, 'system')));
    expect(audits.map((a) => [a.action, a.actorType]).sort()).toEqual([
      ['organization.created', 'system'],
      ['user.created', 'system'],
    ]);
    expect(JSON.stringify(audits)).not.toContain(s.temporaryPassword);
    await expect(createOrganizationWithOwner(env.ctx, { name: 'Dup', kind: 'production', ownerEmail: s.owner.email.toUpperCase() })).rejects.toMatchObject({ code: 'email_taken' });
    await expect(createOrganizationWithOwner(env.ctx, { name: ' ', kind: 'production', ownerEmail: 'x@y.example' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createOrganizationWithOwner(env.ctx, { name: 'Bad', kind: 'sandbox', ownerEmail: 'z@y.example', quotas: { exams: -1 } })).rejects.toBeInstanceOf(TenancyError);
  });

  it('changes kind, quotas and the clean-up period; turning production into a sandbox needs confirmation', async () => {
    const p = await newOrg('production');
    await expect(updateOrganizationTenancy(env.ctx, { orgId: p.org.id, kind: 'sandbox' })).rejects.toMatchObject({ code: 'confirm_required' });
    expect((await orgRow(p.org.id)).kind).toBe('production');
    const r = await updateOrganizationTenancy(env.ctx, { orgId: p.org.id, kind: 'sandbox', confirmPurge: true, quotas: { exams: 'default', candidates: 3 }, sandboxPurgeDays: 7, reason: 'Ticket 9: trial' });
    expect(r.changed).toEqual(['kind', 'quotas', 'sandboxPurgeDays']);
    expect(effectiveQuotas(r.org)).toEqual({ exams: 5, candidates: 3, sessionsPerMonth: 100 });
    const [audit] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.orgId, p.org.id), eq(auditLog.action, 'organization.updated')));
    expect(audit.meta).toMatchObject({ fields: ['kind', 'quotas', 'sandboxPurgeDays'], kind: { from: 'production', to: 'sandbox' }, sandboxPurgeDays: { from: 14, to: 7 }, reason: 'Ticket 9: trial', via: 'operator_cli' });
    // No change: nothing audited.
    expect((await updateOrganizationTenancy(env.ctx, { orgId: p.org.id, quotas: { candidates: 3 } })).changed).toEqual([]);
    // Back to production: explicit overrides stay, defaults become "no limit"; --reset-quotas clears them.
    const back = await updateOrganizationTenancy(env.ctx, { orgId: p.org.id, kind: 'production' });
    expect(effectiveQuotas(back.org)).toEqual({ exams: null, candidates: 3, sessionsPerMonth: null });
    expect(effectiveQuotas((await updateOrganizationTenancy(env.ctx, { orgId: p.org.id, resetQuotas: true })).org)).toEqual({ exams: null, candidates: null, sessionsPerMonth: null });
    await expect(updateOrganizationTenancy(env.ctx, { orgId: '00000000-0000-4000-8000-000000000000', kind: 'production' })).rejects.toMatchObject({ code: 'org_not_found' });
    await expect(updateOrganizationTenancy(env.ctx, { orgId: p.org.id, sandboxPurgeDays: 0 })).rejects.toMatchObject({ code: 'invalid' });
    const bad = (await env.ctx.db
      .update(organizations)
      .set({ kind: 'trial' as never })
      .where(eq(organizations.id, p.org.id))
      .catch((e: unknown) => e)) as { cause?: { constraint?: string } };
    expect(bad.cause?.constraint).toBe('organizations_kind_check');
  });
});

/* =================================================================== quotas */

describe('quotas', () => {
  it('exams: drafts and published count, archived ones do not; create, import and re-publishing are refused at the limit', async () => {
    const s = await newOrg('sandbox', { exams: 2 });
    const api = await s.api();
    const first = await publishedExam(api, 'One');
    json(await api.post('/exams', { ...SAMPLE_EXAM, title: 'Two (draft)' }));
    const refused = quotaError(await api.post('/exams', { ...SAMPLE_EXAM, title: 'Three' }), 'exams');
    expect(refused.details).toEqual({ quota: 'exams', limit: 2, used: 2, requested: 1, resetsAt: null, kind: 'sandbox' });
    expect(refused.message).toBe(
      'This sandbox organisation can have at most 2 exams (drafts and published exams count, archived ones do not); 2 in use. Archive an exam you no longer need, or ask your SmartProctoring operator if you need a higher limit.',
    );
    const doc = json(await api.get(`/exams/${first.id}/export`));
    quotaError(await api.post('/exams/import', doc), 'exams');
    json(await api.post(`/exams/${first.id}/archive`));
    const three = json<ExamDTO>(await api.post('/exams', { ...SAMPLE_EXAM, title: 'Three' }));
    quotaError(await api.post(`/exams/${first.id}/publish`), 'exams'); // archived → published again counts
    json(await api.post(`/exams/${three.id}/archive`));
    expect(json<ExamDTO>(await api.post(`/exams/${first.id}/publish`)).status).toBe('published');
    expect(json<OrgUsageDTO>(await api.get('/usage')).quotas[0]).toEqual({ quota: 'exams', limit: 2, used: 2, level: 'reached' });
  });

  it('candidates: staff app and API (a new candidate only; an upsert of an existing one is fine); deleting frees a place', async () => {
    const s = await newOrg('production', { candidates: 3 });
    const api = await s.api();
    const key = await apiKey(api);
    const a = await newCandidate(api, 'A');
    expect((await v1(key, 'POST', '/candidates', { name: 'B', externalId: 'ext-b' })).statusCode).toBe(201);
    expect(json<OrgUsageDTO>(await api.get('/usage')).quotas[1]).toMatchObject({ used: 2, limit: 3, level: 'ok' }); // 67 %
    await newCandidate(api, 'C');
    expect(json<OrgUsageDTO>(await api.get('/usage')).quotas[1]).toMatchObject({ used: 3, limit: 3, level: 'reached' });
    const refused = quotaError(await api.post('/candidates', { name: 'D' }), 'candidates');
    expect(refused.details).toEqual({ quota: 'candidates', limit: 3, used: 3, requested: 1, resetsAt: null, kind: 'production' });
    expect(refused.message).toBe('Your organisation can have at most 3 candidates; 3 in use. Delete candidates you no longer need, or ask your SmartProctoring operator to raise the limit.');
    quotaError(await v1(key, 'POST', '/candidates', { name: 'E', externalId: 'ext-e' }), 'candidates');
    // An upsert of an existing external id updates, at the limit too.
    expect((await v1(key, 'POST', '/candidates', { name: 'B renamed', externalId: 'ext-b' })).statusCode).toBe(200);
    json(await api.del(`/candidates/${a}`));
    expect((await api.post('/candidates', { name: 'D' })).statusCode).toBe(200);
  });

  it('exam sessions per month (UTC): batches are all or nothing, existing sessions are free, deletions do not refund, the count starts again at 00:00 UTC on the 1st', async () => {
    const s = await newOrg('sandbox', { sessionsPerMonth: 5 });
    env.clock.set(Date.parse('2026-09-30T20:00:00.000Z'));
    let api = await s.api();
    const key = await apiKey(api);
    const exam = await publishedExam(api);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await newCandidate(api, `Cand ${i}`));

    expect(json<{ items: unknown[] }>(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: ids.slice(0, 3) })).items).toHaveLength(3);
    const refused = quotaError(await v1(key, 'POST', `/exams/${exam.id}/assignments`, { candidateIds: ids.slice(3, 6) }), 'sessionsPerMonth');
    expect(refused.details).toEqual({ quota: 'sessionsPerMonth', limit: 5, used: 3, requested: 3, resetsAt: Date.parse('2026-10-01T00:00:00.000Z'), kind: 'sandbox' });
    expect(refused.message).toBe(
      'This would create 3 exam sessions, but only 2 more can be created this month: this sandbox organisation can create 5 exam sessions a month and has created 3. The count starts again on 1 October 2026 (00:00 UTC). Ask your SmartProctoring operator if you need a higher limit.',
    );
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.orgId, s.org.id))).toHaveLength(3); // nothing created
    // Candidates who already have an unfinished session keep it: not counted.
    const again = json<{ items: { existing: boolean }[] }>(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: [...ids.slice(0, 3), ids[3], ids[4]] })).items;
    expect(again.map((x) => x.existing)).toEqual([true, true, true, false, false]);
    expect(json<OrgUsageDTO>(await api.get('/usage')).quotas[2]).toEqual({ quota: 'sessionsPerMonth', limit: 5, used: 5, level: 'reached' });
    // Deleting a candidate (and their session) does not give the session back.
    const [sess] = await env.ctx.db.select().from(examSessions).where(eq(examSessions.candidateId, ids[4]));
    json(await api.post(`/sessions/${sess.id}/terminate`, { reason: 'test' }));
    json(await api.del(`/candidates/${ids[4]}`));
    const single = quotaError(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: [ids[5]] }), 'sessionsPerMonth');
    expect(single.message).toMatch(/^No more exam sessions can be created this month: this sandbox organisation can create 5 exam sessions a month and has created 5\./);

    // The last millisecond of September (UTC) is still September …
    env.clock.set(Date.parse('2026-09-30T23:59:59.999Z'));
    api = await s.api();
    quotaError(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: [ids[5]] }), 'sessionsPerMonth');
    // … and at 00:00 UTC on 1 October the count starts again.
    env.clock.set(Date.parse('2026-10-01T00:00:00.000Z'));
    api = await s.api();
    expect(json<{ items: unknown[] }>(await api.post(`/exams/${exam.id}/assignments`, { candidateIds: [ids[5]] })).items).toHaveLength(1);
    expect(json<{ items: unknown[] }>(await v1(key, 'POST', `/exams/${exam.id}/assignments`, { candidateIds: [ids[6]] })).items).toHaveLength(1);
    const usage = json<OrgUsageDTO>(await api.get('/usage'));
    expect(usage.period).toEqual({ month: '2026-10', startsAt: Date.parse('2026-10-01T00:00:00.000Z'), resetsAt: Date.parse('2026-11-01T00:00:00.000Z') });
    expect(usage.quotas[2]).toMatchObject({ used: 2, limit: 5 });
    const months = await env.ctx.db.select().from(orgUsage).where(eq(orgUsage.orgId, s.org.id)).orderBy(orgUsage.month);
    expect(months.map((m) => [m.month, m.sessionsCreated])).toEqual([
      ['2026-09', 5],
      ['2026-10', 2],
    ]);
    env.clock.set(Date.parse('2026-09-24T09:00:00.000Z'));
  });

  it('production organisations have no limit but their sessions are counted', async () => {
    const owner = await staffApi(env, 'owner');
    const before = json<OrgUsageDTO>(await owner.get('/usage')).quotas[2].used;
    const cand = await env.newCandidate('Counted Candidate');
    json(await owner.post(`/exams/${env.exam.id}/assignments`, { candidateIds: [cand.id] }));
    expect(json<OrgUsageDTO>(await owner.get('/usage')).quotas[2]).toEqual({ quota: 'sessionsPerMonth', limit: null, used: before + 1, level: 'ok' });
  });

  it('parallel requests (staff app and API together) never exceed a limit', async () => {
    const s = await newOrg('sandbox', { sessionsPerMonth: 4, candidates: 10 });
    const api = await s.api();
    const key = await apiKey(api);
    const [e1, e2] = [await publishedExam(api, 'P1'), await publishedExam(api, 'P2')];
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await newCandidate(api, `Par ${i}`));
    const results = await Promise.all([
      ...ids.slice(0, 3).map((id) => api.post(`/exams/${e1.id}/assignments`, { candidateIds: [id] })),
      ...ids.slice(3).map((id) => v1(key, 'POST', `/exams/${e2.id}/assignments`, { candidateIds: [id] })),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 409, 409]);
    const [{ n }] = await env.ctx.db.select({ n: sql<number>`count(*)::int` }).from(examSessions).where(eq(examSessions.orgId, s.org.id));
    expect(n).toBe(4);
    expect((await env.ctx.db.select().from(orgUsage).where(eq(orgUsage.orgId, s.org.id)))[0].sessionsCreated).toBe(4);

    // Candidates: 6 in use of 10 → 8 parallel creations, 4 succeed.
    const created = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => api.post('/candidates', { name: `Staff ${i}` })),
      ...Array.from({ length: 4 }, (_, i) => v1(key, 'POST', '/candidates', { name: `Api ${i}`, externalId: `par-${i}` })),
    ]);
    expect(created.filter((r) => r.statusCode === 200 || r.statusCode === 201)).toHaveLength(4);
    expect(created.filter((r) => r.statusCode === 409)).toHaveLength(4);
    const [{ c }] = await env.ctx.db.select({ c: sql<number>`count(*)::int` }).from(candidates).where(eq(candidates.orgId, s.org.id));
    expect(c).toBe(10);
  });

  it('counts organisations near and at their limits for monitoring', async () => {
    const p = await quotaPressure(env.ctx.db, env.clock.t);
    // From the tests above: the exam-limit sandbox and the candidate-limit organisations are at their limits, and two
    // organisations used up their monthly sessions; the default org (production, no limits) is never counted.
    expect(p.exams.reached).toBe(1);
    expect(p.candidates).toEqual({ warning: 0, reached: 2 });
    expect(p.sessionsPerMonth.reached).toBe(2);
    const s = await newOrg('sandbox', { exams: 5 });
    const api = await s.api();
    for (let i = 0; i < 4; i++) json(await api.post('/exams', { ...SAMPLE_EXAM, title: `Near ${i}` }));
    expect((await quotaPressure(env.ctx.db, env.clock.t)).exams).toEqual({ warning: 1, reached: 1 });
    for (const k of ['exams', 'candidates', 'sessionsPerMonth'] as const) for (const l of ['warning', 'reached'] as const) expect(Number.isInteger(p[k][l])).toBe(true);
  });
});

/* =================================================================== sandbox clean-up */

/** Blob files of an organisation under a storage directory. */
function orgBlobs(dir: string, orgId: string): string[] {
  const base = join(dir, 'o', orgId);
  if (!existsSync(base)) return [];
  return (readdirSync(base, { recursive: true }) as string[]).filter((f) => f.endsWith('.bin'));
}

describe('sandbox clean-up', () => {
  let s: Awaited<ReturnType<typeof newOrg>>;
  const ids = { a: '', b: '', c: '', d: '', e: '', f: '', sessA: '', sessB: '', sessC: '', sessD: '', prodSess: '' };
  let purgeAt = 0;

  async function takeAndSubmit(link: string, withScreenshot = true) {
    const c = await startedSession(env, env.candidateClient(link.split('/take/')[1]));
    env.clock.advance(MIN);
    if (withScreenshot) {
      const ev = await clientEvent(c, { type: 'multiple_people', startedAt: env.clock.t - 20_000, endedAt: env.clock.t - 10_000 });
      await screenshot(c, ev, env.clock.t - 15_000, { person: 'alice', faces: 2 });
    }
    json(await c.req('POST', '/api/candidate/submit'));
  }
  const assign = async (examId: string, candidateId: string) =>
    json<{ items: { sessionId: string; accessLink: string }[] }>(await (await s.api()).post(`/exams/${examId}/assignments`, { candidateIds: [candidateId] })).items[0];
  const liveImages = async (sessionId: string) => (await env.ctx.db.select().from(evidence).where(and(eq(evidence.sessionId, sessionId), isNull(evidence.purgedAt)))).length;

  beforeAll(async () => {
    env.clock.set(Date.parse('2026-09-24T09:00:00.000Z'));
    s = await newOrg('sandbox');
    const api = await s.api();
    const exam = await publishedExam(api, 'Sandbox exam');
    for (const k of ['a', 'b', 'd', 'e'] as const) ids[k] = await newCandidate(api, `Sandbox ${k.toUpperCase()}`);
    // A: ended, images in the default location.
    const a = await assign(exam.id, ids.a);
    ids.sessA = a.sessionId;
    await takeAndSubmit(a.accessLink);
    // From here new images of the sandbox go to the eu location.
    await env.ctx.db.update(organizations).set({ settings: { evidenceLocation: 'eu' } }).where(eq(organizations.id, s.org.id));
    // B: ended, images in eu, under legal hold.
    const b = await assign(exam.id, ids.b);
    ids.sessB = b.sessionId;
    await takeAndSubmit(b.accessLink);
    json(await (await s.api()).post(`/sessions/${b.sessionId}/legal-hold`, { enabled: true }));
    // D: invited and never used (stale).
    ids.sessD = (await assign(exam.id, ids.d)).sessionId;
    // E: no session, an approved ID photo (eu).
    expect(json(await (await s.api()).jpeg(`/candidates/${ids.e}/id-photo`, { person: 'paul' })).accepted).toBe(true);
    // Production: an ended session with images (must never be touched).
    const prodCand = await env.newCandidate('Prod Person');
    const prod = await createExamSession(env.ctx, env.ctx.db, { orgId: env.org.id, examId: env.exam.id, candidateId: prodCand.id });
    ids.prodSess = prod.session.id;
    await takeAndSubmit(prod.accessLink);

    // Ten days later: C takes an exam, F is added (both recent at the clean-up).
    env.clock.advance(10 * DAY);
    ids.c = await newCandidate(await s.api(), 'Sandbox C');
    const c = await assign(exam.id, ids.c);
    ids.sessC = c.sessionId;
    await takeAndSubmit(c.accessLink, false);
    ids.f = await newCandidate(await s.api(), 'Sandbox F');
    env.clock.advance(5 * DAY);
    purgeAt = env.clock.t;
    await new Promise((r) => setTimeout(r, 300)); // background frame purges of passed checks
  });

  it('a dry run counts what is due and deletes nothing', async () => {
    const dry = await runSandboxPurge(env.ctx, { dryRun: true });
    const r = dry.organisations.find((o) => o.orgId === s.org.id)!;
    expect(r).toMatchObject({ purgeAfterDays: 14, sessionsDeleted: 2, candidatesDeleted: 3, skippedLegalHold: 1, legalHoldSessionIds: [ids.sessB] });
    expect(r.evidenceItemsPurged).toBeGreaterThan(0);
    expect(dry.organisations.map((o) => o.orgId)).not.toContain(env.org.id);
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, ids.sessA))).toHaveLength(1);
    expect(await env.ctx.db.select().from(jobStatus).where(eq(jobStatus.name, SANDBOX_PURGE_JOB))).toEqual([]);
  });

  it('deletes old sandbox data (blobs in each storage location first), keeps legal holds and recent data, never touches production', async () => {
    const defaultBefore = orgBlobs(defaultDir, s.org.id);
    const euBefore = orgBlobs(euDir, s.org.id);
    expect(defaultBefore.length).toBeGreaterThan(0);
    expect(euBefore.length).toBeGreaterThan(0);
    const prodImages = await liveImages(ids.prodSess);
    expect(prodImages).toBeGreaterThan(0);
    const prodBlobs = orgBlobs(defaultDir, env.org.id).length;
    const heldImages = await liveImages(ids.sessB);

    const run = await runSandboxPurge(env.ctx, { now: purgeAt });
    const r = run.organisations.find((o) => o.orgId === s.org.id)!;
    expect(r).toMatchObject({ sessionsDeleted: 2, candidatesDeleted: 3, skippedLegalHold: 1, legalHoldSessionIds: [ids.sessB], failures: [] });

    const sessions = await env.ctx.db.select({ id: examSessions.id }).from(examSessions).where(eq(examSessions.orgId, s.org.id));
    expect(sessions.map((x) => x.id).sort()).toEqual([ids.sessB, ids.sessC].sort());
    const cands = await env.ctx.db.select({ id: candidates.id }).from(candidates).where(eq(candidates.orgId, s.org.id));
    expect(cands.map((x) => x.id).sort()).toEqual([ids.b, ids.c, ids.f].sort());
    // No evidence row of a deleted session or candidate is left; the held session keeps its images.
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.sessionId, ids.sessA))).toEqual([]);
    expect(await env.ctx.db.select().from(evidence).where(eq(evidence.candidateId, ids.e))).toEqual([]);
    expect(await liveImages(ids.sessB)).toBe(heldImages);
    // Blobs: A's (default) and E's ID photo (eu) are gone; what is left belongs to B and C.
    const kept = await env.ctx.db.select({ key: evidence.storageKey, loc: evidence.storageLocation }).from(evidence).where(and(eq(evidence.orgId, s.org.id), isNull(evidence.purgedAt)));
    const keptDefault = kept.filter((k) => k.loc == null).map((k) => k.key.replace(`o/${s.org.id}/`, ''));
    const keptEu = kept.filter((k) => k.loc === 'eu').map((k) => k.key.replace(`o/${s.org.id}/`, ''));
    expect(orgBlobs(defaultDir, s.org.id).sort()).toEqual(keptDefault.sort());
    expect(orgBlobs(euDir, s.org.id).sort()).toEqual(keptEu.sort());
    expect(orgBlobs(euDir, s.org.id).length).toBeLessThan(euBefore.length);
    expect(orgBlobs(defaultDir, s.org.id).length).toBeLessThan(defaultBefore.length);
    // Production untouched.
    expect(await liveImages(ids.prodSess)).toBe(prodImages);
    expect(orgBlobs(defaultDir, env.org.id).length).toBe(prodBlobs);
    expect(run.organisations.map((o) => o.orgId)).not.toContain(env.org.id);

    const [audit] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.orgId, s.org.id), eq(auditLog.action, 'sandbox.purge')));
    expect(audit).toMatchObject({ actorType: 'system', targetType: 'organization', targetId: s.org.id });
    expect(audit.meta).toMatchObject({ purgeAfterDays: 14, sessionsDeleted: 2, candidatesDeleted: 3, skippedLegalHold: 1, legalHoldSessionIds: [ids.sessB], failures: 0 });
    const [job] = await env.ctx.db.select().from(jobStatus).where(eq(jobStatus.name, SANDBOX_PURGE_JOB));
    expect(job.lastError).toBeNull();
    expect(job.lastSummary).toMatchObject({ sessionsDeleted: run.totals.sessionsDeleted, candidatesDeleted: run.totals.candidatesDeleted, skippedLegalHold: run.totals.skippedLegalHold, failures: 0 });

    // Operational checks: the sandbox shows its clean-up; production does not have that check.
    const checks = json<OpsChecksDTO>(await (await s.api()).get('/ops/checks')).checks;
    expect(checks.find((c) => c.id === 'sandbox_purge')).toMatchObject({ status: 'ok', label: 'Sandbox clean-up' });
    expect(checks.find((c) => c.id === 'sandbox_purge')!.detail).toContain('deleted 14 days after their last use');
    expect(json<OpsChecksDTO>(await (await staffApi(env, 'owner')).get('/ops/checks')).checks.map((c) => c.id)).not.toContain('sandbox_purge');
  });

  it('is idempotent; a lifted legal hold lets the next run delete the session; production is never selected', async () => {
    const again = await runSandboxPurge(env.ctx, { now: purgeAt });
    const r = again.organisations.find((o) => o.orgId === s.org.id)!;
    expect(r).toMatchObject({ sessionsDeleted: 0, candidatesDeleted: 0, evidenceItemsPurged: 0, skippedLegalHold: 1 });
    // Only the held session was reported: one more audit entry (kept for a legal hold), nothing deleted.
    expect(await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.orgId, s.org.id), eq(auditLog.action, 'sandbox.purge')))).toHaveLength(2);
    json(await (await s.api()).post(`/sessions/${ids.sessB}/legal-hold`, { enabled: false }));
    // Lifting the hold is activity on the session, but an ended session counts from its end.
    const third = (await runSandboxPurge(env.ctx, { now: env.clock.t })).organisations.find((o) => o.orgId === s.org.id)!;
    expect(third).toMatchObject({ sessionsDeleted: 1, candidatesDeleted: 1, skippedLegalHold: 0 });
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, ids.sessB))).toEqual([]);
    expect(orgBlobs(euDir, s.org.id).length + orgBlobs(defaultDir, s.org.id).length).toBe((await env.ctx.db.select().from(evidence).where(and(eq(evidence.orgId, s.org.id), isNull(evidence.purgedAt)))).length);

    expect((await runSandboxPurge(env.ctx, { orgId: env.org.id, now: env.clock.t + 365 * DAY, dryRun: true })).organisations).toEqual([]);
    const far = await runSandboxPurge(env.ctx, { now: env.clock.t + 365 * DAY, dryRun: true });
    expect(far.organisations.map((o) => o.orgId)).not.toContain(env.org.id);
    expect(await env.ctx.db.select().from(examSessions).where(eq(examSessions.id, ids.prodSess))).toHaveLength(1);
  });

  it('skips an organisation that became production; one run at a time', async () => {
    const t = await newOrg('sandbox');
    const api = await t.api();
    const old = await newCandidate(api, 'Old Candidate');
    await updateOrganizationTenancy(env.ctx, { orgId: t.org.id, kind: 'production' });
    const r = await runSandboxPurge(env.ctx, { now: env.clock.t + 30 * DAY });
    expect(r.organisations.map((o) => o.orgId)).not.toContain(t.org.id);
    expect(await env.ctx.db.select().from(candidates).where(eq(candidates.id, old))).toHaveLength(1);

    const client = await env.ctx.database.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [SANDBOX_PURGE_LOCK_KEY]);
      expect(await runSandboxPurgeExclusive(env.ctx, { dryRun: true })).toBeNull();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SANDBOX_PURGE_LOCK_KEY]);
      client.release();
    }
    expect(await runSandboxPurgeExclusive(env.ctx, { dryRun: true })).not.toBeNull();
  });
});

/* =================================================================== CLI */

describe('operator CLI', () => {
  const run = promisify(execFile);
  const cli = async (...args: string[]) => {
    try {
      const r = await run(process.execPath, ['--import', 'tsx', 'src/scripts/org-cli.ts', ...args], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: env.config.databaseUrl,
          EVIDENCE_KEY: env.config.evidenceKey.toString('base64'),
          STORAGE_DRIVER: 'fs',
          STORAGE_DIR: defaultDir,
          STORAGE_LOCATIONS: 'eu',
          STORAGE_LOCATION_EU_DRIVER: 'fs',
          STORAGE_LOCATION_EU_DIR: euDir,
          LOG_LEVEL: 'silent',
        },
      });
      return { code: 0, out: r.stdout, err: r.stderr };
    } catch (err) {
      const x = err as { code: number; stdout: string; stderr: string };
      return { code: x.code, out: x.stdout, err: x.stderr };
    }
  };

  it('org:create, org:set, org:list and sandbox:purge with their exit codes', async () => {
    expect((await cli('bogus')).code).toBe(2);
    expect((await cli('create', '--name', 'X')).code).toBe(2); // no owner
    expect((await cli('create', '--', '--name', 'X', '--owner-email', 'cli@x.example', '--exams', 'lots')).code).toBe(2);
    expect((await cli('create', '--name', 'X', '--owner-email', 'cli@x.example', '--kind', 'trial')).code).toBe(2);
    const created = await cli('create', '--', '--name', 'CLI Sandbox', '--owner-email', 'cli-owner@sandbox.example', '--kind', 'sandbox', '--candidates', '20', '--sessions-per-month', 'unlimited', '--purge-after-days', '7', '--reason', 'Ticket 77', '--json');
    expect(created.code, created.err).toBe(0);
    const out = JSON.parse(created.out) as { organisation: { id: string; kind: string; quotas: unknown; sandboxPurgeDays: number }; owner: { email: string }; temporaryPassword: string };
    expect(out.organisation).toMatchObject({ kind: 'sandbox', quotas: { exams: 5, candidates: 20, sessionsPerMonth: null }, sandboxPurgeDays: 7 });
    expect(out.owner.email).toBe('cli-owner@sandbox.example');
    const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'cli-owner@sandbox.example', password: out.temporaryPassword } });
    expect(login.statusCode).toBe(200);
    expect((await cli('create', '--name', 'Again', '--owner-email', 'CLI-owner@sandbox.example')).code).toBe(4);

    const text = await cli('create', '--name', 'CLI Production', '--owner-email', 'cli-prod@prod.example');
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/temporary password: [A-Z0-9-]{23}/);
    expect(text.out).toContain('kind:            production');
    const prodId = /\(([0-9a-f-]{36})\)/.exec(text.out)![1];

    expect((await cli('set', '--org', prodId)).code).toBe(2); // nothing to change
    expect((await cli('set', '--org', '00000000-0000-4000-8000-000000000000', '--exams', '3')).code).toBe(4);
    const unconfirmed = await cli('set', '--org', prodId, '--kind', 'sandbox');
    expect(unconfirmed.code).toBe(3);
    expect(unconfirmed.err).toContain('--confirm-purge');
    const set = await cli('set', '--', '--org', prodId, '--kind', 'sandbox', '--confirm-purge', '--exams', '2', '--reason', 'Ticket 78', '--json');
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ changed: ['kind', 'quotas'], organisation: { kind: 'sandbox', quotas: { exams: 2, candidates: 50, sessionsPerMonth: 100 } } });
    const setText = await cli('set', '--org', prodId, '--exams', 'default');
    expect(setText.code).toBe(0);
    expect(setText.out).toContain('Updated (quotas)');
    expect(setText.out).toMatch(/Exams \(drafts and published\):\s+0 of 5 \(sandbox default\)/);

    const list = await cli('list', '--json');
    expect(list.code).toBe(0);
    const orgs = (JSON.parse(list.out) as { organisations: { id: string; kind: string }[] }).organisations;
    expect(orgs.find((o) => o.id === env.org.id)).toMatchObject({ kind: 'production' });
    expect(orgs.find((o) => o.id === out.organisation.id)).toMatchObject({ kind: 'sandbox' });

    expect((await cli('purge', '--org', env.org.id, '--dry-run')).code).toBe(4); // production: never
    const dry = await cli('purge', '--', '--dry-run', '--json');
    expect(dry.code, dry.err).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true });
    const real = await cli('purge', '--org', out.organisation.id);
    expect(real.code, real.err).toBe(0);
    expect(real.out).toContain('Sandbox clean-up as of');
  });
});
