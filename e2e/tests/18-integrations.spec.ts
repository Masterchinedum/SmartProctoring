import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type BrowserContext, type Page } from '@playwright/test';
import type { WebhookDeliveryDTO } from '../../packages/shared/src/integrations';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { idPhotoAvailable, idPhotoPath } from '../lib/fixtures';
import { documentedVerifier, localhostCert, privacyProblems, SmtpSink, WebhookReceiver, type ReceivedMail, type VerifyFn } from '../lib/integrations';
import { artifactLog, resetDatabase, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 18 — integrations end to end, on a dedicated server instance (own port, database and storage)
 * configured like a production deployment with an SMTP server and an https webhook receiver:
 *
 *  a) staff UI (Integrations page): create an API key, create a webhook (signing secret shown once), "Send test"
 *     → the local receiver gets a `ping` whose signature the function copied verbatim from
 *     docs/INTEGRATION_API.md accepts; email alert recipients saved and "Send test email" delivered to the local
 *     SMTP sink;
 *  b) an LMS drives /api/v1 with that key: upsert a candidate by externalId, assign it (idempotent), the candidate
 *     takes the exam with the fake camera (ID-photo mismatch at check-in under the advisory policy, a tab switch, a
 *     staff hold and release, submit); webhooks event.created / identity.mismatch / session.held / session.released /
 *     session.submitted arrive signed and without images or similarity scores; the first delivery answered HTTP 500
 *     is retried (same delivery id, attempt 2) and then succeeds; alert emails: the first goes out at once, later
 *     alerts of the same session within 5 minutes wait and are combined into one email (the 5-minute wait is skipped by
 *     moving the previous send time back in the database), another session is not throttled; the session, its report
 *     and events read back through /api/v1 carry no evidence URLs and no similarity scores.
 */

const API_KEY_RE = /^sp_live_[A-Za-z0-9_-]{43}$/;
const PRIVATE_EXTERNAL_ID = `S-${Date.now().toString(36)}`;

async function switchAway(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    if (h) window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) window.dispatchEvent(new Event('focus'));
  }, hidden);
}

