import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { expectNoA11yIssues } from '../lib/a11y';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { artifactLog, cliJson, resetDatabase, runServerCli, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { StaffApi, type SessionHandle } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { AuditLogEntryDTO, Paged } from '../../packages/shared/src';

/**
 * Scenario 19b — data residency, on a dedicated server instance configured with two storage locations: the default
 * one (STORAGE_DIR) and "eu" (STORAGE_LOCATION_EU_*, labelled "EU (Frankfurt)"), both directories.
 *  - A candidate checks in and submits: the images land in the default directory.
 *  - The owner opens Settings → "Where evidence images are stored" (what is and is not stored there, images per
 *    location), switches the organisation to EU (Frankfurt) and saves (audited); the page says the earlier images stay
 *    where they are until the operator moves them.
 *  - A second candidate checks in: the new images land in the eu directory; staff see the images of both.
 *  - The operator runs `pnpm --filter @sp/server storage:move --org <id> --to eu` (dry run, then for real): the older
 *    images move — same bytes for staff, nothing of the organisation left in the default directory, audited.
 */

type Row = { id: string; storage_key: string; storage_location: string | null };
type MoveSummary = { dryRun: boolean; toMove: number; moved: number; failed: number; remaining: number; before: Record<string, number>; after: Record<string, number> };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const images = (n: number, what = 'image') => `${n} ${what}${n === 1 ? '' : 's'}`;

/** Blob files under a storage directory (relative paths, e.g. o/<org>/s/<session>/<id>.<suffix>.bin). */
function blobFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.bin'));
}

