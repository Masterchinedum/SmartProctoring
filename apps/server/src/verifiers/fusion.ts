/**
 * Pure fusion of the internal identity decision with an external second opinion (docs/EXTERNAL_VERIFIER.md §5).
 *
 * Principles
 *   1. The internal pipeline decides first; the external provider is a second opinion, never a replacement.
 *   2. The external provider NEVER produces "possible different person" (mismatch) on its own: false mismatches put
 *      genuine candidates on hold, and a cloud provider's scores are not calibrated on this deployment's data.
 *   3. A CLEAR internal decision is never flipped. When the provider contradicts it, the decision is kept, both
 *      opinions are recorded and the check is flagged for human review.
 *   4. A BORDERLINE internal decision (within `borderlineMargin` of its threshold) contradicted by the provider is
 *      downgraded to "inconclusive" and flagged for human review.
 *   5. An internal "inconclusive" may be resolved to "match" when the provider is confident it is the same person
 *      (`resolveInconclusive`, default on); a confident "different person" keeps it inconclusive + human review.
 *   6. "unable_to_verify" (image not usable) is never changed: the provider cannot fix the image.
 *   7. No answer (disabled, error, timeout, no face, several faces, uncertain score) ⇒ the internal decision stands.
 *   Every result carries a reviewer-facing explanation naming both opinions.
 *
 * Decision table (internal strength × external band ⇒ final decision, [R] = needsHumanReview):
 *
 *   internal \ external | same (>= externalSame)    | different (< externalDifferent) | uncertain    | no face / several faces / error / none
 *   --------------------+---------------------------+---------------------------------+--------------+----------------------------------------
 *   match, clear        | match (agree)             | match [R] (disagreement)        | match        | match
 *   match, borderline   | match (agree)             | inconclusive [R] (downgraded)   | match        | match
 *   inconclusive        | match (resolved)*         | inconclusive [R]                | inconclusive | inconclusive
 *   mismatch, borderline| inconclusive [R] (downgr.)| mismatch (agree)                | mismatch     | mismatch
 *   mismatch, clear     | mismatch [R] (disagreement)| mismatch (agree)               | mismatch     | mismatch
 *   unable_to_verify    | unable_to_verify          | unable_to_verify                | unable_to_v. | unable_to_verify
 *
 *   * only with resolveInconclusive (default true); otherwise inconclusive (no review flag).
 *   borderline: match with similarity < match + margin; mismatch with similarity ≥ mismatch − margin.
 *   A decision without a similarity counts as clear.
 */
import type { IdentityDecision } from '@sp/shared';
import type { ExternalOpinion } from './types.js';

export interface FusionPolicy {
  /** Thresholds the internal decision was made with (reference or ID-photo thresholds). */
  internal: { match: number; mismatch: number };
  /** Distance from an internal threshold within which a match / mismatch counts as borderline. Default 0.05. */
  borderlineMargin: number;
  /** External similarity (0..1) at or above which the provider says "same person". Default 0.95. */
  externalSame: number;
  /** External similarity (0..1) below which the provider says "different person". Default 0.5. */
  externalDifferent: number;
  /** Let a confident external "same person" resolve an internal "inconclusive" to "match". Default true. */
  resolveInconclusive: boolean;
}

/**
 * Defaults. The external bands follow the provider's documented score semantics (AWS Rekognition: similarity is a
 * percentage; its API default threshold is 80 %) — they are NOT calibrated on your data. Measure on consented data
 * before relying on them (docs/accuracy/).
 */
export const DEFAULT_FUSION_POLICY: Omit<FusionPolicy, 'internal'> = {
  borderlineMargin: 0.05,
  externalSame: 0.95,
  externalDifferent: 0.5,
  resolveInconclusive: true,
};

/** Fusion policy for a decision made with `thresholds` (e.g. orgThresholds(org) or its ID-photo pair). */
export function fusionPolicyFor(thresholds: { match: number; mismatch: number }, overrides: Partial<Omit<FusionPolicy, 'internal'>> = {}): FusionPolicy {
  return { ...DEFAULT_FUSION_POLICY, ...overrides, internal: { match: thresholds.match, mismatch: thresholds.mismatch } };
}

