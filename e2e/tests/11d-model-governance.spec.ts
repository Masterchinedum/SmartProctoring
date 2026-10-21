import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { expectNoA11yIssues } from '../lib/a11y';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { artifactLog, resetDatabase, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { AuditLogEntryDTO, DecisionConfigsDTO, Paged } from '../../packages/shared/src';

/**
 * Scenario 11d — model governance, on a dedicated server instance (activating other identity thresholds must not
 * affect the other scenarios' organisation).
 *  - The Quality page shows identity decisions by condition (camera, browser, lighting, version) and no drift.
 *  - The owner proposes stricter-to-suspect thresholds (the form refuses inconsistent values; a reason is required),
 *    sees the preview on recent samples, and cannot approve their own proposal while another administrator exists.
 *  - A second administrator approves it: version 2 is active, the Settings page shows it read-only and the settings
 *    API refuses a direct threshold change.
 *  - The owner restores version 1 at once (version 3, "restores v1"); the audit log records each step.
 */
test.describe('model governance', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 4;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'governance');
  let storageDir = '';
  let server: ServerHandle;
  let owner: StaffApi;
  let admin: StaffApi;

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-governance-storage-'));
    server = await startServer({ port, publicHost: '127.0.0.1', databaseUrl, storageDir, logFile: artifactLog('server-governance.log'), env: { VISION_THREADS: '1' } });
    owner = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    const second = await owner.createUser('admin');
    admin = await StaffApi.login(second.email, second.password, server.url);

    // Identity decisions of the last days, as exams would have recorded them (one exam on Safari at 480p).
    const s = await owner.createSession();
    const now = Date.now();
    await sql(
      databaseUrl,
      `insert into device_records (session_id, at, client_instance_id, purpose, user_agent, video_height) values ($1, $2, 'i1', 'initial', $3, 480)`,
      [s.sessionId, new Date(now - 3_600_000), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'],
    );
    const rows: [string, number | null, number][] = [
      ['match', 0.62, 150],
      ['match', 0.58, 140],
      ['match', 0.55, 160],
      ['inconclusive', 0.38, 120],
      ['mismatch', 0.28, 130], // inconclusive under a mismatch threshold of 0.26
      ['unable_to_verify', null, 40],
    ];
    for (const [i, [decision, similarity, brightness]] of rows.entries()) {
      await sql(
        databaseUrl,
        `insert into identity_checks (session_id, trigger, decision, similarity, confidence, quality, at, received_at, decision_config_version, calibration_version, model_version)
         values ($1, 'periodic', $2, $3, 0.8, $4, $5, $5, 1, 'webcam-v2.1', 'sface-2021dec-flip')`,
        [s.sessionId, decision, similarity, JSON.stringify({ brightness }), new Date(now - 3_000_000 + i * 60_000)],
      );
    }
  });

  test.afterAll(async () => {
    await admin?.dispose().catch(() => undefined);
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  const pageAs = async (browser: Browser, who: StaffApi): Promise<Page> =>
    (await browser.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await who.storageState() })).newPage();

  test('calibration by condition, proposal with preview, four-eyes approval, read-only settings, rollback', async ({ browser }) => {
    test.setTimeout(4 * 60_000);
    const op = await pageAs(browser, owner);
    await op.goto('/admin/quality');

    /* ---------------- calibration and drift */
    const calibration = op.getByTestId('calibration');
    await expect(calibration.getByRole('heading', { name: 'Identity decisions by condition' })).toBeVisible();
    // Face lighting first: five samples in typical light, one in the dark (could not verify).
    await expect(calibration.locator('tbody tr')).toHaveCount(2);
    await expect(calibration.locator('tbody tr', { hasText: 'typical' })).toContainText('5');
    await expect(calibration.locator('tbody tr', { hasText: 'dark' })).toContainText('100.0%');
    await calibration.getByLabel('Break down by').selectOption({ label: 'Browser' });
    await expect(calibration.locator('tbody tr', { hasText: 'Safari' })).toContainText('6');
    await calibration.getByLabel('Break down by').selectOption({ label: 'Camera resolution' });
    await expect(calibration.locator('tbody tr', { hasText: 'low (≤ 480p)' })).toBeVisible();
    await calibration.getByLabel('Break down by').selectOption({ label: 'Decision configuration' });
    await expect(calibration.locator('tbody tr', { hasText: 'v1' })).toBeVisible();
    await expect(op.getByTestId('drift-none')).toContainText('No drift detected');

    /* ---------------- version 1, then a proposal */
    const panel = op.getByTestId('decision-config');
    await expect(panel.getByText('v1 active')).toBeVisible();
    await expect(panel.getByText('Release defaults').first()).toBeVisible();
    await panel.getByTestId('propose-config').click();
    const dialog = op.getByRole('dialog', { name: 'Propose new identity thresholds' });
    await dialog.getByTestId('threshold-mismatch').fill('0.5');
    await expect(dialog.getByText('Must be lower than the match threshold')).toBeVisible();
    await dialog.getByTestId('propose-note').fill('Pilot showed false suspicions in dim rooms; see ticket QA-112.');
    await expect(dialog.getByTestId('propose-submit')).toBeDisabled();
    await dialog.getByTestId('threshold-mismatch').fill('0.26');
    await expect(dialog.getByText('Mismatch threshold 0.3 → 0.26')).toBeVisible();
    await expectNoA11yIssues(op, 'propose dialog');
    await dialog.getByTestId('propose-submit').click();
    await expect(dialog).toBeHidden();

    const proposal = panel.getByTestId('config-proposal');
    await expect(proposal).toContainText('Version 2 is waiting for approval');
    await expect(proposal).toContainText('Mismatch threshold 0.3 → 0.26');
    await expect(proposal.getByTestId('config-impact')).toContainText('Of 5 identity samples in the last 30 days, 1 (20.0 %) would be labelled differently: 1 different person → inconclusive.');
    // Four eyes: the proposer cannot approve while another administrator exists.
    await proposal.getByTestId('config-approve').click();
    await expect(proposal.getByRole('alert')).toContainText('Another administrator must approve');
    await expectNoA11yIssues(op, 'quality page with a proposal');

    /* ---------------- a second administrator approves it */
    const ap = await pageAs(browser, admin);
    await ap.goto('/admin/quality');
    const adminPanel = ap.getByTestId('decision-config');
    await adminPanel.getByTestId('config-proposal').getByLabel('Note (optional)').fill('Checked against the pilot data.');
    await adminPanel.getByTestId('config-approve').click();
    await expect(adminPanel.getByText('v2 active')).toBeVisible();
    await expect(adminPanel.getByTestId('config-proposal')).toHaveCount(0);
    await adminPanel.getByText(/^History/).click();
    await expect(adminPanel.getByTestId('config-v1')).toContainText('Retired');
    await expect(adminPanel.getByTestId('config-v2')).toContainText('E2E admin');

    // Settings show the active version read-only; the settings API no longer changes thresholds.
    await ap.goto('/admin/settings');
    const thresholds = ap.getByTestId('settings-thresholds');
    await expect(thresholds).toContainText('Version 2');
    await expect(thresholds).toContainText('possible different person below 0.26');
    const refused = await admin.api.put('/api/admin/settings', { data: { identityThresholds: { mismatch: 0.2 } } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe('decision_config_required');

    /* ---------------- the owner restores version 1 at once */
    await op.reload();
    await panel.getByText(/^History/).click();
    await panel.getByTestId('config-v1').getByRole('button', { name: 'Restore…' }).click();
    const restore = op.getByRole('dialog', { name: 'Restore version 1' });
    await expect(restore).toContainText('Mismatch threshold 0.26 → 0.3');
    await restore.getByTestId('rollback-note').fill('Inconclusive results doubled after v2; back to the defaults.');
    await restore.getByTestId('rollback-submit').click();
    await expect(restore).toBeHidden();
    await expect(panel.getByText('v3 active')).toBeVisible();
    await expect(panel.getByTestId('config-v3')).toContainText('restores v1');

    const configs = await owner.json<DecisionConfigsDTO>('get', '/api/admin/decision-configs');
    expect(configs.items.map((c) => [c.version, c.status])).toEqual([
      [3, 'active'],
      [2, 'retired'],
      [1, 'retired'],
    ]);
    expect(configs.items[0]).toMatchObject({ releaseDefaults: true, rollbackOfVersion: 1 });
    const audit = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?limit=50&offset=0&action=decision_config');
    expect(audit.items.map((a) => a.action).reverse()).toEqual(['decision_config.proposed', 'decision_config.approved', 'decision_config.rolled_back']);
  });
});