test.describe('data residency', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 10;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'residency');
  let defaultDir = '';
  let euDir = '';
  let server: ServerHandle;
  let owner: StaffApi;
  let browser: Browser | null = null;
  let first: SessionHandle;
  let second: SessionHandle;

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    await resetDatabase(databaseUrl);
    defaultDir = mkdtempSync(join(tmpdir(), 'sp-e2e-residency-default-'));
    euDir = mkdtempSync(join(tmpdir(), 'sp-e2e-residency-eu-'));
    server = await startServer({
      port,
      publicHost: '127.0.0.1',
      databaseUrl,
      storageDir: defaultDir,
      logFile: artifactLog('server-residency.log'),
      env: { VISION_THREADS: '2', STORAGE_LOCATIONS: 'eu', STORAGE_LOCATION_EU_DRIVER: 'fs', STORAGE_LOCATION_EU_DIR: euDir, STORAGE_LOCATION_EU_LABEL: 'EU (Frankfurt)' },
    });
    owner = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server.url);
    const exam = await owner.createExam({ title: 'Residency e2e exam', policy: { identity: { liveness: 'off' }, browser: { requireFullscreen: false } } });
    first = await owner.assign(exam, await owner.createCandidate('Rhea Before'));
    second = await owner.assign(exam, await owner.createCandidate('Rex After'));
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    for (const d of [defaultDir, euDir]) if (d) rmSync(d, { recursive: true, force: true });
  });

  const candidateContext = () => browser!.newContext({ baseURL: server.url, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
  const staffPage = async (plain: Browser): Promise<Page> =>
    (await plain.newContext({ baseURL: server.url, viewport: { width: 1400, height: 1000 }, storageState: await owner.storageState() })).newPage();
  const rows = (sessionId: string) => sql<Row>(databaseUrl, 'SELECT id, storage_key, storage_location FROM evidence WHERE session_id = $1 AND purged_at IS NULL ORDER BY id', [sessionId]);
  const takeExam = async (s: SessionHandle) => {
    const c = await CandidatePage.open(null, s.link, { context: await candidateContext() });
    await c.checkInAndStart();
    await c.submit();
    await c.close();
    await owner.waitForSession(s.sessionId, (d) => d.summary.status === 'submitted');
    // Images of a passed check are deleted right after it (by design): wait until what is kept is settled.
    let last = -1;
    await expect
      .poll(async () => {
        const n = (await rows(s.sessionId)).length;
        const stable = n === last && n > 0;
        last = n;
        return stable;
      }, { message: 'the kept images of the session', intervals: [500, 1000, 1000] })
      .toBe(true);
  };
  const imageHashes = async (ids: string[]) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const r = await owner.raw(`/api/admin/evidence/${id}`);
      expect(r.status(), `evidence ${id}`).toBe(200);
      out.set(id, sha(await r.body()));
    }
    return out;
  };

  test('the owner moves new evidence to the EU location in Settings; storage:move moves the earlier images', async ({ browser: plain }) => {
    skipUnlessFixtures('a');
    test.setTimeout(6 * 60_000);
    browser = await launchCamera('a');
    const orgId = (await owner.json<{ org: { id: string } }>('get', '/api/auth/me')).org.id;

    /* ---------------- before: images in the default directory */
    await takeExam(first);
    const before = await rows(first.sessionId);
    expect(before.length).toBeGreaterThan(0);
    for (const r of before) {
      expect(r.storage_location).toBeNull();
      expect(existsSync(join(defaultDir, r.storage_key)), `${r.id} in the default directory`).toBe(true);
    }
    expect(blobFiles(euDir)).toEqual([]);

    /* ---------------- the owner chooses the EU location in Settings */
    const sp = await staffPage(plain);
    await sp.goto('/admin/settings');
    const section = sp.getByTestId('settings-evidence-storage');
    await expect(section.getByRole('heading', { name: 'Where evidence images are stored' })).toBeVisible();
    await expect(section).toContainText('Not stored there:');
    await expect(section).toContainText('face templates (the numbers used to compare faces)');
    await expect(section.getByTestId('storage-stored')).toHaveText(`Stored now: ${images(before.length)} in Default storage.`);
    const select = section.getByLabel('Location for new images');
    await expect(select).toHaveValue('default');
    await expect(select.locator('option')).toHaveText(['Default storage', 'EU (Frankfurt)']);
    await select.selectOption('eu');
    await expect(section.getByTestId('storage-change-note')).toContainText('From the moment you save, new images are stored in EU (Frankfurt).');
    await expectNoA11yIssues(sp, 'settings with the storage location section');
    await section.getByRole('button', { name: 'Save location' }).click();
    await expect(section.getByTestId('storage-saved')).toHaveText('Saved. New evidence images are stored in EU (Frankfurt).');
    await expect(section.getByTestId('storage-elsewhere')).toContainText(`${images(before.length, 'earlier image')} ${before.length === 1 ? 'is' : 'are'} still stored in Default storage.`);
    await expect(section.getByTestId('storage-elsewhere')).toContainText(/until your server operator moves (it|them) to EU \(Frankfurt\)/);
    const audit = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?action=settings.updated&limit=20');
    expect(audit.items.find((a) => (a.meta.fields as string[]).includes('evidenceLocation'))?.meta).toMatchObject({ evidenceLocation: { from: 'default', to: 'eu' } });

    /* ---------------- after: new images in the eu directory; staff see both */
    await takeExam(second);
    const after = await rows(second.sessionId);
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) {
      expect(r.storage_location).toBe('eu');
      expect(existsSync(join(euDir, r.storage_key)), `${r.id} in the eu directory`).toBe(true);
      expect(existsSync(join(defaultDir, r.storage_key))).toBe(false);
    }
    const hashes = await imageHashes([...before, ...after].map((r) => r.id));

    /* ---------------- the operator moves the earlier images */
    const dry = await runServerCli('storage:move', ['--org', orgId, '--to', 'eu', '--dry-run', '--json'], server.env);
    expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(3);
    const drySummary = cliJson<MoveSummary>(dry);
    expect(drySummary).toMatchObject({ dryRun: true, toMove: before.length, before: { default: before.length, eu: after.length } });
    expect(existsSync(join(defaultDir, before[0].storage_key)), 'a dry run moves nothing').toBe(true);
    const run = await runServerCli('storage:move', ['--org', orgId, '--to', 'eu', '--json'], server.env);
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
    const summary = cliJson<MoveSummary>(run);
    console.log(`storage:move: ${summary.moved}/${summary.toMove} image(s) moved, ${summary.remaining} remaining`);
    expect(summary).toMatchObject({ dryRun: false, moved: before.length, failed: 0, remaining: 0, after: { eu: before.length + after.length } });

    const moved = await rows(first.sessionId);
    expect(moved.every((r) => r.storage_location === 'eu' && existsSync(join(euDir, r.storage_key)))).toBe(true);
    expect(blobFiles(defaultDir).filter((f) => f.startsWith(`o/${orgId}/s/`)), 'no session image of the organisation left in the default directory').toEqual([]);
    expect(await imageHashes(moved.map((r) => r.id))).toEqual(new Map([...hashes].filter(([id]) => moved.some((r) => r.id === id))));
    const again = await runServerCli('storage:move', ['--org', orgId, '--to', 'eu', '--json'], server.env);
    expect(again.code).toBe(0);
    expect(cliJson<MoveSummary>(again)).toMatchObject({ toMove: 0, moved: 0, remaining: 0 });
    const movedAudit = await owner.json<Paged<AuditLogEntryDTO>>('get', '/api/admin/audit-log?action=evidence.storage_moved&limit=10');
    expect(movedAudit.items[0]).toMatchObject({ actorType: 'system', actorName: 'System', meta: { to: 'eu', remaining: 0 } });

    /* ---------------- Settings shows everything in the EU location */
    await sp.reload();
    await expect(section.getByTestId('storage-stored')).toHaveText(`Stored now: ${images(before.length + after.length)} in EU (Frankfurt).`);
    await expect(section.getByTestId('storage-elsewhere')).toHaveCount(0);
    await expect(section.getByLabel('Location for new images')).toHaveValue('eu');
  });
});
