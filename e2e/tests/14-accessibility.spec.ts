import type { Page } from '@playwright/test';
import { eventDrawer } from '../lib/admin';
import { announcements, expectFocusTrapped, expectNoA11yIssues, RECORD_ANNOUNCEMENTS, tabTo } from '../lib/a11y';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { BASE_URL } from '../lib/config';
import { expect, test } from '../lib/test';

/**
 * Scenario 14 — accessibility (WCAG 2.1 AA in practice), with the in-repo checker in lib/a11y.ts
 * (Chromium's computed accessibility tree + DOM / contrast checks) and keyboard-only walkthroughs:
 *
 *  a) candidate: consent → camera check → start → every question type → question navigation →
 *     submit / privacy / pause dialogs, using only the keyboard; focus moves to the heading of each new
 *     screen and question; dialogs trap focus, close with Escape and return focus; the countdown is a
 *     timer that is announced only at minute marks; errors are tied to their fields; 320 px reflow.
 *     Staff: a new flag is announced (politely) on the dashboard; status tabs, session tabs, the events
 *     table, the event drawer and the image viewer are keyboard operable with proper semantics.
 *  b) phones / small screens and devices without a camera get a friendly notice (not a block); the
 *     welcome screen reflows at 320 px; prefers-reduced-motion stops animations; the staff sign-in page.
 */

/** Simulated switch to another tab (see 08-browser-events): produces an integrity flag within seconds. */
async function switchAway(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    if (h) window.dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!h) window.dispatchEvent(new Event('focus'));
  }, hidden);
}

