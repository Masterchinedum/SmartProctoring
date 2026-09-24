/**
 * Organisation settings for the external second-opinion verifier (organizations.settings.externalVerifier).
 *
 * Secrets: the AWS access key pair is stored ENCRYPTED (ctx.keyring, AES-256-GCM, AAD `external-verifier:<orgId>`)
 * as base64 inside the settings JSON, like webhook secrets. It is write-only: responses and audit entries carry only
 * `accessKeyIdSet` and the last 4 characters of the key id. services/rekey.ts re-encrypts it after a key rotation
 * (target `external_verifier_credentials`).
 */
import {
  externalVerifierNoticeName,
  type ExternalVerifierProvider,
  type ExternalVerifierSettingsDTO,
  type ExternalVerifierUpdate,
  type ExternalVerifierUseFor,
} from '@sp/shared';
import type { ExternalVerifiersConfig } from '../config.js';
import type { Keyring } from '../lib/crypto.js';
import type { SecondOpinionKind } from './types.js';

export interface ExternalVerifierStoredSettings {
  provider: ExternalVerifierProvider;
  region: string | null;
  useEnvCredentials: boolean;
  /** base64(keyring.encrypt(JSON {accessKeyId, secretAccessKey}, `external-verifier:<orgId>`)), or null. */
  credentialsEnc: string | null;
  /** Last 4 characters of the stored access key id (display only). */
  accessKeyIdHint: string | null;
  useFor: ExternalVerifierUseFor;
  /** Epoch ms when the current provider became active; null while inactive. */
  enabledAt: number | null;
}

export interface VerifierCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export const DEFAULT_EXTERNAL_VERIFIER_SETTINGS: ExternalVerifierStoredSettings = {
  provider: 'none',
  region: null,
  useEnvCredentials: false,
  credentialsEnc: null,
  accessKeyIdHint: null,
  useFor: { checkIn: false, resume: false, suspectedSwap: false },
  enabledAt: null,
};

/** Stored (possibly partial / older) value with every field filled. */
export function normalizeExternalVerifierSettings(s: Partial<ExternalVerifierStoredSettings> | null | undefined): ExternalVerifierStoredSettings {
  const d = DEFAULT_EXTERNAL_VERIFIER_SETTINGS;
  if (!s || typeof s !== 'object') return { ...d, useFor: { ...d.useFor } };
  return {
    provider: typeof s.provider === 'string' ? s.provider : d.provider,
    region: typeof s.region === 'string' && s.region ? s.region : null,
    useEnvCredentials: s.useEnvCredentials === true,
    credentialsEnc: typeof s.credentialsEnc === 'string' && s.credentialsEnc ? s.credentialsEnc : null,
    accessKeyIdHint: typeof s.accessKeyIdHint === 'string' ? s.accessKeyIdHint : null,
    useFor: {
      checkIn: s.useFor?.checkIn === true,
      resume: s.useFor?.resume === true,
      suspectedSwap: s.useFor?.suspectedSwap === true,
    },
    enabledAt: typeof s.enabledAt === 'number' ? s.enabledAt : null,
  };
}

/** Images may be sent: a provider is chosen and at least one use is on. */
export function isExternalVerifierActive(s: Pick<ExternalVerifierStoredSettings, 'provider' | 'useFor'>): boolean {
  return s.provider !== 'none' && (s.useFor.checkIn || s.useFor.resume || s.useFor.suspectedSwap);
}

export const USE_FOR_KEY: Record<SecondOpinionKind, keyof ExternalVerifierUseFor> = {
  check_in: 'checkIn',
  resume: 'resume',
  suspected_swap: 'suspectedSwap',
};

export function toExternalVerifierDTO(s: ExternalVerifierStoredSettings): ExternalVerifierSettingsDTO {
  return {
    provider: s.provider,
    region: s.region,
    useEnvCredentials: s.useEnvCredentials,
    accessKeyIdSet: !!s.credentialsEnc,
    accessKeyIdHint: s.credentialsEnc ? s.accessKeyIdHint : null,
    useFor: { ...s.useFor },
    active: isExternalVerifierActive(s),
    enabledAt: s.enabledAt,
  };
}

/** Provider name for the candidate privacy notice, or null when inactive. */
export function externalVerifierNoticeNameFor(s: ExternalVerifierStoredSettings): string | null {
  return externalVerifierNoticeName({ provider: s.provider, active: isExternalVerifierActive(s) });
}

/* ------------------------------------------------------------------ secrets */

export const verifierCredentialsAad = (orgId: string) => `external-verifier:${orgId}`;

export function encryptVerifierCredentials(keyring: Pick<Keyring, 'encryptString'>, orgId: string, c: VerifierCredentials): string {
  return keyring.encryptString(JSON.stringify({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }), verifierCredentialsAad(orgId)).toString('base64');
}

/** Throws when the value cannot be decrypted (wrong / retired key, tampering, other organisation). */
export function decryptVerifierCredentials(keyring: Pick<Keyring, 'decryptString'>, orgId: string, enc: string): VerifierCredentials {
  const parsed = JSON.parse(keyring.decryptString(Buffer.from(enc, 'base64'), verifierCredentialsAad(orgId))) as Partial<VerifierCredentials>;
  if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') throw new Error('Malformed verifier credentials');
  return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey };
}

