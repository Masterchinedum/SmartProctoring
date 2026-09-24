/**
 * External second-opinion face verifier — integration seam for the identity engine (docs/EXTERNAL_VERIFIER.md §6).
 *
 *   const opinion = await maybeExternalSecondOpinion(ctx, org, 'resume', { reference: [refJpeg], probe: probeJpeg },
 *     { consentAcceptedAt: session.consentAcceptedAt, sessionId: session.id });
 *   const fused = fuseWithExternal({ decision, similarity }, opinion, fusionPolicyFor(orgThresholds(org)));
 *   // act on fused.decision; store fused.record + fused.explanation with the check; surface fused.needsHumanReview
 *
 * Call it OUTSIDE the session row lock (withSession): it waits for a network call (up to
 * EXTERNAL_VERIFIER_TIMEOUT_MS, default 4 s).
 */
import type { Ctx } from '../context.js';
import type { Organization } from '../db/schema.js';
import { loadOrg, orgSettings } from '../services/org.js';
import { isExternalVerifierActive, USE_FOR_KEY } from './settings.js';
import { ExternalVerifierError, type ExternalCompareInput, type ExternalOpinion, type SecondOpinionKind } from './types.js';

export * from './types.js';
export { DEFAULT_FUSION_POLICY, fuseWithExternal, fusionPolicyFor, type FusionPolicy, type FusionResult, type InternalOpinion } from './fusion.js';
export { createVerifierRegistry, VerifierRegistry, awsRekognitionProvider, type VerifierProviderFactory } from './registry.js';

export interface SecondOpinionOptions {
  /**
   * When the candidate accepted the privacy notice (exam_sessions.consent_accepted_at). Required: images are sent
   * only if the candidate consented at or after the provider was enabled, i.e. to a notice that named it.
   */
  consentAcceptedAt: Date | number | null;
  /** For the failure log line only. */
  sessionId?: string;
  /** Override the configured deadline (EXTERNAL_VERIFIER_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Ask the organisation's external verifier for a second opinion, if it applies.
 *
 * Returns null (nothing is sent) when: no provider is configured / active, the decision point `kind` is not enabled
 * in `externalVerifier.useFor`, the server operator disabled the provider (EXTERNAL_VERIFIERS), the candidate's
 * consent predates the enablement (or is missing), or there are no images.
 *
 * Never throws for provider problems: a failed call returns `{ status: 'error', … }` (logged without images or
 * secrets) and the caller keeps the internal decision ("fail open" — fuseWithExternal does exactly that).
 */
export async function maybeExternalSecondOpinion(
  ctx: Pick<Ctx, 'db' | 'config' | 'keyring' | 'log' | 'verifiers'>,
  org: string | Pick<Organization, 'id' | 'settings'>,
  kind: SecondOpinionKind,
  images: ExternalCompareInput,
  opts: SecondOpinionOptions,
): Promise<ExternalOpinion | null> {
  const row = typeof org === 'string' ? await loadOrg(ctx.db, org) : org;
  if (!row) return null;
  const s = orgSettings(row).externalVerifier;
  if (!isExternalVerifierActive(s) || !s.useFor[USE_FOR_KEY[kind]]) return null;
  if (!ctx.config.externalVerifiers.allowedProviders.includes(s.provider)) return null;
  const consentAt = opts.consentAcceptedAt == null ? null : typeof opts.consentAcceptedAt === 'number' ? opts.consentAcceptedAt : opts.consentAcceptedAt.getTime();
  if (consentAt == null || s.enabledAt == null || consentAt < s.enabledAt) return null;
  if (!images.probe?.length || !images.reference.some((r) => r?.length)) return null;

  const provider = ctx.verifiers.provider(s.provider);
  const providerName = provider?.displayName ?? s.provider;
  try {
    const r = await ctx.verifiers.compare(ctx, row.id, s, { reference: images.reference.filter((b) => b?.length), probe: images.probe }, { timeoutMs: opts.timeoutMs });
    ctx.log.debug({ orgId: row.id, sessionId: opts.sessionId, kind, provider: r.provider, similarity: r.similarity, faceFound: r.faceFound, latencyMs: r.latencyMs }, 'external verifier answered');
    return {
      status: 'ok',
      provider: r.provider,
      providerName: r.providerName,
      kind,
      similarity: r.similarity,
      faceFound: r.faceFound,
      faceCount: r.faceCount ?? null,
      latencyMs: r.latencyMs,
      ...(r.raw !== undefined ? { raw: r.raw } : {}),
    };
  } catch (err) {
    const e = err instanceof ExternalVerifierError ? err : new ExternalVerifierError('provider_error', String((err as Error)?.message ?? err).slice(0, 300));
    ctx.log.warn({ orgId: row.id, sessionId: opts.sessionId, kind, provider: s.provider, code: e.code, reason: e.message, latencyMs: e.latencyMs }, 'external verifier failed; the internal decision stands alone');
    return { status: 'error', provider: s.provider, providerName, kind, error: e.code, message: e.message, latencyMs: e.latencyMs };
  }
}
