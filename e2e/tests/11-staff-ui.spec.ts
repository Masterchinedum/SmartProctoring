import { readFileSync } from 'node:fs';
import { eventDrawer, feedItems, loginViaUi, navLinks, sessionCard } from '../lib/admin';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from '../lib/config';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 11 — staff workflows in the admin UI: login; dashboard by status with monitoring labels; a
 * live flag arriving without reload; event drawer with screenshot; review / dismiss / notes; filters;
 * report page (all sections, print); CSV export; reviewer role restrictions.
 */
test('staff UI: dashboard, live flag, drawer, review, notes, filters, report, CSV', async ({ browser, staff }) => {
  skipUnlessFixtures('two');
  test.setTimeout(5 * 60_000);
  // A session that has not started, and one that the candidate takes (a second person appears at ~50 s).
  const idle = await staff.createSession({ candidateName: `Idle ${Date.now().toString(36)}` });
  const s = await staff.createSession({ policy: { detection: { multiplePeopleSec: 1 } } });

  /* ---------------- login through the UI */
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const sp = await ctx.newPage();
  await loginViaUi(sp, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(navLinks(sp)).toContainText(['Live', 'Sessions', 'Exams', 'Candidates', 'Quality', 'Audit log', 'Settings', 'Integrations', 'Users']);

  const cam = await launchCamera('two');
  try {
    const c = await CandidatePage.open(cam, s.link);
    await c.consent();
    const t0 = Date.now();
    await c.runCheck();
    await c.startExam();
    await c.answerStandardQuestions();

    /* ---------------- dashboard: sessions by status with monitoring labels */
    const card = sessionCard(sp, s.sessionId);
    await expect(card).toContainText('Active');
    await expect(card).toContainText('Online');
    await expect(card.locator('.sc-monitor')).toContainText('1 face', { timeout: 20_000 });
    await expect(card).toContainText('Identity:');
    const idleCard = sessionCard(sp, idle.sessionId);
    await expect(idleCard).toContainText('Has not started the readiness check');
    await sp.getByRole('tab', { name: /Not started/ }).click();
    await expect(idleCard).toBeVisible();
    await expect(card).toHaveCount(0);
    await sp.getByRole('tab', { name: /Active/ }).click();
    await expect(card).toBeVisible();
    await expect(idleCard).toHaveCount(0);
    await sp.getByRole('tab', { name: /^All/ }).click();

    /* ---------------- a live flag arrives without reload */
    const navigations: string[] = [];
    sp.on('framenavigated', (f) => f === sp.mainFrame() && navigations.push(f.url()));
    const flag = feedItems(sp, s.candidateName).filter({ hasText: 'More than one person in view' });
    await expect(flag.first()).toBeVisible({ timeout: Math.max(10_000, 100_000 - (Date.now() - t0)) });
    expect(navigations, 'no page reload').toEqual([]);
    await expect(card).toContainText(/unreviewed/);

    /* ---------------- open the event drawer with its screenshot */
    const mp = await staff.waitForEvent(s.sessionId, (e) => e.type === 'multiple_people' && e.status === 'closed', { timeout: 60_000 });
    await flag.first().click();
    await expect(sp).toHaveURL(new RegExp(`/admin/sessions/${s.sessionId}\\?event=`));
    const drawer = eventDrawer(sp);
    await expect(drawer.getByRole('heading', { name: 'More than one person in view' })).toBeVisible();
    const shot = drawer.locator('.gallery img').first();
    await expect(shot).toBeVisible();
    await expect.poll(() => shot.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
    await drawer.locator('.gallery .evidence').first().click();
    await expect(sp.getByRole('dialog', { name: 'Image viewer' })).toBeVisible();
    await sp.getByRole('dialog', { name: 'Image viewer' }).getByRole('button', { name: 'Close' }).click();

    /* ---------------- review with a note, and an event note */
    await drawer.getByLabel('Review note (optional)').fill('Second person visible behind the candidate.');
    await drawer.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(drawer.locator('.review-panel')).toContainText('Reviewed');
    await expect(drawer.locator('.review-note')).toContainText('Second person visible behind the candidate.');
    await drawer.getByPlaceholder('Add a note for other reviewers…').fill('Asked the candidate to keep the room clear.');
    await drawer.getByRole('button', { name: 'Add note' }).click();
    await expect(drawer.locator('.notes')).toContainText('Asked the candidate to keep the room clear.');
    const reviewed = await staff.json<{ review: { status: string; note: string | null; byName: string | null }; notesCount: number }>('get', `/api/admin/events/${mp.id}`);
    expect(reviewed.review.status).toBe('reviewed');
    expect(reviewed.review.note).toBe('Second person visible behind the candidate.');
    expect(reviewed.notesCount).toBeGreaterThanOrEqual(1);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);

    /* ---------------- events tab: filters; dismiss a false positive */
    await sp.getByRole('tab', { name: 'Events' }).click();
    const rows = sp.locator('table.events-table tbody tr');
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    await sp.getByRole('button', { name: 'Integrity', pressed: false }).click();
    await expect(rows.filter({ hasText: 'More than one person in view' })).toHaveCount(1);
    for (const cat of await rows.locator('.badge').allInnerTexts()) expect(cat).not.toMatch(/Session change|Technical/);
    expect(await rows.count()).toBeLessThan(total);
    await sp.getByLabel('Only unreviewed').check();
    await expect(rows.filter({ hasText: 'More than one person in view' })).toHaveCount(0);
    await sp.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows).toHaveCount(total);
    await sp.getByLabel('Type').selectOption('multiple_people');
    await expect(rows).toHaveCount(1);
    await sp.getByRole('button', { name: 'Clear filters' }).click();

    const other = (await staff.events(s.sessionId)).find((e) => e.category !== 'neutral' && e.type !== 'multiple_people' && e.review.status === 'unreviewed');
    if (other) {
      await rows.filter({ hasText: other.title }).first().click();
      await eventDrawer(sp).getByRole('button', { name: 'Dismiss as false positive' }).click();
      await expect(eventDrawer(sp).locator('.review-panel')).toContainText('Dismissed');
      await eventDrawer(sp).getByRole('button', { name: 'Close' }).click();
      expect((await staff.json<{ review: { status: string } }>('get', `/api/admin/events/${other.id}`)).review.status).toBe('dismissed');
    }

    /* ---------------- session note */
    await sp.getByRole('tab', { name: /Notes/ }).click();
    const noteBox = sp.locator('.tab-panel textarea').first();
    await noteBox.fill('Session reviewed in the E2E suite.');
    await sp.locator('.tab-panel').getByRole('button', { name: 'Add note' }).click();
    await expect(sp.locator('.tab-panel')).toContainText('Session reviewed in the E2E suite.');

    /* ---------------- CSV export downloads */
    const [download] = await Promise.all([sp.waitForEvent('download'), sp.getByRole('link', { name: 'Export CSV' }).click()]);
    const csv = readFileSync((await download.path())!, 'utf8').replace(/^﻿/, '');
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^id,type,category,severity,title,observation,startedAt,endedAt/);
    expect(lines.some((l) => l.includes('multiple_people') && l.includes('reviewed'))).toBe(true);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);

    /* ---------------- submit, then the report: all sections, print */
    await c.submit();
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await sp.getByRole('link', { name: 'Open report' }).click();
    await expect(sp).toHaveURL(new RegExp(`/admin/sessions/${s.sessionId}/report`));
    for (const h of ['Summary', 'Periods (every active period, pause and resume)', 'Identity', 'Events by category', 'Events by type', 'Notable events', 'Observations', 'Reviewer notes', 'Limitations']) {
      await expect(sp.getByRole('heading', { name: h, exact: true })).toBeVisible();
    }
    await expect(sp.locator('.notable-list')).toContainText('More than one person in view');
    await expect(sp.locator('.notable-list')).toContainText('Second person visible behind the candidate.');
    await expect(sp.locator('.report')).toContainText('Session reviewed in the E2E suite.');
    await expect(sp.locator('.report-totals')).toContainText('Score');
    // Print: the button opens the print dialog; the print stylesheet hides the navigation and toolbar.
    await sp.evaluate(() => {
      (window as unknown as { __printed: number }).__printed = 0;
      window.print = () => void ((window as unknown as { __printed: number }).__printed += 1);
    });
    await sp.getByRole('button', { name: 'Print / Save as PDF' }).click();
    expect(await sp.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    await sp.emulateMedia({ media: 'print' });
    await expect(sp.locator('.admin-nav')).toBeHidden();
    await expect(sp.locator('.report-toolbar')).toBeHidden();
    await expect(sp.getByRole('heading', { name: 'Notable events', exact: true })).toBeVisible();
    const pdf = await sp.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(20_000);
    await sp.emulateMedia({ media: 'screen' });
  } finally {
    await cam.close();
    await ctx.close();
  }
});

test('reviewer role cannot see Settings or Users', async ({ browser, staff }) => {
  const reviewer = await staff.createUser('reviewer');
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  const page = await ctx.newPage();
  try {
    await loginViaUi(page, reviewer.email, reviewer.password);
    const nav = navLinks(page);
    await expect(nav).toContainText(['Live', 'Sessions', 'Exams', 'Candidates', 'Quality']);
    for (const hidden of ['Settings', 'Users', 'Audit log', 'Integrations']) await expect(nav.filter({ hasText: hidden })).toHaveCount(0);
    for (const path of ['/admin/settings', '/admin/users']) {
      await page.goto(path);
      await expect(page.getByText('Administrators only')).toBeVisible();
    }
    // The API enforces the same rule.
    const api = await StaffApi.login(reviewer.email, reviewer.password);
    for (const path of ['/api/admin/settings', '/api/admin/users']) expect((await api.raw(path)).status()).toBe(403);
    expect((await api.raw('/api/admin/dashboard')).status()).toBe(200);
    await api.dispose();
  } finally {
    await ctx.close();
  }
});