test.describe('integrations', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 1;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'integr');
  let storageDir = '';
  let server: ServerHandle;
  let receiver: WebhookReceiver;
  let smtp: SmtpSink;
  let verify: VerifyFn;
  let staff: StaffApi;
  let staffCtx: BrowserContext;
  // Created in (a), used in (b).
  let apiKey = '';
  let webhookId = '';
  let webhookSecret = '';
  const recipient = 'proctoring-team@e2e.example';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const tls = localhostCert();
    receiver = await WebhookReceiver.start(tls);
    smtp = await SmtpSink.start();
    verify = await documentedVerifier();
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-integr-storage-'));
    server = await startServer({
      port,
      publicHost: '127.0.0.1',
      databaseUrl,
      storageDir,
      logFile: artifactLog('server-integrations.log'),
      env: {
        // Production mode: webhooks must be https:// — the receiver's self-signed certificate is trusted explicitly.
        NODE_EXTRA_CA_CERTS: tls.certPath,
        WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.port),
        SMTP_SECURE: 'false',
        SMTP_FROM: 'SmartProctoring <proctoring-alerts@e2e.example>',
        VISION_THREADS: '2',
      },
    });
    staff = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    staffCtx = await browser.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await staff.storageState() });
  });

  test.afterAll(async () => {
    await staffCtx?.close().catch(() => undefined);
    await staff?.dispose().catch(() => undefined);
    await server?.stop();
    await receiver?.close();
    await smtp?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  test('staff UI: API key, signed webhook with a verified test ping, email alerts with a test email', async () => {
    const page = await staffCtx.newPage();
    await page.goto('/admin/integrations');
    await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();

    /* ---------------- API key: shown once */
    const keys = page.locator('section', { has: page.getByRole('heading', { name: 'API keys' }) });
    await keys.getByLabel('Key name').fill('E2E LMS');
    await keys.getByRole('button', { name: 'Create API key' }).click();
    const keyModal = page.getByRole('dialog', { name: /API key “E2E LMS” created/ });
    await expect(keyModal).toBeVisible();
    apiKey = (await keyModal.getByTestId('secret-value').innerText()).trim();
    expect(apiKey).toMatch(API_KEY_RE);
    await keyModal.getByRole('button', { name: 'I have stored it' }).click();
    const keyRow = keys.locator('tr', { hasText: 'E2E LMS' });
    await expect(keyRow).toContainText(apiKey.slice(0, 16));
    await expect(keyRow).toContainText('Active');
    await expect(keyRow).not.toContainText(apiKey.slice(16));

    /* ---------------- webhook: create, secret shown once, send test */
    const hooks = page.locator('section', { has: page.getByRole('heading', { name: 'Webhooks' }) });
    await hooks.getByRole('button', { name: 'Add webhook' }).click();
    const form = page.getByRole('dialog', { name: 'Add webhook' });
    await form.getByLabel('Endpoint URL').fill(receiver.url());
    await form.getByLabel('Description (optional)').fill('E2E LMS receiver');
    for (const t of ['identity.mismatch', 'session.released']) await form.getByRole('checkbox', { name: new RegExp(t.replace('.', '\\.')) }).check();
    for (const t of ['event.created', 'session.held', 'session.submitted']) await expect(form.getByRole('checkbox', { name: new RegExp(t.replace('.', '\\.')) })).toBeChecked();
    await form.getByRole('button', { name: 'Create webhook' }).click();
    const secretModal = page.getByRole('dialog', { name: 'Webhook created' });
    webhookSecret = (await secretModal.getByTestId('secret-value').innerText()).trim();
    expect(webhookSecret).toMatch(/^whsec_/);
    await secretModal.getByRole('button', { name: 'I have stored it' }).click();
    const hookRow = hooks.locator('tr', { hasText: receiver.url() });
    await expect(hookRow).toContainText('Active');
    webhookId = (await staff.json<{ items: { id: string; url: string }[] }>('get', '/api/admin/webhooks')).items.find((w) => w.url === receiver.url())!.id;

    await hookRow.getByRole('button', { name: 'Send test' }).click();
    await expect(hooks.getByRole('status')).toContainText(`Test to 127.0.0.1:${receiver.port}: delivered (HTTP 200).`);
    const ping = receiver.ofType('ping');
    expect(ping).toHaveLength(1);
    const p = ping[0];
    expect(p.headers['user-agent']).toBe('SmartProctoring-Webhooks/1.0');
    expect(p.headers['x-smartproctoring-event']).toBe('ping');
    expect(p.headers['x-smartproctoring-delivery']).toBe(p.body.id);
    expect(p.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(p.body.data).toMatchObject({ webhookId, sentBy: expect.any(String) });
    // The documented verification function: accepts the genuine request, rejects a wrong secret / altered body / stale time.
    expect(verify(p.rawBody, p.headers['x-smartproctoring-signature'], webhookSecret)).toBe(true);
    expect(verify(p.rawBody.toString('utf8'), p.headers['x-smartproctoring-signature'], webhookSecret)).toBe(true);
    expect(verify(p.rawBody, p.headers['x-smartproctoring-signature'], `${webhookSecret}x`)).toBe(false);
    expect(verify(Buffer.from(p.rawBody.toString('utf8').replace('Test notification', 'Test notificatioN')), p.headers['x-smartproctoring-signature'], webhookSecret)).toBe(false);
    expect(verify(p.rawBody, p.headers['x-smartproctoring-signature'], webhookSecret, 300, Math.floor(Date.now() / 1000) + 600)).toBe(false);

    /* ---------------- email alerts: recipients, toggles, test email */
    const email = page.locator('section', { has: page.getByRole('heading', { name: 'Email alerts' }) });
    await expect(email).toContainText('Alert emails are sent from SmartProctoring <proctoring-alerts@e2e.example>');
    await email.getByLabel('Recipients (one email address per line)').fill(recipient);
    for (const name of [/An exam is put on hold/, /A candidate requests a pause/, /A high-severity event is observed/]) await expect(email.getByRole('checkbox', { name })).toBeChecked();
    await email.getByRole('button', { name: 'Save email alerts' }).click();
    await expect(email.getByText('Saved.')).toBeVisible();
    await email.getByRole('button', { name: 'Send test email' }).click();
    await expect(email).toContainText(`Test email sent to ${recipient}.`);
    await expect.poll(() => smtp.messages.length, { timeout: 15_000 }).toBe(1);
    const m = smtp.messages[0];
    expect(m.to).toEqual([recipient]);
    expect(m.from).toBe('proctoring-alerts@e2e.example');
    expect(m.subject).toBe('[SmartProctoring] Test email for E2E University');
    expect(m.text).toContain('Email alerts are working.');
    await page.close();
  });

  test('LMS flow over /api/v1 + fake-camera exam: signed webhooks (with a retry), throttled alert emails, no evidence or scores', async () => {
    skipUnlessFixtures('a');
    test.skip(!idPhotoAvailable('id-other.jpg'), 'face images for the ID photo not found (set E2E_FACES_DIR)');
    test.setTimeout(6 * 60_000);
    expect(apiKey, 'API key from the UI test').toMatch(API_KEY_RE);
    const lms = await request.newContext({ baseURL: server.url, extraHTTPHeaders: { Authorization: `Bearer ${apiKey}` } });
    const v1 = async <T>(method: 'get' | 'post', path: string, data?: unknown, status?: number): Promise<T> => {
      const res = await lms[method](`/api/v1${path}`, data === undefined ? undefined : { data });
      if (status != null) expect(res.status(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBe(status);
      else expect(res.ok(), `${method.toUpperCase()} ${path}: ${res.status()} ${await res.text()}`).toBe(true);
      return (await res.json()) as T;
    };
    try {
      /* ---------------- auth */
      const anon = await request.newContext({ baseURL: server.url });
      const unauth = await anon.get('/api/v1/exams');
      expect(unauth.status()).toBe(401);
      expect(await unauth.json()).toMatchObject({ error: 'invalid_api_key' });
      await anon.dispose();

      /* ---------------- the exam (created by staff), visible to the LMS */
      const exam = await staff.createExam({ policy: { identity: { liveness: 'off', idPhotoComparison: 'advisory', periodicCheckIntervalSec: 30 }, browser: { requireFullscreen: false } } });
      const exams = await v1<{ items: { id: string; title: string; status: string; durationSec: number }[] }>('get', '/exams?status=published');
      expect(exams.items.find((e) => e.id === exam.id)).toMatchObject({ title: exam.title, status: 'published', durationSec: 1800 });

      /* ---------------- candidates: upsert by externalId */
      const created = await v1<{ candidate: { id: string; name: string; externalId: string }; created: boolean }>('post', '/candidates', { name: 'Ada Lovelace', email: 'ada@e2e.example', externalId: PRIVATE_EXTERNAL_ID }, 201);
      expect(created.created).toBe(true);
      const updated = await v1<{ candidate: { id: string; name: string; email: string }; created: boolean }>('post', '/candidates', { name: 'Ada King', externalId: PRIVATE_EXTERNAL_ID }, 200);
      expect(updated).toMatchObject({ created: false, candidate: { id: created.candidate.id, name: 'Ada King', email: 'ada@e2e.example' } });
      const found = await v1<{ items: { id: string }[]; total: number }>('get', `/candidates?externalId=${encodeURIComponent(PRIVATE_EXTERNAL_ID)}`);
      expect(found.total).toBe(1);
      expect(found.items[0].id).toBe(created.candidate.id);
      const other = await v1<{ candidate: { id: string } }>('post', '/candidates', { name: 'Grace Hopper', externalId: `${PRIVATE_EXTERNAL_ID}-2` }, 201);
      // An approved ID photo of someone else: the check-in comparison flags it (advisory: the exam continues).
      expect((await staff.uploadIdPhoto(created.candidate.id, readFileSync(idPhotoPath('id-other.jpg')))).accepted).toBe(true);

      /* ---------------- assignments: links, idempotent */
      type Assign = { items: { sessionId: string; candidateId: string; externalId: string; accessLink: string; existing: boolean }[] };
      const a1 = await v1<Assign>('post', `/exams/${exam.id}/assignments`, { externalIds: [PRIVATE_EXTERNAL_ID] });
      expect(a1.items[0]).toMatchObject({ candidateId: created.candidate.id, externalId: PRIVATE_EXTERNAL_ID, existing: false });
      expect(a1.items[0].accessLink).toMatch(new RegExp(`^${server.url.replace(/[.]/g, '\\.')}/take/`));
      const again = await v1<Assign>('post', `/exams/${exam.id}/assignments`, { externalIds: [PRIVATE_EXTERNAL_ID] });
      expect(again.items[0]).toMatchObject({ sessionId: a1.items[0].sessionId, accessLink: a1.items[0].accessLink, existing: true });
      const s1 = a1.items[0].sessionId;
      const s2 = (await v1<Assign>('post', `/exams/${exam.id}/assignments`, { candidateIds: [other.candidate.id] })).items[0].sessionId;

      /* ---------------- the receiver fails the first proctoring-event notification once (HTTP 500) */
      let failedDelivery: string | null = null;
      receiver.responder = (r) => {
        if (!failedDelivery && r.body.type === 'event.created') {
          failedDelivery = r.body.id;
          return 500;
        }
        return 200;
      };

      /* ---------------- the candidate takes the exam */
      const browser = await launchCamera('a');
      try {
        const ctx = await browser.newContext({ baseURL: server.url, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
        const c = await CandidatePage.open(null, a1.items[0].accessLink, { context: ctx });
        await c.checkInAndStart(); // ID-photo mismatch under 'advisory': flagged, not stopped
        await c.answerStandardQuestions();
        const mm = await staff.waitForEventType(s1, 'identity_mismatch');
        expect(mm.details).toMatchObject({ against: 'id_photo' });

        // First alert email of this session (high severity: possible different person) goes out at once.
        const mailsFor = (sid: string): ReceivedMail[] => smtp.messages.filter((x) => x.text.includes(`/admin/sessions/${sid}`));
        await expect.poll(() => mailsFor(s1).length, { timeout: 30_000, message: 'first alert email' }).toBe(1);
        const first = mailsFor(s1)[0];
        expect(first.subject).toMatch(/^\[SmartProctoring\] (Possible different person|\d+ alerts): Ada King — /);
        expect(first.subject.endsWith(exam.title)).toBe(true);
        expect(first.text).toContain('Possible different person: The candidate at check-in may not be the person in the approved identity photo.');
        expect(first.to).toEqual([recipient]);
        expect(first.text).toContain(`Candidate: Ada King (external ID ${PRIVATE_EXTERNAL_ID})`);
        expect(first.text).toContain(`${server.url}/admin/sessions/${s1}`);

        // A tab switch (potential integrity event, medium severity) -> webhook only.
        await switchAway(c.page, true);
        await c.page.waitForTimeout(3_000);
        await switchAway(c.page, false);
        await staff.waitForEventType(s1, 'tab_hidden', { closed: true });

        // Staff hold -> session.held + hold alert; within 5 minutes of the first email it waits (throttled).
        const heldAt = Date.now();
        await staff.hold(s1, 'Checking the ID photo');
        await expect(c.tid('hold-screen')).toBeVisible({ timeout: 30_000 });
        // Another session is not throttled by this one: its hold email goes out at once.
        await staff.hold(s2, 'Not yet started');
        await expect.poll(() => mailsFor(s2).length, { timeout: 30_000, message: 'other session: immediate email' }).toBe(1);
        expect(mailsFor(s2)[0].subject).toBe(`[SmartProctoring] Exam on hold: Grace Hopper — ${exam.title}`);
        type AlertRow = { kind: string; status: string; sent_at: Date | null; next_attempt_at: Date };
        const rows = async () => sql<AlertRow>(databaseUrl, 'SELECT kind, status, sent_at, next_attempt_at FROM email_alerts WHERE session_id = $1 ORDER BY created_at', [s1]);
        await expect.poll(async () => (await rows()).some((r) => r.kind === 'hold'), { timeout: 15_000 }).toBe(true);
        await new Promise((r) => setTimeout(r, Math.max(0, heldAt + 15_000 - Date.now()))); // > one email-job interval (10 s)
        expect(mailsFor(s1), 'throttled: still one email for this session').toHaveLength(1);
        const firstSentAt = (await rows()).find((r) => r.status === 'sent')!.sent_at!.getTime();
        const holdRow = (await rows()).find((r) => r.kind === 'hold')!;
        expect(holdRow.status).toBe('pending');
        expect(holdRow.next_attempt_at.getTime(), 'waits for the 5-minute window').toBe(firstSentAt + 5 * 60_000);

        // Skip the wait: the previous email "was sent" 5 minutes earlier -> one combined email.
        await sql(databaseUrl, `UPDATE email_alerts SET sent_at = sent_at - interval '5 minutes' WHERE session_id = $1 AND status = 'sent'`, [s1]);
        await sql(databaseUrl, `UPDATE email_alerts SET next_attempt_at = now() WHERE session_id = $1 AND status = 'pending'`, [s1]);
        await expect.poll(() => mailsFor(s1).length, { timeout: 30_000, message: 'combined alert email' }).toBe(2);
        const digest = mailsFor(s1)[1];
        expect(digest.text).toContain('Exam on hold: The exam was put on hold because a staff member placed it on hold.');
        expect(digest.subject).toMatch(/^\[SmartProctoring\] (Exam on hold|\d+ alerts): Ada King — /);
        expect((await rows()).find((r) => r.kind === 'hold')!.status).toBe('sent');

        // Release without a new check -> the candidate continues and submits.
        await staff.release(s1, { requireCheck: false, note: 'ID photo to be reviewed after the exam' });
        await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
        await c.submit();
        await c.close();
      } finally {
        await browser.close();
      }

      /* ---------------- webhooks: every notification signed, retried once after HTTP 500 */
      await expect
        .poll(() => ['identity.mismatch', 'session.held', 'session.released', 'session.submitted'].every((t) => receiver.requests.some((r) => r.body.type === t && r.body.data.sessionId === s1 && r.status === 200)), {
          timeout: 90_000,
          message: 'all notifications delivered',
        })
        .toBe(true);
      expect(failedDelivery, 'a delivery was answered with HTTP 500').not.toBeNull();
      await expect.poll(() => receiver.requests.filter((r) => r.body.id === failedDelivery).map((r) => r.status), { timeout: 90_000, message: 'retried after 500' }).toEqual([500, 200]);
      const attempts = receiver.requests.filter((r) => r.body.id === failedDelivery);
      expect(attempts.map((r) => r.headers['x-smartproctoring-attempt'])).toEqual(['1', '2']);
      expect(attempts.map((r) => r.headers['x-smartproctoring-delivery'])).toEqual([failedDelivery, failedDelivery]);
      expect(attempts[1].at - attempts[0].at, 'first retry after ~30 s').toBeGreaterThanOrEqual(29_000);
      expect(attempts[1].rawBody.equals(attempts[0].rawBody), 'same payload').toBe(true);
      const deliveries = await staff.json<{ items: WebhookDeliveryDTO[] }>('get', `/api/admin/webhooks/${webhookId}/deliveries`);
      expect(deliveries.items.find((d) => d.id === failedDelivery)).toMatchObject({ status: 'succeeded', attempts: 2, lastStatusCode: 200 });

      const now = Math.floor(Date.now() / 1000);
      for (const r of receiver.requests) {
        expect(verify(r.rawBody, r.headers['x-smartproctoring-signature'], webhookSecret, 300, now), `signature of ${r.body.type} ${r.body.id}`).toBe(true);
        expect(r.headers['x-smartproctoring-event']).toBe(r.body.type);
        expect(privacyProblems(r.body), `${r.body.type} payload`).toEqual([]);
        expect(r.rawBody.toString('utf8')).not.toMatch(/similarity/i);
      }
      const ofSession = (type: string) => receiver.requests.filter((r) => r.status === 200 && r.body.type === type && r.body.data.sessionId === s1).map((r) => r.body.data);
      const created1 = ofSession('event.created');
      expect(created1.map((d) => d.type)).toEqual(expect.arrayContaining(['identity_mismatch', 'tab_hidden']));
      for (const d of created1) {
        expect(['integrity', 'uncertain', 'technical']).toContain(d.category);
        expect(['medium', 'high']).toContain(d.severity);
        expect(d.candidate).toEqual({ id: created.candidate.id, name: 'Ada King', externalId: PRIVATE_EXTERNAL_ID });
        expect(d.exam).toEqual({ id: exam.id, title: exam.title });
        expect(d.staffUrl).toBe(`${server.url}/admin/sessions/${s1}?event=${d.id}`);
        expect(Object.keys(d)).not.toContain('details');
      }
      expect(created1.find((d) => d.type === 'tab_hidden')).toMatchObject({ category: 'integrity', severity: 'medium', title: 'Left the exam tab' });
      expect(ofSession('identity.mismatch')[0]).toMatchObject({ type: 'identity_mismatch', severity: 'high', title: 'Possible different person' });
      expect(ofSession('session.held')[0]).toMatchObject({ status: 'on_hold', reason: 'staff', staffUrl: `${server.url}/admin/sessions/${s1}` });
      expect(ofSession('session.released')[0]).toMatchObject({ requireCheck: false });
      const submitted = ofSession('session.submitted')[0];
      expect(submitted).toMatchObject({ status: 'submitted', endReason: 'candidate_submitted', candidate: { externalId: PRIVATE_EXTERNAL_ID } });
      expect(submitted.score).toMatchObject({ maxPoints: 8, autoGraded: false });
      expect((submitted.score as { points: number }).points).toBeGreaterThanOrEqual(4);

      /* ---------------- emails: no images, no scores */
      for (const m of smtp.messages) {
        expect(m.partTypes.filter((t) => t.startsWith('image/'))).toEqual([]);
        expect(m.html).not.toMatch(/<img/i);
        expect(`${m.subject}\n${m.text}\n${m.html}`).not.toMatch(/similarity|data:image/i);
      }

      /* ---------------- read back through /api/v1: session, report, events */
      const sess = await v1<Record<string, unknown>>('get', `/sessions/${s1}`);
      expect(sess).toMatchObject({ id: s1, status: 'submitted', endReason: 'candidate_submitted', candidate: { externalId: PRIVATE_EXTERNAL_ID }, staffUrl: `${server.url}/admin/sessions/${s1}` });
      expect(sess.accessLink).toBe(a1.items[0].accessLink);
      expect((sess.counts as { integrity: number }).integrity).toBeGreaterThanOrEqual(2);
      expect(privacyProblems(sess)).toEqual([]);
      const list = await v1<{ items: { id: string }[]; total: number }>('get', `/sessions?externalId=${encodeURIComponent(PRIVATE_EXTERNAL_ID)}`);
      expect(list.items.map((x) => x.id)).toEqual([s1]);

      const report = await v1<Record<string, unknown>>('get', `/sessions/${s1}/report?tz=Europe/Berlin`);
      expect(privacyProblems(report), 'report').toEqual([]);
      const reportText = JSON.stringify(report);
      expect(reportText).not.toMatch(/\/api\/admin\/evidence\//);
      expect(reportText).not.toMatch(/similarity[^"]*"\s*:\s*-?\d/i);
      expect(reportText).toContain('approved ID photo');

      const events = (await v1<{ items: Record<string, unknown>[] }>('get', `/sessions/${s1}/events`)).items;
      expect(privacyProblems(events), 'events').toEqual([]);
      const mmEvent = events.find((e) => e.type === 'identity_mismatch')!;
      expect(mmEvent.evidenceCount as number).toBeGreaterThan(0);
      expect(mmEvent).not.toHaveProperty('evidence');
      expect(mmEvent.staffUrl).toBe(`${server.url}/admin/sessions/${s1}?event=${mmEvent.id}`);
      expect((mmEvent.details as Record<string, unknown>).similarity).toBeNull();
      expect((events.find((e) => e.type === 'id_photo_compared')!.details as Record<string, unknown>).similarity).toBeNull();

      /* ---------------- staff UI: the retried delivery, and the key's last use */
      const page = await staffCtx.newPage();
      await page.goto('/admin/integrations');
      const hooks = page.locator('section', { has: page.getByRole('heading', { name: 'Webhooks' }) });
      await hooks.locator('tr', { hasText: receiver.url() }).getByRole('button', { name: 'Deliveries' }).click();
      const dm = page.getByRole('dialog', { name: /Deliveries/ });
      await expect(dm.locator('tbody tr', { hasText: '2/10' }).first()).toContainText('Delivered');
      await dm.getByRole('button', { name: 'Close' }).last().click();
      const keyRow = page.locator('section', { has: page.getByRole('heading', { name: 'API keys' }) }).locator('tr', { hasText: 'E2E LMS' });
      await expect(keyRow).not.toContainText('Never');
      await page.close();
    } finally {
      await lms.dispose();
    }
  });
});
