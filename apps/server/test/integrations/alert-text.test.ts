/**
 * Security review #10: text a candidate controls (client event observations, camera labels, pause reasons) must
 * not reach staff inboxes or webhook receivers as links from a trusted sender. Client-reported events use the
 * EVENT_CATALOG wording; other user-controlled text is stripped of links.
 */
import { EVENT_CATALOG, type WebhookEnvelope } from '@sp/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailAlerts, webhookDeliveries } from '../../src/db/schema.js';
import { MemoryMailer } from '../../src/lib/mailer.js';
import { LINK_PLACEHOLDER, stripUrls } from '../../src/lib/text-safety.js';
import { composeAlertEmail, sendDueEmailAlerts } from '../../src/services/email-alerts.js';
import { outboundEventText } from '../../src/services/integration-events.js';
import { clientEvent, json, MIN, staffApi, type Api } from '../admin/fixtures.js';
import { DEVICE, runCheck, startedSession } from '../flow.js';
import { createTestEnv, type TestEnv } from '../helpers.js';

const EVIL = 'Your exam account is locked. Verify now at https://evil.example/verify or evil-support.example.com';

describe('stripUrls', () => {
  it('removes explicit links, bare host names and IP literals, keeping ordinary sentences', () => {
    expect(stripUrls('see https://evil.example/a?b=1 now')).toBe(`see ${LINK_PLACEHOLDER} now`);
    expect(stripUrls('go to evil.com/reset or www.evil.co.uk')).toBe(`go to ${LINK_PLACEHOLDER} or ${LINK_PLACEHOLDER}`);
    expect(stripUrls('mailto:a@evil.com')).toBe(LINK_PLACEHOLDER);
    expect(stripUrls('open 203.0.113.5:8080/x')).toBe(`open ${LINK_PLACEHOLDER}`);
    expect(stripUrls('fullwidth evil．com')).toBe(`fullwidth ${LINK_PLACEHOLDER}`);
    expect(stripUrls('HXXP://evil.com')).toBe(LINK_PLACEHOLDER);
    for (const ok of ['I need a bathroom break, e.g. 5 minutes. Thanks!', 'Headache; back in 5 min.', 'The lighting differs from the identity reference (darker).']) {
      expect(stripUrls(ok)).toBe(ok);
    }
    // Identifiers keep e-mail addresses / dotted names, but lose explicit links.
    expect(stripUrls('jane.doe@uni.edu', { bareHosts: false })).toBe('jane.doe@uni.edu');
    expect(stripUrls('Alice https://x.example', { bareHosts: false })).toBe(`Alice ${LINK_PLACEHOLDER}`);
  });

  it('uses catalog wording for client-reported events and keeps (link-free) server wording', () => {
    const cat = EVENT_CATALOG.multiple_people;
    for (const source of ['client_vision', 'client_browser'] as const) {
      expect(outboundEventText({ type: 'multiple_people', source, title: 'x', observation: EVIL })).toEqual({ title: cat.title, observation: cat.observation });
    }
    const server = outboundEventText({ type: 'identity_mismatch', source: 'server_identity', title: 'Possible different person', observation: 'A different face may have appeared.' });
    expect(server).toEqual({ title: 'Possible different person', observation: 'A different face may have appeared.' });
    expect(outboundEventText({ type: 'identity_mismatch', source: 'server_identity', title: 'Possible different person', observation: 'see www.evil.example' }).observation).toBe(`see ${LINK_PLACEHOLDER}`);
  });

  it('strips links when rendering alert emails (also rows queued before the fix)', () => {
    const msg = composeAlertEmail(
      { orgName: 'Uni https://evil.example', sessionId: 's', candidate: { name: 'Mallory www.evil.example', externalId: 'm.allory@uni.example' }, exam: { title: 'Maths' }, staffUrl: 'http://exam.test/admin/sessions/s' },
      [{ title: 'More than one person in view', observation: EVIL, occurredAt: new Date(0) }],
      ['staff@test.example'],
    );
    for (const part of [msg.subject, msg.text, msg.html ?? '']) {
      expect(part).not.toContain('evil');
    }
    expect(msg.text).toContain('m.allory@uni.example');
    expect(msg.text).toContain('http://exam.test/admin/sessions/s');
  });
});

