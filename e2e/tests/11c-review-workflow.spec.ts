import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eventDrawer } from '../lib/admin';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { faceImage } from '../lib/config';
import { StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';
import type { EventDTO, SessionDetailDTO } from '../../packages/shared/src/api';

/**
 * Scenario 11c — the reviewer workflow. A candidate takes the exam (fake camera); flags are reported at known times
 * through the candidate API (as the browser's detectors would), forming two incidents and a separate flag.
 *  - A reviewer finds the exam in the review queue, assigns it to themselves, decides one incident together
 *    (phone + looking away + tab switch), the technical / low-severity flags in bulk, and the last flag in the event
 *    drawer after reading why it was recorded and comparing with the start of the exam; then escalates.
 *  - The owner disagrees with one decision (a reason is required; the history shows the disagreement), resolves
 *    the escalated review, and the outcome reaches the timeline, the report, the Quality page's reviewer agreement
 *    and the audit-log CSV.
 */
test('review queue, incidents, bulk and individual decisions, escalation, disagreement and the outcome', async ({ staff, staffPage, browser }) => {
  skipUnlessFixtures('a');
  test.setTimeout(6 * 60_000);
  // Camera-integrity checks off: Chrome's fake camera would otherwise be (correctly) flagged as a virtual camera.
  const s = await staff.createSession({ policy: { detection: { enabled: { cameraIntegrity: false } } } });
  const cam = await launchCamera('a');
  const reviewerUser = await staff.createUser('reviewer');
  const reviewerApi = await StaffApi.login(reviewerUser.email, reviewerUser.password);
  try {
    /* ---------------- the candidate takes the exam; flags at known times */
    const c = await CandidatePage.open(cam, s.link);
    await c.checkInAndStart();
    // The verified browser's credentials, from a heartbeat sent while the exam runs.
    const hb = await c.page.waitForRequest((r) => r.url().includes('/api/candidate/heartbeat') && !!r.headers()['x-client-instance'], { timeout: 30_000 });
    // Same browser identity (User-Agent too): a different one would rightly be treated as a second device.
    const auth = { authorization: hb.headers()['authorization'], 'x-client-instance': hb.headers()['x-client-instance'], 'user-agent': hb.headers()['user-agent'] };
    const startedAt = (await staff.json<SessionDetailDTO>('get', `/api/admin/sessions/${s.sessionId}`)).summary.startedAt!;
    // Wait until all the planned flags lie in the past (they must be within the exam).
    await new Promise((r) => setTimeout(r, Math.max(0, startedAt + 122_000 - Date.now())));
    const at = (sec: number) => startedAt + sec * 1000;
    const report = async (type: string, from: number, to: number, details: Record<string, unknown> = {}) => {
      const id = randomUUID();
      const res = await staff.api.post('/api/candidate/events/batch', {
        headers: auth,
        data: { events: [{ id, type, phase: 'close', startedAt: at(from), endedAt: at(to), confidence: 0.85, details, version: 1 }] },
      });
      expect(res.ok(), await res.text()).toBe(true);
      expect((await res.json()).results[0].result).toBe('created');
      return id;
    };
    // Incident A: phone, then looking away, then a tab switch, each within seconds of the last.
    const phone = await report('phone_detected', 10, 14, { label: 'cell phone', maxScore: 0.81, meanScore: 0.74, detections: 9, detectorRuns: 12 });
    const away = await report('looking_away', 16, 24, { durationSec: 8, direction: 'down', maxYawOffsetDeg: 12, maxPitchOffsetDeg: 31 });
    const tab = await report('tab_hidden', 28, 33);
    // Incident B, more than 30 s later: a frozen camera and a short unfocus (technical / low severity: decided in bulk).
    const frozen = await report('camera_frozen', 70, 76, { durationSec: 6 });
    const unfocus = await report('window_unfocused', 77, 80);
    // A separate flag, more than 30 s later again, decided on its own.
    const object = await report('unauthorized_object', 115, 119, { label: 'book', maxScore: 0.66, meanScore: 0.63, detections: 4, detectorRuns: 8 });
    // Its screenshot, uploaded as the browser does.
    const shot = await staff.api.put(`/api/candidate/evidence/${randomUUID()}?eventId=${object}&capturedAt=${at(116)}&reason=onset`, {
      headers: { ...auth, 'content-type': 'image/jpeg' },
      data: readFileSync(faceImage('obama.jpg')),
    });
    expect(shot.ok(), await shot.text()).toBe(true);
    await c.answerStandardQuestions();
    await c.submit();
    const scripted: string[] = [phone, away, tab, frozen, unfocus, object];

    /* ---------------- reviewer: the queue, assignment */
    const ctx = await browser.newContext({ storageState: await reviewerApi.storageState(), viewport: { width: 1400, height: 1000 } });
    const rp = await ctx.newPage();
    await rp.goto('/admin/review');
    await expect(rp.getByRole('heading', { name: 'Review queue', level: 1 })).toBeVisible();
    const row = rp.getByTestId('queue-row').filter({ hasText: s.candidateName });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('review-due')).toContainText(/Flag decisions due in/);
    await row.getByRole('button', { name: 'Assign to me' }).click();
    await rp.getByRole('tab', { name: /Assigned to me/ }).click();
    await expect(rp.getByTestId('queue-row').filter({ hasText: s.candidateName })).toContainText('E2E reviewer');
    await rp.getByRole('link', { name: s.candidateName }).click();
    await expect(rp.getByRole('tab', { name: /Review/, selected: true })).toBeVisible();

    /* ---------------- incident A decided together */
    const review = rp.getByTestId('review-tab');
    await expect(rp.getByTestId('session-review')).toContainText('Assigned to E2E reviewer');
    const incidentA = review.getByTestId('incident').filter({ hasText: 'Phone visible' });
    await expect(incidentA).toContainText('Sustained looking away');
    await expect(incidentA).toContainText('Left the exam tab');
    await expect(incidentA).not.toContainText('Camera image frozen');
    await expect(incidentA).toContainText(/\d+ undecided/);
    await incidentA.getByTestId('incident-resolution').selectOption('no_concern');
    await incidentA.getByLabel('Note').fill('Calculator app on the phone, permitted for this exam.');
    await incidentA.getByTestId('incident-decide').click();
    await expect(incidentA).toContainText('All decided');
    await expect(incidentA).toContainText('Accurate, no concern');
    for (const id of [phone, away, tab]) expect((await staff.json<EventDTO>('get', `/api/admin/events/${id}`)).review).toMatchObject({ status: 'reviewed', resolution: 'no_concern' });

    /* ---------------- technical / low-severity flags in bulk */
    const bulk = rp.getByTestId('bulk-decision');
    await bulk.getByTestId('bulk-resolution').selectOption('technical');
    await bulk.getByLabel('Note').fill('Old laptop camera, intermittent.');
    await bulk.getByTestId('bulk-decide').click();
    await expect(bulk.getByRole('status')).toContainText(/\d+ decided/);
    for (const id of [frozen, unfocus]) expect((await staff.json<EventDTO>('get', `/api/admin/events/${id}`)).review).toMatchObject({ status: 'reviewed', resolution: 'technical' });

    /* ---------------- the separate flag, in the drawer: why it was recorded, compare with the start */
    await rp.goto(`/admin/sessions/${s.sessionId}?tab=review&event=${object}`);
    const drawer = eventDrawer(rp);
    await expect(drawer.getByTestId('explanation')).toContainText('Recorded when the object detector finds a book with a score of at least');
    await expect(drawer.getByTestId('explanation')).toContainText('Seen in 4 of 8 detector runs (50 %).');
    await drawer.getByTestId('baseline-compare').click();
    await expect(drawer.locator('.baseline-compare .baseline-side')).toHaveCount(2);
    await expect(drawer.locator('.baseline-compare')).toContainText('At check-in');
    await drawer.getByLabel(/^Accurate, no concern/).check();
    await drawer.getByLabel('Note (optional)').fill('A closed textbook on the shelf behind.');
    await drawer.getByTestId('record-decision').click();
    await expect(drawer.locator('.review-panel')).toContainText('Accurate, no concern');
    await drawer.getByRole('button', { name: 'Close' }).click();

    // Anything the live detectors reported on their own (e.g. Chrome's fake camera is a "virtual camera") is decided too.
    const undecided = (await staff.json<{ items: EventDTO[] }>('get', `/api/admin/sessions/${s.sessionId}/events`)).items.filter(
      (e) => ['integrity', 'uncertain', 'technical'].includes(e.category) && e.review.status === 'unreviewed' && !scripted.includes(e.id),
    );
    for (const e of undecided) await reviewerApi.json('post', `/api/admin/events/${e.id}/review`, { resolution: 'inconclusive', note: 'Live detector during the E2E run.' });
    await rp.reload();
    await expect(rp.getByTestId('session-review')).toContainText('Every flag is decided.');

    /* ---------------- escalate: an administrator resolves it */
    await rp.getByRole('button', { name: 'Escalate…' }).click();
    const dlg = rp.getByRole('dialog', { name: 'Escalate the review' });
    await dlg.getByLabel('Reason').fill('Phone at the desk during the exam: please confirm the calculator exception.');
    await dlg.getByRole('button', { name: 'Escalate' }).click();
    await expect(rp.getByTestId('review-escalation')).toContainText('please confirm the calculator exception');
    await expect(rp.getByTestId('resolve-blocker')).toContainText('an administrator resolves it');
    await ctx.close();

    /* ---------------- owner: disagrees with one decision (reason required), resolves */
    const op = await staffPage();
    await op.goto('/admin/review?view=escalated');
    await expect(op.getByTestId('queue-row').filter({ hasText: s.candidateName })).toBeVisible();
    await op.goto(`/admin/sessions/${s.sessionId}?tab=review&event=${phone}`);
    const od = eventDrawer(op);
    await expect(od.getByTestId('explanation')).toContainText('Highest detector score 0.81');
    await od.getByLabel(/^Integrity concern/).check();
    await expect(od.getByTestId('record-decision')).toBeDisabled();
    await od.getByLabel(/Reason for changing E2E reviewer’s decision/).fill('Phones are not covered by the calculator exception.');
    await od.getByTestId('record-decision').click();
    await expect(od.getByTestId('decision-history')).toContainText('Changed another reviewer’s decision');
    await od.getByRole('button', { name: 'Close' }).click();

    await op.getByLabel(/^No integrity concerns/).check();
    await op.getByTestId('resolve-submit').click();
    await expect(op.getByTestId('review-outcome')).toContainText('No integrity concerns');

    // Timeline, report, Quality page, audit CSV.
    await op.getByRole('tab', { name: 'Timeline' }).click();
    await expect(op.locator('.tab-panel')).toContainText('Review completed');
    await op.goto(`/admin/sessions/${s.sessionId}/report`);
    await expect(op.getByTestId('report-review')).toContainText('No integrity concerns');
    await expect(op.getByTestId('report-review')).toContainText('Incidents (');
    await op.goto('/admin/quality');
    await expect(op.getByTestId('reviewer-agreement')).toContainText(/[1-9]\d* changed another reviewer’s decision/);
    await op.goto('/admin/audit');
    await op.getByLabel('Action').fill('review.');
    await expect(op.getByTestId('audit-export')).toContainText('(filtered)');
    const [download] = await Promise.all([op.waitForEvent('download'), op.getByTestId('audit-export').click()]);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv).toContain('review.escalated');
    expect(csv).toContain('review.resolved');
    expect(csv).toContain(s.sessionId);
  } finally {
    await reviewerApi.dispose();
    await cam.close();
  }
});
