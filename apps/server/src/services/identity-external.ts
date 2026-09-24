/**
 * External second opinion for the identity engine (docs/EXTERNAL_VERIFIER.md): the glue between the decision points
 * of checks.ts / identity-samples.ts and the verifier seam (verifiers/index.ts `maybeExternalSecondOpinion` +
 * `fuseWithExternal`).
 *
 *  - `check_in`       initial check: the approved ID photo comparison (ID-photo thresholds) when there is one,
 *                     otherwise the enrolment's own consistency (best reference frame vs the frame taken last).
 *  - `resume`         resume / reconnect / reverify checks: the check's decision against the protected reference.
 *  - `suspected_swap` mid-exam: when the evidence accumulator is about to confirm a possible different person.
 *
 * Always called OUTSIDE the session row lock (a network call of up to EXTERNAL_VERIFIER_TIMEOUT_MS). Off by default:
 * `secondOpinionApplies` mirrors the seam's own gate (provider active, decision point enabled, server allows the
 * provider, candidate consented after enablement) so that nothing — not even the images — is loaded otherwise, and
 * callers keep their exact previous behaviour when it returns null. Failures fail open (the fusion treats them as
 * "no opinion" and records them).
 */
import type { IdentityDecision } from '@sp/shared';
import type { Ctx } from '../context.js';
import type { Organization } from '../db/schema.js';
import type { ExternalBand, FusionOutcome, InternalStrength } from '../verifiers/fusion.js';
import { fuseWithExternal, fusionPolicyFor, maybeExternalSecondOpinion, type ExternalCompareInput, type FusionResult, type InternalOpinion, type SecondOpinionKind } from '../verifiers/index.js';
import { isExternalVerifierActive, USE_FOR_KEY } from '../verifiers/settings.js';
import { orgSettings } from './org.js';

/** What is stored with the identity check (context.secondOpinion) and the events it affects. No images, no secrets. */
export interface SecondOpinionRecord {
  kind: SecondOpinionKind;
  provider: string | null;
  outcome: FusionOutcome;
  /** The fused decision the engine acted on. */
  decision: IdentityDecision;
  internalDecision: IdentityDecision;
  changed: boolean;
  needsHumanReview: boolean;
  internalStrength: InternalStrength;
  externalBand: ExternalBand;
  /** Reviewer-facing explanation naming both opinions. */
  explanation: string;
  record: FusionResult['record'];
  at: number;
}

type GateCtx = Pick<Ctx, 'config'>;

/** Would the seam ask a provider for this organisation / decision point / candidate? (No I/O.) */
export function secondOpinionApplies(ctx: GateCtx, org: Pick<Organization, 'settings'> | null | undefined, kind: SecondOpinionKind, consentAcceptedAt: Date | number | null | undefined): boolean {
  if (!org) return false;
  const s = orgSettings(org).externalVerifier;
  if (!isExternalVerifierActive(s) || !s.useFor[USE_FOR_KEY[kind]]) return false;
  if (!ctx.config.externalVerifiers.allowedProviders.includes(s.provider)) return false;
  const consentAt = consentAcceptedAt == null ? null : typeof consentAcceptedAt === 'number' ? consentAcceptedAt : consentAcceptedAt.getTime();
  return consentAt != null && s.enabledAt != null && consentAt >= s.enabledAt;
}

export interface SecondOpinionInput {
  org: Organization | null;
  kind: SecondOpinionKind;
  internal: InternalOpinion;
  /** Thresholds the internal decision was made with (reference or ID-photo pair). */
  thresholds: { match: number; mismatch: number };
  /** Loads the images only when a provider will be asked (best reference first). null = no images => no opinion. */
  images: () => Promise<ExternalCompareInput | null>;
  consentAcceptedAt: Date | number | null;
  sessionId: string;
}

/**
 * Ask the organisation's external verifier and fuse its answer with the internal decision. Returns null — and the
 * caller keeps its internal decision untouched — when the verifier does not apply, the internal image was not usable
 * (the second opinion cannot fix an image), or there are no images to send.
 */
export async function secondOpinion(ctx: Pick<Ctx, 'db' | 'config' | 'keyring' | 'log' | 'verifiers' | 'now'>, input: SecondOpinionInput): Promise<SecondOpinionRecord | null> {
  if (!input.org || !secondOpinionApplies(ctx, input.org, input.kind, input.consentAcceptedAt)) return null;
  if (input.internal.decision === 'unable_to_verify') return null;
  let images: ExternalCompareInput | null = null;
  try {
    images = await input.images();
  } catch (err) {
    ctx.log.warn({ err, sessionId: input.sessionId, kind: input.kind }, 'second opinion: images could not be loaded; the internal decision stands');
    return null;
  }
  if (!images || !images.probe?.length || !images.reference.some((r) => r?.length)) return null;
  const opinion = await maybeExternalSecondOpinion(ctx, input.org, input.kind, images, { consentAcceptedAt: input.consentAcceptedAt, sessionId: input.sessionId });
  if (!opinion) return null;
  const fused = fuseWithExternal(input.internal, opinion, fusionPolicyFor(input.thresholds));
  return {
    kind: input.kind,
    provider: opinion.provider,
    outcome: fused.outcome,
    decision: fused.decision,
    internalDecision: fused.internalDecision,
    changed: fused.changed,
    needsHumanReview: fused.needsHumanReview,
    internalStrength: fused.internalStrength,
    externalBand: fused.externalBand,
    explanation: fused.explanation,
    record: fused.record,
    at: ctx.now(),
  };
}

/** Event-details fragment for an event the second opinion affected. */
export function secondOpinionDetails(r: SecondOpinionRecord | null | undefined): Record<string, unknown> {
  return r ? { secondOpinion: r, needsHumanReview: r.needsHumanReview } : {};
}