test('keyboard-only exam and staff review: names, focus management, dialogs, live regions', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(6 * 60_000);
  // 10 min 20 s: the "10 minutes remaining" announcement happens during the walkthrough.
  const s = await staff.createSession({
    durationSec: 10 * 60 + 20,
    policy: { pause: { allowed: true, requireReason: true, requireApproval: false, timerBehavior: 'stop' }, browser: { flagTabHidden: true } },
  });

  // The staff dashboard is open (and listening) before the candidate starts.
  const sp = await staffPage();
  await sp.addInitScript(RECORD_ANNOUNCEMENTS);
  await sp.goto('/admin');
  await expect(sp.getByRole('heading', { name: 'Live', exact: true })).toBeVisible();
  await expect(sp).toHaveTitle('Live dashboard — SmartProctoring staff');

  const browser = await launchCamera('a');
  try {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
    await context.addInitScript(RECORD_ANNOUNCEMENTS);
    const c = await CandidatePage.open(null, s.link, { context });
    const { page } = c;

    /* ---------------- welcome: structure, names, accommodations note; consent with the keyboard */
    await expect(page.getByRole('heading', { level: 1, name: s.examTitle })).toBeVisible();
    // No focus jump on the initial page load (reading starts at the top); later screens get the focus.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(page).toHaveTitle(`Welcome — ${s.examTitle} — SmartProctoring`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(c.tid('requirements')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Accessibility & accommodations' })).toBeVisible();
    await expect(c.tid('accessibility-note')).toContainText('without the head-movement check');
    await expect(c.tid('accessibility-note')).toContainText('extra time');
    await expect(c.tid('device-notice')).toHaveCount(0); // desktop with a camera: no warning
    await expect(c.tid('consent-continue')).toHaveAccessibleDescription(/tick the box above/i);
    await expectNoA11yIssues(page, 'welcome screen');
    await tabTo(page, c.tid('consent-checkbox'));
    await page.keyboard.press('Space');
    await expect(c.tid('consent-checkbox')).toBeChecked();
    await tabTo(page, c.tid('consent-continue'));
    await page.keyboard.press('Enter');

    /* ---------------- camera check: focus on the new heading, camera picker, status line */
    await expect(page.getByRole('heading', { level: 1, name: 'Camera check' })).toBeFocused({ timeout: 20_000 });
    await expect(page).toHaveTitle(`Camera check — ${s.examTitle} — SmartProctoring`);
    await expect(page.getByRole('combobox', { name: 'Camera' })).toBeVisible();
    await expect(c.tid('readiness-continue')).toBeEnabled({ timeout: 90_000 });
    await expect(c.tid('readiness-status')).toHaveAttribute('role', 'status');
    await expect(c.tid('readiness-status')).toContainText('All checks passed');
    await expectNoA11yIssues(page, 'camera check');
    await tabTo(page, c.tid('camera-select'));
    await tabTo(page, c.tid('readiness-continue'));
    await page.keyboard.press('Enter');

    /* ---------------- calibration → identity check → ready (the instruction is a polite status) */
    await expect(c.tid('verify-step').or(c.tid('ready-screen'))).toBeVisible({ timeout: 60_000 });
    if (await c.tid('verify-step').isVisible()) {
      await expect(c.tid('verify-instruction')).toHaveAttribute('role', 'status');
      await expect(c.tid('verify-instruction')).toHaveAttribute('aria-live', 'polite');
    }
    await expect(c.tid('ready-screen')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'You are ready to start' })).toBeFocused();
    await expectNoA11yIssues(page, 'ready screen');

    // "What is monitored?" dialog: opened with Enter, focus inside and trapped, page behind inert, Escape.
    const what = page.getByRole('button', { name: 'What is monitored?' });
    await tabTo(page, what);
    await page.keyboard.press('Enter');
    const notice = page.getByRole('dialog', { name: 'What is monitored during your exam' });
    await expect(notice).toBeVisible();
    await expect(page.locator('main')).toHaveJSProperty('inert', true);
    await expectFocusTrapped(page, notice, 4);
    await page.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);
    await expect(what).toBeFocused();
    await expect(page.locator('main')).toHaveJSProperty('inert', false);

    await tabTo(page, c.tid('start-exam'));
    await page.keyboard.press('Enter');
    await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
    await c.expectMonitoringActive();

    /* ---------------- exam screen: focus on the question, countdown is a timer (never a live region) */
    const qHeading = (n: number) => page.getByRole('heading', { level: 2, name: `Question ${n} of 5` });
    await expect(qHeading(1)).toBeFocused();
    await expect(page).toHaveTitle(`Question 1 of 5 — ${s.examTitle} — SmartProctoring`);
    const timer = page.getByRole('timer', { name: 'Time remaining' });
    await expect(timer).toBeVisible();
    expect(await timer.evaluate((el) => !!el.closest('[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"], [role="log"]'))).toBe(false);
    await expect(page.getByRole('navigation', { name: 'Questions' })).toBeVisible();
    await expect(page.getByRole('main', { name: 'Current question' })).toBeVisible();
    await expectNoA11yIssues(page, 'exam screen');

    // Staff: a new flag (here: the candidate left the exam tab) is announced politely on the dashboard.
    await switchAway(page, true);
    await page.waitForTimeout(2_500);
    await switchAway(page, false);
    await expect(qHeading(1)).toBeFocused();
    await expect
      .poll(async () => (await announcements(sp)).map((a) => a.text).join(' | '), { timeout: 90_000, message: 'new flag announced on the dashboard' })
      .toMatch(/new flags?\b/i);

    // Q1 single choice: a fieldset whose legend carries the question; arrow keys choose.
    await expect(page.getByRole('group', { name: /Question 1 of 5.*most affected by outliers/ })).toBeVisible();
    await tabTo(page, page.getByRole('radio', { name: 'Median' }));
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: 'Mean' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Mean' })).toBeFocused();
    await expect(c.tid('autosave-status')).toHaveText('Answer saved automatically');
    await expect(c.tid('qnav-0')).toHaveAccessibleName('Question 1, answered');
    await tabTo(page, c.tid('next-question'));
    await page.keyboard.press('Enter');

    // Q2 multiple choice (Space toggles).
    await expect(qHeading(2)).toBeFocused();
    await expect(page.getByRole('group', { name: /Question 2 of 5.*Select all that apply/ })).toBeVisible();
    await tabTo(page, page.getByRole('checkbox', { name: 'Variance' }));
    await page.keyboard.press('Space');
    await tabTo(page, page.getByRole('checkbox', { name: 'Range' }));
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Variance' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Range' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Mean' })).not.toBeChecked();
    await tabTo(page, c.tid('next-question'));
    await page.keyboard.press('Enter');

    // Q3 short text.
    await expect(qHeading(3)).toBeFocused();
    await tabTo(page, page.getByRole('textbox', { name: 'Your answer', exact: true }));
    await page.keyboard.type('normal');
    await expect(c.tid('answer-input')).toHaveValue('normal');
    await tabTo(page, c.tid('next-question'));
    await page.keyboard.press('Enter');

    // Q4 numeric: an invalid value is flagged and the message is the field's description.
    await expect(qHeading(4)).toBeFocused();
    const num = page.getByRole('textbox', { name: 'Your answer (a number)' });
    await tabTo(page, num);
    await page.keyboard.type('abc');
    await expect(num).toHaveAttribute('aria-invalid', 'true');
    await expect(num).toHaveAccessibleDescription(/Enter a number, for example 42 or 3\.5/);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('5');
    await expect(num).toHaveAttribute('aria-invalid', 'false');
    await expect(num).toHaveAccessibleDescription('');
    await tabTo(page, c.tid('next-question'));
    await page.keyboard.press('Enter');

    // Q5 long text (last question: "Review and submit" replaces Next; the focus is not lost).
    await expect(qHeading(5)).toBeFocused();
    await tabTo(page, page.getByRole('textbox', { name: 'Your answer', exact: true }));
    await page.keyboard.type('Correlation is not causation.');
    await expect(c.tid('answer-input')).toHaveValue('Correlation is not causation.');

    // Question navigation with the keyboard (back to question 1).
    const nav = page.getByRole('navigation', { name: 'Questions' });
    await tabTo(page, nav.getByRole('button', { name: 'Question 1, answered' }), { back: true });
    await page.keyboard.press('Enter');
    await expect(qHeading(1)).toBeFocused();
    await expect(nav.getByRole('button', { name: 'Question 1, answered' })).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('radio', { name: 'Mean' })).toBeChecked();

    // Reflow: at 320 CSS px (400 % zoom of 1280 px) nothing scrolls sideways and the controls remain.
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scrolling at 320 px').toBeLessThanOrEqual(320);
    await expect(c.tid('submit-button')).toBeVisible();
    await expect(qHeading(1)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });

    /* ---------------- submit dialog: safe default focus, description, trap, Escape returns focus */
    await tabTo(page, c.tid('submit-button'), { back: true });
    await page.keyboard.press('Enter');
    const submitDlg = page.getByRole('dialog', { name: 'Submit your exam?' });
    await expect(submitDlg).toBeVisible();
    await expect(submitDlg).toHaveAccessibleDescription(/You have answered 5 of 5 questions/);
    await expect(submitDlg.getByRole('button', { name: 'Back to exam' })).toBeFocused();
    await expectFocusTrapped(page, submitDlg, 3);
    await expectNoA11yIssues(page, 'submit dialog');
    await page.keyboard.press('Escape');
    await expect(submitDlg).toHaveCount(0);
    await expect(c.tid('submit-button')).toBeFocused();

    /* ---------------- countdown: announced at the 10-minute mark, never every second */
    await expect
      .poll(async () => (await announcements(page)).map((a) => a.text).join(' | '), { timeout: 40_000, message: '10-minute announcement' })
      .toContain('10 minutes remaining.');
    const said = await announcements(page);
    expect(said.filter((a) => /\b\d{1,2}:\d{2}\b/.test(a.text)), 'the clock value itself is never announced').toEqual([]);
    expect(said.filter((a) => /minutes? remaining/.test(a.text)).length, 'one announcement per mark').toBe(1);

    /* ---------------- pause dialog: trap, error tied to the field, Escape, then pause */
    await tabTo(page, c.tid('pause-button'), { back: true });
    await page.keyboard.press('Enter');
    const pauseDlg = page.getByRole('dialog', { name: 'Pause the exam' });
    await expect(pauseDlg).toBeVisible();
    await expect(c.tid('pause-reason')).toBeFocused();
    await expect(page.locator('.cand-exam-header')).toHaveJSProperty('inert', true);
    await expectFocusTrapped(page, pauseDlg, 5);
    await tabTo(page, c.tid('pause-confirm'));
    await page.keyboard.press('Enter');
    await expect(pauseDlg.getByRole('alert')).toContainText('Please give a reason for the pause.');
    await expect(c.tid('pause-reason')).toBeFocused();
    await expect(c.tid('pause-reason')).toHaveAttribute('aria-invalid', 'true');
    await expect(c.tid('pause-reason')).toHaveAccessibleDescription('Please give a reason for the pause.');
    await page.keyboard.press('Escape');
    await expect(pauseDlg).toHaveCount(0);
    await expect(c.tid('pause-button')).toBeFocused();
    await expect(page.locator('.cand-exam-header')).toHaveJSProperty('inert', false);
    await page.keyboard.press('Enter');
    await expect(c.tid('pause-reason')).toBeFocused();
    await page.keyboard.type('Short break (accessibility test)');
    await tabTo(page, c.tid('pause-confirm'));
    await page.keyboard.press('Enter');
    await expect(c.tid('paused-screen')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Your exam is paused' })).toBeFocused();
    await expect(page).toHaveTitle(`Your exam is paused — ${s.examTitle} — SmartProctoring`);
    await expectNoA11yIssues(page, 'paused screen');
    expect(c.pageErrors).toEqual([]);

    /* ---------------- staff dashboard: announcements were rate-limited; status tabs */
    const flagSaid = (await announcements(sp)).filter((a) => /new flags?\b/i.test(a.text));
    for (let i = 1; i < flagSaid.length; i++) expect(flagSaid[i].t - flagSaid[i - 1].t, 'flag announcements at most every 15 s').toBeGreaterThanOrEqual(14_000);
    await expectNoA11yIssues(sp, 'staff dashboard');
    const statusTabs = sp.getByRole('tablist', { name: 'Session status' });
    const allTab = statusTabs.getByRole('tab', { name: /^All/ });
    await allTab.focus();
    await expect(allTab).toHaveAttribute('aria-selected', 'true');
    expect(await statusTabs.locator('[role="tab"][tabindex="0"]').count(), 'one tab stop in the tab list').toBe(1);
    await sp.keyboard.press('ArrowRight');
    const activeTab = statusTabs.getByRole('tab', { name: /^Active/ });
    await expect(activeTab).toBeFocused();
    await expect(activeTab).toHaveAttribute('aria-selected', 'true');
    await expect(allTab).toHaveAttribute('tabindex', '-1');
    await expect(sp.getByRole('tabpanel', { name: /^Active/ })).toBeVisible();
    await sp.keyboard.press('End');
    await expect(statusTabs.getByRole('tab', { name: /^Completed/ })).toBeFocused();
    await sp.keyboard.press('Home');
    await expect(allTab).toBeFocused();
    await expect(allTab).toHaveAttribute('aria-selected', 'true');

    /* ---------------- session detail: tabs, events table, drawer, image viewer */
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await expect(sp).toHaveTitle('Session details — SmartProctoring staff');
    const sessionTabs = sp.getByRole('tablist', { name: 'Session details' });
    const timelineTab = sessionTabs.getByRole('tab', { name: 'Timeline' });
    await expect(timelineTab).toHaveAttribute('aria-selected', 'true');
    await expect(sp.getByRole('tabpanel', { name: 'Timeline' })).toBeVisible();
    await expect(sp.locator('.tl-section').first()).toBeVisible();
    await expectNoA11yIssues(sp, 'session detail — timeline');

    await timelineTab.focus();
    await sp.keyboard.press('ArrowRight');
    const eventsTab = sessionTabs.getByRole('tab', { name: 'Events' });
    await expect(eventsTab).toBeFocused();
    await expect(eventsTab).toHaveAttribute('aria-selected', 'true');
    await expect(sp.getByRole('tabpanel', { name: 'Events' })).toBeVisible();
    const firstRow = sp.locator('table.events-table tbody tr').first();
    await expect(firstRow).toBeVisible();
    await expectNoA11yIssues(sp, 'session detail — events');
    const rowButton = firstRow.getByRole('button').first();
    await tabTo(sp, rowButton);
    await sp.keyboard.press('Enter');
    const drawer = eventDrawer(sp);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(drawer.locator('.review-panel')).toBeVisible();
    await expectFocusTrapped(sp, drawer, 6);
    await expectNoA11yIssues(sp, 'event drawer');
    await sp.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(rowButton).toBeFocused();

    await eventsTab.focus();
    await sp.keyboard.press('ArrowRight');
    const identityTab = sessionTabs.getByRole('tab', { name: /Identity/ });
    await expect(identityTab).toHaveAttribute('aria-selected', 'true');
    const refImage = sp.getByRole('button', { name: /Identity reference image at \d\d:\d\d:\d\d/ }).first();
    await expect(refImage).toBeVisible();
    await expectNoA11yIssues(sp, 'session detail — identity');
    await tabTo(sp, refImage, { max: 80 });
    await sp.keyboard.press('Enter');
    const viewer = sp.getByRole('dialog', { name: 'Image viewer' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(viewer.getByRole('img')).toHaveAccessibleName(/^Identity reference image at \d\d:\d\d:\d\d/);
    const nImages = await sp.locator('.gallery .evidence').count();
    if (nImages > 1) {
      await expect(viewer).toContainText(`image 1 of ${nImages}`);
      await sp.keyboard.press('ArrowRight');
      await expect(viewer).toContainText(`image 2 of ${nImages}`);
      await sp.keyboard.press('ArrowLeft');
      await expect(viewer).toContainText(`image 1 of ${nImages}`);
    }
    await expectFocusTrapped(sp, viewer, 3);
    await sp.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(refImage).toBeFocused();

    /* ---------------- candidate: resume (intro → check → result) and submit, still keyboard only */
    await page.bringToFront();
    await tabTo(page, c.tid('resume-button'));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Resume your exam' })).toBeFocused();
    await expectNoA11yIssues(page, 'resume intro');
    await tabTo(page, c.tid('check-intro-continue'));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Camera check' })).toBeFocused();
    await expect(c.tid('readiness-continue')).toBeEnabled({ timeout: 90_000 });
    await tabTo(page, c.tid('readiness-continue'));
    await page.keyboard.press('Enter');
    await expect(c.tid('check-passed')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Check complete' })).toBeFocused();
    await expectNoA11yIssues(page, 'check result');
    await tabTo(page, c.tid('check-continue'));
    await page.keyboard.press('Enter');
    await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
    await expect(qHeading(1)).toBeFocused();
    await tabTo(page, c.tid('submit-button'), { back: true });
    await page.keyboard.press('Enter');
    await expect(submitDlg).toBeVisible();
    await tabTo(page, c.tid('submit-confirm'));
    await page.keyboard.press('Enter');
    await expect(c.tid('ended-screen')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: 'Your exam has been submitted' })).toBeFocused();
    await expectNoA11yIssues(page, 'ended screen');
    expect(c.pageErrors).toEqual([]);
  } finally {
    await browser.close();
  }
});