export interface InternalOpinion {
  decision: IdentityDecision;
  /** Internal similarity (cosine, max over the reference), null when not computed. */
  similarity: number | null;
}

export type InternalStrength = 'clear' | 'borderline' | 'grey' | 'unusable';
export type ExternalBand = 'same' | 'different' | 'uncertain' | 'no_face' | 'multiple_faces' | 'error' | 'none';

export type FusionOutcome =
  /** No second opinion (disabled / not asked). */
  | 'internal_only'
  /** The provider could not answer usefully (error, timeout, no face, several faces). */
  | 'external_unusable'
  /** The provider's score is in its uncertain band. */
  | 'external_uncertain'
  | 'agree'
  /** Internal inconclusive resolved to match by a confident external "same person". */
  | 'resolved_by_external'
  /** Borderline internal decision contradicted: recorded as inconclusive. */
  | 'downgraded_to_inconclusive'
  /** Clear internal decision contradicted: kept, flagged for review. */
  | 'disagreement_flagged'
  /** Internal inconclusive, provider says different person: kept inconclusive, flagged for review. */
  | 'external_suggests_mismatch'
  /** Internal inconclusive, provider says same person, but resolveInconclusive is off. */
  | 'kept_inconclusive'
  /** Internal unable_to_verify: the second opinion does not apply. */
  | 'not_applicable';

export interface FusionResult {
  /** The decision to act on. */
  decision: IdentityDecision;
  internalDecision: IdentityDecision;
  /** decision !== internalDecision */
  changed: boolean;
  /** Surface to a person (the opinions disagree or the provider points to a different person). */
  needsHumanReview: boolean;
  outcome: FusionOutcome;
  internalStrength: InternalStrength;
  externalBand: ExternalBand;
  /** Reviewer-facing explanation naming both opinions. */
  explanation: string;
  /** Both opinions, to store with the identity check (no images, no secrets). */
  record: {
    internal: InternalOpinion;
    external: { provider: string; status: 'ok' | 'error'; similarity: number | null; faceFound: boolean | null; faceCount: number | null; error: string | null; latencyMs: number } | null;
  };
}

/** Tolerance for threshold ± margin arithmetic (0.28 - 0.05 is 0.23000000000000004 in floating point). */
const EPS = 1e-9;

export function internalStrength(internal: InternalOpinion, policy: FusionPolicy): InternalStrength {
  const s = internal.similarity;
  const m = policy.borderlineMargin;
  switch (internal.decision) {
    case 'match':
      return s != null && s < policy.internal.match + m - EPS ? 'borderline' : 'clear';
    case 'mismatch':
      return s != null && s >= policy.internal.mismatch - m - EPS ? 'borderline' : 'clear';
    case 'inconclusive':
      return 'grey';
    default:
      return 'unusable';
  }
}

export function externalBand(external: ExternalOpinion | null, policy: FusionPolicy): ExternalBand {
  if (!external) return 'none';
  if (external.status === 'error') return 'error';
  if (!external.faceFound) return 'no_face';
  if (external.faceCount != null && external.faceCount > 1) return 'multiple_faces';
  if (external.similarity >= policy.externalSame) return 'same';
  if (external.similarity < policy.externalDifferent) return 'different';
  return 'uncertain';
}

const DECISION_TEXT: Record<IdentityDecision, string> = {
  match: 'same person',
  mismatch: 'possible different person',
  inconclusive: 'inconclusive',
  unable_to_verify: 'unable to verify (image not usable)',
};

const fmt = (v: number) => v.toFixed(2);

function internalText(internal: InternalOpinion, strength: InternalStrength, policy: FusionPolicy): string {
  const sim = internal.similarity != null ? ` (similarity ${fmt(internal.similarity)}; match ≥ ${fmt(policy.internal.match)}, mismatch < ${fmt(policy.internal.mismatch)})` : '';
  const border = strength === 'borderline' ? ', close to the threshold' : '';
  return `SmartProctoring: ${DECISION_TEXT[internal.decision]}${border}${sim}.`;
}

