import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { expectNoA11yIssues } from '../lib/a11y';
import { DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { artifactLog, cliJson, resetDatabase, runServerCli, siblingDatabaseUrl, startServer, type ServerHandle } from '../lib/server';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { CandidateDTO, ExamDTO, OrgUsageDTO } from '../../packages/shared/src';

/**
 * Scenario 19d — a sandbox organisation with small quotas, on a dedicated server instance (organisations are created
 * and changed by the operator CLI; the other scenarios' organisation must stay production without limits).
 *  - The operator creates a sandbox organisation with `pnpm --filter @sp/server org:create` (the first owner's
 *    temporary password is printed once) and lowers its limits with `org:set`.
 *  - Its owner signs in: every staff page shows the sandbox banner; the candidate's welcome screen says it is a
 *    practice environment.
 *  - Adding a candidate beyond the limit, and assigning more candidates than the monthly session limit allows, are
 *    refused in the staff app with the plain-language message; nothing is created.
 *  - Settings → Usage and limits shows the numbers, with "Limit reached" warnings.
 */
test.describe('sandbox organisation and quotas', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 8;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'sandbox');
  const ownerEmail = 'sandbox-owner@example.com';
  let storageDir = '';
  let server: ServerHandle;
  let owner: StaffApi;
  let orgId = '';
  let exam: ExamDTO;
  const people: CandidateDTO[] = [];

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-sandbox-storage-'));
    server = await startServer({ port, publicHost: '127.0.0.1', databaseUrl, storageDir, logFile: artifactLog('server-sandbox.log'), env: { VISION_THREADS: '2' } });

    /* ---------------- operator: create the sandbox and set small limits */
    const created = await runServerCli('org:create', ['--name', 'Sandbox College', '--kind', 'sandbox', '--owner-email', ownerEmail, '--owner-name', 'Sandra Owner', '--reason', 'E2E trial', '--json'], server.env);
    expect(created.code, created.stderr + created.stdout).toBe(0);
    const out = cliJson<{ organisation: { id: string; kind: string; quotas: Record<string, number | null> }; temporaryPassword: string }>(created);
    expect(out.organisation).toMatchObject({ kind: 'sandbox', quotas: { exams: 5, candidates: 50, sessionsPerMonth: 100 } });
    orgId = out.organisation.id;
    const set = await runServerCli('org:set', ['--org', orgId, '--candidates', '3', '--sessions-per-month', '2', '--reason', 'E2E small limits'], server.env);
    expect(set.code, set.stderr + set.stdout).toBe(0);
    expect(set.stdout).toContain('Updated (quotas)');
    expect(set.stdout).toMatch(/Candidates:\s+0 of 3 \(set by operator\)/);

    owner = await StaffApi.login(ownerEmail, out.temporaryPassword, server.url);
    exam = await owner.createExam({ title: 'Sandbox practice exam', policy: { identity: { liveness: 'off' }, browser: { requireFullscreen: false } } });
    for (const name of ['Ada Practice', 'Ben Practice', 'Cy Practice']) people.push(await owner.createCandidate(name));
  });

  test.afterAll(async () => {
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  const staffPage = async (plain: Browser): Promise<Page> =>
    (await plain.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await owner.storageState() })).newPage();

  test('the sandbox is marked, limits refuse with a plain message, and Settings shows the usage', async ({ browser: plain }) => {
    test.setTimeout(4 * 60_000);
    const sp = await staffPage(plain);
    const banner = sp.getByTestId('sandbox-banner');

    /* ---------------- the banner on every page */
    await sp.goto('/admin');
    await expect(banner).toHaveText('Sandbox — data is deleted after 14 days; not for real candidates.');
    await expect(sp.locator('.brand-sandbox')).toHaveText('Sandbox');
    await expectNoA11yIssues(sp, 'dashboard with the sandbox banner');

    /* ---------------- candidates: the fourth is refused */
    await sp.goto('/admin/candidates');
    await expect(banner).toBeVisible();
    await sp.getByRole('button', { name: 'Add candidate' }).click();
    const dialog = sp.getByRole('dialog', { name: 'Add candidate' });
    await dialog.getByLabel('Full name').fill('Dee Overlimit');
    await dialog.getByRole('button', { name: 'Add candidate' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'This sandbox organisation can have at most 3 candidates; 3 in use. Delete candidates you no longer need, or ask your SmartProctoring operator if you need a higher limit.',
    );
    await expectNoA11yIssues(sp, 'the refused candidate in the dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(((await owner.json<{ items: CandidateDTO[] }>('get', '/api/admin/candidates')).items).map((c) => c.name).sort()).toEqual(['Ada Practice', 'Ben Practice', 'Cy Practice']);

    /* ---------------- assignments: three sessions when two are left this month → refused, nothing created */
    await sp.goto(`/admin/exams/${exam.id}`);
    for (const c of people) await sp.locator('.assign-item', { hasText: c.name }).getByRole('checkbox').check();
    await sp.getByRole('button', { name: 'Assign 3 selected' }).click();
    const refused = sp.getByRole('alert').filter({ hasText: 'This would create 3 exam sessions' });
    await expect(refused).toContainText(
      'This would create 3 exam sessions, but only 2 more can be created this month: this sandbox organisation can create 2 exam sessions a month and has created 0.',
    );
    await expect(refused).toContainText('The count starts again on');
    await expect(refused).toContainText('(00:00 UTC)');
    expect((await owner.json<{ items: unknown[] }>('get', `/api/admin/exams/${exam.id}/sessions`)).items).toHaveLength(0);
    // Two fit.
    await sp.locator('.assign-item', { hasText: 'Cy Practice' }).getByRole('checkbox').uncheck();
    await sp.getByRole('button', { name: 'Assign 2 selected' }).click();
    await expect(sp.getByText('2 access links created.')).toBeVisible();
    const sessions = (await owner.json<{ items: { id: string; accessLink: string | null; candidate: { name: string } }[] }>('get', `/api/admin/exams/${exam.id}/sessions`)).items;
    expect(sessions).toHaveLength(2);

    /* ---------------- the candidate sees a practice environment */
    const link = sessions.find((s) => s.candidate.name === 'Ada Practice')!.accessLink!;
    const cand = await (await plain.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await cand.goto(link);
    const notice = cand.getByTestId('practice-notice');
    await expect(notice).toContainText('Practice environment.', { timeout: 30_000 });
    await expect(notice).toContainText('not for a real exam');
    await expectNoA11yIssues(cand, 'candidate welcome screen in a practice environment');
    await cand.context().close();

    /* ---------------- Settings → Usage and limits */
    await sp.goto('/admin/settings');
    const usage = sp.getByTestId('settings-usage');
    await expect(usage.getByRole('heading', { name: 'Usage and limits' })).toBeVisible();
    await expect(usage.getByTestId('usage-sandbox')).toContainText('deleted 14 days after their last use');
    await expect(usage.getByTestId('usage-exams')).toContainText('1 of 5');
    await expect(usage.getByTestId('usage-exams')).toContainText('Within the limit');
    await expect(usage.getByTestId('usage-candidates')).toContainText('3 of 3');
    await expect(usage.getByTestId('usage-candidates')).toContainText('Limit reached');
    await expect(usage.getByTestId('usage-sessionsPerMonth')).toContainText('2 of 2');
    await expect(usage.getByTestId('usage-warning')).toHaveText([
      'Limit reached: candidates — 3 of 3. Nothing more can be created.',
      /^Limit reached: exam sessions created this month — 2 of 2\. Nothing more can be created until \d{1,2} \w+ \d{4}\.$/,
    ]);
    await expect(usage).toContainText('The limits are set by your SmartProctoring operator.');
    await expectNoA11yIssues(sp, 'settings with usage and limits');
    const dto = await owner.json<OrgUsageDTO>('get', '/api/admin/usage');
    expect(dto.quotas.map((q) => [q.quota, q.used, q.limit, q.level])).toEqual([
      ['exams', 1, 5, 'ok'],
      ['candidates', 3, 3, 'reached'],
      ['sessionsPerMonth', 2, 2, 'reached'],
    ]);

    /* ---------------- the bootstrap organisation stays production, without a banner */
    const list = await runServerCli('org:list', ['--json'], server.env);
    expect(list.code).toBe(0);
    const orgs = cliJson<{ organisations: { id: string; name: string; kind: string }[] }>(list).organisations;
    expect(orgs.map((o) => [o.name, o.kind]).sort()).toEqual([
      ['E2E University', 'production'],
      ['Sandbox College', 'sandbox'],
    ]);
  });
});