test('small screens and missing cameras get a friendly notice; 320 px reflow; reduced motion; staff sign-in', async ({ browser, staff }) => {
  const s = await staff.createSession();
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
  try {
    // A phone-sized screen without a camera.
    await ctx.addInitScript(() => {
      if (navigator.mediaDevices) navigator.mediaDevices.enumerateDevices = async () => [];
    });
    const page = await ctx.newPage();
    await page.goto(s.path);
    await expect(page.getByRole('heading', { level: 1, name: s.examTitle })).toBeVisible();
    await expect(page.getByTestId('requirements')).toBeVisible();
    const notice = page.getByTestId('device-notice');
    await expect(notice).toContainText('This exam needs a computer with a webcam');
    await expect(notice).toContainText('phone or a small screen');
    await expect(notice).toContainText('could not find a camera');
    // A warning, not a block: consent is still possible.
    await page.getByTestId('consent-checkbox').check();
    await expect(page.getByTestId('consent-continue')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scrolling at 320 px').toBeLessThanOrEqual(320);
    await expectNoA11yIssues(page, 'welcome screen at 320 px');

    // prefers-reduced-motion: animations are effectively off.
    const duration = await page.evaluate(() => {
      const el = document.createElement('span');
      el.className = 'cand-spinner';
      document.body.append(el);
      const d = getComputedStyle(el).animationDuration;
      el.remove();
      return Number.parseFloat(d) * (d.endsWith('ms') ? 0.001 : 1);
    });
    expect(duration).toBeLessThan(0.01);

    // Staff sign-in page.
    const login = await ctx.newPage();
    await login.setViewportSize({ width: 1280, height: 900 });
    await login.goto('/admin/login');
    await expect(login).toHaveTitle('Sign in — SmartProctoring staff');
    await expect(login.getByLabel('Email')).toBeFocused();
    await expectNoA11yIssues(login, 'staff sign-in');
  } finally {
    await ctx.close();
  }
});

test('every staff page: accessible names, landmarks, headings, titles, contrast', async ({ staff, staffPage }) => {
  const s = await staff.createSession({ policy: { pause: { allowed: true } } });
  const sp = await staffPage();
  const pages: [string, RegExp][] = [
    ['/admin', /^Live dashboard/],
    ['/admin/sessions', /^Sessions/],
    [`/admin/sessions/${s.sessionId}`, /^Session details/],
    [`/admin/sessions/${s.sessionId}/report`, /^Session report/],
    ['/admin/exams', /^Exams/],
    [`/admin/exams/${s.examId}`, /^Exam details/],
    [`/admin/exams/${s.examId}/edit`, /^Edit exam/],
    ['/admin/exams/new', /^New exam/],
    ['/admin/candidates', /^Candidates/],
    [`/admin/candidates/${s.candidateId}`, /^Candidate details/],
    ['/admin/quality', /^Quality/],
    ['/admin/audit', /^Audit log/],
    ['/admin/settings', /^Settings/],
    ['/admin/integrations', /^Integrations/],
    ['/admin/users', /^Users/],
  ];
  for (const [path, title] of pages) {
    await sp.goto(path);
    await expect(sp.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(sp.locator('.loading')).toHaveCount(0, { timeout: 20_000 });
    await expect(sp).toHaveTitle(title);
    await expectNoA11yIssues(sp, path);
  }
  // Skip link: the first Tab stop, and it moves the focus to the main content.
  await sp.goto('/admin/sessions');
  await expect(sp.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await sp.keyboard.press('Tab');
  const skip = sp.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  await sp.keyboard.press('Enter');
  await expect(sp.getByRole('main')).toBeFocused();
});
