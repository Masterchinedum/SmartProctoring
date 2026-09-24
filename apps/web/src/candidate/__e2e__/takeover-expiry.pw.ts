import { expect, test } from '@playwright/test';
import { acceptConsent, AdminApi, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * - Opening the exam in a second browser window takes over after the reconnect check; the first
 *   window is told calmly that the exam continues elsewhere (superseded).
 * - `?trace=1` offers a JSONL download of the recorded observations (accuracy evaluation data).
 * - When the exam clock runs out, the server submits automatically and the candidate sees why.
 */
test('second window takes over; trace download; time expiry submits automatically', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const admin = await AdminApi.login();
  const { path } = await admin.createSession({
    policy: { identity: { liveness: 'off', idPhotoComparison: 'off' }, browser: { requireFullscreen: false } },
    durationSec: 90,
  });
  const browser = await launchWithCamera(video);
  try {
    /* ---------------- first window, with trace recording */
    const first = await openCandidate(browser, `${path}?trace=1`);
    await acceptConsent(first.page);
    expect(await runCheck(first.page)).toBe('ready');
    await first.page.getByTestId('start-exam').click();
    await expect(first.page.getByTestId('exam-screen')).toBeVisible();
    await first.page.getByRole('radio', { name: 'Mean' }).check();
    await expect(first.page.getByTestId('trace-tools')).toBeVisible();
    await first.page.waitForTimeout(4000);
    const [download] = await Promise.all([first.page.waitForEvent('download'), first.page.getByTestId('trace-download').click()]);
    const lines = (await (await download.createReadStream()).toArray()).join('').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; obs?: { faces: unknown[]; frame: unknown } });
    expect(lines[0]).toMatchObject({ kind: 'meta', format: 'sp-trace/1' });
    const obs = lines.filter((l) => l.kind === 'obs');
    expect(obs.length).toBeGreaterThan(5);
    expect(obs.some((o) => (o.obs?.faces.length ?? 0) === 1 && o.obs?.frame)).toBe(true);

    /* ---------------- second window takes over */
    const second = await openCandidate(browser, path);
    expect(await runCheck(second.page, { introPurpose: 'reconnect' })).toBe('passed');
    await second.page.getByTestId('check-continue').click();
    await expect(second.page.getByTestId('exam-screen')).toBeVisible();
    await expect(first.page.getByTestId('superseded-screen')).toBeVisible({ timeout: 20_000 });
    await expect(first.page.getByTestId('superseded-screen')).toContainText('continues in another window');
    // The answer given in the first window is there in the second.
    await expect(second.page.getByTestId('qnav-0')).toHaveClass(/answered/);

    /* ---------------- time runs out */
    await second.page.getByTestId('qnav-3').click();
    await second.page.getByTestId('answer-input').fill('5');
    await expect(second.page.getByTestId('ended-screen')).toBeVisible({ timeout: 120_000 });
    await expect(second.page.getByTestId('ended-screen')).toContainText('time ran out');
  } finally {
    await browser.close();
    await admin.dispose();
  }
});
