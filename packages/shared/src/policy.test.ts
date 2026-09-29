import { describe, expect, it } from 'vitest';
import { burstSizeFor, DEFAULT_POLICY, resolvePolicy, SAMPLING_PROFILES, samplingProfileOf } from './policy';

describe('identity sampling profiles', () => {
  it('the default policy is the maximum-accuracy profile (3-frame samples every 6 s, then every 15 s)', () => {
    expect(DEFAULT_POLICY.identity).toMatchObject({ ...SAMPLING_PROFILES.maximum, samplingProfile: 'maximum' });
  });

  it('balanced: 2-frame routine samples every 12 s, then every 30 s; triggered samples keep 3 frames', () => {
    const p = resolvePolicy({ identity: { ...SAMPLING_PROFILES.balanced } });
    expect(p.identity).toMatchObject({ burstSize: 3, routineBurstSize: 2, startupIntervalSec: 12, startupWindowSec: 180, periodicCheckIntervalSec: 30, samplingProfile: 'balanced' });
    expect(burstSizeFor('periodic', p.identity)).toBe(2);
    for (const t of ['exam_start', 'track_break', 'appearance_change', 'face_return', 'camera_reconnect', 'after_obstruction', 'after_multiple_people', 'follow_up', 'server_request']) {
      expect(burstSizeFor(t, p.identity)).toBe(3);
    }
  });

  it('the label describes the numbers: any other combination is custom, whatever label was stored', () => {
    expect(resolvePolicy({ identity: { ...SAMPLING_PROFILES.balanced, periodicCheckIntervalSec: 45, samplingProfile: 'balanced' } }).identity.samplingProfile).toBe('custom');
    expect(resolvePolicy({ identity: { ...SAMPLING_PROFILES.maximum, samplingProfile: 'custom' } }).identity.samplingProfile).toBe('maximum');
    expect(samplingProfileOf({ ...SAMPLING_PROFILES.maximum, routineBurstSize: 2 })).toBe('custom');
  });

  it('routineBurstSize follows burstSize when not set (a stored one-frame policy keeps one-frame routine samples)', () => {
    expect(resolvePolicy({ identity: { burstSize: 1 } }).identity.routineBurstSize).toBe(1);
    expect(resolvePolicy({ identity: { burstSize: 5, routineBurstSize: 2 } }).identity.routineBurstSize).toBe(2);
    expect(() => resolvePolicy({ identity: { routineBurstSize: 6 } })).toThrow();
  });
});

describe('detection policy: looking away while working', () => {
  it('stored policies from before the working-region fields stay valid and get the new defaults', () => {
    const old = resolvePolicy({ detection: { lookAwaySec: 6, lookAwayYawDeg: 30, lookDownPitchDeg: 25, glanceMinSec: 1.5, enabled: { lookingAway: true } } });
    expect(old.detection).toMatchObject({ lookAwaySec: 6, lookAwayYawDeg: 30, lookDownPitchDeg: 25, glanceMinSec: 1.5, lookUpPitchDeg: 35, lookUpSec: 15, attentionReference: 'learned', typingExcuseSec: 3 });
    expect(DEFAULT_POLICY.detection).toMatchObject({ lookAwaySec: 5, lookAwayYawDeg: 28, lookDownPitchDeg: 20, lookUpPitchDeg: 35, lookUpSec: 15, attentionReference: 'learned', typingExcuseSec: 3, glanceMinSec: 1.2, repeatedLookAwayCount: 5, sameDirectionCount: 4 });
  });

  it('validates the new fields', () => {
    expect(resolvePolicy({ detection: { attentionReference: 'calibration', typingExcuseSec: 0 } }).detection).toMatchObject({ attentionReference: 'calibration', typingExcuseSec: 0 });
    expect(() => resolvePolicy({ detection: { attentionReference: 'camera' } })).toThrow();
    expect(() => resolvePolicy({ detection: { typingExcuseSec: 11 } })).toThrow();
    expect(() => resolvePolicy({ detection: { lookUpPitchDeg: 5 } })).toThrow();
  });
});
