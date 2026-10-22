import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from '@sp/shared';
import { reviewerGuidance } from './labels';

describe('reviewerGuidance', () => {
  it('uses the catalog note by default', () => {
    expect(reviewerGuidance({ type: 'identity_unverifiable', details: { lastReason: 'unable_to_verify', qualityOnly: true } })).toBe(EVENT_CATALOG.identity_unverifiable.reviewerNote);
    expect(reviewerGuidance({ type: 'identity_mismatch', details: {} })).toBe(EVENT_CATALOG.identity_mismatch.reviewerNote ?? null);
  });

  it('asks for a comparison when clear images never matched convincingly', () => {
    const g = reviewerGuidance({ type: 'identity_unverifiable', details: { lastReason: 'inconclusive', qualityOnly: false } })!;
    expect(g).toMatch(/Compare the reference/);
    expect(g).not.toMatch(/NOT evidence of a different person/);
  });
});