/* ------------------------------------------------------------------ updates (PUT /api/admin/settings) */

export interface ExternalVerifierUpdateResult {
  next: ExternalVerifierStoredSettings;
  issues: { path: string; message: string }[];
  credentials: 'set' | 'removed' | 'unchanged';
}

/**
 * Apply a validated `externalVerifier` patch to the current (normalised) settings. Returns the value to store and
 * validation issues (paths `externalVerifier.<field>`); the caller rejects the whole update when there are issues.
 */
export function applyExternalVerifierUpdate(
  deps: { keyring: Pick<Keyring, 'encryptString'>; config: ExternalVerifiersConfig; orgId: string; now: number },
  cur: ExternalVerifierStoredSettings,
  patch: ExternalVerifierUpdate,
): ExternalVerifierUpdateResult {
  const issues: ExternalVerifierUpdateResult['issues'] = [];
  const at = (field: string, message: string) => issues.push({ path: `externalVerifier.${field}`, message });
  const next: ExternalVerifierStoredSettings = { ...cur, useFor: { ...cur.useFor } };
  let credentials: ExternalVerifierUpdateResult['credentials'] = 'unchanged';
  const hadKey = !!cur.credentialsEnc;
  const removeKey = () => {
    next.credentialsEnc = null;
    next.accessKeyIdHint = null;
  };

  if (patch.provider !== undefined) next.provider = patch.provider;
  if (patch.region !== undefined) next.region = patch.region || null;
  if (patch.useEnvCredentials !== undefined) next.useEnvCredentials = patch.useEnvCredentials;
  if (patch.useFor) for (const [k, v] of Object.entries(patch.useFor)) if (v !== undefined) next.useFor[k as keyof ExternalVerifierUseFor] = v;

  const keyGiven = patch.accessKeyId !== undefined || patch.secretAccessKey !== undefined;
  if (keyGiven && (patch.accessKeyId === undefined || patch.secretAccessKey === undefined)) {
    at(patch.accessKeyId === undefined ? 'accessKeyId' : 'secretAccessKey', 'Enter the access key id and the secret access key together');
  } else if (keyGiven) {
    if (next.provider === 'none') at('provider', 'Choose a provider before entering its credentials');
    else if (next.useEnvCredentials) at('useEnvCredentials', "Use either a stored access key or the server's credentials, not both");
    else {
      next.credentialsEnc = encryptVerifierCredentials(deps.keyring, deps.orgId, { accessKeyId: patch.accessKeyId!, secretAccessKey: patch.secretAccessKey! });
      next.accessKeyIdHint = patch.accessKeyId!.slice(-4);
      credentials = 'set';
    }
  }
  // Keys are removed on request, when the provider is switched off, and when the server's credentials are used.
  if (patch.clearCredentials === true && keyGiven) at('clearCredentials', 'Either remove the stored key or enter a new one');
  if (credentials !== 'set' && (patch.clearCredentials === true || next.provider === 'none' || next.useEnvCredentials)) removeKey();
  if (hadKey && !next.credentialsEnc) credentials = 'removed';

  const enabling = (patch.provider !== undefined && patch.provider !== 'none') || Object.values(patch.useFor ?? {}).some((v) => v === true);
  if (next.provider !== 'none') {
    if (enabling && !deps.config.allowedProviders.includes(next.provider)) at('provider', 'This provider is not available on this server (EXTERNAL_VERIFIERS)');
    if (next.provider === 'aws-rekognition') {
      if (!next.region) at('region', 'Choose the AWS region (e.g. eu-west-1)');
      if (patch.useEnvCredentials === true && !deps.config.allowEnvCredentials) {
        at('useEnvCredentials', "This server does not allow organisations to use its own AWS credentials (EXTERNAL_VERIFIER_ENV_CREDENTIALS); enter an access key");
      } else if (!next.useEnvCredentials && !next.credentialsEnc && !issues.some((i) => i.path.endsWith('accessKeyId') || i.path.endsWith('secretAccessKey'))) {
        at('accessKeyId', "Enter an access key id and secret access key (IAM permission rekognition:CompareFaces), or use the server's credentials");
      }
    }
  }

  const wasActive = isExternalVerifierActive(cur);
  const isActive = isExternalVerifierActive(next);
  if (!isActive) next.enabledAt = null;
  else if (!wasActive || cur.provider !== next.provider || cur.enabledAt == null) next.enabledAt = deps.now;
  return { next, issues, credentials };
}

function summary(s: ExternalVerifierStoredSettings) {
  return { provider: s.provider, region: s.region, useEnvCredentials: s.useEnvCredentials, credentialsSet: !!s.credentialsEnc, useFor: { ...s.useFor }, active: isExternalVerifierActive(s) };
}

/** `settings.updated` audit meta for the verifier (never the key or its ciphertext). */
export function externalVerifierAuditMeta(cur: ExternalVerifierStoredSettings, next: ExternalVerifierStoredSettings, credentials: ExternalVerifierUpdateResult['credentials']) {
  return { from: summary(cur), to: summary(next), credentials };
}