describe('alerts and webhooks from a hostile candidate', () => {
  let env: TestEnv;
  let admin: Api;
  const mailer = new MemoryMailer('SmartProctoring <alerts@test.example>');
  const received: string[] = [];
  let server: import('node:http').Server;
  let hookUrl = '';

  beforeAll(async () => {
    env = await createTestEnv({ mailer, policy: { pause: { requireApproval: true } } });
    const http = await import('node:http');
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await env?.close();
  });
  beforeEach(async () => {
    admin = await staffApi(env, 'admin');
  });

  it('forwards catalog wording for client events and link-free pause reasons; never camera labels', async () => {
    json(await admin.put('/settings', { alertRecipients: ['proctors@test.example'] }));
    json(await admin.post('/webhooks', { url: hookUrl, events: ['event.created', 'event.closed', 'session.pause_requested'], minSeverity: 'info', description: 'test' }));
    const s = await env.newSession();
    const c = await startedSession(env, env.candidateClient(s.token));
    env.clock.advance(MIN);
    const t = env.clock.t;
    await clientEvent(c, { type: 'multiple_people', startedAt: t - 10_000, endedAt: null, confidence: 0.9, observation: EVIL });
    await clientEvent(c, { type: 'camera_disconnected', startedAt: t - 9_000, endedAt: t - 8_000, observation: 'Camera “Call +1 555 0100 or visit evil.example” disconnected', details: { cameraLabel: 'https://evil.example' } });
    const pause = await c.req('POST', '/api/candidate/pause', { reason: 'Urgent: staff must re-login at www.evil.example/login' });
    expect(pause.json().outcome).toBe('pending_approval');
    // A reconnect check from a browser whose camera label is a link (server-side camera_changed event).
    env.clock.advance(5_000);
    const c2 = env.candidateClient(s.token);
    const { complete } = await runCheck(env, c2, 'reconnect', { device: { ...DEVICE, cameraLabel: 'Visit https://evil.example/cam', cameraIdHash: 'cam-hash-b' } });
    expect(complete!.outcome).toBe('passed');

    // Email: catalog wording, pause reason without the link.
    const queued = await env.ctx.db.select().from(emailAlerts).where(eq(emailAlerts.sessionId, s.id));
    expect(queued.map((q) => q.kind).sort()).toEqual(['high_severity', 'pause_request']);
    expect(queued.find((q) => q.kind === 'high_severity')!.observation).toBe(EVENT_CATALOG.multiple_people.observation);
    expect(queued.find((q) => q.kind === 'pause_request')!.observation).toContain(`re-login at ${LINK_PLACEHOLDER}`);
    await sendDueEmailAlerts(env.ctx);
    env.clock.advance(6 * MIN);
    await sendDueEmailAlerts(env.ctx);
    const mails = mailer.sent.filter((m) => m.to.includes('proctors@test.example'));
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) expect(`${m.subject}\n${m.text}\n${m.html}`).not.toMatch(/evil|555 0100/);

    // Webhooks: the stored payloads and what the receiver got.
    const { deliverDueWebhooks } = await import('../../src/services/webhooks.js');
    await deliverDueWebhooks(env.ctx);
    const payloads = (await env.ctx.db.select().from(webhookDeliveries)).map((d) => d.payload as unknown as WebhookEnvelope);
    const created = payloads.filter((p) => p.type === 'event.created').map((p) => p.data as { type: string; title: string; observation: string });
    expect(created.find((d) => d.type === 'multiple_people')).toMatchObject({ title: EVENT_CATALOG.multiple_people.title, observation: EVENT_CATALOG.multiple_people.observation });
    expect(created.find((d) => d.type === 'camera_disconnected')).toMatchObject({ observation: EVENT_CATALOG.camera_disconnected.observation });
    const pr = payloads.find((p) => p.type === 'session.pause_requested')!.data as { pauseRequest: { reason: string } };
    expect(pr.pauseRequest.reason).toBe(`Urgent: staff must re-login at ${LINK_PLACEHOLDER}`);
    expect(received.length).toBe(payloads.length);
    for (const body of [JSON.stringify(payloads), ...received]) expect(body).not.toMatch(/evil|555 0100/);
  });
});
