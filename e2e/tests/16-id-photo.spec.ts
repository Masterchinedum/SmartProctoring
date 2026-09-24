import type { Browser, Page } from '@playwright/test';
import { CandidatePage, launchCamera, skipUnlessFixtures } from '../lib/candidate';
import { idPhotoAvailable, idPhotoPath, stillPath, type IdPhotoName } from '../lib/fixtures';
import type { SessionHandle, StaffApi } from '../lib/staff-api';
import { expect, test } from '../lib/test';

/**
 * Scenario 16 — approved ID photo (uploaded by staff on the candidate page) compared with the live
 * candidate at check-in, with the exam policy `identity.idPhotoComparison` = 'advisory' or 'required'.
 * Camera: candidate A. ID photos (derived at runtime into e2e/.fixtures/id-photos):
 *   id-a.jpg       — A on another photo (same person)            -> match
 *   id-other.jpg   — someone else                                -> mismatch
 *   id-a-poor.jpg  — A as a tiny, heavily compressed thumbnail   -> inconclusive (unable to compare dependably)
 * Expected: advisory never stops the candidate (a mismatch is an `identity_mismatch` event against the ID photo,
 * the exam continues); required holds on a mismatch (`id_photo_mismatch`) and — distinctly, never as a
 * mismatch — on an inconclusive comparison (`id_photo_unverifiable`). Staff compare the ID photo with the
 * check-in image in the comparison view.
 */

function skipUnlessIdPhotos(...names: IdPhotoName[]): void {
  const missing = names.filter((n) => !idPhotoAvailable(n));
  test.skip(missing.length > 0, `face images for ID photo(s) ${missing.join(', ')} not found (set E2E_FACES_DIR)`);
}

/** Candidate page → "Approved ID photo" → upload a file through the page's own file input (converted to JPEG in the browser). */
async function uploadInUi(sp: Page, candidateId: string, file: string): Promise<void> {
  await sp.goto(`/admin/candidates/${candidateId}`);
  const panel = sp.locator('section', { has: sp.getByRole('heading', { name: 'Approved ID photo' }) });
  await expect(panel).toBeVisible();
  await panel.locator('input[type="file"]').setInputFiles(file);
  await expect(panel.locator('.banner')).toContainText(/Photo accepted|Photo not accepted/, { timeout: 30_000 });
}

async function expectPhotoOnFile(sp: Page, staff: StaffApi, candidateId: string): Promise<void> {
  const panel = sp.locator('section', { has: sp.getByRole('heading', { name: 'Approved ID photo' }) });
  await expect(panel.locator('.banner-success')).toContainText('Photo accepted.');
  const img = panel.getByRole('img', { name: /^ID photo of / });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  await expect(panel).toContainText('Approved ');
  const cand = await staff.json<{ idPhoto: { evidenceId: string } | null }>('get', `/api/admin/candidates/${candidateId}`);
  expect(cand.idPhoto?.evidenceId, 'ID photo stored').toBeTruthy();
}

/** A candidate of `exam` with an ID photo uploaded in the staff UI. */
async function candidateWithPhoto(staff: StaffApi, sp: Page, exam: Awaited<ReturnType<StaffApi['createExam']>>, photo: IdPhotoName, label: string): Promise<SessionHandle> {
  const cand = await staff.createCandidate(`${label} ${Date.now().toString(36)}`);
  await uploadInUi(sp, cand.id, idPhotoPath(photo));
  await expectPhotoOnFile(sp, staff, cand.id);
  return staff.assign(exam, cand);
}

async function checkIn(browser: Browser, s: SessionHandle): Promise<{ c: CandidatePage; outcome: string }> {
  const c = await CandidatePage.open(browser, s.link);
  await c.consent();
  const outcome = await c.runCheck();
  return { c, outcome };
}

