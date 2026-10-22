import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { readZip } from '../../apps/server/test/zip-reader';
import { expectNoA11yIssues } from '../lib/a11y';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { artifactLog, resetDatabase, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { StaffApi, type SessionHandle } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { AuditLogEntryDTO, Paged, PrivacyRequestsDTO } from '../../packages/shared/src';

/**
 * Scenario 11e — privacy operations, on a dedicated server instance (the register, the deletion schedule and the
 * operational checks are organisation-wide; the other scenarios' legal holds and sessions must not show up here).
 *  - A candidate withdraws consent during the exam from the privacy notice (confirmation step): their exam ends ("You
 *    withdrew your consent"), its images are deleted (410), and a consent-withdrawal request appears in the register,
 *    made in the exam app, with the reason they gave.
 *  - An administrator records an access request in the staff app, exports the candidate's data as a ZIP (records and
 *    decrypted images; the export is recorded on the request), then erases the candidate through an erasure request:
 *    refused while a session is under legal hold, done once it is lifted; the requests stay, without the candidate.
 *  - The deletion schedule shows the retention job's run (it runs at start) and the legal hold.
 */
test.describe('privacy operations', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 5;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'privacy');
  let storageDir = '';
  let server: ServerHandle;
  let owner: StaffApi;
  let browser: Browser | null = null;
  let exported: SessionHandle;
  let withdrawn: SessionHandle;

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-privacy-storage-'));
    server = await startServer({ port, publicHost: '127.0.0.1', databaseUrl, storageDir, logFile: artifactLog('server-privacy.log'), env: { VISION_THREADS: '2' } });
    owner = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    const exam = await owner.createExam({ title: 'Privacy e2e exam', policy: { identity: { liveness: 'off' }, browser: { requireFullscreen: false } } });
    exported = await owner.assign(exam, await owner.createCandidate('Erin Export'));
    withdrawn = await owner.assign(exam, await owner.createCandidate('Wanda Withdraw'));
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  const candidateContext = () => browser!.newContext({ baseURL: server.url, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
  const staffPage = async (plain: Browser): Promise<Page> =>
    (await plain.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await owner.storageState(), acceptDownloads: true })).newPage();
  const liveEvidence = async (sessionId: string) => (await sql<{ n: number }>(databaseUrl, 'SELECT count(*)::int AS n FROM evidence WHERE session_id = $1 AND purged_at IS NULL', [sessionId]))[0].n;

  test('consent withdrawal, access export, erasure with a legal hold, deletion schedule', async ({ browser: plain }) => {
    skipUnlessFixtures('a');
    test.setTimeout(6 * 60_000);
    browser = await launchCamera('a');

    /* ---------------- one candidate completes the exam; the other withdraws consent during it */
    const done = await CandidatePage.open(null, exported.link, { context: await candidateContext() });
    await done.checkInAndStart();
    await done.submit();
    await done.close();
    const w = await CandidatePage.open(null, withdrawn.link, { context: await candidateContext() });
    await w.checkInAndStart();
    await expect.poll(() => liveEvidence(withdrawn.sessionId), { message: 'the check-in kept identity images' }).toBeGreaterThan(0);
    const evidenceIds = (await sql<{ id: string }>(databaseUrl, 'SELECT id FROM evidence WHERE session_id = $1 AND purged_at IS NULL', [withdrawn.sessionId])).map((r) => r.id);
    // From the privacy notice in the exam: what happens is spelled out, a reason is optional, ending needs a tick.
    await w.page.getByTestId('what-is-monitored').click();
    const notice = w.page.getByRole('dialog', { name: 'What is monitored during your exam' });
    await expect(notice).toContainText('You can withdraw your consent at any time');
    await notice.getByTestId('withdraw-consent').click();
    const confirmWithdraw = w.page.getByRole('dialog', { name: 'Withdraw your consent?' });
    await expect(confirmWithdraw).toContainText('your exam ends now');
    await expect(confirmWithdraw.getByTestId('withdraw-confirm')).toBeDisabled();
    await expectNoA11yIssues(w.page, 'withdraw consent dialog');
    await confirmWithdraw.getByTestId('withdraw-reason').fill('I prefer to sit the exam in person.');
    await confirmWithdraw.getByTestId('withdraw-understood').check();
    await confirmWithdraw.getByTestId('withdraw-confirm').click();
    await expect(w.page.getByTestId('ended-screen')).toContainText('You withdrew your consent', { timeout: 30_000 });
    await w.close();
    expect(await liveEvidence(withdrawn.sessionId)).toBe(0);
    for (const id of evidenceIds) expect((await owner.raw(`/api/admin/evidence/${id}`)).status()).toBe(410);

    /* ---------------- the register shows it; an access request is recorded in the staff app */
    const sp = await staffPage(plain);
    await sp.goto('/admin/privacy');
    await expect(sp.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
    const register = sp.getByTestId('privacy-requests');
    const withdrawal = register.locator('tbody tr', { hasText: 'Consent withdrawn' });
    await expect(withdrawal).toContainText('Wanda Withdraw');
    await expect(withdrawal).toContainText('made in the exam app');
    await withdrawal.getByRole('button', { name: 'Consent withdrawn' }).click();
    const withdrawalDetail = sp.getByRole('dialog', { name: 'Consent withdrawn' });
    await expect(withdrawalDetail).toContainText('Reason given by the candidate: I prefer to sit the exam in person.');
    await sp.keyboard.press('Escape');
    await expect(withdrawalDetail).toBeHidden();
    await expect(sp.getByTestId('ops-checks').getByTestId('ops-privacy_requests')).toContainText('1 open request');
    await expectNoA11yIssues(sp, 'privacy page');

    await register.getByTestId('new-privacy-request').click();
    const create = sp.getByRole('dialog', { name: 'Record a privacy request' });
    await create.getByLabel('From (name, email or reference)').fill('Erin Export (letter of 20 Oct)');
    await create.getByLabel('Search candidates').fill('Erin');
    await create.getByLabel('Candidate', { exact: true }).selectOption(exported.candidateId);
    await create.getByLabel('Received by').selectOption('letter');
    await create.getByLabel(/What the person asked/).fill('A copy of my exam recording and results.');
    await expectNoA11yIssues(sp, 'new request dialog');
    await create.getByTestId('create-privacy-request').click();
    await expect(create).toBeHidden();

    /* ---------------- export: a ZIP with the records and the images, recorded on the request */
    const detail = sp.getByRole('dialog', { name: 'Access (copy of their data)' });
    await expect(detail.getByText('A copy of my exam recording and results.')).toBeVisible();
    await expectNoA11yIssues(sp, 'request dialog');
    const [download] = await Promise.all([sp.waitForEvent('download'), detail.getByTestId('privacy-export').click()]);
    expect(download.suggestedFilename()).toMatch(/^personal-data-Erin-Export-\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = readZip(readFileSync((await download.path())!));
    const names = [...zip.keys()];
    expect(names).toEqual(expect.arrayContaining(['README.txt', 'candidate.json']));
    expect(names.some((n) => /^sessions\/01 Privacy e2e exam \(.+\)\/session\.json$/.test(n))).toBe(true);
    const images = names.filter((n) => n.endsWith('.jpg'));
    expect(images.length).toBeGreaterThan(0);
    // Real JPEGs (decrypted), not the encrypted blobs.
    for (const n of images) expect(zip.get(n)!.data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(JSON.parse(zip.get('candidate.json')!.data.toString('utf8')).candidate.name).toBe('Erin Export');
    const list = await owner.json<PrivacyRequestsDTO>('get', '/api/admin/privacy-requests?status=all');
    const access = list.items.find((r) => r.kind === 'access')!;
    expect(access.exportedAt).not.toBeNull();
    await detail.getByLabel('Status').selectOption('completed');
    await detail.getByLabel(/How it was answered/).fill('Archive sent by encrypted email on request.');
    await detail.getByTestId('save-privacy-request').click();
    await expect(detail).toBeHidden(); // closed requests leave the "Open" list

    /* ---------------- erasure: refused under legal hold, done once it is lifted */
    const erasure = await owner.json<{ id: string }>('post', '/api/admin/privacy-requests', { kind: 'erasure', subject: 'Erin Export', candidateId: exported.candidateId, channel: 'email' });
    await owner.json('post', `/api/admin/sessions/${exported.sessionId}/legal-hold`, { enabled: true });
    await sp.reload();
    await register.locator('tbody tr', { hasText: 'Erasure' }).getByRole('button', { name: 'Erasure' }).click();
    const eraseDialog = sp.getByRole('dialog', { name: 'Erasure' });
    await eraseDialog.getByTestId('privacy-erase').click();
    const confirm = sp.getByRole('dialog', { name: 'Erase this candidate?' });
    await confirm.getByRole('button', { name: 'Erase permanently' }).click();
    await expect(confirm.getByRole('alert')).toContainText('under legal hold');

    // The deletion schedule lists the hold, and the retention job's run at start.
    await expect(sp.getByTestId('legal-holds')).toContainText('Erin Export');
    await expect(sp.getByTestId('retention-job')).toContainText('Last run');

    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await owner.json('post', `/api/admin/sessions/${exported.sessionId}/legal-hold`, { enabled: false });
    await eraseDialog.getByTestId('privacy-erase').click();
    await sp.getByRole('dialog', { name: 'Erase this candidate?' }).getByRole('button', { name: 'Erase permanently' }).click();
    await expect(eraseDialog.getByRole('status').filter({ hasText: 'were erased' })).toContainText('1 session');
    expect((await owner.raw(`/api/admin/candidates/${exported.candidateId}`)).status()).toBe(404);
    expect(await liveEvidence(exported.sessionId)).toBe(0);
    const after = await owner.json<PrivacyRequestsDTO>('get', '/api/admin/privacy-requests?status=all');
    expect(after.items.find((r) => r.id === erasure.id)).toMatchObject({ candidate: null, subject: 'Erin Export', erasedAt: expect.any(Number) });
    expect(after.items.find((r) => r.id === access.id)).toMatchObject({ candidate: null, status: 'completed' });

    const audit = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?limit=100&offset=0&action=privacy_request');
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(['privacy_request.created', 'privacy_request.exported', 'privacy_request.completed', 'privacy_request.erased']));
    const withdrawals = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?limit=10&offset=0&action=candidate.consent_withdrawn');
    expect(withdrawals.items).toHaveLength(1);
    await sp.context().close();
  });
});
