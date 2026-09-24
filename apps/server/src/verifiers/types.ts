/**
 * External "second-opinion" face verifiers (docs/EXTERNAL_VERIFIER.md).
 *
 * The built-in recogniser (OpenCV Zoo SFace, src/vision) always decides first, on this server. An organisation may
 * additionally ask an external provider — a cloud API (AWS Rekognition) or a licensed on-premises SDK — for a
 * second opinion on the decisions that matter (check-in, resume, suspected change of person). The provider's
 * answer is combined with the internal decision by the pure `fuseWithExternal()` (fusion.ts); it never replaces
 * the internal pipeline and never decides "different person" on its own.
 *
 * To add a provider: implement `ExternalVerifier`, register a `VerifierProviderFactory` in registry.ts, add its
 * id to EXTERNAL_VERIFIER_PROVIDERS (packages/shared/src/verifiers.ts) — see docs/EXTERNAL_VERIFIER.md §7.
 */

/** 'aws-rekognition' or the id of another registered provider (e.g. a licensed on-premises SDK). */
export type ExternalVerifierId = 'aws-rekognition' | (string & {});

export interface ExternalCompareInput {
  /** Reference face image(s) (JPEG bytes), best first. Providers may use only the first (AWS: one call). */
  reference: Buffer[];
  /** The live camera image to verify (JPEG bytes). */
  probe: Buffer;
}

export interface ExternalCompareOptions {
  /** Deadline for the whole comparison, retries included (default: config EXTERNAL_VERIFIER_TIMEOUT_MS, 4 s). */
  timeoutMs?: number;
}

/** A comparison the provider completed. Failures are thrown as ExternalVerifierError instead. */
export interface ExternalCompareResult {
  /** 0..1 similarity of the probe's primary (largest) face to the reference face; 0 when no face was found. */
  similarity: number;
  /** A usable face was found in the probe (false = no face, or filtered out by the provider's quality filter). */
  faceFound: boolean;
  /** Faces the provider found in the probe (when it reports it). > 1 makes the answer ambiguous. */
  faceCount?: number;
  /** Provider-specific, SANITISED details (counts and scores only — never image bytes, boxes or landmarks). */
  raw?: unknown;
  /** Wall-clock time of the comparison, retries included. */
  latencyMs: number;
}

export interface ExternalVerifier {
  readonly id: ExternalVerifierId;
  /** Human-readable name (reviewer explanations, privacy notice). */
  readonly displayName: string;
  /** 'cloud' = images leave your infrastructure. */
  readonly location: 'cloud' | 'on_premises';
  compare(input: ExternalCompareInput, opts?: ExternalCompareOptions): Promise<ExternalCompareResult>;
  /** Release pooled connections (called when the registry evicts a cached instance). */
  close?(): void;
}

/**
 * Why a comparison did not produce a result. The caller always falls back to the internal decision ("fail open").
 *   timeout         deadline passed (EXTERNAL_VERIFIER_TIMEOUT_MS)
 *   throttled       the provider rate-limited us, also after one retry
 *   auth            credentials missing, invalid, expired or not permitted (IAM: rekognition:CompareFaces)
 *   invalid_image   the provider refused an image (format, size)
 *   network         DNS / connection failure
 *   not_configured  settings incomplete, credentials cannot be decrypted, provider not available on this server
 *   unavailable     too many consecutive failures: calls are paused for a minute (circuit breaker)
 *   provider_error  anything else the provider returned (5xx, unexpected responses)
 */
export type ExternalVerifierErrorCode = 'timeout' | 'throttled' | 'auth' | 'invalid_image' | 'network' | 'not_configured' | 'unavailable' | 'provider_error';

export class ExternalVerifierError extends Error {
  constructor(
    readonly code: ExternalVerifierErrorCode,
    message: string,
    readonly latencyMs = 0,
  ) {
    super(message);
    this.name = 'ExternalVerifierError';
  }
}

/** Decision points the seam is called at (org setting `externalVerifier.useFor`). */
export type SecondOpinionKind = 'check_in' | 'resume' | 'suspected_swap';

/**
 * What `maybeExternalSecondOpinion()` returns when a provider was asked: either its answer or the recorded failure.
 * Safe to store in identity-check details (no images, no secrets).
 */
export type ExternalOpinion =
  | {
      status: 'ok';
      provider: ExternalVerifierId;
      providerName: string;
      kind: SecondOpinionKind;
      similarity: number;
      faceFound: boolean;
      faceCount: number | null;
      latencyMs: number;
      raw?: unknown;
    }
  | {
      status: 'error';
      provider: ExternalVerifierId;
      providerName: string;
      kind: SecondOpinionKind;
      error: ExternalVerifierErrorCode;
      message: string;
      latencyMs: number;
    };