test('advisory: same person matches, a different person is flagged against the ID photo and the exam continues', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  skipUnlessIdPhotos('id-a.jpg', 'id-other.jpg');
  test.setTimeout(5 * 60_000);
  const exam = await staff.createExam({ policy: { identity: { liveness: 'off', idPhotoComparison: 'advisory', periodicCheckIntervalSec: 30 }, browser: { requireFullscreen: false } } });
  const sp = await staffPage();

  /* ---------------- staff UI: an unsuitable photo is refused with guidance, nothing is stored */
  const probe = await staff.createCandidate(`IdPhoto refused ${Date.now().toString(36)}`);
  await uploadInUi(sp, probe.id, stillPath('room.jpg'));
  const panel = sp.locator('section', { has: sp.getByRole('heading', { name: 'Approved ID photo' }) });
  await expect(panel.locator('.banner-warning')).toContainText('Photo not accepted');
  await expect(panel.locator('.banner-warning')).toContainText('No face was found in the photo.');
  await expect(panel).toContainText('No ID photo on file.');
  expect((await staff.json<{ idPhoto: unknown }>('get', `/api/admin/candidates/${probe.id}`)).idPhoto).toBeNull();

  const same = await candidateWithPhoto(staff, sp, exam, 'id-a.jpg', 'IdPhoto same');
  const other = await candidateWithPhoto(staff, sp, exam, 'id-other.jpg', 'IdPhoto other');

  const browser = await launchCamera('a');
  try {
    /* ---------------- same person: match, no identity event */
    const a = await checkIn(browser, same);
    expect(a.outcome, 'same person passes check-in').toBe('ready');
    await a.c.startExam();
    const evA = await staff.events(same.sessionId);
    const cmpA = evA.find((e) => e.type === 'id_photo_compared');
    expect(cmpA, 'id_photo_compared recorded').toBeTruthy();
    expect(cmpA!.category).toBe('neutral');
    expect(cmpA!.details).toMatchObject({ decision: 'match', policy: 'advisory' });
    expect(cmpA!.details.similarity as number).toBeGreaterThanOrEqual(0.42);
    expect(evA.filter((e) => e.type === 'identity_mismatch' || e.type === 'identity_unverifiable')).toHaveLength(0);
    const dA = await staff.session(same.sessionId);
    expect(dA.summary.status).toBe('active');
    expect(dA.references[0].idPhoto).toMatchObject({ decision: 'match' });
    expect(dA.identityChecks.find((ch) => ch.trigger === 'id_photo')?.decision).toBe('match');
    await a.c.close();

    /* ---------------- different person: flagged against the ID photo, the candidate is not stopped */
    const b = await checkIn(browser, other);
    expect(b.outcome, 'advisory never holds').toBe('ready');
    await b.c.startExam();
    await b.c.answerStandardQuestions();
    const evB = await staff.events(other.sessionId);
    expect(evB.find((e) => e.type === 'id_photo_compared')!.details).toMatchObject({ decision: 'mismatch', policy: 'advisory' });
    const mm = evB.find((e) => e.type === 'identity_mismatch');
    expect(mm, 'identity_mismatch against the ID photo').toBeTruthy();
    expect(mm!.category).toBe('integrity');
    expect(mm!.severity).toBe('high');
    expect(mm!.details).toMatchObject({ against: 'id_photo' });
    expect(mm!.details.similarity as number).toBeLessThan(0.24);
    expect(mm!.observation).toContain('approved identity photo');
    expect(mm!.evidence.map((x) => x.kind).sort()).toEqual(expect.arrayContaining(['id_photo', 'identity_probe']));
    const dB = await staff.session(other.sessionId);
    expect(dB.summary.status, 'the exam continues').toBe('active');
    expect(dB.summary.hold).toBeNull();
    await b.c.expectMonitoringActive();

    /* ---------------- staff: comparison view (approved ID photo vs the check-in image) */
    const cmp = await staff.compare(mm!.id);
    expect(cmp.reference.images.map((i) => i.kind)).toEqual(['id_photo']);
    expect(cmp.reference.purpose).toContain('approved ID photo');
    expect(cmp.similarity.thresholds).toEqual({ match: 0.42, mismatch: 0.24 });
    expect(cmp.probes.map((p) => p.check.trigger)).toEqual(['id_photo']);
    expect(cmp.probes[0].check.decision).toBe('mismatch');
    expect(cmp.probes[0].image, 'the check-in image is shown').toBeTruthy();

    await sp.goto(`/admin/sessions/${other.sessionId}?tab=identity`);
    await sp.getByRole('link', { name: 'Compare images' }).first().click();
    await expect(sp).toHaveURL(new RegExp(`/compare/${mm!.id}`));
    await expect(sp.getByRole('heading', { name: /Identity comparison — Possible different person/ })).toBeVisible();
    const refSection = sp.locator('section', { has: sp.getByRole('heading', { name: 'Original reference' }) });
    const laterSection = sp.locator('section', { has: sp.getByRole('heading', { name: 'Later images' }) });
    await expect(refSection).toContainText('approved ID photo');
    for (const img of [refSection.locator('img').first(), laterSection.locator('img').first()]) {
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    }
    await expect(refSection.getByRole('button', { name: /^ID photo at .* \(open larger\)$/ })).toBeVisible();
    await expect(laterSection).toContainText('ID photo comparison');
    await expect(laterSection).toContainText('Possible different person');
    await expect(sp.getByRole('heading', { name: 'Similarity to the reference' })).toBeVisible();
    await expect(sp.locator('.sim-threshold').first()).toContainText('0.24');
    await b.c.close();
  } finally {
    await browser.close();
  }
});

