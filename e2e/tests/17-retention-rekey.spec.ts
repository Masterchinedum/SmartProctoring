import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { idPhotoAvailable, idPhotoPath } from '../lib/fixtures';
import { documentedVerifier, localhostCert, WebhookReceiver } from '../lib/integrations';
import { artifactLog, cliJson, resetDatabase, runServerCli, serverEnv, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { StaffApi, type SessionHandle } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 17 — data lifecycle operations, run exactly as an operator would (docs/OPERATIONS.md §3, §6):
 *
 *  a) Retention (main server): a submitted session whose evidence retention (exam policy: 1 day) has passed —
 *     its end time is moved 2 days back in the database, the only way to get there without waiting — is purged by
 *     `pnpm --filter @sp/server retention:run`: blobs deleted, every evidence URL answers 410, the staff UI shows
 *     "Deleted under the retention policy" placeholders, events stay. A session under legal hold is kept, and is
 *     purged once the hold is lifted.
 *  b) Key rotation (dedicated server instance on its own port / database / storage, restarted three times):
 *     EVIDENCE_KEY rotated with the old key in EVIDENCE_KEYS_OLD → `pnpm --filter @sp/server rekey` → old key
 *     removed → evidence images, access links, webhook signing secrets, identity references (resume check) and the
 *     approved ID photo's template (check-in comparison) all still work.
 */

