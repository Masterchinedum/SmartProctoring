import { TRACK_CAMERA_STREAMS } from '../lib/candidate';
import { BASE_URL } from '../lib/config';
import { SWAP_AT_SEC, SWAP_DONE_SEC } from '../lib/realistic';
import { launchRw, recordMetric, reps, secs, skipUnlessRw } from '../lib/realistic-run';
import { expect, test } from '../lib/test';

/**
 * Scenario 24 — the staff "Camera & identity test" page (/admin/tools/camera-test) end to end with a realistic
 * webcam: the camera shows candidate A (typical light, 1280×720) and, from 35 s, person B sits down (rwSwapGap).
 * Staff enrol A, start the live comparison (probe bursts every ~1.5 s): A must read as consistent; after B sits
 * down the evidence must reach "suspect" and "confirmed" (a different person). States and timings are recorded.
 */
for (const rep of reps()) {
  test(`realistic staff camera test: enrol A, probe A then B #${rep}`, async ({ staff }, testInfo) => {
    skipUnlessRw('rwSwapGap');
    test.setTimeout(4 * 60_000);
    const browser = await launchRw('rwSwapGap');
    try {
      const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1400, height: 1000 }, permissions: ['camera'], storageState: await staff.storageState() });
      await ctx.addInitScript(TRACK_CAMERA_STREAMS);
      const page = await ctx.newPage();
      const tid = (id: string) => page.getByTestId(id);
      await page.goto('/admin/tools/camera-test');
      await expect(tid('camera-test-camera')).toContainText('×', { timeout: 30_000 });
      await expect(tid('camera-test-camera')).toContainText(/faces in view: 1/, { timeout: 30_000 });
      const cameraText = (await tid('camera-test-camera').innerText()).replace(/\s+/g, ' ');
      const camAt = await page.evaluate(() => {
        const o = (window as unknown as { __spCamOpens?: { at: number }[] }).__spCamOpens ?? [];
        return o.length ? o[o.length - 1]!.at : null;
      });
      expect(camAt).not.toBeNull();
      const camSec = () => (Date.now() - camAt!) / 1000;

      /* ---------------- enrol A */
      await tid('camera-test-enrol').click();
      await expect(tid('camera-test-message')).toContainText(/Enrolled \d+ of \d+ frames|No frame was usable/, { timeout: 60_000 });
      const enrolMessage = await tid('camera-test-message').innerText();
      const enrolledAtSec = camSec();
      expect(enrolMessage).toMatch(/Enrolled [1-9]\d* of/);
      expect(enrolledAtSec, 'enrolment finished while A is in view').toBeLessThan(SWAP_AT_SEC - 5);

      /* ---------------- live comparison: A, then B */
      await tid('camera-test-probe').click();
      const states: { sec: number; state: string | null; similarity: string }[] = [];
      let last = '';
      const deadline = SWAP_DONE_SEC.gap + 40;
      while (camSec() < deadline) {
        const state = await tid('camera-test-evidence').getAttribute('data-state', { timeout: 500 }).catch(() => null);
        const similarity = (await tid('camera-test-similarity').innerText({ timeout: 500 }).catch(() => '')).trim();
        if (`${state}|${similarity}` !== last) states.push({ sec: Math.round(camSec() * 10) / 10, state, similarity });
        last = `${state}|${similarity}`;
        if (camSec() > SWAP_DONE_SEC.gap && state === 'confirmed_mismatch') break;
        await page.waitForTimeout(400);
      }
      await tid('camera-test-probe').click(); // stop
      const beforeSwap = states.filter((x) => x.sec < SWAP_AT_SEC);
      const afterSwap = states.filter((x) => x.sec >= SWAP_DONE_SEC.gap);
      const firstAfter = (st: string) => afterSwap.find((x) => x.state === st)?.sec ?? null;
      const aStates = [...new Set(beforeSwap.map((x) => x.state).filter(Boolean))];
      const bStates = [...new Set(afterSwap.map((x) => x.state).filter(Boolean))];
      const suspectAt = firstAfter('suspect');
      const confirmedAt = firstAfter('confirmed_mismatch');
      recordMetric(testInfo, {
        scenario: 'camera-test',
        case: 'enrol A, probe A then B (rwSwapGap)',
        rep,
        pass: aStates.length > 0 && aStates.every((s) => s === 'consistent' || s === 'monitoring') && confirmedAt != null,
        camera: cameraText,
        enrolMessage,
        enrolledAtS: secs(enrolledAtSec * 1000),
        statesWithA: aStates,
        statesWithB: bStates,
        suspectAfterS: suspectAt != null ? Math.round((suspectAt - SWAP_DONE_SEC.gap) * 10) / 10 : null,
        confirmedAfterS: confirmedAt != null ? Math.round((confirmedAt - SWAP_DONE_SEC.gap) * 10) / 10 : null,
        trace: states.slice(0, 80),
      });
      expect(aStates.length, 'probes of A produced an evidence state').toBeGreaterThan(0);
      expect(aStates.every((s) => s === 'consistent' || s === 'monitoring'), `A reads as the enrolled person: ${JSON.stringify(beforeSwap)}`).toBe(true);
      expect(confirmedAt, `B is confirmed as a different person: ${JSON.stringify(afterSwap)}`).not.toBeNull();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });
}
