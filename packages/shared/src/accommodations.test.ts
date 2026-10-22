import { describe, expect, it } from 'vitest';
import {
  ACCOMMODATION_CATALOG,
  ACCOMMODATION_KINDS,
  accommodationApplies,
  accommodationExtraTimeMs,
  accommodationGrantSchema,
  accommodationSpecSchema,
  applyAccommodations,
  EXCEPTION_PATH_LABEL,
  policyExceptions,
} from './accommodations';
import { DEFAULT_POLICY, resolvePolicy } from './policy';

describe('policy modes', () => {
  it('defaults to automatic identity verification with the camera on', () => {
    expect(DEFAULT_POLICY.identity).toMatchObject({ verification: 'automatic', staffReverifyOnContinue: false, liveness: 'active' });
    expect(DEFAULT_POLICY.camera).toEqual({ enabled: true });
  });

  it('staff verification switches off the automated face checks', () => {
    const p = resolvePolicy({ identity: { verification: 'staff', liveness: 'active', idPhotoComparison: 'required' } });
    expect(p.identity).toMatchObject({ verification: 'staff', liveness: 'off', idPhotoComparison: 'off' });
    expect(p.detection.enabled.lookingAway).toBe(true); // the camera still observes behaviour
  });

  it('without a camera nothing camera-based runs and identity is verified by staff', () => {
    const p = resolvePolicy({ camera: { enabled: false }, evidence: { screenshots: true } });
    expect(p.identity).toMatchObject({ verification: 'staff', liveness: 'off', idPhotoComparison: 'off' });
    expect(Object.values(p.detection.enabled).every((v) => v === false)).toBe(true);
    expect(p.evidence).toMatchObject({ screenshots: false, keepMatchingIdentitySamples: false });
    expect(p.browser.requireFullscreen).toBe(true); // browser rules still apply
    // Resolving a resolved policy changes nothing.
    expect(resolvePolicy(p)).toEqual(p);
  });
});

describe('accommodation specs', () => {
  it('validates parameters per kind', () => {
    expect(accommodationSpecSchema.parse({ kind: 'extra_time', params: { percent: 25 } })).toEqual({ kind: 'extra_time', params: { percent: 25, minutes: 0 } });
    expect(accommodationSpecSchema.safeParse({ kind: 'extra_time', params: {} }).success).toBe(false);
    expect(accommodationSpecSchema.safeParse({ kind: 'extra_time', params: { percent: 301 } }).success).toBe(false);
    expect(accommodationSpecSchema.parse({ kind: 'rest_breaks' })).toEqual({ kind: 'rest_breaks', params: { maxPauses: null, maxPauseMinutes: null } });
    expect(accommodationSpecSchema.safeParse({ kind: 'detection_exemptions', params: {} }).success).toBe(false);
    expect(accommodationSpecSchema.parse({ kind: 'detection_exemptions', params: { lookingAway: true } }).params).toMatchObject({ lookingAway: true, absence: false });
    expect(accommodationSpecSchema.safeParse({ kind: 'no_liveness_challenge', params: { x: 1 } }).success).toBe(false);
    expect(accommodationSpecSchema.safeParse({ kind: 'teleportation', params: {} }).success).toBe(false);
  });

  it('grants carry a broad basis, scope, expiry and an optional note', () => {
    const g = accommodationGrantSchema.parse({ kind: 'support_person', params: { role: 'scribe' }, basis: 'accessibility' });
    expect(g).toMatchObject({ kind: 'support_person', params: { role: 'scribe' }, basis: 'accessibility', examId: null, validUntil: null, note: '' });
    expect(accommodationGrantSchema.safeParse({ kind: 'support_person', basis: 'medical' }).success).toBe(false);
  });

  it('labels every kind for staff and candidates', () => {
    for (const kind of ACCOMMODATION_KINDS) {
      const info = ACCOMMODATION_CATALOG[kind];
      expect(info.title.length).toBeGreaterThan(3);
      const params = accommodationSpecSchema.parse({ kind, params: kind === 'extra_time' ? { minutes: 10 } : kind === 'detection_exemptions' ? { movement: true } : undefined }).params as Record<string, unknown>;
      expect(info.label(params)).not.toMatch(/undefined|NaN/);
      expect(info.candidateLabel(params)).not.toMatch(/undefined|NaN/);
    }
    expect(ACCOMMODATION_CATALOG.extra_time.label({ percent: 25, minutes: 10 })).toBe('Extra time: +25 %, +10 minutes');
    expect(ACCOMMODATION_CATALOG.detection_exemptions.label({ lookingAway: true, objects: true })).toBe('Not observed: looking away, objects such as phones or books');
  });
});

