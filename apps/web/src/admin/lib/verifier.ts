/** Pure helpers for the external second-opinion verifier card (Integrations page). */
import {
  AWS_REGION_RE,
  EXTERNAL_VERIFIER_NAMES,
  type ExternalVerifierProvider,
  type ExternalVerifierSettingsDTO,
  type ExternalVerifierTestResultDTO,
  type ExternalVerifierUpdate,
  type ExternalVerifierUseFor,
} from '@sp/shared';
import type { Tone } from './integrations';

export interface VerifierDraft {
  provider: ExternalVerifierProvider;
  region: string;
  /** 'key' = a stored access key (IAM user); 'env' = the server's own credentials (IAM role). */
  credentialMode: 'key' | 'env';
  /** New key pair (write-only; blank = keep the stored one). */
  accessKeyId: string;
  secretAccessKey: string;
  /** Remove the stored key without entering a new one. */
  clearKey: boolean;
  useFor: ExternalVerifierUseFor;
}

export const USE_FOR_OPTIONS: { key: keyof ExternalVerifierUseFor; label: string; help: string }[] = [
  { key: 'checkIn', label: 'At check-in', help: 'the readiness check at the start, including the comparison with an approved ID photo' },
  { key: 'resume', label: 'When resuming or reconnecting', help: 'after a pause, a reconnect or a hold' },
  { key: 'suspectedSwap', label: 'When a change of person is suspected', help: 'during the exam, before a “possible different person” event is raised' },
];

export function verifierToDraft(s: ExternalVerifierSettingsDTO): VerifierDraft {
  return {
    provider: s.provider,
    region: s.region ?? '',
    credentialMode: s.useEnvCredentials ? 'env' : 'key',
    accessKeyId: '',
    secretAccessKey: '',
    clearKey: false,
    useFor: { ...s.useFor },
  };
}

const anyUse = (u: ExternalVerifierUseFor) => u.checkIn || u.resume || u.suspectedSwap;

/** Client-side checks, keyed by field (the server validates again). */
export function validateVerifierDraft(d: VerifierDraft, opts: { keySet: boolean; envAllowed: boolean }): Record<string, string> {
  const e: Record<string, string> = {};
  if (d.provider === 'none') return e;
  const region = d.region.trim();
  if (!region) e.region = 'Required';
  else if (!AWS_REGION_RE.test(region)) e.region = 'Enter a region name such as eu-west-1';
  if (d.credentialMode === 'env') {
    if (!opts.envAllowed) e.credentialMode = 'This server does not allow the use of its own AWS credentials';
    return e;
  }
  const id = d.accessKeyId.trim();
  const secret = d.secretAccessKey.trim();
  const needKey = !opts.keySet || d.clearKey;
  if (id || secret) {
    if (!id) e.accessKeyId = 'Enter the access key id with the secret';
    else if (!/^[A-Z0-9]{16,128}$/.test(id)) e.accessKeyId = 'Upper-case letters and digits, e.g. AKIA…';
    if (!secret) e.secretAccessKey = 'Enter the secret access key with the key id';
    else if (secret.length < 16 || /\s/.test(secret)) e.secretAccessKey = 'This does not look like a secret access key';
  } else if (needKey) {
    e.accessKeyId = 'Required';
    e.secretAccessKey = 'Required';
  }
  return e;
}

/** The PUT /settings `externalVerifier` patch for a draft (keys only when entered). */
export function buildVerifierPatch(d: VerifierDraft): ExternalVerifierUpdate {
  if (d.provider === 'none') return { provider: 'none', useFor: { ...d.useFor } };
  const patch: ExternalVerifierUpdate = { provider: d.provider, region: d.region.trim(), useEnvCredentials: d.credentialMode === 'env', useFor: { ...d.useFor } };
  if (d.credentialMode === 'key') {
    const id = d.accessKeyId.trim();
    const secret = d.secretAccessKey.trim();
    if (id && secret) {
      patch.accessKeyId = id;
      patch.secretAccessKey = secret;
    } else if (d.clearKey) {
      patch.clearCredentials = true;
    }
  }
  return patch;
}

/** Something differs from the saved settings. */
export function verifierDraftDirty(d: VerifierDraft, s: ExternalVerifierSettingsDTO): boolean {
  const base = verifierToDraft(s);
  return (
    d.provider !== base.provider ||
    (d.provider !== 'none' && (d.region.trim() !== base.region || d.credentialMode !== base.credentialMode)) ||
    !!d.accessKeyId.trim() ||
    !!d.secretAccessKey.trim() ||
    d.clearKey ||
    JSON.stringify(d.useFor) !== JSON.stringify(base.useFor)
  );
}

/** Saving this draft starts sending face images (ask for confirmation). */
export function verifierDraftActivates(d: VerifierDraft, s: ExternalVerifierSettingsDTO): boolean {
  if (d.provider === 'none' || !anyUse(d.useFor)) return false;
  return !s.active || d.provider !== s.provider;
}

export function verifierStatus(s: ExternalVerifierSettingsDTO): { label: string; tone: Tone } {
  if (s.provider === 'none') return { label: 'Off', tone: 'neutral' };
  if (!s.active) return { label: 'Configured — not used for any check', tone: 'warning' };
  return { label: 'Active', tone: 'success' };
}

export function providerName(p: ExternalVerifierProvider): string {
  return EXTERNAL_VERIFIER_NAMES[p] ?? p;
}

/** One sentence for a test-connection result. */
export function describeVerifierTest(r: ExternalVerifierTestResultDTO): { tone: 'success' | 'warning' | 'danger'; text: string } {
  if (!r.ok) return { tone: 'danger', text: `The provider could not be used (${r.error?.code ?? 'error'}): ${r.error?.message ?? 'unknown error'}` };
  if (!r.faceFound) return { tone: 'warning', text: `Connected (${r.latencyMs} ms), but no face was found in the photo. Try again with a photo of one clear, front-facing face.` };
  const pct = r.similarity != null ? `${(r.similarity * 100).toFixed(1)} %` : 'n/a';
  if (r.similarity != null && r.similarity < 0.9) return { tone: 'warning', text: `Connected (${r.latencyMs} ms), but the photo compared with itself scored only ${pct}. Try a sharper photo.` };
  return { tone: 'success', text: `Connected: the photo compared with itself scored ${pct} in ${r.latencyMs} ms.` };
}
