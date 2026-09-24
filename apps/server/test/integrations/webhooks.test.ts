/**
 * Webhooks: staff CRUD, durable outbox, signed delivery to a local HTTP receiver (verified with the snippet
 * published in docs/INTEGRATION_API.md), retries, severity filter, lifecycle notifications (incl. sweeper),
 * auto-disable, test ping / redelivery and the SSRF guard.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CreatedWebhookDTO, WebhookDTO, WebhookDeliveryDTO, WebhookEnvelope, WebhookEventType } from '@sp/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, webhookDeliveries, webhooks } from '../../src/db/schema.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { withSession } from '../../src/services/session-state.js';
import { deliverDueWebhooks, webhookHousekeeping } from '../../src/services/webhooks.js';
import { clientEvent, json, MIN, staffApi, type Api } from '../admin/fixtures.js';
import { sample, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

type Verify = (rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec?: number, nowSec?: number) => boolean;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

async function receiver() {
  const received: Received[] = [];
  const plan: number[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const code = plan.length ? plan.shift()! : 200;
      res.writeHead(code, { 'content-type': 'text/plain' }).end(code < 300 ? 'ok' : 'receiver error');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    received,
    plan,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The verification function exactly as published in docs/INTEGRATION_API.md. */
async function loadDocumentedVerifier(): Promise<Verify> {
  const doc = readFileSync(new URL('../../../../docs/INTEGRATION_API.md', import.meta.url), 'utf8');
  const m = /<!-- verify-snippet:start -->\s*```js\n([\s\S]*?)```\s*<!-- verify-snippet:end -->/.exec(doc);
  if (!m) throw new Error('verification snippet not found in docs/INTEGRATION_API.md');
  const file = join(mkdtempSync(join(tmpdir(), 'sp-verify-')), 'verify.mjs');
  writeFileSync(file, m[1]);
  return ((await import(pathToFileURL(file).href)) as { verifySmartProctoringSignature: Verify }).verifySmartProctoringSignature;
}

let env: TestEnv;
let admin: Api;
let verify: Verify;
const receivers: Awaited<ReturnType<typeof receiver>>[] = [];

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  verify = await loadDocumentedVerifier();
});
afterAll(async () => {
  await Promise.all(receivers.map((r) => r.close()));
  await env?.close();
});
// Tests move the clock far ahead: mint a fresh staff cookie for each test.
beforeEach(async () => {
  admin = await staffApi(env, 'admin');
});

/** Remove all webhooks (and their deliveries) so a test's run summaries only concern its own webhook. */
const clearHooks = () => env.ctx.db.delete(webhooks).where(eq(webhooks.orgId, env.org.id));

async function newReceiver() {
  const r = await receiver();
  receivers.push(r);
  return r;
}

async function createHook(url: string, events: WebhookEventType[], minSeverity = 'medium'): Promise<CreatedWebhookDTO> {
  return json<CreatedWebhookDTO>(await admin.post('/webhooks', { url, events, minSeverity, description: 'test' }));
}

const deliveriesOf = (webhookId: string) => env.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId)).orderBy(webhookDeliveries.createdAt);
const nowSec = () => Math.floor(env.clock.t / 1000);

describe('webhook configuration (staff)', () => {
  it('creates a webhook with a one-time secret (encrypted at rest), validates input and audits', async () => {
    const r = await newReceiver();
    const created = await createHook(r.url, ['event.created', 'session.held']);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.webhook).toMatchObject({ url: r.url, events: ['event.created', 'session.held'], minSeverity: 'medium', active: true, failureCount: 0, disabledReason: null, pendingDeliveries: 0 });
    const list = json<{ items: WebhookDTO[] }>(await admin.get('/webhooks'));
    expect(list.items.map((w) => w.id)).toContain(created.webhook.id);
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const [row] = await env.ctx.db.select().from(webhooks).where(eq(webhooks.id, created.webhook.id));
    expect(row.secretEnc.toString('latin1')).not.toContain(created.secret.slice(6));
    const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'webhook.created'), eq(auditLog.targetId, created.webhook.id)));
    expect(a.meta).toMatchObject({ host: `127.0.0.1:${r.port}` });

    expect((await admin.post('/webhooks', { url: r.url, events: [] })).statusCode).toBe(400);
    expect((await admin.post('/webhooks', { url: r.url, events: ['nope'] })).statusCode).toBe(400);
    const bad = await admin.post('/webhooks', { url: 'ftp://example.com/x', events: ['event.created'] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_webhook_url');
    expect((await (await staffApi(env, 'reviewer')).get('/webhooks')).statusCode).toBe(403);

    const upd = json<WebhookDTO>(await admin.put(`/webhooks/${created.webhook.id}`, { minSeverity: 'high', events: ['event.created', 'event.closed'] }));
    expect(upd).toMatchObject({ minSeverity: 'high', events: ['event.created', 'event.closed'] });
    const rotated = json<CreatedWebhookDTO>(await admin.post(`/webhooks/${created.webhook.id}/rotate-secret`));
    expect(rotated.secret).not.toBe(created.secret);
    expect(json(await admin.del(`/webhooks/${created.webhook.id}`))).toEqual({ ok: true });
    expect((await admin.get(`/webhooks/${created.webhook.id}`)).statusCode).toBe(404);
  });
});