test('required: same person proceeds, a different person is held (id_photo_mismatch), an unclear photo is held as unverifiable — not a mismatch', async ({ staff, staffPage }) => {
  skipUnlessFixtures('a');
  skipUnlessIdPhotos('id-a.jpg', 'id-other.jpg', 'id-a-poor.jpg');
  test.setTimeout(6 * 60_000);
  const exam = await staff.createExam({ policy: { identity: { liveness: 'off', idPhotoComparison: 'required', periodicCheckIntervalSec: 30 }, browser: { requireFullscreen: false } } });
  const sp = await staffPage();
  const same = await candidateWithPhoto(staff, sp, exam, 'id-a.jpg', 'Required same');
  const other = await candidateWithPhoto(staff, sp, exam, 'id-other.jpg', 'Required other');
  const poor = await candidateWithPhoto(staff, sp, exam, 'id-a-poor.jpg', 'Required poor');

  const browser = await launchCamera('a');
  try {
    /* ---------------- same person: passes, exam starts */
    const a = await checkIn(browser, same);
    expect(a.outcome).toBe('ready');
    await a.c.startExam();
    const evA = await staff.events(same.sessionId);
    expect(evA.find((e) => e.type === 'id_photo_compared')!.details).toMatchObject({ decision: 'match', policy: 'required' });
    expect((await staff.session(same.sessionId)).summary.status).toBe('active');
    await a.c.close();

    /* ---------------- different person: held before the exam starts */
    const b = await checkIn(browser, other);
    expect(b.outcome, 'held at check-in').toBe('hold');
    await expect(b.c.tid('hold-screen')).toContainText('We could not match you with the identity photo on file.');
    await expect(b.c.tid('hold-screen')).not.toContainText(/cheat|fraud|impostor/i);
    await expect.poll(() => b.c.liveCameraTracks(), { timeout: 10_000, message: 'camera released while on hold' }).toBe(0);
    const dB = await staff.waitForSession(other.sessionId, (d) => d.summary.status === 'on_hold');
    expect(dB.summary.hold?.reason).toBe('id_photo_mismatch');
    expect(dB.summary.startedAt, 'the exam never started').toBeNull();
    const evB = await staff.events(other.sessionId);
    expect(evB.find((e) => e.type === 'id_photo_compared')!.details).toMatchObject({ decision: 'mismatch', policy: 'required' });
    const mm = evB.find((e) => e.type === 'identity_mismatch')!;
    expect(mm.details).toMatchObject({ against: 'id_photo' });
    const cmp = await staff.compare(mm.id);
    expect(cmp.reference.images.map((i) => i.kind)).toEqual(['id_photo']);
    expect(cmp.probes.map((p) => p.check.decision)).toEqual(['mismatch']);
    await sp.goto(`/admin/sessions/${other.sessionId}`);
    await expect(sp.getByText('Live image may not match the approved ID photo').first()).toBeVisible();
    await sp.goto(`/admin/sessions/${other.sessionId}/compare/${mm.id}`);
    const refSection = sp.locator('section', { has: sp.getByRole('heading', { name: 'Original reference' }) });
    await expect(refSection).toContainText('approved ID photo');
    await expect.poll(() => refSection.locator('img').first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    await b.c.close();

    /* ---------------- poor ID photo: inconclusive -> held as "could not compare", never as a different person */
    const c = await checkIn(browser, poor);
    expect(c.outcome).toBe('hold');
    await expect(c.c.tid('hold-screen')).toContainText('This is not a finding that you are a different person.');
    const dC = await staff.waitForSession(poor.sessionId, (d) => d.summary.status === 'on_hold');
    expect(dC.summary.hold?.reason).toBe('id_photo_unverifiable');
    const evC = await staff.events(poor.sessionId);
    const compared = evC.find((e) => e.type === 'id_photo_compared')!;
    expect(['inconclusive', 'unable_to_verify']).toContain(compared.details.decision);
    console.log(`poor ID photo: decision ${String(compared.details.decision)}, similarity ${String(compared.details.similarity)}`);
    expect(evC.filter((e) => e.type === 'identity_mismatch'), 'never reported as a different person').toHaveLength(0);
    await sp.goto(`/admin/sessions/${poor.sessionId}`);
    await expect(sp.getByText('Could not be verified against the approved ID photo (image unclear — not a mismatch)').first()).toBeVisible();
    await c.c.close();
  } finally {
    await browser.close();
  }
});
