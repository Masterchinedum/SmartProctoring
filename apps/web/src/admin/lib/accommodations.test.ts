import { describe, expect, it } from 'vitest';
import { emptyGrant, endOfDay, formatExceptionValue, grantBody, kindsSummary } from './accommodations';

const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();

describe('grant form → request', () => {
  it('builds each kind’s parameters from the form', () => {
    expect(grantBody({ ...emptyGrant('extra_time'), percent: '50', minutes: '10' }, NOW)).toEqual({
      ok: true,
      body: { kind: 'extra_time', params: { percent: 50, minutes: 10 }, basis: 'accessibility', examId: null, validUntil: null, note: '' },
    });
    expect(grantBody({ ...emptyGrant('rest_breaks'), maxPauses: '3' }, NOW)).toMatchObject({ ok: true, body: { params: { maxPauses: 3, maxPauseMinutes: null } } });
    const det = emptyGrant('detection_exemptions');
    expect(grantBody({ ...det, detectors: { ...det.detectors, lookingAway: true } }, NOW)).toMatchObject({ ok: true, body: { params: { lookingAway: true, absence: false } } });
    expect(grantBody({ ...emptyGrant('support_person'), role: 'scribe' }, NOW)).toMatchObject({ ok: true, body: { params: { role: 'scribe' } } });
    expect(grantBody({ ...emptyGrant('no_camera'), reverifyOnContinue: true, examId: '3f2b6a1e-8c4d-4e5f-9a0b-1c2d3e4f5a6b', note: '  ref 7  ' }, NOW)).toMatchObject({
      ok: true,
      body: { kind: 'no_camera', params: { reverifyOnContinue: true }, examId: '3f2b6a1e-8c4d-4e5f-9a0b-1c2d3e4f5a6b', note: 'ref 7' },
    });
    expect(grantBody(emptyGrant('assistive_technology'), NOW)).toMatchObject({ ok: true, body: { params: {} } });
  });

  it('explains what is wrong in words', () => {
    expect(grantBody({ ...emptyGrant('extra_time'), percent: '0', minutes: '' }, NOW)).toEqual({ ok: false, error: 'Add a percentage or minutes' });
    expect(grantBody({ ...emptyGrant('extra_time'), percent: '400' }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/^Extra time percentage \(0–300\)/) });
    expect(grantBody({ ...emptyGrant('rest_breaks'), maxPauses: '0' }, NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/^Number of breaks/) });
    expect(grantBody(emptyGrant('detection_exemptions'), NOW)).toMatchObject({ ok: false, error: expect.stringContaining('Choose at least one detector') });
    expect(grantBody({ ...emptyGrant('rest_breaks'), validUntil: '2026-10-20' }, NOW)).toEqual({ ok: false, error: 'The end date must be in the future.' });
  });

  it('ends on the chosen day, at its end, in local time', () => {
    expect(endOfDay('')).toBeNull();
    const t = endOfDay('2026-10-21')!;
    const d = new Date(t);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 21, 23, 59]);
    expect(grantBody({ ...emptyGrant('rest_breaks'), validUntil: '2026-10-21' }, NOW)).toMatchObject({ ok: true, body: { validUntil: t } });
  });
});

describe('formatting', () => {
  it('shows exception values in words', () => {
    expect(formatExceptionValue({ path: 'durationMs' }, 5_400_000)).toBe('1h 30m');
    expect(formatExceptionValue({ path: 'pause.maxPauses' }, null)).toBe('No limit');
    expect(formatExceptionValue({ path: 'pause.maxPauses' }, 3)).toBe('3');
    expect(formatExceptionValue({ path: 'pause.maxPauseDurationSec' }, 600)).toBe('10m 00s');
    expect(formatExceptionValue({ path: 'identity.verification' }, 'staff')).toBe('By staff');
    expect(formatExceptionValue({ path: 'identity.liveness' }, 'active')).toBe('Head-turn challenge');
    expect(formatExceptionValue({ path: 'camera.enabled' }, false)).toBe('No');
    expect(formatExceptionValue({ path: 'x' }, null)).toBe('—');
  });

  it('summarises kinds for badges', () => {
    expect(kindsSummary(['extra_time', 'no_camera'])).toBe('Extra time, No camera');
  });
});
