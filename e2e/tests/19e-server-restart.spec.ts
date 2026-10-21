import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL, EXTERNAL_SERVER, PORT } from '../lib/config';
import { artifactLog, resetDatabase, siblingDatabaseUrl, sql, startServer, type ServerHandle } from '../lib/server';
import { BASE_POLICY, candidateState, mergePolicy, StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 19e — the server process restarts in the middle of an exam, on a dedicated instance (its own port, database
 * and storage; the other scenarios run on the main server and must not see the restart).
 *  - The candidate is answering when the server stops (SIGTERM). They keep working: "Live reporting is interrupted",
 *    answers saved on the device.
 *  - The server starts again on the same database and storage. The candidate's page carries on without a new check
 *    (the same browser), and everything typed during the outage reaches the server, once.
 *  - The timeline shows the outage once: a reporting_interrupted episode from the last heartbeat before the restart to
 *    the first one after it, closed by the same browser coming back — whichever of the new process's sweeper and the
 *    candidate's heartbeat came first — and the exam clock did not run meanwhile (disconnect policy "stop").
 */
test.describe('server restart mid-exam', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(EXTERNAL_SERVER, 'starts and restarts its own server instance from this repository (not with E2E_BASE_URL)');

  const port = PORT + 12;
  const databaseUrl = siblingDatabaseUrl(DATABASE_URL, 'restart');
  let storageDir = '';
  let server: ServerHandle | null = null;
  let owner: StaffApi;
  let browser: Browser | null = null;
  let starts = 0;
  const start = async () => {
    starts++;
    server = await startServer({ port, publicHost: '127.0.0.1', databaseUrl, storageDir, logFile: artifactLog('server-restart.log'), appendLog: starts > 1, env: { VISION_THREADS: '2' } });
    return server;
  };

  test.beforeAll(async () => {
    test.setTimeout(3 * 60_000);
    await resetDatabase(databaseUrl);
    storageDir = mkdtempSync(join(tmpdir(), 'sp-e2e-restart-storage-'));
    await start();
    owner = await StaffApi.login(ADMIN_EMAIL, ADMIN_PASSWORD, server!.url);
  });

  test.afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await owner?.dispose().catch(() => undefined);
    await server?.stop();
    if (storageDir) rmSync(storageDir, { recursive: true, force: true });
  });

  const answers = async (sessionId: string) => (await sql<{ n: number }>(databaseUrl, 'SELECT count(*)::int AS n FROM answers WHERE session_id = $1', [sessionId]))[0].n;

  test('the candidate works through a restart: nothing is lost, the outage is in the timeline once, the clock stopped for it', async () => {
    skipUnlessFixtures('a');
    test.setTimeout(6 * 60_000);
    const url = server!.url;
    const exam = await owner.createExam({ title: 'Restart e2e exam', policy: mergePolicy(BASE_POLICY, { connection: { heartbeatTimeoutSec: 10, disconnectTimerBehavior: 'stop' } }) });
    const s = await owner.assign(exam, await owner.createCandidate('Rita Restart'));
    browser = await launchCamera('a');
    const c = await CandidatePage.open(null, s.link, { context: await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 900 }, permissions: ['camera'] }) });
    await c.checkInAndStart();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await expect.poll(() => answers(s.sessionId), { message: 'the first answer reached the server' }).toBe(1);

    /* ---------------- the server process stops */
    const before = await candidateState(s.token, url);
    const stoppedAt = Date.now();
    await server!.stop();
    server = null;
    // The candidate keeps answering; the page tells them reporting is interrupted and keeps the answers.
    await c.tid('next-question').click();
    await c.page.getByRole('checkbox', { name: 'Variance' }).check();
    await c.page.getByRole('checkbox', { name: 'Range' }).check();
    await c.tid('next-question').click();
    await c.tid('answer-input').fill('normal');
    await expect(c.tid('qnav-2')).toHaveClass(/answered/);
    await expect(c.tid('reporting-banner')).toBeVisible({ timeout: 30_000 });
    await expect(c.tid('reporting-banner')).toContainText('saved on this device');
    // Down for longer than the heartbeat timeout (10 s).
    const down = 25_000 - (Date.now() - stoppedAt);
    if (down > 0) await c.page.waitForTimeout(down);

    /* ---------------- the server starts again (same database, same storage) */
    await start();
    const backAt = Date.now();
    await expect(c.tid('reporting-banner')).toHaveCount(0, { timeout: 60_000 });
    await expect(c.tid('exam-screen')).toBeVisible(); // the same browser: no reconnect check
    await expect.poll(() => answers(s.sessionId), { message: 'the answers typed during the outage reached the server', timeout: 30_000 }).toBe(3);

    // The outage, once, from the last heartbeat before the stop to the first one after the start.
    const outage = await owner.waitForEvent(s.sessionId, (e) => e.type === 'reporting_interrupted' && e.status === 'closed', { timeout: 30_000 });
    // (a heartbeat already in flight may still be answered while the process shuts down)
    expect(outage.startedAt, 'starts at the last heartbeat before the stop').toBeLessThanOrEqual(stoppedAt + 3_000);
    expect(outage.startedAt).toBeGreaterThanOrEqual(stoppedAt - 8_000);
    expect(outage.endedAt!, 'ends when the browser reached the new process').toBeGreaterThanOrEqual(backAt - 1_000);
    expect(outage.details).toMatchObject({ closedBy: 'heartbeat_resumed' });
    const all = await owner.events(s.sessionId);
    expect(all.filter((e) => e.type === 'reporting_interrupted')).toHaveLength(1);
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);

    // The clock stopped at the last heartbeat and ran again from the browser's return: the time used across the
    // restart is the wall time minus the outage.
    const after = await candidateState(s.token, server!.url);
    const used = before.session.remainingMs - after.session.remainingMs;
    const wall = after.serverTime - before.serverTime;
    const gap = outage.endedAt! - outage.startedAt;
    expect(gap).toBeGreaterThan(20_000);
    expect(Math.abs(used - (wall - gap)), `used ${used} ms of ${wall} ms wall time with a ${gap} ms outage`).toBeLessThan(2_000);

    /* ---------------- the candidate finishes; every answer is there */
    await c.submit();
    const end = await candidateState(s.token, server!.url);
    expect(end.session.status).toBe('submitted');
    const qs = [...(end.questions ?? [])].sort((a, b) => a.index - b.index);
    const byQ = new Map((end.answers ?? []).map((a) => [a.questionId, a.value] as const));
    expect(byQ.get(qs[0].id)).toBe('b');
    expect(byQ.get(qs[1].id)).toEqual(['a', 'b']);
    expect(byQ.get(qs[2].id)).toBe('normal');
    await c.close();
  });
});
