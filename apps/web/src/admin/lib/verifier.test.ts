import type { ExternalVerifierSettingsDTO } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { buildVerifierPatch, describeVerifierTest, validateVerifierDraft, verifierDraftActivates, verifierDraftDirty, verifierStatus, verifierToDraft } from './verifier';

const OFF: ExternalVerifierSettingsDTO = {
  provider: 'none',
  region: null,
  useEnvCredentials: false,
  accessKeyIdSet: false,
  accessKeyIdHint: null,
  useFor: { checkIn: false, resume: false, suspectedSwap: false },
  active: false,
  enabledAt: null,
};
const CONFIGURED: ExternalVerifierSettingsDTO = { ...OFF, provider: 'aws-rekognition', region: 'eu-west-1', accessKeyIdSet: true, accessKeyIdHint: 'WXYZ' };
const ACTIVE: ExternalVerifierSettingsDTO = { ...CONFIGURED, useFor: { checkIn: true, resume: true, suspectedSwap: false }, active: true, enabledAt: 1_790_000_000_000 };
const KEY = { accessKeyId: 'AKIAEXAMPLE0000WXYZ', secretAccessKey: 'abcdEFGH1234/secret+key0000' };

describe('external verifier card helpers', () => {
  it('starts from the saved settings without any secret', () => {
    expect(verifierToDraft(ACTIVE)).toEqual({ provider: 'aws-rekognition', region: 'eu-west-1', credentialMode: 'key', accessKeyId: '', secretAccessKey: '', clearKey: false, useFor: ACTIVE.useFor });
    expect(verifierToDraft({ ...CONFIGURED, useEnvCredentials: true, accessKeyIdSet: false }).credentialMode).toBe('env');
  });

  it('validates region and credentials (a stored key may be kept)', () => {
    const opts = { keySet: false, envAllowed: false };
    const aws = { ...verifierToDraft(OFF), provider: 'aws-rekognition' as const };
    expect(validateVerifierDraft(verifierToDraft(OFF), opts)).toEqual({});
    expect(validateVerifierDraft(aws, opts)).toEqual({ region: 'Required', accessKeyId: 'Required', secretAccessKey: 'Required' });
    expect(validateVerifierDraft({ ...aws, region: 'Ireland', ...KEY }, opts).region).toMatch(/eu-west-1/);
    expect(validateVerifierDraft({ ...aws, region: 'eu-west-1', ...KEY }, opts)).toEqual({});
    expect(validateVerifierDraft({ ...aws, region: 'us-gov-west-1', ...KEY }, opts)).toEqual({});
    expect(validateVerifierDraft({ ...aws, region: 'eu-west-1', accessKeyId: KEY.accessKeyId }, opts)).toEqual({ secretAccessKey: expect.any(String) });
    expect(validateVerifierDraft({ ...aws, region: 'eu-west-1', ...KEY, accessKeyId: 'akia-lower' }, opts).accessKeyId).toBeDefined();
    expect(validateVerifierDraft({ ...aws, region: 'eu-west-1', ...KEY, secretAccessKey: 'short' }, opts).secretAccessKey).toBeDefined();
    // stored key: blank keeps it, "remove" requires a new one
    const stored = verifierToDraft(CONFIGURED);
    expect(validateVerifierDraft(stored, { keySet: true, envAllowed: false })).toEqual({});
    expect(validateVerifierDraft({ ...stored, clearKey: true }, { keySet: true, envAllowed: false }).accessKeyId).toBe('Required');
    // server credentials only when the server allows them
    expect(validateVerifierDraft({ ...stored, credentialMode: 'env' }, { keySet: true, envAllowed: false }).credentialMode).toBeDefined();
    expect(validateVerifierDraft({ ...stored, credentialMode: 'env' }, { keySet: true, envAllowed: true })).toEqual({});
  });

  it('builds a minimal patch: keys only when entered, clearCredentials only without a new key', () => {
    const stored = verifierToDraft(CONFIGURED);
    expect(buildVerifierPatch(stored)).toEqual({ provider: 'aws-rekognition', region: 'eu-west-1', useEnvCredentials: false, useFor: CONFIGURED.useFor });
    expect(buildVerifierPatch({ ...stored, ...KEY, region: ' eu-central-1 ' })).toMatchObject({ region: 'eu-central-1', ...KEY });
    expect(buildVerifierPatch({ ...stored, clearKey: true })).toMatchObject({ clearCredentials: true });
    expect(buildVerifierPatch({ ...stored, clearKey: true, ...KEY })).not.toHaveProperty('clearCredentials');
    expect(buildVerifierPatch({ ...stored, credentialMode: 'env', ...KEY })).toEqual({ provider: 'aws-rekognition', region: 'eu-west-1', useEnvCredentials: true, useFor: CONFIGURED.useFor });
    expect(buildVerifierPatch({ ...stored, provider: 'none' })).toEqual({ provider: 'none', useFor: CONFIGURED.useFor });
  });

  it('knows when a save starts sending images (confirmation) and when the draft is dirty', () => {
    const d = verifierToDraft(CONFIGURED);
    expect(verifierDraftDirty(d, CONFIGURED)).toBe(false);
    expect(verifierDraftActivates(d, CONFIGURED)).toBe(false);
    const on = { ...d, useFor: { ...d.useFor, suspectedSwap: true } };
    expect(verifierDraftDirty(on, CONFIGURED)).toBe(true);
    expect(verifierDraftActivates(on, CONFIGURED)).toBe(true);
    expect(verifierDraftActivates(verifierToDraft(ACTIVE), ACTIVE)).toBe(false); // already active
    expect(verifierDraftActivates({ ...verifierToDraft(ACTIVE), useFor: { checkIn: true, resume: true, suspectedSwap: true } }, ACTIVE)).toBe(false);
    expect(verifierDraftDirty({ ...d, accessKeyId: 'X' }, CONFIGURED)).toBe(true);
    expect(verifierDraftDirty({ ...verifierToDraft(OFF), region: 'eu-west-1' }, OFF)).toBe(false); // region is irrelevant while off
  });

  it('describes status and test results', () => {
    expect(verifierStatus(OFF)).toEqual({ label: 'Off', tone: 'neutral' });
    expect(verifierStatus(CONFIGURED).label).toMatch(/not used/);
    expect(verifierStatus(ACTIVE)).toEqual({ label: 'Active', tone: 'success' });
    expect(describeVerifierTest({ ok: true, provider: 'aws-rekognition', faceFound: true, similarity: 0.9999, latencyMs: 640, error: null })).toEqual({
      tone: 'success',
      text: 'Connected: the photo compared with itself scored 100.0 % in 640 ms.',
    });
    expect(describeVerifierTest({ ok: true, provider: 'aws-rekognition', faceFound: false, similarity: null, latencyMs: 500, error: null }).tone).toBe('warning');
    expect(describeVerifierTest({ ok: false, provider: 'aws-rekognition', faceFound: false, similarity: null, latencyMs: 90, error: { code: 'auth', message: 'The security token included in the request is invalid.' } })).toEqual({
      tone: 'danger',
      text: 'The provider could not be used (auth): The security token included in the request is invalid.',
    });
  });
});
