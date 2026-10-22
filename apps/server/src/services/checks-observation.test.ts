import { describe, expect, it } from 'vitest';
import { unverifiableObservation } from './checks.js';

describe('unverifiableObservation (check out of attempts)', () => {
  it('separates clear-but-unconvincing images from image-quality failures', () => {
    const clear = unverifiableObservation('inconclusive', false, 5)!;
    expect(clear).toMatch(/clearly visible/);
    expect(clear).toMatch(/5 attempts/);
    expect(clear).not.toMatch(/not evidence of a different person/i);

    for (const [reason, qualityOnly] of [['inconclusive', true], ['unable_to_verify', false], ['reference_not_established', true]] as const) {
      const poor = unverifiableObservation(reason, qualityOnly, 3)!;
      expect(poor).toMatch(/not clear enough/);
      expect(poor).toMatch(/not evidence of a different person/i);
    }
  });

  it('names a failed live-person check and falls back to the catalog wording otherwise', () => {
    expect(unverifiableObservation('liveness_failed', false, 1)).toMatch(/after 1 attempt\b/);
    expect(unverifiableObservation('second_opinion_inconclusive', false, 2)).toBeUndefined();
  });
});
