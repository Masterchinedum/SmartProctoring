import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidatePage, launchCamera, launchPersistentCamera, skipUnlessFixtures } from '../lib/candidate';
import { BASE_URL } from '../lib/config';
import { expect, test } from '../lib/test';

/**
 * Extra scenarios folded in from the candidate app's draft scripts:
 *  a) the in-browser vision models cannot load: the (server-verified) check still works, the exam runs,
 *     and monitoring is reported as degraded (technical) — never blocking the exam;
 *  b) resuming from another seat (same browser, the camera view changed): the same person matches the
 *     reference; the difference is recorded as NEUTRAL context only;
 *  c) a staff member puts the exam on hold manually and releases it without a new check.
 */
test('vision models unavailable: the exam continues and monitoring_degraded is reported', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession();
  const browser = await launchCamera('a');
  try {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
    await context.route(/\/models\/.*\.(task|tflite)$/, (route) => route.fulfill({ status: 404, body: 'not found' }));
    const c = await CandidatePage.open(null, s.link, { context });
    await c.consent();
    await expect(c.page.getByText('The automatic camera check could not start in this browser')).toBeVisible({ timeout: 60_000 });
    await c.tid('readiness-continue').click();
    await expect(c.page.getByText('Automatic guidance is unavailable in this browser')).toBeVisible({ timeout: 30_000 });
    expect(await c.waitForCheckOutcome(90_000)).toBe('ready');
    await c.tid('start-exam').click();
    await expect(c.tid('exam-screen')).toBeVisible();
    await expect(c.tid('monitoring-status')).toContainText('Monitoring limited', { timeout: 30_000 });
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();

    const ev = await staff.waitForEventType(s.sessionId, 'monitoring_degraded', { timeout: 30_000 });
    expect(ev.category).toBe('technical');
    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.monitoring?.state === 'degraded', { timeout: 30_000 });
    expect(d.summary.status).toBe('active');
    expect(d.references).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

test('resume from another seat: same person, neutral context only', async ({ staff }) => {
  skipUnlessFixtures('a', 'aMoved');
  const s = await staff.createSession();
  const profile = mkdtempSync(join(tmpdir(), 'sp-e2e-profile-'));
  try {
    let ctx = await launchPersistentCamera('a', profile);
    let c = await CandidatePage.open(null, s.link, { context: ctx });
    await c.checkInAndStart();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await c.pause('Moving to a quieter room');
    await ctx.close();

    // Same computer and browser, later, sitting elsewhere (smaller and off-centre in the picture).
    ctx = await launchPersistentCamera('aMoved', profile);
    c = await CandidatePage.open(null, s.link, { context: ctx });
    await c.tid('resume-button').click();
    expect(await c.runCheck({ purpose: 'resume' })).toBe('passed');
    await c.continueAfterCheck();
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);
    await c.expectMonitoringActive();

    const env = await staff.waitForEventType(s.sessionId, 'environment_changed', { timeout: 30_000 });
    expect(env.category).toBe('neutral');
    expect(env.observation).toMatch(/position|size|distance|background|camera/i);
    const d = await staff.session(s.sessionId);
    expect(d.identityChecks.find((ch) => ch.trigger === 'resume')?.decision).toBe('match');
    const events = await staff.events(s.sessionId);
    expect(events.some((e) => e.type === 'identity_mismatch' || e.type === 'session_held')).toBe(false);
    await ctx.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('staff hold (manual) and release without a new check', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession();
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await sp.getByRole('button', { name: 'Put on hold…' }).click();
    const dlg = sp.getByRole('dialog', { name: 'Put this exam on hold?' });
    await dlg.getByLabel(/Note/).fill('Checking the room by phone (E2E).');
    await dlg.getByRole('button', { name: 'Put on hold' }).click();
    await expect(dlg).toHaveCount(0);

    await expect(c.tid('hold-screen')).toBeVisible({ timeout: 20_000 });
    await expect(c.tid('hold-screen')).toContainText('Your exam is on hold');
    await expect(c.tid('reverify-button')).toHaveCount(0);
    const clockOnHold = await c.countdownMs();

    await sp.getByRole('button', { name: 'Release hold…' }).click();
    const rel = sp.getByRole('dialog', { name: 'Release hold' });
    await rel.getByLabel('Require a fresh identity check before the candidate continues (recommended)').uncheck();
    await rel.getByRole('button', { name: 'Release hold' }).click();
    await expect(rel).toHaveCount(0);

    // The same (still verified) browser continues without a new check.
    await expect(c.tid('exam-screen')).toBeVisible({ timeout: 20_000 });
    await c.expectMonitoringActive();
    expect(clockOnHold - (await c.countdownMs())).toBeLessThan(5_000);
    const d = await staff.session(s.sessionId);
    expect(d.summary.status).toBe('active');
    const held = d.periods.find((p) => p.kind === 'on_hold');
    expect(held?.observed).toBe(false);
    expect(held?.endedAt).not.toBeNull();
    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    expect(types).toContain('session_held');
    expect(types).toContain('hold_released');
  } finally {
    await browser.close();
  }
});