function externalText(external: ExternalOpinion | null, band: ExternalBand, policy: FusionPolicy): string {
  if (!external) return 'No external second opinion was requested.';
  const name = external.providerName;
  if (external.status === 'error') return `${name} could not be asked (${external.error}: ${external.message}).`;
  switch (band) {
    case 'no_face':
      return `${name}: no usable face found in the camera image.`;
    case 'multiple_faces':
      return `${name}: ${external.faceCount} faces in the camera image — ambiguous (largest face similarity ${fmt(external.similarity)}).`;
    case 'same':
      return `${name}: same person (similarity ${fmt(external.similarity)} ≥ ${fmt(policy.externalSame)}).`;
    case 'different':
      return `${name}: different person (similarity ${fmt(external.similarity)} < ${fmt(policy.externalDifferent)}).`;
    default:
      return `${name}: uncertain (similarity ${fmt(external.similarity)}, between ${fmt(policy.externalDifferent)} and ${fmt(policy.externalSame)}).`;
  }
}

/**
 * Combine the internal decision with an external opinion (null = none requested / disabled). Pure and total:
 * every combination returns a decision and an explanation; see the table at the top of this file.
 */
export function fuseWithExternal(internal: InternalOpinion, external: ExternalOpinion | null, policy: FusionPolicy): FusionResult {
  const strength = internalStrength(internal, policy);
  const band = externalBand(external, policy);
  let decision: IdentityDecision = internal.decision;
  let review = false;
  let outcome: FusionOutcome;
  let verdict: string;

  if (strength === 'unusable') {
    outcome = external ? 'not_applicable' : 'internal_only';
    verdict = external ? 'The image was not usable for the internal comparison, so the decision is unchanged.' : '';
  } else if (band === 'none') {
    outcome = 'internal_only';
    verdict = '';
  } else if (band === 'error' || band === 'no_face' || band === 'multiple_faces') {
    outcome = 'external_unusable';
    verdict = 'The internal decision stands.';
  } else if (band === 'uncertain') {
    outcome = 'external_uncertain';
    verdict = 'The internal decision stands.';
  } else if (strength === 'grey') {
    if (band === 'same' && policy.resolveInconclusive) {
      decision = 'match';
      outcome = 'resolved_by_external';
      verdict = 'The internal result was inconclusive and the external provider is confident it is the same person: recorded as a match.';
    } else if (band === 'same') {
      outcome = 'kept_inconclusive';
      verdict = 'The internal result stays inconclusive (resolving it with the external result is switched off).';
    } else {
      review = true;
      outcome = 'external_suggests_mismatch';
      verdict = 'The internal result was inconclusive and the external provider indicates a different person: kept as inconclusive and flagged for human review (an external result alone never records a possible different person).';
    }
  } else {
    // match or mismatch, clear or borderline
    const agrees = (internal.decision === 'match' && band === 'same') || (internal.decision === 'mismatch' && band === 'different');
    if (agrees) {
      outcome = 'agree';
      verdict = 'Both agree; the decision is kept.';
    } else if (strength === 'borderline') {
      decision = 'inconclusive';
      review = true;
      outcome = 'downgraded_to_inconclusive';
      verdict = 'The internal result was close to its threshold and the external provider disagrees: recorded as inconclusive and flagged for human review.';
    } else {
      review = true;
      outcome = 'disagreement_flagged';
      verdict = 'The two disagree. The internal decision is kept and the check is flagged for human review.';
    }
  }

  const explanation = [internalText(internal, strength, policy), externalText(external, band, policy), verdict].filter(Boolean).join(' ');
  return {
    decision,
    internalDecision: internal.decision,
    changed: decision !== internal.decision,
    needsHumanReview: review,
    outcome,
    internalStrength: strength,
    externalBand: band,
    explanation,
    record: {
      internal: { decision: internal.decision, similarity: internal.similarity },
      external: external
        ? external.status === 'ok'
          ? { provider: external.provider, status: 'ok', similarity: external.similarity, faceFound: external.faceFound, faceCount: external.faceCount, error: null, latencyMs: external.latencyMs }
          : { provider: external.provider, status: 'error', similarity: null, faceFound: null, faceCount: null, error: external.error, latencyMs: external.latencyMs }
        : null,
    },
  };
}