type RetentionSummary = {
  sessionsEvidencePurged: number;
  evidenceItemsPurged: number;
  skippedLegalHold: number;
  failures: unknown[];
  dryRun: boolean;
  sessions: { sessionId: string; evidencePurged: number | null }[];
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Consent → check → start → submit (the shortest complete session with identity evidence). */
async function completeSession(browser: Browser, s: SessionHandle): Promise<void> {
  const c = await CandidatePage.open(browser, s.link);
  try {
    await c.checkInAndStart();
    await c.submit();
  } finally {
    await c.close();
  }
}

/** Evidence whose image still exists (surplus burst-frame and passed-check images are purged by design). */
async function evidenceIds(databaseUrl: string, sessionId: string): Promise<{ id: string; kind: string }[]> {
  return sql<{ id: string; kind: string }>(databaseUrl, 'SELECT id, kind FROM evidence WHERE session_id = $1 AND purged_at IS NULL ORDER BY created_at', [sessionId]);
}

async function statuses(staff: StaffApi, ids: string[]): Promise<number[]> {
  return Promise.all(ids.map(async (id) => (await staff.raw(`/api/admin/evidence/${id}`)).status()));
}

async function placeholders(page: Page): Promise<number> {
  return page.locator('.evidence-purged', { hasText: 'Deleted under the retention policy' }).count();
}

test('retention: an ended session past its retention is purged by retention:run (410, placeholders); legal hold keeps it', async ({ staff, staffPage }) => {
  test.skip(EXTERNAL_SERVER, 'runs the retention CLI against the main server’s database and storage (not available with E2E_BASE_URL)');
  skipUnlessFixtures('a');
  test.skip(!idPhotoAvailable('id-other.jpg'), 'face images for the ID photo not found (set E2E_FACES_DIR)');
  test.setTimeout(5 * 60_000);
  const storageDir = process.env.E2E_STORAGE_DIR;
  expect(storageDir, 'global setup exports the main server’s storage directory').toBeTruthy();
  const cliEnv = serverEnv({ port: PORT, databaseUrl: DATABASE_URL, storageDir: storageDir! });

  // Evidence kept for 1 day after the session ends; ID-photo comparison adds an event-linked copy of the photo.
  const exam = await staff.createExam({
    policy: { identity: { liveness: 'off', idPhotoComparison: 'advisory', periodicCheckIntervalSec: 30 }, browser: { requireFullscreen: false }, retention: { evidenceDays: 1 } },
  });
  const candP = await staff.createCandidate();
  expect((await staff.uploadIdPhoto(candP.id, readFileSync(idPhotoPath('id-other.jpg')))).accepted).toBe(true);
  const purged = await staff.assign(exam, candP);
  const kept = await staff.assign(exam, await staff.createCandidate());

  const browser = await launchCamera('a');
  try {
    await completeSession(browser, purged);
    await completeSession(browser, kept);
  } finally {
    await browser.close();
  }
  await staff.waitForSession(purged.sessionId, (d) => d.summary.status === 'submitted');
  await staff.waitForSession(kept.sessionId, (d) => d.summary.status === 'submitted');
  const mm = (await staff.events(purged.sessionId)).find((e) => e.type === 'identity_mismatch');
  expect(mm, 'ID-photo mismatch event with evidence').toBeTruthy();
  expect(mm!.evidence.map((e) => e.kind)).toContain('id_photo');
  const evP = await evidenceIds(DATABASE_URL, purged.sessionId);
  const evK = await evidenceIds(DATABASE_URL, kept.sessionId);
  expect(evP.map((e) => e.kind)).toEqual(expect.arrayContaining(['identity_reference', 'identity_probe', 'id_photo']));
  expect(evK.length).toBeGreaterThan(0);
  expect(new Set(await statuses(staff, [...evP, ...evK].map((e) => e.id)))).toEqual(new Set([200]));
  const eventsBefore = (await staff.events(purged.sessionId)).length;
  const photoOnFile = (await staff.json<{ idPhoto: { evidenceId: string } }>('get', `/api/admin/candidates/${candP.id}`)).idPhoto.evidenceId;

  /* ---------------- legal hold on the second session, placed in the staff UI */
  const sp = await staffPage();
  await sp.goto(`/admin/sessions/${kept.sessionId}`);
  await sp.getByRole('button', { name: 'Place legal hold…' }).click();
  await sp.getByRole('dialog').getByRole('button', { name: 'Place legal hold' }).click();
  await expect(sp.getByRole('button', { name: 'Remove legal hold…' })).toBeVisible();
  expect((await staff.session(kept.sessionId)).summary.legalHold).toBe(true);

  /* ---------------- both sessions ended 2 days ago (retention: 1 day) */
  await sql(DATABASE_URL, `UPDATE exam_sessions SET ended_at = ended_at - interval '2 days' WHERE id = ANY($1::uuid[])`, [[purged.sessionId, kept.sessionId]]);

  const dry = await runServerCli('retention:run', ['--dry-run', '--json'], cliEnv);
  expect(dry.code, dry.stderr).toBe(0);
  const drySummary = cliJson<RetentionSummary>(dry);
  expect(drySummary.dryRun).toBe(true);
  expect(drySummary.sessions.map((s) => s.sessionId)).toContain(purged.sessionId);
  expect(drySummary.sessions.map((s) => s.sessionId)).not.toContain(kept.sessionId);
  expect(new Set(await statuses(staff, evP.map((e) => e.id))), 'a dry run deletes nothing').toEqual(new Set([200]));

  const run = await runServerCli('retention:run', ['--json'], cliEnv);
  expect(run.code, run.stderr).toBe(0);
  const summary = cliJson<RetentionSummary>(run);
  console.log(`retention:run: ${summary.sessionsEvidencePurged} session(s), ${summary.evidenceItemsPurged} item(s) purged, ${summary.skippedLegalHold} kept (legal hold)`);
  expect(summary.failures).toEqual([]);
  expect(summary.sessions.find((s) => s.sessionId === purged.sessionId)?.evidencePurged).toBe(evP.length);
  expect(summary.sessions.map((s) => s.sessionId)).not.toContain(kept.sessionId);
  expect(summary.skippedLegalHold).toBeGreaterThanOrEqual(1);

  /* ---------------- purged: every image of the session is gone (410), including the compared ID-photo copy */
  expect(new Set(await statuses(staff, evP.map((e) => e.id)))).toEqual(new Set([410]));
  const gone = await staff.raw(`/api/admin/evidence/${evP[0].id}`);
  expect(await gone.json()).toMatchObject({ error: 'evidence_purged', message: expect.stringContaining('under the retention policy') });
  const files = await sql<{ n: number }>(DATABASE_URL, `SELECT count(*)::int AS n FROM evidence WHERE session_id = $1 AND purged_at IS NULL`, [purged.sessionId]);
  expect(files[0].n).toBe(0);
  expect((await staff.events(purged.sessionId)).length, 'event records remain').toBe(eventsBefore);
  // The approved ID photo on file is candidate data (kept until an administrator removes it), not session evidence.
  expect((await staff.raw(`/api/admin/evidence/${photoOnFile}`)).status()).toBe(200);
  // Kept: legal hold.
  expect(new Set(await statuses(staff, evK.map((e) => e.id)))).toEqual(new Set([200]));

  /* ---------------- staff UI: placeholders instead of images */
  await sp.goto(`/admin/sessions/${purged.sessionId}?tab=identity`);
  await expect(sp.getByRole('heading', { name: 'Identity reference' })).toBeVisible();
  await expect.poll(() => placeholders(sp)).toBeGreaterThan(0);
  await expect(sp.locator('.evidence-purged').first()).toContainText(/Deleted under the retention policy on \d/);
  await expect(sp.locator('.identity-tab img')).toHaveCount(0);
  await sp.goto(`/admin/sessions/${purged.sessionId}?event=${mm!.id}`);
  const drawer = sp.getByRole('dialog', { name: 'Event details' });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.evidence-purged').first()).toContainText('Deleted under the retention policy');
  await expect(drawer.locator('img')).toHaveCount(0);
  await sp.goto(`/admin/sessions/${purged.sessionId}/compare/${mm!.id}`);
  const refSection = sp.locator('section', { has: sp.getByRole('heading', { name: /^(Original reference|Approved ID photo)$/ }) });
  await expect(refSection.locator('.evidence-purged')).toContainText('Deleted under the retention policy');
  await expect(sp.locator('.compare-page img')).toHaveCount(0);
  // The kept session still shows its images.
  await sp.goto(`/admin/sessions/${kept.sessionId}?tab=identity`);
  await expect(sp.locator('.identity-tab img').first()).toBeVisible();
  await expect.poll(() => sp.locator('.identity-tab img').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  expect(await placeholders(sp)).toBe(0);

  const auditRows = await staff.json<{ items: { action: string; targetId: string | null }[] }>('get', '/api/admin/audit-log?action=retention.purge&limit=100');
  expect(auditRows.items.some((a) => a.targetId === purged.sessionId), 'retention.purge audit entry').toBe(true);

  /* ---------------- legal hold lifted: the next run purges it */
  await staff.legalHold(kept.sessionId, false);
  const run2 = await runServerCli('retention:run', ['--json'], cliEnv);
  expect(run2.code, run2.stderr).toBe(0);
  expect(cliJson<RetentionSummary>(run2).sessions.map((s) => s.sessionId)).toContain(kept.sessionId);
  expect(new Set(await statuses(staff, evK.map((e) => e.id)))).toEqual(new Set([410]));
});

/* ============================================================================ key rotation */

test.describe('key rotation', () => {
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 2;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'rekey');
  const K1 = randomBytes(32).toString('base64');
  const K2 = randomBytes(32).toString('base64');
  let storageDir = '';
  let server: ServerHandle | null = null;
  let receiver: WebhookReceiver | null = null;

  test.afterAll(async () => {
    await server?.stop();
    await receiver?.close();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  test('rotate EVIDENCE_KEY, rekey, drop the old key: evidence, access links, webhook secrets, references and ID photos still work', async () => {
    skipUnlessFixtures('a');
    test.skip(!idPhotoAvailable('id-a.jpg'), 'face images for the ID photo not found (set E2E_FACES_DIR)');
    test.setTimeout(8 * 60_000);
    const tls = localhostCert();
    receiver = await WebhookReceiver.start(tls);
    const verify = await documentedVerifier();
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-rekey-storage-'));
    // Production mode allows https:// webhooks only; the receiver's self-signed certificate is trusted explicitly.
    const common = { port, publicHost: '127.0.0.1', databaseUrl, storageDir, env: { NODE_EXTRA_CA_CERTS: tls.certPath, WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true', VISION_THREADS: '2' } };
    const start = async (n: number, evidenceKey: string, old?: string) => {
      await server?.stop();
      server = await startServer({ ...common, evidenceKey, env: { ...common.env, EVIDENCE_KEYS_OLD: old ?? '' }, logFile: artifactLog(`server-rekey-${n}.log`) });
      return StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    };

    /* ---------------- 1. data under the original key K1 */
    let staff = await start(1, K1);
    const url = server!.url;
    const exam = await staff.createExam({ policy: { identity: { liveness: 'off', idPhotoComparison: 'advisory', periodicCheckIntervalSec: 30 }, browser: { requireFullscreen: false } } });
    const c1 = await staff.createCandidate();
    const c2 = await staff.createCandidate();
    for (const c of [c1, c2]) expect((await staff.uploadIdPhoto(c.id, readFileSync(idPhotoPath('id-a.jpg')))).accepted).toBe(true);
    const s1 = await staff.assign(exam, c1);
    const s2 = await staff.assign(exam, c2);
    const hook = await staff.json<{ webhook: { id: string }; secret: string }>('post', '/api/admin/webhooks', { url: receiver.url(), events: ['session.held', 'session.submitted'], minSeverity: 'medium', active: true });
    const ping1 = await staff.json<{ status: string }>('post', `/api/admin/webhooks/${hook.webhook.id}/test`, {});
    expect(ping1.status).toBe('succeeded');

    const browser = await launchCamera('a');
    try {
      const ctx = () => browser.newContext({ baseURL: url, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
      // Candidate 1 checks in (reference + ID-photo comparison), starts and pauses; the browser is closed.
      let c = await CandidatePage.open(null, s1.link, { context: await ctx() });
      await c.checkInAndStart();
      await c.pause('Short break');
      await c.close();
      const before = await staff.session(s1.sessionId);
      expect(before.references[0].idPhoto).toMatchObject({ decision: 'match' });
      const accessLink = before.summary.accessLink;
      expect(accessLink).toBe(s1.link);
      const ev = await evidenceIds(databaseUrl, s1.sessionId);
      expect(ev.length).toBeGreaterThan(0);
      const bytes = new Map<string, string>();
      for (const e of ev) {
        const r = await staff.raw(`/api/admin/evidence/${e.id}`);
        expect(r.status()).toBe(200);
        bytes.set(e.id, sha(await r.body()));
      }
      const idPhotoEvidence = (await staff.json<{ idPhoto: { evidenceId: string } }>('get', `/api/admin/candidates/${c2.id}`)).idPhoto.evidenceId;
      bytes.set(idPhotoEvidence, sha(await (await staff.raw(`/api/admin/evidence/${idPhotoEvidence}`)).body()));
      await staff.dispose();

      /* ---------------- 2. rotate: K2 current, K1 still accepted for reading */
      staff = await start(2, K2, K1);
      for (const [id, h] of bytes) expect(sha(await (await staff.raw(`/api/admin/evidence/${id}`)).body()), `evidence ${id} readable with the old key`).toBe(h);
      const dry = await runServerCli('rekey', ['--dry-run', '--json'], server!.env);
      expect(dry.code, 'items remain under the old key').toBe(3);
      const drySum = cliJson<{ targets: { target: string; outdated: number }[]; remaining: Record<string, number>; oldKeyIds: string[] }>(dry);
      const outdated = Object.fromEntries(drySum.targets.map((t) => [t.target, t.outdated]));
      console.log(`rekey --dry-run: ${JSON.stringify(outdated)}`);
      for (const t of ['evidence_blobs', 'id_photo_embeddings', 'reference_embeddings', 'check_frame_embeddings', 'access_tokens', 'webhook_secrets']) expect(outdated[t], `${t} under K1`).toBeGreaterThan(0);
      expect(drySum.remaining[drySum.oldKeyIds[0]]).toBeGreaterThan(0);

      // Run right after the restart, like the documented procedure (the server's retention job runs at start too).
      const run = await runServerCli('rekey', [], server!.env);
      expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('nothing is encrypted under an old key');
      expect(run.stdout).toMatch(/EVIDENCE_KEYS_OLD \S+: no longer needed — can be removed/);
      const after = await runServerCli('rekey', ['--dry-run'], server!.env);
      expect(after.code, after.stdout).toBe(0);
      await staff.dispose();

      /* ---------------- 3. old key removed */
      staff = await start(3, K2);
      for (const [id, h] of bytes) expect(sha(await (await staff.raw(`/api/admin/evidence/${id}`)).body()), `evidence ${id} readable after rekey`).toBe(h);
      expect((await staff.session(s1.sessionId)).summary.accessLink, 'access link (stored encrypted) still shown').toBe(accessLink);
      expect((await staff.session(s2.sessionId)).summary.accessLink).toBe(s2.link);

      // Webhook secret: the receiver still verifies with the secret it was given at creation.
      const n0 = receiver.requests.length;
      const ping3 = await staff.json<{ status: string; lastError: string | null }>('post', `/api/admin/webhooks/${hook.webhook.id}/test`, {});
      expect(ping3.status, ping3.lastError ?? '').toBe('succeeded');
      const pings = receiver.requests.slice(n0);
      expect(pings).toHaveLength(1);
      for (const r of receiver.requests) expect(verify(r.rawBody, r.headers['x-smartproctoring-signature'], hook.secret), `signature of ${r.body.type}`).toBe(true);

      // Reference embeddings: candidate 1 reopens the link and resumes (resume check against the reference).
      c = await CandidatePage.open(null, s1.link, { context: await ctx() });
      await expect(c.tid('paused-screen')).toBeVisible();
      await c.tid('resume-button').click();
      expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
      await c.continueAfterCheck();
      await c.submit();
      await c.close();
      const done = await staff.session(s1.sessionId);
      expect(done.identityChecks.find((ch) => ch.trigger === 'resume')?.decision).toBe('match');
      await expect.poll(() => receiver!.ofType('session.submitted').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

      // ID-photo template (uploaded under K1): candidate 2 checks in and is compared with it.
      c = await CandidatePage.open(null, s2.link, { context: await ctx() });
      await c.consent();
      expect(await c.runCheck()).toBe('ready');
      await c.close();
      const cmp = (await staff.events(s2.sessionId)).find((e) => e.type === 'id_photo_compared');
      expect(cmp?.details).toMatchObject({ decision: 'match' });
      for (const r of receiver.requests) expect(verify(r.rawBody, r.headers['x-smartproctoring-signature'], hook.secret)).toBe(true);
      await staff.dispose();
    } finally {
      await browser.close();
    }
    const log = readFileSync(server!.logFile, 'utf8');
    expect(log, 'no decryption failures after the old key was removed').not.toMatch(/could not be decrypted|Unsupported state or unable to authenticate data|unknown key id/i);
  });
});