describe('applyAccommodations', () => {
  it('relaxes exactly the rules each accommodation names', () => {
    const p = applyAccommodations(DEFAULT_POLICY, [
      { kind: 'assistive_technology', params: {} },
      { kind: 'detection_exemptions', params: { lookingAway: true, movement: true } },
      { kind: 'support_person', params: { role: 'reader' } },
      { kind: 'no_liveness_challenge', params: {} },
    ]);
    expect(p.browser).toMatchObject({ requireFullscreen: false, blockClipboard: false, flagWindowBlur: false, flagTabHidden: true });
    expect(p.detection.enabled).toMatchObject({ lookingAway: false, movement: false, multiplePeople: false, absence: true, objects: true, cameraIntegrity: true });
    expect(p.identity).toMatchObject({ liveness: 'off', verification: 'automatic' });
    expect(DEFAULT_POLICY.browser.requireFullscreen).toBe(true); // not mutated
  });

  it('rest breaks are never stricter than the exam', () => {
    const strict = resolvePolicy({ pause: { allowed: false } });
    expect(applyAccommodations(strict, [{ kind: 'rest_breaks', params: { maxPauses: 3, maxPauseMinutes: 10 } }]).pause).toEqual({
      allowed: true,
      requireReason: false,
      requireApproval: false,
      timerBehavior: 'stop',
      maxPauses: 3,
      maxPauseDurationSec: 600,
    });
    const lenient = resolvePolicy({ pause: { allowed: true, requireApproval: true, maxPauses: null, maxPauseDurationSec: 1200, timerBehavior: 'continue' } });
    expect(applyAccommodations(lenient, [{ kind: 'rest_breaks', params: { maxPauses: 3, maxPauseMinutes: 10 } }]).pause).toMatchObject({ maxPauses: null, maxPauseDurationSec: 1200, requireApproval: false, timerBehavior: 'stop' });
    expect(applyAccommodations(lenient, [{ kind: 'rest_breaks', params: { maxPauses: null, maxPauseMinutes: null } }]).pause.maxPauseDurationSec).toBeNull();
  });

  it('staff verification and no camera set the modes and their invariants', () => {
    const staff = applyAccommodations(DEFAULT_POLICY, [{ kind: 'staff_identity_verification', params: { reverifyOnContinue: true } }]);
    expect(staff.identity).toMatchObject({ verification: 'staff', staffReverifyOnContinue: true, liveness: 'off', idPhotoComparison: 'off' });
    expect(staff.camera.enabled).toBe(true);
    const none = applyAccommodations(DEFAULT_POLICY, [{ kind: 'no_camera', params: { reverifyOnContinue: false } }]);
    expect(none.camera.enabled).toBe(false);
    expect(none.identity).toMatchObject({ verification: 'staff', staffReverifyOnContinue: false });
    expect(Object.values(none.detection.enabled).every((v) => !v)).toBe(true);
    expect(none.evidence.screenshots).toBe(false);
    // The result is a valid, already-resolved policy.
    expect(resolvePolicy(none)).toEqual(none);
  });

  it('adds extra time from every extra_time accommodation', () => {
    const hour = 3_600_000;
    expect(accommodationExtraTimeMs(hour, [])).toBe(0);
    expect(accommodationExtraTimeMs(hour, [{ kind: 'extra_time', params: { percent: 25, minutes: 0 } }])).toBe(900_000);
    expect(accommodationExtraTimeMs(hour, [{ kind: 'extra_time', params: { percent: 50, minutes: 10 } }, { kind: 'extra_time', params: { percent: 0, minutes: 5 } }, { kind: 'rest_breaks', params: {} }])).toBe(2_700_000);
  });
});

describe('policyExceptions', () => {
  it('lists every changed setting with both values and the accommodations responsible', () => {
    const items = [
      { kind: 'no_camera' as const, params: {} },
      { kind: 'extra_time' as const, params: { percent: 50, minutes: 0 } },
    ];
    const applied = applyAccommodations(DEFAULT_POLICY, items);
    const ex = policyExceptions(DEFAULT_POLICY, applied, items, { baseMs: 3_600_000, extraMs: 1_800_000 });
    const byPath = new Map(ex.map((e) => [e.path, e]));
    expect(byPath.get('durationMs')).toEqual({ path: 'durationMs', label: 'Exam duration', from: 3_600_000, to: 5_400_000, kinds: ['extra_time'] });
    expect(byPath.get('camera.enabled')).toMatchObject({ from: true, to: false, kinds: ['no_camera'] });
    expect(byPath.get('identity.verification')).toMatchObject({ from: 'automatic', to: 'staff', kinds: ['no_camera'] });
    expect(byPath.get('detection.enabled.lookingAway')).toMatchObject({ from: true, to: false, kinds: ['no_camera'] });
    expect(byPath.has('browser.requireFullscreen')).toBe(false);
    for (const e of ex) expect(EXCEPTION_PATH_LABEL[e.path], e.path).toBe(e.label);
    expect(policyExceptions(DEFAULT_POLICY, DEFAULT_POLICY, [])).toEqual([]);
  });

  it('attributes a shared setting to whichever present accommodation can change it', () => {
    const items = [{ kind: 'support_person' as const, params: { role: 'scribe' } }];
    const ex = policyExceptions(DEFAULT_POLICY, applyAccommodations(DEFAULT_POLICY, items), items);
    expect(ex).toEqual([{ path: 'detection.enabled.multiplePeople', label: 'Other people in view observed', from: true, to: false, kinds: ['support_person'] }]);
  });
});

describe('accommodationApplies', () => {
  it('respects revocation, expiry and exam scope', () => {
    const base = { examId: null, validUntil: null, revokedAt: null };
    expect(accommodationApplies(base, 'e1', 1000)).toBe(true);
    expect(accommodationApplies({ ...base, examId: 'e2' }, 'e1', 1000)).toBe(false);
    expect(accommodationApplies({ ...base, examId: 'e1' }, 'e1', 1000)).toBe(true);
    expect(accommodationApplies({ ...base, validUntil: 1000 }, 'e1', 1000)).toBe(false);
    expect(accommodationApplies({ ...base, validUntil: 1001 }, 'e1', 1000)).toBe(true);
    expect(accommodationApplies({ ...base, revokedAt: 5 }, 'e1', 1000)).toBe(false);
  });
});
