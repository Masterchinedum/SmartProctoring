import { describe, expect, it } from 'vitest';
import { describeMicError, MIC_HEARD_RMS, MIC_QUIET_AFTER_MS, micVerdict, rms } from './micLevel';

describe('microphone check', () => {
  it('measures the level (RMS) of samples', () => {
    expect(rms([])).toBe(0);
    expect(rms(new Float32Array(100))).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([1, 0, 0, 0])).toBeCloseTo(0.5);
  });

  it('is working once a voice was heard, a warning after a long silence, listening before', () => {
    expect(micVerdict([], 0)).toBe('listening');
    expect(micVerdict([0, 0.002, 0.004], 3000)).toBe('listening');
    expect(micVerdict([0, 0.002, MIC_HEARD_RMS], 1000)).toBe('ok');
    // Heard once: it stays ok, however quiet afterwards.
    expect(micVerdict([0.05, 0, 0, 0], MIC_QUIET_AFTER_MS * 3)).toBe('ok');
    expect(micVerdict([0, 0.001], MIC_QUIET_AFTER_MS)).toBe('quiet');
    expect(micVerdict([0.2], 0, { heardRms: 0.3 })).toBe('listening');
  });

  it('blocks only when the microphone is clearly absent or refused; says what to do', () => {
    for (const name of ['NotAllowedError', 'SecurityError']) {
      const d = describeMicError({ name });
      expect(d.blocking, name).toBe(true);
      expect(d.message).toMatch(/allow the microphone/);
    }
    expect(describeMicError({ name: 'NotFoundError' })).toMatchObject({ blocking: true, message: expect.stringMatching(/No microphone was found/) });
    expect(describeMicError({ name: 'NotReadableError' })).toMatchObject({ blocking: false, message: expect.stringMatching(/in use by another application/) });
    expect(describeMicError(new Error('odd')).blocking).toBe(false);
  });
});
