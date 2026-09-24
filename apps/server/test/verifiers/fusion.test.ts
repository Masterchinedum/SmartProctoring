/**
 * External second opinion: the pure fusion table (src/verifiers/fusion.ts, docs/EXTERNAL_VERIFIER.md §5).
 */
import type { IdentityDecision } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FUSION_POLICY, fuseWithExternal, fusionPolicyFor, type ExternalBand, type FusionOutcome, type InternalOpinion } from '../../src/verifiers/fusion.js';
import type { ExternalOpinion } from '../../src/verifiers/types.js';

const policy = fusionPolicyFor({ match: 0.45, mismatch: 0.28 }); // margin 0.05, external same >= 0.95, different < 0.5

const INTERNAL: Record<string, InternalOpinion> = {
  matchClear: { decision: 'match', similarity: 0.6 },
  matchBorder: { decision: 'match', similarity: 0.47 },
  grey: { decision: 'inconclusive', similarity: 0.35 },
  mismatchBorder: { decision: 'mismatch', similarity: 0.25 },
  mismatchClear: { decision: 'mismatch', similarity: 0.1 },
  unusable: { decision: 'unable_to_verify', similarity: null },
};

const ok = (similarity: number, extra: Partial<Extract<ExternalOpinion, { status: 'ok' }>> = {}): ExternalOpinion => ({
  status: 'ok',
  provider: 'aws-rekognition',
  providerName: 'Amazon Rekognition (Amazon Web Services)',
  kind: 'resume',
  similarity,
  faceFound: true,
  faceCount: 1,
  latencyMs: 420,
  ...extra,
});

const EXTERNAL: Record<ExternalBand, ExternalOpinion | null> = {
  same: ok(0.993),
  different: ok(0.04),
  uncertain: ok(0.8),
  no_face: ok(0, { faceFound: false, faceCount: 0 }),
  multiple_faces: ok(0.99, { faceCount: 2 }),
  error: { status: 'error', provider: 'aws-rekognition', providerName: 'Amazon Rekognition (Amazon Web Services)', kind: 'resume', error: 'timeout', message: 'No answer within 4000 ms', latencyMs: 4000 },
  none: null,
};

type Cell = [IdentityDecision, boolean, FusionOutcome];
// [final decision, needsHumanReview, outcome] for internal row × external column.
const TABLE: Record<string, Record<ExternalBand, Cell>> = {
  matchClear: {
    same: ['match', false, 'agree'],
    different: ['match', true, 'disagreement_flagged'],
    uncertain: ['match', false, 'external_uncertain'],
    no_face: ['match', false, 'external_unusable'],
    multiple_faces: ['match', false, 'external_unusable'],
    error: ['match', false, 'external_unusable'],
    none: ['match', false, 'internal_only'],
  },
  matchBorder: {
    same: ['match', false, 'agree'],
    different: ['inconclusive', true, 'downgraded_to_inconclusive'],
    uncertain: ['match', false, 'external_uncertain'],
    no_face: ['match', false, 'external_unusable'],
    multiple_faces: ['match', false, 'external_unusable'],
    error: ['match', false, 'external_unusable'],
    none: ['match', false, 'internal_only'],
  },
  grey: {
    same: ['match', false, 'resolved_by_external'],
    different: ['inconclusive', true, 'external_suggests_mismatch'],
    uncertain: ['inconclusive', false, 'external_uncertain'],
    no_face: ['inconclusive', false, 'external_unusable'],
    multiple_faces: ['inconclusive', false, 'external_unusable'],
    error: ['inconclusive', false, 'external_unusable'],
    none: ['inconclusive', false, 'internal_only'],
  },
  mismatchBorder: {
    same: ['inconclusive', true, 'downgraded_to_inconclusive'],
    different: ['mismatch', false, 'agree'],
    uncertain: ['mismatch', false, 'external_uncertain'],
    no_face: ['mismatch', false, 'external_unusable'],
    multiple_faces: ['mismatch', false, 'external_unusable'],
    error: ['mismatch', false, 'external_unusable'],
    none: ['mismatch', false, 'internal_only'],
  },
  mismatchClear: {
    same: ['mismatch', true, 'disagreement_flagged'],
    different: ['mismatch', false, 'agree'],
    uncertain: ['mismatch', false, 'external_uncertain'],
    no_face: ['mismatch', false, 'external_unusable'],
    multiple_faces: ['mismatch', false, 'external_unusable'],
    error: ['mismatch', false, 'external_unusable'],
    none: ['mismatch', false, 'internal_only'],
  },
  unusable: {
    same: ['unable_to_verify', false, 'not_applicable'],
    different: ['unable_to_verify', false, 'not_applicable'],
    uncertain: ['unable_to_verify', false, 'not_applicable'],
    no_face: ['unable_to_verify', false, 'not_applicable'],
    multiple_faces: ['unable_to_verify', false, 'not_applicable'],
    error: ['unable_to_verify', false, 'not_applicable'],
    none: ['unable_to_verify', false, 'internal_only'],
  },
};

