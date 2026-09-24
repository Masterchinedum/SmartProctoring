import { expect, test } from '@playwright/test';
import { acceptConsent, AdminApi, launchWithCamera, openCandidate, runCheck, y4m } from './helpers';

/**
 * Resuming from a different position/room is NOT a violation: after the resume check the same person
 * matches the reference, and the difference is recorded only as neutral context (environment_changed).
 * Fake camera: the candidate for 45 s, then the same candidate smaller and further left (moved seat).
 * A second tab keeps the camera device open so the video keeps playing across the pause.
 */
test('resume from a different position records neutral context only', async () => {
  const video = y4m('env', '/tmp/claude-0/candidate-agent/env.y4m');
  const admin = await AdminApi.login();
  const { path, sessionId } = await admin.createSession({
    policy: { identity: { liveness: 'off', idPhotoComparison: 'off' }, browser: { requireFullscreen: false } },
  });
  const browser = await launchWithCamera(video);
  const t0 = Date.now();
  try {
    const { context, page } = await openCandidate(browser, path);
    const holder = await context.newPage();
    await holder.goto('/mediapipe/vision_wasm_internal.js');
    await holder.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      (window as unknown as { __hold: MediaStream }).__hold = s;
    });
    await page.bringToFront();

    await acceptConsent(page);
    expect(await runCheck(page)).toBe('ready');
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await page.getByRole('radio', { name: 'Mean' }).check();
    await page.waitForTimeout(3000);
    await page.getByTestId('pause-button').click();
    await page.getByTestId('pause-confirm').click();
    await expect(page.getByTestId('paused-screen')).toBeVisible({ timeout: 20_000 });
    expect((Date.now() - t0) / 1000).toBeLessThan(40);

    // Close the exam tab; come back after the "move" in the video.
    await page.close();
    await holder.waitForTimeout(Math.max(0, 52_000 - (Date.now() - t0)));
    const again = await context.newPage();
    await again.goto(path);
    await again.getByTestId('resume-button').click();
    expect(await runCheck(again, { introPurpose: 'resume' })).toBe('passed');
    await again.getByTestId('check-continue').click();
    await expect(again.getByTestId('exam-screen')).toBeVisible();
    await expect(again.getByTestId('qnav-0')).toHaveClass(/answered/);
    await again.waitForTimeout(4000);

    const detail = await admin.sessionDetail(sessionId);
    expect(detail.identityChecks.some((c) => c.trigger === 'resume' && c.decision === 'match')).toBe(true);
    const events = await admin.events(sessionId);
    const env = events.find((e) => e.type === 'environment_changed');
    expect(env, 'environment_changed event').toBeTruthy();
    expect(env!.category).toBe('neutral');
    expect(env!.observation).toMatch(/position|background/i);
    expect(events.some((e) => e.type === 'identity_mismatch')).toBe(false);
  } finally {
    await browser.close();
    await admin.dispose();
  }
});
