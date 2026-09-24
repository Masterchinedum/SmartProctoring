import { describe, expect, it } from 'vitest';
import { barPercent, evidenceTone, selfTestErrorMessage, similarityBand, summarizeProbes, type ProbeRecord } from './cameraTest';
import { NAV, staffPageTitle } from '../components/Shell';

describe('camera & identity self-test helpers', () => {
  const scale = { min: 0, max: 1, match: 0.45, mismatch: 0.28 };

  it('places similarities on the bar and in the exam’s bands', () => {
    expect(barPercent(0.45, scale)).toBeCloseTo(45);
    expect(barPercent(-0.2, scale)).toBe(0);
    expect(barPercent(1.4, scale)).toBe(100);
    expect(similarityBand(0.5, scale)).toBe('match');
    expect(similarityBand(0.45, scale)).toBe('match');
    expect(similarityBand(0.3, scale)).toBe('grey');
    expect(similarityBand(0.1, scale)).toBe('mismatch');
    expect(similarityBand(null, scale)).toBeNull();
  });

  it('colours the accumulated evidence', () => {
    expect(evidenceTone('consistent')).toBe('success');
    expect(evidenceTone('suspect')).toBe('warning');
    expect(evidenceTone('confirmed_mismatch')).toBe('danger');
    expect(evidenceTone(null)).toBe('info');
  });

  it('summarises the probe history', () => {
    const rec = (similarity: number | null, decision: ProbeRecord['decision'], roundTripMs: number): ProbeRecord => ({ at: 0, similarity, decision, llr: null, evidence: null, issues: [], analyzeMs: 50, roundTripMs });
    const s = summarizeProbes([rec(0.6, 'match', 200), rec(0.2, 'mismatch', 300), rec(null, 'unable_to_verify', 250)]);
    expect(s).toMatchObject({ count: 3, usable: 2, minSimilarity: 0.2, maxSimilarity: 0.6, medianRoundTripMs: 250 });
    expect(s.meanSimilarity).toBeCloseTo(0.4);
    expect(s.byDecision).toEqual({ match: 1, mismatch: 1, unable_to_verify: 1 });
    expect(summarizeProbes([]).meanSimilarity).toBeNull();
  });

  it('explains the self-test API errors', () => {
    expect(selfTestErrorMessage({ status: 409, code: 'not_enrolled' })).toMatch(/Enrol first/);
    expect(selfTestErrorMessage({ status: 409, code: 'too_many_probes' })).toMatch(/Reset/);
    expect(selfTestErrorMessage({ status: 404, code: 'not_found' })).toMatch(/does not offer/);
  });

  it('is reachable from the navigation for every staff role, with its own page title', () => {
    const item = NAV.find((n) => n.to === '/admin/tools/camera-test');
    expect(item).toMatchObject({ label: 'Camera & identity test', group: 'Tools' });
    expect(item?.adminOnly).toBeFalsy();
    expect(staffPageTitle('/admin/tools/camera-test')).toBe('Camera & identity test — SmartProctoring staff');
  });
});