describe('fuseWithExternal decision table', () => {
  for (const [row, cols] of Object.entries(TABLE)) {
    for (const [band, [decision, review, outcome]] of Object.entries(cols) as [ExternalBand, Cell][]) {
      it(`${row} × ${band} => ${decision}${review ? ' [review]' : ''} (${outcome})`, () => {
        const r = fuseWithExternal(INTERNAL[row], EXTERNAL[band], policy);
        expect(r.decision).toBe(decision);
        expect(r.needsHumanReview).toBe(review);
        expect(r.outcome).toBe(outcome);
        expect(r.internalDecision).toBe(INTERNAL[row].decision);
        expect(r.changed).toBe(decision !== INTERNAL[row].decision);
        expect(r.explanation.length).toBeGreaterThan(10);
        if (row !== 'unusable') expect(r.externalBand).toBe(band);
      });
    }
  }

  it('never produces "possible different person" unless the internal pipeline already said so', () => {
    for (const internal of Object.values(INTERNAL)) {
      for (const external of Object.values(EXTERNAL)) {
        const r = fuseWithExternal(internal, external, policy);
        if (r.decision === 'mismatch') expect(internal.decision).toBe('mismatch');
      }
    }
  });

  it('never flips a clear internal decision to the opposite one, and records both opinions', () => {
    const a = fuseWithExternal(INTERNAL.mismatchClear, EXTERNAL.same, policy);
    expect(a.decision).toBe('mismatch');
    expect(a.record.internal).toEqual({ decision: 'mismatch', similarity: 0.1 });
    expect(a.record.external).toMatchObject({ provider: 'aws-rekognition', status: 'ok', similarity: 0.993 });
    expect(a.explanation).toContain('SmartProctoring: possible different person (similarity 0.10');
    expect(a.explanation).toContain('Amazon Rekognition (Amazon Web Services): same person (similarity 0.99');
    expect(a.explanation).toMatch(/disagree.*human review/);
    const b = fuseWithExternal(INTERNAL.matchClear, EXTERNAL.different, policy);
    expect(b.decision).toBe('match');
    expect(b.explanation).toContain('different person (similarity 0.04 < 0.50)');
  });

  it('explains downgrades, resolutions and failures for reviewers', () => {
    expect(fuseWithExternal(INTERNAL.mismatchBorder, EXTERNAL.same, policy).explanation).toMatch(/close to the threshold.*inconclusive and flagged for human review/);
    expect(fuseWithExternal(INTERNAL.grey, EXTERNAL.same, policy).explanation).toMatch(/inconclusive.*confident it is the same person: recorded as a match/);
    const failed = fuseWithExternal(INTERNAL.grey, EXTERNAL.error, policy);
    expect(failed.explanation).toContain('could not be asked (timeout: No answer within 4000 ms)');
    expect(failed.record.external).toMatchObject({ status: 'error', error: 'timeout', similarity: null });
    expect(fuseWithExternal(INTERNAL.matchClear, EXTERNAL.multiple_faces, policy).explanation).toContain('2 faces in the camera image');
    expect(fuseWithExternal(INTERNAL.matchClear, null, policy)).toMatchObject({ outcome: 'internal_only', record: { external: null } });
  });

  it('respects the policy: borderline margin, external bands, resolveInconclusive', () => {
    // exactly on the band edges
    expect(fuseWithExternal(INTERNAL.grey, ok(0.95), policy).decision).toBe('match');
    expect(fuseWithExternal(INTERNAL.grey, ok(0.9499), policy).outcome).toBe('external_uncertain');
    expect(fuseWithExternal(INTERNAL.matchClear, ok(0.5), policy).outcome).toBe('external_uncertain');
    expect(fuseWithExternal(INTERNAL.matchClear, ok(0.4999), policy).outcome).toBe('disagreement_flagged');
    // borderline edges: match < 0.45 + 0.05, mismatch >= 0.28 - 0.05
    expect(fuseWithExternal({ decision: 'match', similarity: 0.4999 }, EXTERNAL.different, policy).decision).toBe('inconclusive');
    expect(fuseWithExternal({ decision: 'match', similarity: 0.5 }, EXTERNAL.different, policy).decision).toBe('match');
    expect(fuseWithExternal({ decision: 'mismatch', similarity: 0.23 }, EXTERNAL.same, policy).decision).toBe('inconclusive');
    expect(fuseWithExternal({ decision: 'mismatch', similarity: 0.2299 }, EXTERNAL.same, policy).decision).toBe('mismatch');
    // no similarity = clear
    expect(fuseWithExternal({ decision: 'mismatch', similarity: null }, EXTERNAL.same, policy)).toMatchObject({ decision: 'mismatch', needsHumanReview: true });
    // resolveInconclusive off
    const strict = fusionPolicyFor({ match: 0.45, mismatch: 0.28 }, { resolveInconclusive: false });
    expect(fuseWithExternal(INTERNAL.grey, EXTERNAL.same, strict)).toMatchObject({ decision: 'inconclusive', needsHumanReview: false, outcome: 'kept_inconclusive' });
    // a wider margin makes the "clear" match borderline
    expect(fuseWithExternal(INTERNAL.matchClear, EXTERNAL.different, fusionPolicyFor({ match: 0.45, mismatch: 0.28 }, { borderlineMargin: 0.2 })).decision).toBe('inconclusive');
    expect(DEFAULT_FUSION_POLICY).toEqual({ borderlineMargin: 0.05, externalSame: 0.95, externalDifferent: 0.5, resolveInconclusive: true });
  });
});
