/**
 * Optional external "second-opinion" face verifier (docs/EXTERNAL_VERIFIER.md).
 *
 * SmartProctoring's own face comparison (OpenCV Zoo SFace) always runs on the organisation's server. An
 * administrator may additionally ask an external provider for a second opinion on the identity decisions that
 * matter most (check-in, resume, suspected change of person). OFF by default: nothing leaves the server unless
 * an administrator chooses a provider and at least one use.
 *
 * Staff API (types below; the settings themselves are part of GET/PUT /api/admin/settings):
 *   GET  /api/admin/verifiers                         -> ExternalVerifierInfoDTO        [admin]
 *   POST /api/admin/verifiers/test  body image/jpeg   -> ExternalVerifierTestResultDTO  [admin]  (image vs itself)
 */
import { z } from 'zod';

/** Providers known to this build. 'none' = internal (on-premises) comparison only. */
export const EXTERNAL_VERIFIER_PROVIDERS = ['none', 'aws-rekognition'] as const;
export type ExternalVerifierProvider = (typeof EXTERNAL_VERIFIER_PROVIDERS)[number];

export const EXTERNAL_VERIFIER_NAMES: Record<ExternalVerifierProvider, string> = {
  none: 'None (on-premises comparison only)',
  'aws-rekognition': 'Amazon Rekognition (Amazon Web Services)',
};

/** Decision points at which a second opinion may be requested. */
export interface ExternalVerifierUseFor {
  /** Readiness check at the start (reference creation / ID-photo comparison). */
  checkIn: boolean;
  /** Resume after a pause, reconnect, re-verification after a hold. */
  resume: boolean;
  /** A possible change of person during the exam (internal mismatch / swap signal). */
  suspectedSwap: boolean;
}

export interface ExternalVerifierSettingsDTO {
  provider: ExternalVerifierProvider;
  /** Provider region, e.g. `eu-west-1` (AWS). */
  region: string | null;
  /** Use the server's own credentials (default AWS credential chain: IAM role, environment) instead of a stored key. */
  useEnvCredentials: boolean;
  /** Write-only secret semantics: a stored access key exists (the key itself is never returned). */
  accessKeyIdSet: boolean;
  /** Last 4 characters of the stored access key id (to recognise which key is set), or null. */
  accessKeyIdHint: string | null;
  useFor: ExternalVerifierUseFor;
  /** true when face images may be sent: a provider is chosen and at least one use is switched on. */
  active: boolean;
  /**
   * When the current provider became active (epoch ms). Only sessions whose candidate consented to the privacy
   * notice at or after this time are sent to the provider (their notice named it).
   */
  enabledAt: number | null;
}

/** AWS region names, e.g. us-east-1, eu-central-2, ap-southeast-4, us-gov-west-1. */
export const AWS_REGION_RE = /^[a-z]{2,4}(?:-[a-z]+)+-\d{1,2}$/;

/**
 * `externalVerifier` in PUT /api/admin/settings (every field optional; omitted = unchanged).
 * `accessKeyId` + `secretAccessKey` are write-only and must be given together; `clearCredentials` removes the
 * stored key. Choosing provider 'none' or `useEnvCredentials: true` also removes a stored key.
 */
export const externalVerifierUpdateSchema = z
  .object({
    provider: z.enum(EXTERNAL_VERIFIER_PROVIDERS),
    region: z.string().trim().max(32).regex(AWS_REGION_RE, 'Enter a region name such as eu-west-1').nullable(),
    useEnvCredentials: z.boolean(),
    accessKeyId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{16,128}$/, 'An access key id has 16–128 upper-case letters and digits (e.g. AKIA…)'),
    secretAccessKey: z
      .string()
      .trim()
      .min(16, 'The secret access key is too short')
      .max(256)
      .regex(/^\S+$/, 'The secret access key cannot contain spaces'),
    clearCredentials: z.boolean(),
    useFor: z.object({ checkIn: z.boolean(), resume: z.boolean(), suspectedSwap: z.boolean() }).partial(),
  })
  .partial()
  .strict();
export type ExternalVerifierUpdate = z.infer<typeof externalVerifierUpdateSchema>;

/** GET /api/admin/verifiers — what this server offers. */
export interface ExternalVerifierInfoDTO {
  providers: {
    id: Exclude<ExternalVerifierProvider, 'none'>;
    name: string;
    /** 'cloud' = images leave your infrastructure. */
    location: 'cloud' | 'on_premises';
    /** false when the server operator disabled it (EXTERNAL_VERIFIERS). */
    available: boolean;
  }[];
  /** The operator allows organisations to use the server's own credentials (EXTERNAL_VERIFIER_ENV_CREDENTIALS). */
  envCredentialsAllowed: boolean;
  /** Per-comparison timeout; on timeout the internal decision stands alone. */
  timeoutMs: number;
}

/** POST /api/admin/verifiers/test — the uploaded image is compared with itself using the SAVED settings. */
export interface ExternalVerifierTestResultDTO {
  /** The provider answered (credentials, region and network work). */
  ok: boolean;
  provider: ExternalVerifierProvider;
  /** A face was found in the test image (use a photo with exactly one clear face). */
  faceFound: boolean;
  /** 0..1; a working provider returns close to 1 for an image compared with itself. null on error / no face. */
  similarity: number | null;
  latencyMs: number;
  error: { code: string; message: string } | null;
}

/** Name for the candidate privacy notice when the external verifier is active, else null. */
export function externalVerifierNoticeName(s: Pick<ExternalVerifierSettingsDTO, 'provider' | 'active'> | null | undefined): string | null {
  if (!s || !s.active || s.provider === 'none') return null;
  return EXTERNAL_VERIFIER_NAMES[s.provider] ?? s.provider;
}
