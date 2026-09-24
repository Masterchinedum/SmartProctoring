import { readFileSync } from 'node:fs';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { expect, test } from '../lib/test';

/**
 * Scenario 10 — reconnects.
 *  - Reloading the exam page creates a new browser instance: a reconnect check (camera + identity) is
 *    required before questions are served; the exam continues where it was; the timeline shows the gap.
 *  - Opening the same link in another browser takes over after its reconnect check; the first window is
 *    told calmly that the exam continues in another window (superseded) and stops.
 */
test('reload requires a reconnect check; a second browser supersedes the first', async ({ staff }) => {
  skipUnlessFixtures('a');
  const s = await staff.createSession();
  const browser1 = await launchCamera('a');
  const browser2 = await launchCamera('a');
  try {
    // ?trace=1 records the monitoring observations for offline accuracy evaluation (downloadable JSONL).
    const c1 = await CandidatePage.open(browser1, `${s.link}?trace=1`);
    await c1.checkInAndStart();
    await c1.gotoQuestion(0);
    await c1.page.getByRole('radio', { name: 'Mean' }).check();
    await c1.gotoQuestion(2);
    await c1.tid('answer-input').fill('normal');
    await c1.page.waitForTimeout(3_000);
    await expect(c1.tid('trace-tools')).toBeVisible();
    const [download] = await Promise.all([c1.page.waitForEvent('download'), c1.tid('trace-download').click()]);
    // JSONL replayable by the detection eval harness: a meta line, then the engine's FrameObservations.
    const lines = readFileSync((await download.path())!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { $?: string; format?: string; t?: number; faces?: unknown[] });
    expect(lines[0]).toMatchObject({ $: 'meta', format: 'sp-trace/1' });
    const obs = lines.filter((l) => !l.$ && Array.isArray(l.faces));
    expect(obs.length).toBeGreaterThan(5);
    expect(obs.some((o) => o.faces!.length === 1)).toBe(true);

    /* ---------------- reload = new instance → reconnect check */
    const reloadAt = Date.now();
    await c1.page.reload();
    await expect(c1.tid('check-intro')).toHaveAttribute('data-purpose', 'reconnect', { timeout: 30_000 });
    await expect(c1.tid('check-intro')).toContainText('This exam is already in progress');
    await expect(c1.tid('exam-screen')).toHaveCount(0);
    expect(await c1.runCheck({ purpose: 'reconnect' })).toBe('passed');
    await c1.continueAfterCheck();
    await expect(c1.tid('question')).toContainText('bell-shaped');
    await expect(c1.tid('answer-input')).toHaveValue('normal');
    await expect(c1.tid('qnav-0')).toHaveClass(/answered/);
    await c1.expectMonitoringActive();

    const d = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.some((ch) => ch.trigger === 'reconnect'));
    expect(d.identityChecks.find((ch) => ch.trigger === 'reconnect')?.decision).toBe('match');
    const periods = [...d.periods].sort((a, b) => a.startedAt - b.startedAt);
    const gapIdx = periods.findIndex((p) => p.kind === 'disconnected' && p.startedAt >= reloadAt - 10_000);
    expect(gapIdx, `a gap period in ${periods.map((p) => p.kind).join(',')}`).toBeGreaterThan(0);
    expect(periods[gapIdx].observed).toBe(false);
    expect(periods[gapIdx].endedAt).not.toBeNull();
    expect(periods.slice(0, gapIdx).some((p) => p.kind === 'active')).toBe(true);
    expect(periods.slice(gapIdx + 1).some((p) => p.kind === 'active')).toBe(true);
    const timeline = await staff.timeline(s.sessionId);
    expect(timeline.some((it) => it.kind === 'period' && it.period.id === periods[gapIdx].id)).toBe(true);

    /* ---------------- the same link in a second browser */
    const c2 = await CandidatePage.open(browser2, s.link);
    await expect(c2.tid('check-intro')).toHaveAttribute('data-purpose', 'reconnect', { timeout: 30_000 });
    expect(await c2.runCheck({ purpose: 'reconnect' })).toBe('passed');
    await c2.continueAfterCheck();
    await expect(c2.tid('qnav-0')).toHaveClass(/answered/);
    await expect(c2.tid('qnav-2')).toHaveClass(/answered/);

    await expect(c1.tid('superseded-screen')).toBeVisible({ timeout: 20_000 });
    await expect(c1.tid('superseded-screen')).toContainText('This exam continues in another window');
    await expect(c1.tid('exam-screen')).toHaveCount(0);

    // The second window works normally; the session is active and in its control.
    await c2.gotoQuestion(3);
    await c2.tid('answer-input').fill('5');
    await c2.expectMonitoringActive();
    const after = await staff.waitForSession(s.sessionId, (x) => x.identityChecks.filter((ch) => ch.trigger === 'reconnect').length >= 2);
    expect(after.summary.status).toBe('active');
    expect(after.devices.filter((dv) => dv.purpose === 'reconnect').length).toBeGreaterThanOrEqual(2);
    const types = (await staff.events(s.sessionId)).map((e) => e.type);
    console.log(`event types: ${[...new Set(types)].join(', ')}`);
    await c2.submit();
  } finally {
    await browser1.close();
    await browser2.close();
  }
});