describe('outbox and delivery', () => {
  it('delivers signed event notifications at/above minSeverity, retries a 500 and never duplicates', async () => {
    const rMed = await newReceiver();
    const rHigh = await newReceiver();
    const med = await createHook(rMed.url, ['event.created', 'event.closed'], 'medium');
    const high = await createHook(rHigh.url, ['event.created'], 'high');
    const c = await startedSession(env, env.candidateClient((await env.newSession()).token));
    env.clock.advance(MIN);
    const t = env.clock.t;
    await clientEvent(c, { type: 'looking_away', startedAt: t - 30_000, endedAt: t - 25_000 }); // low
    const absent = await clientEvent(c, { type: 'candidate_absent', startedAt: t - 20_000, endedAt: t - 10_000 }); // medium, closed
    const multi = await clientEvent(c, { type: 'multiple_people', startedAt: t - 5_000, endedAt: null, confidence: 0.93 }); // high, open

    const medRows = await deliveriesOf(med.webhook.id);
    expect(medRows.map((d) => `${d.eventType}:${(d.payload as unknown as WebhookEnvelope).data.id}`).sort()).toEqual(
      [`event.closed:${absent}`, `event.created:${absent}`, `event.created:${multi}`].sort(),
    );
    const highRows = await deliveriesOf(high.webhook.id);
    expect(highRows.map((d) => (d.payload as unknown as WebhookEnvelope).data.id)).toEqual([multi]);

    // First attempt to the medium webhook gets a 500: that delivery is retried later, the rest of the batch waits.
    rMed.plan.push(500);
    const run1 = await deliverDueWebhooks(env.ctx);
    expect(run1).toMatchObject({ attempted: 2, succeeded: 1, deferred: 2 });
    const failedOnce = (await deliveriesOf(med.webhook.id)).find((d) => d.attempts === 1)!;
    expect(failedOnce).toMatchObject({ status: 'pending', lastStatusCode: 500 });
    expect(failedOnce.lastError).toMatch(/HTTP 500/);
    expect(failedOnce.nextAttemptAt.getTime()).toBe(env.clock.t + 30_000);
    expect((await deliverDueWebhooks(env.ctx)).attempted).toBe(0); // nothing due yet

    env.clock.advance(31_000);
    const run2 = await deliverDueWebhooks(env.ctx);
    expect(run2).toMatchObject({ attempted: 3, succeeded: 3 });
    expect((await deliverDueWebhooks(env.ctx)).attempted).toBe(0);
    const final = await deliveriesOf(med.webhook.id);
    expect(final.every((d) => d.status === 'succeeded' && d.deliveredAt)).toBe(true);
    expect(json<WebhookDTO>(await admin.get(`/webhooks/${med.webhook.id}`))).toMatchObject({ failureCount: 0, pendingDeliveries: 0 });

    // Receiver side: 4 requests, 3 distinct deliveries; the retried one carries the same delivery id.
    expect(rMed.received).toHaveLength(4);
    const ids = rMed.received.map((r) => r.headers['x-smartproctoring-delivery'] as string);
    expect(new Set(ids).size).toBe(3);
    const retried = rMed.received.filter((r) => r.headers['x-smartproctoring-delivery'] === failedOnce.id);
    expect(retried.map((r) => r.headers['x-smartproctoring-attempt'])).toEqual(['1', '2']);
    for (const req of rMed.received) {
      const sig = req.headers['x-smartproctoring-signature'] as string;
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(verify(req.body, sig, med.secret, 300, nowSec())).toBe(true);
      expect(verify(Buffer.from(req.body), sig, med.secret, 300, nowSec())).toBe(true);
      expect(verify(req.body.replace('"high"', '"low"').replace('"medium"', '"info"'), sig, med.secret, 300, nowSec())).toBe(false);
      expect(verify(req.body, sig, high.secret, 300, nowSec())).toBe(false);
      expect(verify(req.body, sig, med.secret, 300, nowSec() + 3600)).toBe(false); // replay window
      expect(verify(req.body, undefined, med.secret)).toBe(false);
      const env1 = JSON.parse(req.body) as WebhookEnvelope;
      expect(env1.id).toBe(req.headers['x-smartproctoring-delivery']);
      expect(env1.type).toBe(req.headers['x-smartproctoring-event']);
      expect(req.headers['content-type']).toMatch(/application\/json/);
    }
    const created = rMed.received.map((r) => JSON.parse(r.body) as WebhookEnvelope).find((e) => e.type === 'event.created' && e.data.id === multi)!;
    expect(created.data).toMatchObject({
      id: multi,
      type: 'multiple_people',
      category: 'integrity',
      severity: 'high',
      title: 'More than one person in view',
      observation: 'More than one person was visible in the camera view.',
      status: 'open',
      confidence: 0.93,
      candidate: { id: env.candidate.id, name: env.candidate.name, externalId: env.candidate.externalId },
      exam: { id: env.exam.id, title: 'Sample Exam' },
    });
    expect(created.data.staffUrl).toMatch(new RegExp(`^http://exam\\.test/admin/sessions/[0-9a-f-]+\\?event=${multi}$`));
    for (const r of rMed.received) {
      expect(r.body).not.toMatch(/evidence|details|similarity|embedding|jpeg|base64/i);
    }
    expect(rHigh.received.map((r) => (JSON.parse(r.body) as WebhookEnvelope).data.id)).toEqual([multi]);

    // Replays / newer versions of the same episode never enqueue event.created again; closing it adds event.closed.
    const before = (await deliveriesOf(med.webhook.id)).length;
    const again = await c.req('POST', '/api/candidate/events/batch', {
      events: [{ id: multi, type: 'multiple_people', phase: 'update', startedAt: env.clock.t - 36_000, endedAt: null, confidence: 0.95, details: {}, version: 2 }],
    });
    expect(again.json().results[0].result).toBe('updated');
    expect((await deliveriesOf(med.webhook.id)).length).toBe(before);
    env.clock.advance(5_000);
    await c.req('POST', '/api/candidate/events/batch', {
      events: [{ id: multi, type: 'multiple_people', phase: 'close', startedAt: env.clock.t - 41_000, endedAt: env.clock.t - 1_000, confidence: 0.95, details: {}, version: 3 }],
    });
    const after = await deliveriesOf(med.webhook.id);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.eventType).toBe('event.closed');
    expect((await deliveriesOf(high.webhook.id)).length).toBe(1); // not subscribed to event.closed
  });

  it('enqueues in the same transaction: a rolled-back change leaves no delivery', async () => {
    const r = await newReceiver();
    const hook = await createHook(r.url, ['session.held']);
    const s = await env.newSession();
    await expect(
      withSession(env.ctx, s.id, async (m) => {
        await m.addEvent({ type: 'session_held', details: { reason: 'staff' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await deliveriesOf(hook.webhook.id)).toHaveLength(0);
    json(await admin.post(`/sessions/${s.id}/hold`, { note: 'x' }));
    expect(await deliveriesOf(hook.webhook.id)).toHaveLength(1);
  });

  it('sends session lifecycle notifications (hold, release, pause request, identity mismatch, termination, sweeper expiry)', async () => {
    const r = await newReceiver();
    const hook = await createHook(r.url, ['session.held', 'session.released', 'session.pause_requested', 'session.submitted', 'session.terminated', 'identity.mismatch']);
    const payloads = async () => (await deliveriesOf(hook.webhook.id)).map((d) => d.payload as unknown as WebhookEnvelope);

    // Pause request needing approval.
    const { exam } = await env.newExam({ policy: { pause: { requireApproval: true } } });
    const s1 = await env.newSession({ examId: exam.id });
    const c1 = await startedSession(env, env.candidateClient(s1.token));
    expect((await c1.req('POST', '/api/candidate/pause', { reason: 'restroom' })).json().outcome).toBe('pending_approval');
    // Staff hold + release.
    env.clock.advance(1000);
    json(await admin.post(`/sessions/${s1.id}/hold`, { note: 'private note' }));
    env.clock.advance(1000);
    json(await admin.post(`/sessions/${s1.id}/release`, { requireCheck: false }));
    // Staff termination (the free-text reason is not forwarded).
    env.clock.advance(1000);
    json(await admin.post(`/sessions/${s1.id}/terminate`, { reason: 'confidential staff note' }));

    // Possible different person mid-exam -> identity.mismatch + session.held (identity_mismatch).
    const s2 = await env.newSession();
    const c2 = await startedSession(env, env.candidateClient(s2.token));
    env.clock.advance(30_000);
    await sample(env, c2, { person: 'mallory' }, 'face_return');
    env.clock.advance(4_000);
    expect((await sample(env, c2, { person: 'mallory' }, 'follow_up')).json().status).toBe('on_hold');

    // Time expiry through the sweeper -> session.submitted with the score.
    const s3 = await env.newSession();
    await startedSession(env, env.candidateClient(s3.token));
    env.clock.advance(3601_000);
    await sweepOnce(env.ctx);

    const all = await payloads();
    const bySession = (id: string) => all.filter((p) => p.data.sessionId === id).map((p) => p.type);
    expect(bySession(s1.id)).toEqual(['session.pause_requested', 'session.held', 'session.released', 'session.terminated']);
    expect(bySession(s2.id)).toEqual(expect.arrayContaining(['identity.mismatch', 'session.held']));
    expect(bySession(s3.id)).toEqual(['session.submitted']);

    const pr = all.find((p) => p.type === 'session.pause_requested')!;
    expect(pr.data).toMatchObject({ sessionId: s1.id, status: 'active', pauseRequest: { reason: 'restroom' }, candidate: { id: env.candidate.id }, staffUrl: `http://exam.test/admin/sessions/${s1.id}` });
    expect(all.find((p) => p.type === 'session.held' && p.data.sessionId === s1.id)!.data).toMatchObject({ status: 'on_hold', reason: 'staff' });
    expect(all.find((p) => p.type === 'session.released')!.data).toMatchObject({ reason: 'staff', requireCheck: false, status: 'active' });
    const term = all.find((p) => p.type === 'session.terminated')!;
    expect(term.data).toMatchObject({ status: 'terminated', endReason: 'staff_terminated', reason: null });
    expect(JSON.stringify(all)).not.toContain('confidential staff note');
    expect(JSON.stringify(all)).not.toContain('private note');
    expect(all.find((p) => p.type === 'session.held' && p.data.sessionId === s2.id)!.data).toMatchObject({ reason: 'identity_mismatch' });
    expect(all.find((p) => p.type === 'identity.mismatch')!.data).toMatchObject({ type: 'identity_mismatch', category: 'integrity', severity: 'high', title: 'Possible different person' });
    const sub = all.find((p) => p.type === 'session.submitted')!;
    expect(sub.data).toMatchObject({ status: 'submitted', endReason: 'time_expired', score: { points: 0, maxPoints: 10, autoGraded: false } });

    await deliverDueWebhooks(env.ctx);
    expect(r.received.length).toBe(all.length);
    expect(new Set(r.received.map((x) => x.headers['x-smartproctoring-delivery'])).size).toBe(all.length);
  });
});

describe('failures, auto-disable, test ping and redelivery', () => {
  it('marks a delivery failed after maxAttempts and disables a webhook that keeps failing (audit + badge); re-enabling resumes', async () => {
    const cfg = env.ctx.config.webhooks;
    const saved = { ...cfg };
    cfg.maxAttempts = 3;
    cfg.disableAfterFailures = 100;
    cfg.disableMinFailingMs = 2 * MIN;
    try {
      await clearHooks();
      const r = await newReceiver();
      r.plan.push(...Array(20).fill(503));
      const hook = await createHook(r.url, ['session.held']);
      const s = await env.newSession();
      // Phase 1: one delivery fails maxAttempts (3) times with backoff 30 s, 60 s -> failed.
      json(await admin.post(`/sessions/${s.id}/hold`, {}));
      expect(await deliverDueWebhooks(env.ctx)).toMatchObject({ attempted: 1, failed: 0 });
      env.clock.advance(29_000);
      expect((await deliverDueWebhooks(env.ctx)).attempted).toBe(0);
      env.clock.advance(2_000);
      expect(await deliverDueWebhooks(env.ctx)).toMatchObject({ attempted: 1, failed: 0 });
      env.clock.advance(61_000);
      expect(await deliverDueWebhooks(env.ctx)).toMatchObject({ attempted: 1, failed: 1 });
      const [first] = await deliveriesOf(hook.webhook.id);
      expect(first).toMatchObject({ status: 'failed', attempts: 3, lastStatusCode: 503 });
      let w = json<WebhookDTO>(await admin.get(`/webhooks/${hook.webhook.id}`));
      expect(w).toMatchObject({ active: true, failureCount: 3 });

      // Phase 2: with a threshold of 4 consecutive failures over >= 2 minutes, the next failure disables it.
      cfg.disableAfterFailures = 4;
      env.clock.advance(MIN);
      json(await admin.post(`/sessions/${s.id}/hold`, { note: 'again' }));
      json(await admin.post(`/sessions/${s.id}/hold`, { note: 'and again' }));
      expect(await deliverDueWebhooks(env.ctx)).toMatchObject({ attempted: 1, deferred: 1, disabled: 1 });
      w = json<WebhookDTO>(await admin.get(`/webhooks/${hook.webhook.id}`));
      expect(w).toMatchObject({ active: false, disabledReason: 'failures', failureCount: 4 });
      expect(w.pendingDeliveries).toBe(2);
      const [a] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'webhook.auto_disabled'), eq(auditLog.targetId, hook.webhook.id)));
      expect(a).toMatchObject({ actorType: 'system' });
      const rows = await deliveriesOf(hook.webhook.id);

      // Disabled: new changes are not enqueued, nothing is sent.
      const sent = r.received.length;
      json(await admin.post(`/sessions/${s.id}/release`, { requireCheck: false }));
      json(await admin.post(`/sessions/${s.id}/hold`, {}));
      expect((await deliveriesOf(hook.webhook.id)).length).toBe(rows.length);
      env.clock.advance(60 * MIN);
      expect((await deliverDueWebhooks(env.ctx)).attempted).toBe(0);
      expect(r.received.length).toBe(sent);
      admin = await staffApi(env, 'admin'); // an hour later: past the staff idle timeout (60 min)

      // Re-enable: counters reset, pending deliveries are sent right away.
      r.plan.length = 0;
      const re = json<WebhookDTO>(await admin.put(`/webhooks/${hook.webhook.id}`, { active: true }));
      expect(re).toMatchObject({ active: true, failureCount: 0, disabledReason: null, disabledAt: null });
      const pendingBefore = (await deliveriesOf(hook.webhook.id)).filter((d) => d.status === 'pending').length;
      const run = await deliverDueWebhooks(env.ctx);
      expect(run.succeeded).toBe(pendingBefore);
      expect(json<WebhookDTO>(await admin.get(`/webhooks/${hook.webhook.id}`))).toMatchObject({ pendingDeliveries: 0, failureCount: 0 });
    } finally {
      Object.assign(cfg, saved);
    }
  });

  it('sends a test ping immediately (no retries) and redelivers a delivery with the same id', async () => {
    const r = await newReceiver();
    const hook = await createHook(r.url, ['session.held']);
    const ok = json<WebhookDeliveryDTO>(await admin.post(`/webhooks/${hook.webhook.id}/test`));
    expect(ok).toMatchObject({ eventType: 'ping', status: 'succeeded', attempts: 1, maxAttempts: 1, lastStatusCode: 200 });
    const ping = r.received.at(-1)!;
    expect(ping.headers['x-smartproctoring-event']).toBe('ping');
    expect(verify(ping.body, ping.headers['x-smartproctoring-signature'] as string, hook.secret, 300, nowSec())).toBe(true);
    r.plan.push(500);
    const bad = json<WebhookDeliveryDTO>(await admin.post(`/webhooks/${hook.webhook.id}/test`));
    expect(bad).toMatchObject({ status: 'failed', attempts: 1, lastStatusCode: 500 });
    expect(json<WebhookDTO>(await admin.get(`/webhooks/${hook.webhook.id}`)).failureCount).toBe(0); // pings do not affect health
    expect((await admin.post(`/webhooks/deliveries/${bad.id}/redeliver`)).statusCode).toBe(409);

    const s = await env.newSession();
    json(await admin.post(`/sessions/${s.id}/hold`, {}));
    await deliverDueWebhooks(env.ctx);
    const list = json<{ items: WebhookDeliveryDTO[] }>(await admin.get(`/webhooks/${hook.webhook.id}/deliveries`)).items;
    const held = list.find((d) => d.eventType === 'session.held')!;
    expect(held).toMatchObject({ status: 'succeeded', sessionId: s.id });
    expect(held.payload).toBeUndefined();
    const detail = json<WebhookDeliveryDTO>(await admin.get(`/webhooks/deliveries/${held.id}`));
    expect(detail.payload).toMatchObject({ id: held.id, type: 'session.held', data: { sessionId: s.id } });
    const n = r.received.length;
    const re = json<WebhookDeliveryDTO>(await admin.post(`/webhooks/deliveries/${held.id}/redeliver`));
    expect(re).toMatchObject({ id: held.id, status: 'succeeded', attempts: 1 });
    expect(r.received.length).toBe(n + 1);
    expect(r.received.at(-1)!.headers['x-smartproctoring-delivery']).toBe(held.id);
    const [aud] = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'webhook.redelivered'), eq(auditLog.targetId, held.id)));
    expect(aud).toBeTruthy();
    // Other organisations cannot see or redeliver it.
    expect((await admin.get(`/webhooks/deliveries/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('expires stuck deliveries after 72 h and deletes old delivery records after 30 days', async () => {
    const r = await newReceiver();
    const hook = await createHook(r.url, ['session.held']);
    json(await admin.put(`/webhooks/${hook.webhook.id}`, { active: false }));
    await env.ctx.db.insert(webhookDeliveries).values({
      id: randomUUID(),
      webhookId: hook.webhook.id,
      orgId: env.org.id,
      eventType: 'session.held',
      dedupeKey: `manual:${randomUUID()}`,
      payload: {},
      nextAttemptAt: new Date(env.clock.t),
      createdAt: new Date(env.clock.t),
    });
    env.clock.advance(73 * 3600_000);
    expect((await webhookHousekeeping(env.ctx)).expired).toBeGreaterThanOrEqual(1);
    expect((await deliveriesOf(hook.webhook.id))[0]).toMatchObject({ status: 'failed' });
    env.clock.advance(31 * 24 * 3600_000);
    expect((await webhookHousekeeping(env.ctx)).deleted).toBeGreaterThanOrEqual(1);
    expect(await deliveriesOf(hook.webhook.id)).toHaveLength(0);
  });
});

describe('SSRF protection', () => {
  it('refuses private destinations when saving and when delivering (production settings)', async () => {
    await clearHooks();
    const r = await newReceiver();
    const hook = await createHook(r.url, ['session.held']); // created while private networks are allowed (dev/test)
    const cfg = env.ctx.config.webhooks;
    const saved = { ...cfg };
    cfg.allowPrivateNetworks = false;
    cfg.requireHttps = true;
    try {
      for (const url of [`https://127.0.0.1:${r.port}/hook`, `https://localhost:${r.port}/hook`, 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://10.0.0.8/x', 'https://[fd00::1]/x']) {
        const res = await admin.post('/webhooks', { url, events: ['session.held'] });
        expect(res.statusCode, url).toBe(400);
        expect(res.json().error).toBe('invalid_webhook_url');
      }
      const http1 = await admin.post('/webhooks', { url: 'http://93.184.216.34/hook', events: ['session.held'] });
      expect(http1.statusCode).toBe(400);
      expect(http1.json().message).toMatch(/https/);
      expect((await admin.put(`/webhooks/${hook.webhook.id}`, { url: `https://127.0.0.1:${r.port}/other` })).statusCode).toBe(400);

      // An existing webhook whose URL now points at a private address is not called.
      cfg.requireHttps = false;
      const s = await env.newSession();
      json(await admin.post(`/sessions/${s.id}/hold`, {}));
      await deliverDueWebhooks(env.ctx);
      const [d] = await deliveriesOf(hook.webhook.id);
      expect(d.lastError).toMatch(/not a public address/);
      expect(r.received).toHaveLength(0);
    } finally {
      Object.assign(cfg, saved);
    }
  });
});
