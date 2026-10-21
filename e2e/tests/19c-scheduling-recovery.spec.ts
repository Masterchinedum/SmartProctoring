import { expectNoA11yIssues } from '../lib/a11y';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { BASE_POLICY, uniqueName } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 19c — scheduling windows, the resume policy and reopening for recovery (roadmap #13).
 *  a. An exam is assigned in the staff app with a scheduling window three hours ahead: the candidate's link shows when
 *     it opens (their own time zone) instead of the check-in; staff reschedule it on the session page to open now; the
 *     candidate checks in and starts.
 *  b. The exam's rules (policy editor, "Interruptions and recovery") allow no reopening in a new browser window: after
 *     a reload the exam goes on hold instead of the reconnect check. Staff end it, then reopen it for recovery (reason,
 *     no extra minutes); the candidate reloads, passes a fresh identity check and continues with their answer kept.
 */

const H = 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** A datetime-local value in this machine's time zone (the staff browser uses the same). */
function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('a scheduling window set at assignment: the candidate sees when the exam opens; staff reschedule it; the candidate checks in and starts', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(5 * 60_000);
  const exam = await staff.createExam({ policy: BASE_POLICY, title: uniqueName('Scheduled exam') });
  const cand = await staff.createCandidate(uniqueName('Sam Scheduled'));

  /* ---------------- staff: assign with a window */
  const sp = await staffPage();
  await sp.goto(`/admin/exams/${exam.id}`);
  await sp.getByLabel('Opens').fill(localInput(Date.now() + 3 * H));
  // An inconsistent window is refused before anything is sent.
  await sp.getByLabel('Closes').fill(localInput(Date.now() + 2 * H));
  await expect(sp.getByRole('alert').filter({ hasText: 'The window must close after it opens.' })).toBeVisible();
  await sp.getByLabel('Closes').fill(localInput(Date.now() + 5 * H));
  await expect(sp.getByText('The window must close after it opens.')).toHaveCount(0);
  await sp.getByLabel('Filter candidates').fill(cand.name);
  await sp.locator('.assign-item', { hasText: cand.name }).getByRole('checkbox').check();
  await expectNoA11yIssues(sp, 'assignment panel with a scheduling window');
  await sp.getByRole('button', { name: 'Assign 1 selected' }).click();
  await expect(sp.getByText('1 access link created.')).toBeVisible();
  await expect(sp.getByText(/Window: .* \(opens in 2h 5\dm\)/)).toBeVisible();
  const { items } = await staff.json<{ items: { id: string; candidate: { id: string } }[] }>('get', `/api/admin/exams/${exam.id}/sessions`);
  const sessionId = items.find((x) => x.candidate.id === cand.id)!.id;
  const detail = await staff.session(sessionId);
  expect(detail.summary.window?.startsAt).toBeGreaterThan(Date.now() + 2.9 * H);
  const link = detail.summary.accessLink!;

  const browser = await launchCamera('a');
  try {
    /* ---------------- candidate: not open yet */
    const c = await CandidatePage.open(browser, link);
    const screen = c.tid('window-screen');
    await expect(screen).toHaveAttribute('data-phase', 'before_check_in', { timeout: 30_000 });
    await expect(c.page.getByRole('heading', { name: 'This exam is not open yet' })).toBeVisible();
    await expect(screen).toContainText('This exam opens on');
    await expect(screen).toContainText('you can do the camera and identity check');
    await expect(screen).toContainText('Times are shown in your time zone');
    await expect(c.page.getByRole('heading', { name: 'Privacy notice: camera monitoring' })).toHaveCount(0);
    expect(await c.liveCameraTracks()).toBe(0);
    await expectNoA11yIssues(c.page, 'candidate: exam not open yet');

    /* ---------------- staff: reschedule to open now */
    await sp.goto(`/admin/sessions/${sessionId}`);
    await expect(sp.getByTestId('session-window')).toContainText('(opens in');
    await sp.getByRole('button', { name: 'Reschedule…' }).click();
    const dlg = sp.getByRole('dialog', { name: 'Reschedule the exam' });
    await dlg.getByLabel('Opens').fill(localInput(Date.now() - 5 * 60_000));
    await dlg.getByLabel('Closes').fill(localInput(Date.now() + 2 * H));
    await dlg.getByLabel(/Note/).fill('Moved forward at the candidate’s request (E2E)');
    await expectNoA11yIssues(sp, 'reschedule dialog');
    await dlg.getByRole('button', { name: 'Save window' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(sp.getByTestId('session-window')).toContainText('(open now)');
    const rescheduled = await staff.waitForEventType(sessionId, 'session_rescheduled');
    expect(rescheduled.details).toMatchObject({ note: 'Moved forward at the candidate’s request (E2E)', previousWindow: { startsAt: detail.summary.window!.startsAt } });

    /* ---------------- candidate: the same link now leads to the check-in */
    await c.page.getByRole('button', { name: 'Check again' }).click();
    await c.checkInAndStart();
    const active = await staff.waitForSession(sessionId, (x) => x.summary.status === 'active');
    expect(active.summary.window?.endsAt).toBeGreaterThan(Date.now() + H);
  } finally {
    await browser.close();
  }
});

test('the resume policy holds a reconnection the rules do not allow; staff end the exam and reopen it for recovery; the candidate continues after an identity check', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(7 * 60_000);
  const exam = await staff.createExam({ policy: BASE_POLICY, title: uniqueName('Recovery exam') });

  /* ---------------- staff: the exam's rules in the policy editor */
  const sp = await staffPage();
  await sp.goto(`/admin/exams/${exam.id}/edit`);
  const group = sp.getByRole('group', { name: /Interruptions and recovery/ });
  await expect(group).toBeVisible();
  const reconnects = sp.locator('#pf-resume-maxReconnects');
  await expect(reconnects).toHaveValue('');
  await sp.locator('.policy-field', { has: reconnects }).getByRole('checkbox', { name: 'Unlimited' }).uncheck();
  await expect(reconnects).toHaveValue('0');
  await expect(sp.locator('#pf-resume-onLimit')).toHaveValue('hold');
  await expectNoA11yIssues(sp, 'policy editor: interruptions and recovery');
  await sp.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(async () => (await staff.json<{ policy: { resume: { maxReconnects: number | null } } }>('get', `/api/admin/exams/${exam.id}`)).policy.resume.maxReconnects).toBe(0);

  const cand = await staff.createCandidate(uniqueName('Rhea Recovery'));
  const s = await staff.assign(exam, cand);
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await c.checkInAndStart();
    await c.gotoQuestion(0);
    await c.page.getByRole('radio', { name: 'Mean' }).check();
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);
    await c.page.waitForTimeout(3_000); // the answer is delivered (saved as typed; the outbox retries otherwise)

    /* ---------------- a reload: no reconnection allowed -> on hold */
    await c.page.reload();
    await expect(c.tid('check-intro')).toHaveAttribute('data-purpose', 'reconnect', { timeout: 30_000 });
    await c.tid('check-intro-continue').click();
    await c.passReadiness();
    await expect(c.tid('hold-screen')).toBeVisible({ timeout: 60_000 });
    await expect(c.tid('hold-screen')).toContainText('which the exam rules do not allow');
    const held = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'on_hold');
    expect(held.summary.hold?.reason).toBe('resume_limit');
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    await expect(sp.getByText('Interrupted more often or longer than the exam rules allow').first()).toBeVisible();

    /* ---------------- staff end the exam; the candidate's page shows it */
    await staff.terminate(s.sessionId, 'Ended while the arrangement is clarified (E2E)');
    await expect(c.tid('ended-screen')).toBeVisible({ timeout: 30_000 });

    /* ---------------- staff: reopen for recovery */
    await sp.reload();
    await sp.getByRole('button', { name: 'Reopen for recovery…' }).click();
    const dlg = sp.getByRole('dialog', { name: 'Reopen the exam for recovery' });
    await expect(dlg).toContainText('Terminated by staff');
    await expect(dlg).toContainText('The candidate continues where they stopped, after a fresh camera and identity check.');
    await expect(dlg.getByTestId('confirm-reopen')).toBeDisabled();
    await dlg.getByLabel(/^Reason/).fill('The arrangement was confirmed; the candidate continues (E2E)');
    await expect(dlg.getByLabel('Minutes to add to the exam time')).toHaveValue('0');
    await expectNoA11yIssues(sp, 'reopen dialog');
    await dlg.getByTestId('confirm-reopen').click();
    await expect(dlg).toHaveCount(0);
    await expect(sp.getByTestId('recovery-banner')).toContainText('Reopened for recovery');
    const reopened = await staff.waitForEventType(s.sessionId, 'session_reopened');
    expect(reopened.details).toMatchObject({ previousEndReason: 'staff_terminated', addMinutes: 0, started: true });

    /* ---------------- candidate: back with the same link, identity check, continues */
    await c.page.reload();
    await expect(c.tid('hold-screen')).toHaveAttribute('data-reason', 'recovery', { timeout: 30_000 });
    await expect(c.page.getByRole('heading', { name: 'Your exam has been reopened' })).toBeVisible();
    await expectNoA11yIssues(c.page, 'candidate: exam reopened');
    await c.tid('reverify-button').click();
    expect(await c.runCheck({ purpose: 'reverify' })).toBe('passed');
    await c.continueAfterCheck();
    await expect(c.tid('qnav-0')).toHaveClass(/answered/);
    const after = await staff.waitForSession(s.sessionId, (x) => x.summary.status === 'active');
    expect(after.summary.endReason).toBeNull();
    expect(after.identityChecks.some((ch) => ch.trigger === 'reverify' && ch.decision === 'match')).toBe(true);
    await sp.reload();
    // The timeline entry (the event-type filter also lists it, as a hidden option).
    await expect(sp.getByRole('button', { name: /Exam reopened for recovery An administrator reopened the exam for recovery after an administrator had ended it/ })).toBeVisible();
  } finally {
    await browser.close();
  }
});
