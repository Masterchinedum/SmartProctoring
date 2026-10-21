import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import type { AccommodationDTO } from '../../packages/shared/src/accommodations';
import { expect, test } from '../lib/test';

/**
 * Scenario 19 — accommodations (approved per-candidate exceptions to exam rules).
 *  a) An administrator adds "extra time" and "identity verified by staff" on the candidate's page. The candidate sees
 *     them on the welcome screen with the longer duration; the check needs only a working camera (no face check), then
 *     the exam waits on a staff_verification hold; a reviewer verifies the identity in the staff app (method
 *     recorded) and the candidate starts. No identity picture is ever sent. The session page lists the accommodations
 *     and every exam rule they changed.
 *  b) "No camera": the candidate takes the exam in a browser without a camera — no camera step, no camera opened —
 *     after a staff member verified them.
 */
test('extra time and identity verified by staff, granted and verified in the staff app', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession({ durationSec: 1800 });
  const sp = await staffPage();

  /* ---------------- staff: grant on the candidate page */
  await sp.goto(`/admin/candidates/${s.candidateId}`);
  const panel = sp.getByTestId('accommodations');
  await expect(panel).toContainText('No active accommodations.');
  for (const [kind, fill] of [
    ['Extra time', async () => sp.getByLabel('Extra time (% of the exam’s duration)').fill('50')],
    ['Identity verified by staff', async () => undefined],
  ] as const) {
    await panel.getByRole('button', { name: 'Add accommodation…' }).click();
    const dialog = sp.getByRole('dialog', { name: 'Add accommodation' });
    await dialog.getByLabel('Accommodation').selectOption({ label: kind });
    await fill();
    await dialog.getByLabel('Note for administrators (optional)').fill('Approved by student services');
    await dialog.getByRole('button', { name: 'Add accommodation' }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(panel.getByTestId('accommodation-extra_time')).toContainText('Extra time: +50 %');
  await expect(panel.getByTestId('accommodation-staff_identity_verification')).toContainText('Identity verified by staff');

  /* ---------------- candidate: welcome, camera-only check, waiting for staff */
  const browser = await launchCamera('a');
  try {
    const c = await CandidatePage.open(browser, s.link);
    await expect(c.tid('candidate-accommodations')).toContainText('Extra time (+50 %)');
    await expect(c.tid('candidate-accommodations')).toContainText('A staff member verifies your identity instead of the automated face check');
    await expect(c.page.locator('.cand-facts')).toContainText('45m 00s'); // 30 min + 50 %
    await c.consent();
    await expect(c.tid('readiness-checklist')).toBeVisible();
    await expect(c.tid('readiness-continue')).toBeEnabled({ timeout: 60_000 });
    await c.tid('readiness-continue').click();
    await expect(c.tid('attest-step')).toHaveAttribute('data-purpose', 'initial');
    await c.tid('attest-continue').click();
    await expect(c.tid('hold-screen')).toContainText('A staff member will now verify your identity', { timeout: 30_000 });

    /* ---------------- staff: verify in the session page */
    await sp.goto(`/admin/sessions/${s.sessionId}`);
    const card = sp.getByTestId('session-accommodations');
    await expect(card).toContainText('Extra time: +50 %');
    await expect(card).toContainText('Identity verification');
    await expect(card).toContainText('By staff');
    await sp.getByRole('button', { name: 'Verify identity…' }).click();
    const verify = sp.getByRole('dialog', { name: 'Verify the candidate’s identity' });
    await expect(verify.getByTestId('verify-identity')).toBeDisabled();
    await verify.getByLabel('How did you verify their identity?').selectOption({ label: 'Video call' });
    await verify.getByLabel('Note (optional; recorded in the timeline)').fill('Student card shown on camera');
    await verify.getByRole('checkbox').check();
    await verify.getByTestId('verify-identity').click();
    await expect(verify).toHaveCount(0);
    await expect(card).toContainText('Identity verified by staff:', { timeout: 20_000 });
    await expect(card).toContainText('video call');

    /* ---------------- candidate: start, no identity pictures */
    await c.startExam();
    const d = await staff.session(s.sessionId);
    expect(d.summary.accommodations).toEqual(['extra_time', 'staff_identity_verification']);
    expect(d.accommodations!.extraTimeMs).toBe(900_000);
    expect(d.policy.identity).toMatchObject({ verification: 'staff', liveness: 'off' });
    await c.page.waitForTimeout(20_000); // longer than the start-up sampling interval
    expect(c.apiLog.filter((l) => l.includes('identity/sample'))).toEqual([]);
    expect((await staff.events(s.sessionId)).map((e) => e.type)).toEqual(expect.arrayContaining(['identity_verified_by_staff', 'accommodations_applied', 'session_started']));
    await c.submit();
  } finally {
    await browser.close();
  }
});

test('no camera: the exam runs without opening a camera', async ({ staff, browser }) => {
  const s = await staff.createSession({ durationSec: 900 });
  await staff.json<AccommodationDTO>('post', `/api/admin/candidates/${s.candidateId}/accommodations`, { kind: 'no_camera', basis: 'technical' });
  const c = await CandidatePage.open(browser, s.link);
  try {
    await expect(c.page.getByRole('heading', { name: 'Privacy notice: exam monitoring' })).toBeVisible();
    await expect(c.tid('requirements')).not.toContainText('Camera');
    await c.tid('consent-checkbox').check();
    await c.tid('consent-continue').click();
    await expect(c.tid('attest-step')).toContainText('Your exam runs without a camera.');
    await c.tid('attest-continue').click();
    await expect(c.tid('hold-screen')).toBeVisible({ timeout: 30_000 });
    await staff.json('post', `/api/admin/sessions/${s.sessionId}/release`, { verification: { method: 'in_person' } });
    await expect(c.tid('ready-screen')).toBeVisible({ timeout: 30_000 });
    await c.tid('start-exam').click();
    await expect(c.tid('exam-screen')).toBeVisible({ timeout: 30_000 });
    await expect(c.tid('monitoring-status')).toContainText('Monitoring active');
    await c.page.waitForTimeout(5_000);
    expect(await c.cameraOpens()).toEqual([]);
    expect(await c.liveCameraTracks()).toBe(0);
    const d = await staff.session(s.sessionId);
    expect(d.summary.monitoring?.label).toBe('No camera (approved arrangement)');
    await c.submit();
  } finally {
    await c.close();
  }
});
