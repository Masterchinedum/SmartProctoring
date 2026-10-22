import { describe, expect, it } from 'vitest';
import { checkVersionLabel, driftSegmentLabel, impactSummary, rate, reportVersionsLabel, thresholdChanges, validateThresholdDraft } from './governance';

const T = { match: 0.42, mismatch: 0.24, idPhotoMatch: 0.42, idPhotoMismatch: 0.24, mismatchConfirmations: 2 };

describe('governance helpers', () => {
  it('validates a proposal form', () => {
    const ok = { match: '0.45', mismatch: '0.3', idPhotoMatch: '0.42', idPhotoMismatch: '0.24', mismatchConfirmations: '2' };
    expect(validateThresholdDraft(ok)).toEqual({});
    expect(validateThresholdDraft({ ...ok, mismatch: '0.5' }).mismatch).toMatch(/lower than/);
    expect(validateThresholdDraft({ ...ok, idPhotoMismatch: '0.42' }).idPhotoMismatch).toMatch(/lower than/);
    expect(validateThresholdDraft({ ...ok, match: '1.5' }).match).toBeDefined();
    expect(validateThresholdDraft({ ...ok, match: '' }).match).toBeDefined();
    expect(validateThresholdDraft({ ...ok, mismatchConfirmations: '0' }).mismatchConfirmations).toBeDefined();
    expect(validateThresholdDraft({ ...ok, mismatchConfirmations: '2.5' }).mismatchConfirmations).toBeDefined();
  });

  it('lists the threshold changes between two versions', () => {
    expect(thresholdChanges(T, { ...T, mismatch: 0.2, mismatchConfirmations: 3 })).toEqual(['Mismatch threshold 0.24 → 0.2', 'Confirmations 2 → 3']);
    expect(thresholdChanges(T, T)).toEqual(['No change in values']);
  });

  it('summarises the preview of a proposal', () => {
    expect(
      impactSummary({
        from: 0,
        to: 1,
        samples: 200,
        changes: [
          { from: 'inconclusive', to: 'mismatch', count: 6 },
          { from: 'match', to: 'inconclusive', count: 2 },
        ],
        idPhotoComparisons: 10,
        idPhotoChanges: [{ from: 'match', to: 'inconclusive', count: 1 }],
      }),
    ).toBe(
      'Of 200 identity samples in the last 30 days, 8 (4.0 %) would be labelled differently: 6 inconclusive → different person, 2 same person → inconclusive. ID-photo comparisons: 1 of 10 would change. Labels of single samples only — confirmed decisions also weigh image quality and the samples before them.',
    );
    expect(impactSummary({ from: 0, to: 1, samples: 0, changes: [], idPhotoComparisons: 0, idPhotoChanges: [] })).toMatch(/^No identity samples/);
  });

  it('labels the versions behind decisions', () => {
    expect(checkVersionLabel({ decisionConfig: 2, calibration: 'webcam-v2.1', model: 'sface-2021dec-flip' })).toEqual({
      label: 'thresholds v2',
      title: 'Decision configuration v2 · calibration webcam-v2.1 · recogniser sface-2021dec-flip',
    });
    expect(checkVersionLabel({ decisionConfig: null, calibration: null, model: 'm' }).label).toBe('thresholds unrecorded');
    expect(reportVersionsLabel({ decisionConfigs: [1, 2], calibrations: ['webcam-v2.1'], models: [] })).toBe('Decision configuration v1 then v2 · calibration webcam-v2.1 · recogniser unrecorded');
  });

  it('labels drift segments and computes rates', () => {
    expect(driftSegmentLabel({ dimension: 'type', segment: 'phone_detected' })).toBe('Phone visible');
    expect(driftSegmentLabel({ dimension: 'overall', segment: 'all' })).toBe('All');
    expect(driftSegmentLabel({ dimension: 'browser', segment: 'Safari' })).toBe('Browser: Safari');
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
  });
});
