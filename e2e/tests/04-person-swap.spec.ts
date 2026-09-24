import { CandidatePage, launchCamera, since, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 4 — person swap during the active exam (no pause, no absence: the face in view simply
 * changes). Fake camera: candidate A for 60 s from camera start, then person B.
 * Expected: routine identity samples (every 10 s by policy) stop matching; after the configured
 * confirmation a high-severity integrity event `identity_mismatch` is raised and the exam is held for
 * review. Staff see the flag arrive live, compare reference vs later images, release with a fresh check
 * (the camera restarts, so A is in view again and passes), then terminate.
 */
test('person swap mid-exam: flagged live, held, compared, released with a fresh check, terminated', async ({ staff, staffPage }) => {
  skipUnlessFixtures('swap');
  test.setTimeout(5 * 60_000);
  const s = await staff.createSession({ policy: { identity: { periodicCheckIntervalSec: 10, onMismatch: 'hold_for_review' } } });
  const sp = await staffPage();
  await sp.goto('/admin');
  await expect(sp.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();

  const browser = await launchCamera('swap');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.consent();
    const t0 = Date.now(); // ≈ camera start (the video starts with the camera check)
    expect(await c.runCheck()).toBe('ready');
    await c.startExam();
    await c.answerStandardQuestions();
    console.log(`exam started ${since(t0)} after camera start (person B appears at 60 s)`);
    expect(Date.now() - t0).toBeLessThan(45_000);

    // While A is in view, routine samples match and the exam continues.
    const matched = await staff.waitForSession(s.sessionId, (d) => d.identityChecks.some((ch) => ch.trigger === 'periodic' && ch.decision === 'match'), { timeout: 40_000 });
    expect(matched.summary.status).toBe('active');
    expect(Date.now() - t0).toBeLessThan(58_000);

    /* ---------------- the swap: hold screen for the candidate */
    await expect(c.tid('hold-screen')).toBeVisible({ timeout: 120_000 });
    console.log(`held ${since(t0)} after camera start`);
    expect(Date.now() - t0).toBeGreaterThan(60_000);
    await expect(c.tid('hold-screen')).toContainText('Your exam is on hold');
    await expect(c.tid('hold-screen')).not.toContainText(/cheat|fraud|impostor/i);
    await expect(c.tid('reverify-button')).toHaveCount(0);
    // Monitoring stopped: the camera is released (no live track left behind).
    await expect.poll(() => c.liveCameraTracks(), { timeout: 10_000, message: 'camera released while on hold' }).toBe(0);

    const d = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold');
    expect(d.summary.hold?.reason).toBe('identity_mismatch');
    const ev = (await staff.events(s.sessionId)).find((e) => e.type === 'identity_mismatch')!;
    expect(ev).toBeTruthy();
    expect(ev.category).toBe('integrity');
    expect(ev.severity).toBe('high');
    expect(ev.evidence.length).toBeGreaterThan(0);
    const mismatches = d.identityChecks.filter((ch) => ch.decision === 'mismatch');
    expect(mismatches.length, 'confirmed by more than one sample').toBeGreaterThanOrEqual(2);
    expect(mismatches.every((ch) => ch.at > t0 + 55_000)).toBe(true);

    /* ---------------- staff: the flag arrived live on the dashboard (no reload) */
    const feedItem = sp.locator('.feed-item', { hasText: s.candidateName }).filter({ hasText: 'Possible different person' });
    await expect(feedItem.first()).toBeVisible({ timeout: 15_000 });
    const card = sp.locator(`a.session-card[href="/admin/sessions/${s.sessionId}"]`);
    await expect(card).toContainText('On hold');
    await expect(card).toContainText('Possible different person — awaiting review');
    await expect(sp.locator('.attention-item.hold', { hasText: s.candidateName })).toBeVisible();

    /* ---------------- comparison view: reference vs later images */
    await card.click();
    await expect(sp).toHaveURL(new RegExp(`/admin/sessions/${s.sessionId}$`));
    await sp.getByRole('tab', { name: /Identity/ }).click();
    await sp.getByRole('link', { name: 'Compare images' }).first().click();
    await expect(sp).toHaveURL(new RegExp(`/compare/${ev.id}`));
    const refSection = sp.locator('section', { has: sp.getByRole('heading', { name: 'Original reference' }) });
    const laterSection = sp.locator('section', { has: sp.getByRole('heading', { name: 'Later images' }) });
    await expect(refSection.locator('img').first()).toBeVisible();
    await expect(laterSection.locator('img').first()).toBeVisible();
    await expect(refSection.locator('img').first()).toHaveJSProperty('complete', true);
    expect(await refSection.locator('img').first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    expect(await laterSection.locator('img').first().evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    await expect(sp.getByRole('heading', { name: 'Similarity to the reference' })).toBeVisible();
    const cmp = await staff.compare(ev.id);
    expect(cmp.similarity.max!).toBeLessThan(cmp.similarity.thresholds.mismatch);

    /* ---------------- release with a fresh identity check */
    await sp.goBack();
    await sp.getByRole('button', { name: 'Release hold…' }).click();
    const dlg = sp.getByRole('dialog', { name: 'Release hold' });
    await expect(dlg.getByLabel('Require a fresh identity check before the candidate continues (recommended)')).toBeChecked();
    await dlg.getByLabel(/Note/).fill('Checked images; asking for a fresh check.');
    await dlg.getByRole('button', { name: 'Release hold' }).click();
    await expect(dlg).toHaveCount(0);

    // The candidate is asked to verify again; the camera restarts (the video starts again with A).
    await expect(c.tid('reverify-button')).toBeVisible({ timeout: 20_000 });
    await c.tid('reverify-button').click();
    expect(await c.runCheck({ purpose: 'reverify' })).toBe('passed');
    await c.continueAfterCheck();
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);
    const after = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'active');
    expect(after.identityChecks.some((ch) => ch.trigger === 'reverify' && ch.decision === 'match')).toBe(true);

    /* ---------------- terminate from the admin UI */
    await sp.reload();
    await sp.getByRole('button', { name: 'Terminate…' }).click();
    const tdlg = sp.getByRole('dialog', { name: 'Terminate this exam?' });
    await tdlg.getByLabel('Reason').fill('Identity could not be confirmed after a possible person swap (E2E).');
    await tdlg.getByRole('button', { name: 'Terminate exam' }).click();
    await expect(tdlg).toHaveCount(0);
    await expect(c.tid('ended-screen')).toBeVisible({ timeout: 20_000 });
    await expect(c.tid('ended-screen')).toHaveAttribute('data-status', 'terminated');
    await expect(c.tid('ended-screen')).toContainText('ended by the exam administrator');

    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    for (const t of ['identity_mismatch', 'session_held', 'hold_released', 'session_terminated']) expect(types).toContain(t);
    const report = await staff.report(s.sessionId);
    expect(report.identity.mismatches).toBeGreaterThanOrEqual(2);
    expect(report.observations.join(' ')).not.toMatch(/cheat/i);
  } finally {
    await browser.close();
  }
});
