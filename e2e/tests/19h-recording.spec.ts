import type { AuditLogEntryDTO, Paged } from '../../packages/shared/src/api';
import type { SessionRecordingDTO } from '../../packages/shared/src/recording';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 19h — recording of the whole exam (policy.recording; webcam, microphone and screen), Chromium only:
 *
 * the recording notice before consent → system check (recording, screen sharing) → microphone item on the camera
 * check → "Share your screen" before the start (Start disabled until shared; Chromium shares the entire screen by
 * itself with --auto-select-desktop-capture-source) → recording runs ("Recording" in the header) → segments arrive
 * (staff API: camera and screen parts with plausible durations and sizes) → sharing stopped mid-exam (the track is
 * stopped as the browser's "Stop sharing" would) → the exam is covered and screen_share_stopped is recorded → shared
 * again (the span closes) → submit while uploads are held back: the end screen says the recording is still uploading
 * → released: uploaded → staff Recording tab: both players load a part (readyState ≥ 2), Watch on the event seeks
 * there, each part opened is audit-logged.
 *
 * Headless Chromium here reports the shared surface as `monitor`; if a build reported nothing, the app accepts the
 * share as "unknown" (the candidate is reminded to share the entire screen) — the test logs which it was.
 */
test('exam recording: share the screen, record, stop and share again, upload after submit, staff playback', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  test.setTimeout(8 * 60_000);
  const s = await staff.createSession({ policy: { recording: { enabled: true } } });
  const browser = await launchCamera('a', { screenCapture: true });
  try {
    const c = await CandidatePage.open(browser, s.link);
    const { page } = c;

    /* ---------------- before consent: what is recorded, kept how long, who can watch */
    await expect(c.tid('recording-notice')).toContainText('This exam is recorded.');
    await expect(c.tid('recording-notice')).toContainText('your webcam video, the sound from your microphone and your entire screen are recorded');
    await expect(page.getByText(/The whole exam is recorded: your webcam video, the sound from your microphone and your entire screen/).first()).toBeVisible();
    await expect(page.getByText(/Screenshots, identity data and the recording of your exam are deleted \d+ days after your/)).toBeVisible();
    await expect(c.tid('requirements')).toContainText('Recording supported');
    await expect(c.tid('requirements')).toContainText('Screen sharing supported');
    await expect(c.tid('consent-checkbox').locator('xpath=..')).toContainText('the recording of my exam');
    await c.consent();

    /* ---------------- camera check with the microphone item (the fake microphone beeps) */
    await expect(c.tid('readiness-checklist')).toBeVisible({ timeout: 30_000 });
    const micItem = page.locator('[data-testid="mic-check"] [data-item="microphone"]');
    await expect(micItem).toBeVisible();
    await expect(micItem).toHaveAttribute('data-state', /listening|ok|quiet|starting/);
    expect(await c.runCheck()).toBe('ready');

    /* ---------------- share the screen before the start */
    await expect(c.tid('screen-share-step')).toBeVisible();
    await expect(c.tid('ready-recording-note')).toContainText('The exam is recorded from the start to the end');
    await expect(c.tid('start-exam')).toBeDisabled();
    await c.tid('screen-share-button').click();
    await expect(c.tid('screen-share-status')).toBeVisible({ timeout: 15_000 });
    const surface = await page.evaluate(() => {
      const t = (window as unknown as { __spScreenTracks: MediaStreamTrack[] }).__spScreenTracks.at(-1);
      return (t?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface ?? 'unknown';
    });
    console.log(`[19h] shared surface reported by the browser: ${surface}`);
    await c.startExam();
    await expect(c.tid('recording-status')).toBeVisible();
    await c.answerStandardQuestions();

    /* ---------------- segments arrive: a camera and a screen part, about 30 s each */
    const recordings = () => staff.json<SessionRecordingDTO>('get', `/api/admin/sessions/${s.sessionId}/recordings`);
    await expect
      .poll(async () => {
        const r = await recordings();
        return r.streams.camera.segments >= 1 && r.streams.screen.segments >= 1;
      }, { timeout: 90_000, intervals: [2000], message: 'a camera and a screen segment were uploaded' })
      .toBe(true);
    const first = await recordings();
    for (const seg of first.segments) {
      expect(seg.durationMs, `${seg.stream} ${seg.seq} duration`).toBeGreaterThan(20_000);
      expect(seg.durationMs, `${seg.stream} ${seg.seq} duration`).toBeLessThan(45_000);
      expect(seg.byteSize, `${seg.stream} ${seg.seq} size`).toBeGreaterThan(5_000);
      expect(seg.byteSize, `${seg.stream} ${seg.seq} size`).toBeLessThan(4_000_000);
      expect(seg.mimeType).toMatch(/^video\/(webm|mp4)/);
      expect(seg.available).toBe(true);
    }
    expect(first.segments.find((x) => x.stream === 'camera')!.mimeType).toMatch(/opus/);

    /* ---------------- sharing stops mid-exam: covered, recorded, shared again */
    await page.evaluate(() => (window as unknown as { __spScreenTracks: MediaStreamTrack[] }).__spScreenTracks.forEach((t) => t.stop()));
    await expect(c.tid('screen-share-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(c.tid('screen-share-overlay')).toContainText('Share your screen again to continue');
    const opened = await staff.waitForEvent(s.sessionId, (e) => e.type === 'screen_share_stopped', { message: 'screen_share_stopped recorded' });
    expect(opened).toMatchObject({ category: 'integrity', severity: 'low' });
    await page.waitForTimeout(2000);
    await c.tid('screen-share-again').click();
    await expect(c.tid('screen-share-overlay')).toBeHidden({ timeout: 15_000 });
    const closed = await staff.waitForEvent(s.sessionId, (e) => e.type === 'screen_share_stopped' && e.endedAt != null, { message: 'screen_share_stopped closed' });
    expect(closed.endedAt! - closed.startedAt).toBeGreaterThanOrEqual(1500);

    /* ---------------- submit while uploads are held back: the end screen waits for them */
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/candidate/recordings/segments**', async (route) => {
      await held;
      await route.continue();
    });
    await c.submit();
    await expect(c.tid('recording-uploading')).toBeVisible({ timeout: 15_000 });
    await expect(c.tid('recording-uploading')).toContainText('Uploading the recording… do not close this page.');
    release();
    await expect(c.tid('recording-uploaded')).toBeVisible({ timeout: 60_000 });
    await page.unroute('**/api/candidate/recordings/segments**');
    const final = await recordings();
    expect(final.streams.camera.segments).toBeGreaterThan(first.streams.camera.segments);
    expect(final.streams.screen.segments).toBeGreaterThanOrEqual(2); // before and after sharing again
    // Stopping the share is a screen_share_stopped span, not a recording failure.
    expect((await staff.events(s.sessionId)).filter((e) => e.type === 'recording_interrupted').map((e) => e.details)).toEqual([]);
    const report = await staff.report(s.sessionId);
    expect(report.recording).toMatchObject({ segments: final.segments.length, available: final.segments.length });
    expect(report.observations.join(' ')).toMatch(/The exam was recorded: .* of webcam video and .* of the screen/);

    /* ---------------- staff: the Recording tab plays both streams; Watch seeks to an event */
    const sp = await staffPage();
    await sp.goto(`/admin/sessions/${s.sessionId}?tab=recording`);
    await expect(sp.getByTestId('recording-tab')).toBeVisible();
    await expect(sp.getByTestId('session-recording')).toContainText('of webcam');
    for (const id of ['rec-camera', 'rec-screen']) {
      await expect.poll(() => sp.locator(`[data-testid="${id}"] video`).evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000, message: `${id} loaded a part` }).toBeGreaterThanOrEqual(2);
    }
    await expect(sp.getByTestId('rec-marker').first()).toBeVisible();
    await sp.getByTestId('rec-play').click();
    await expect.poll(() => sp.getByTestId('rec-clock').getAttribute('data-clock').then(Number), { timeout: 10_000, message: 'the shared clock runs' }).toBeGreaterThan(final.segments[0].startedAt + 1000);
    await sp.getByTestId('rec-play').click(); // pause

    await sp.goto(`/admin/sessions/${s.sessionId}?tab=timeline`);
    const row = sp.locator('li.tl-event', { hasText: 'Screen sharing stopped' });
    await row.getByTestId('watch-recording').click();
    await expect(sp).toHaveURL(/tab=recording/);
    await expect(sp.getByTestId('recording-tab')).toBeVisible();
    const clock = Number(await sp.getByTestId('rec-clock').getAttribute('data-clock'));
    expect(Math.abs(clock - (closed.startedAt - 10_000))).toBeLessThan(2000);

    /* ---------------- every part opened is in the audit log */
    const audit = await staff.json<Paged<AuditLogEntryDTO>>('get', `/api/admin/audit-log?action=recording.view&targetId=${s.sessionId}`);
    expect(audit.items.length).toBeGreaterThanOrEqual(2);
    expect(audit.items[0]).toMatchObject({ action: 'recording.view', targetType: 'session', targetId: s.sessionId });
  } finally {
    await browser.close();
  }
});
