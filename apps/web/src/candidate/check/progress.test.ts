import { describe, expect, it } from 'vitest';
import { attemptsAfterText, CheckProgress } from './progress';

describe('CheckProgress', () => {
  it('gives up on frontal frames after the rejection limit (below the server cap of 10)', () => {
    const p = new CheckProgress();
    p.start(0);
    expect(p.maxFrontalRejections).toBeLessThan(10);
    for (let i = 1; i < p.maxFrontalRejections; i++) expect(p.frontalRejected()).toBe(false);
    expect(p.frontalRejected()).toBe(true);
    expect(p.frontalRejections).toBe(p.maxFrontalRejections);
  });

  it('detects a stall when nothing progresses for the stall time', () => {
    const p = new CheckProgress({ stallMs: 30_000 });
    p.start(1000);
    expect(p.stalled(30_999)).toBe(false);
    expect(p.stalled(31_000)).toBe(true);
    p.accepted(31_000);
    expect(p.stalled(60_000)).toBe(false);
  });

  it('counts a new liveness step or getting closer as progress, but not jitter', () => {
    const p = new CheckProgress({ stallMs: 10_000, minProgressGain: 0.05 });
    p.start(0);
    p.liveness(1, 0.1, 1000); // new step
    p.liveness(1, 0.12, 9000); // jitter: no progress
    expect(p.stalled(11_000)).toBe(true);
    p.liveness(1, 0.3, 11_000); // closer to the target
    expect(p.stalled(20_000)).toBe(false);
    expect(p.stalled(21_000)).toBe(true);
    p.liveness(2, 0, 21_000); // next step
    expect(p.stalled(30_000)).toBe(false);
  });

  it('a still photo that cannot turn stalls the head-turn step', () => {
    const p = new CheckProgress({ stallMs: 30_000 });
    p.start(0);
    p.liveness(0, 1, 2000); // centre step done
    p.captured(2500);
    for (let t = 3000; t <= 40_000; t += 200) p.liveness(1, 0.02 + (t % 400 ? 0.01 : 0), t);
    expect(p.stalled(33_000)).toBe(true);
  });
});

describe('attemptsAfterText', () => {
  it('shows the attempts left after an ordinary failure', () => {
    expect(attemptsAfterText({ attemptsRemaining: 3, attemptsAfter: { failed: 2, unclear: 2 } })).toBe('Attempts remaining after this one: 2');
  });

  it('does not say 0 when an unclear-picture failure (half an attempt) would still allow another try', () => {
    const t = attemptsAfterText({ attemptsRemaining: 1, attemptsAfter: { failed: 0, unclear: 1 } });
    expect(t).not.toMatch(/: 0/);
    expect(t).toMatch(/last attempt.*too unclear/);
    expect(attemptsAfterText({ attemptsRemaining: 2, attemptsAfter: { failed: 1, unclear: 2 } })).toMatch(/: 1 \(2 if the pictures/);
  });

  it('an older server without the split: attemptsRemaining - 1', () => {
    expect(attemptsAfterText({ attemptsRemaining: 3 })).toBe('Attempts remaining after this one: 2');
    expect(attemptsAfterText({ attemptsRemaining: 0 })).toBe('Attempts remaining after this one: 0');
  });
});
