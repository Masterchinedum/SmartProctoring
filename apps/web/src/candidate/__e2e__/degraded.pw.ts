import { expect, test } from '@playwright/test';
import { acceptConsent, AdminApi, launchWithCamera, openCandidate, y4m } from './helpers';

/**
 * If the in-browser vision models cannot load, the candidate can still complete the (server-verified)
 * check and take the exam; monitoring is reported as degraded rather than failing the exam.
 */
test('vision models unavailable: exam continues, monitoring_degraded is reported', async () => {
  const video = y4m('obama', '/tmp/claude-0/candidate-agent/obama-cam.y4m');
  const admin = await AdminApi.login();
  const { path, sessionId } = await admin.createSession({
    policy: { identity: { liveness: 'off', idPhotoComparison: 'off' }, browser: { requireFullscreen: false } },
  });
  const browser = await launchWithCamera(video);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
    await context.routeWebSocket((url) => url.searchParams.has('token'), () => undefined);
    await context.route(/\/models\/.*\.(task|tflite)$/, (route) => route.fulfill({ status: 404, body: 'not found' }));
    const page = await context.newPage();
    const base = new URL(path, (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SP_BASE_URL ?? 'http://localhost:5174');
    await page.goto(base.toString());

    await acceptConsent(page);
    await expect(page.getByText('The automatic camera check could not start in this browser')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('readiness-continue').click();
    await expect(page.getByTestId('verify-step')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Automatic guidance is unavailable in this browser')).toBeVisible();
    await expect(page.getByTestId('ready-screen')).toBeVisible({ timeout: 90_000 });
    await page.getByTestId('start-exam').click();
    await expect(page.getByTestId('exam-screen')).toBeVisible();
    await expect(page.getByTestId('monitoring-status')).toContainText('Monitoring limited', { timeout: 20_000 });
    await page.getByRole('radio', { name: 'Mean' }).check();
    await page.waitForTimeout(3000);

    const ev = (await admin.events(sessionId)).find((e) => e.type === 'monitoring_degraded');
    expect(ev, 'monitoring_degraded event').toBeTruthy();
    expect(ev!.category).toBe('technical');
    expect(JSON.stringify(ev!.details)).toContain('face model');
    const detail = await admin.sessionDetail(sessionId);
    expect(detail.summary.status).toBe('active');
    expect(detail.summary.monitoring?.state).toBe('degraded');
  } finally {
    await browser.close();
    await admin.dispose();
  }
});
