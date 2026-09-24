/**
 * External second-opinion verifier: organisation settings (validation, write-only secrets, audit), the staff
 * "test connection" endpoint with a mocked Rekognition client, the candidate privacy notice, and the
 * maybeExternalSecondOpinion() seam (consent gate, fail open).
 */
import type { AuditLogEntryDTO, ExternalVerifierInfoDTO, ExternalVerifierTestResultDTO, OrgSettingsDTO, PrivacyNoticeDTO } from '@sp/shared';
import { eq } from 'drizzle-orm';
import { AccessDeniedException } from '@aws-sdk/client-rekognition';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations } from '../../src/db/schema.js';
import { orgSettings } from '../../src/services/org.js';
import { fuseWithExternal, fusionPolicyFor, maybeExternalSecondOpinion } from '../../src/verifiers/index.js';
import { awsRekognitionProvider, VerifierRegistry } from '../../src/verifiers/registry.js';
import { decryptVerifierCredentials } from '../../src/verifiers/settings.js';
import { json, otherOrg, staffApi, type Api } from '../admin/fixtures.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { faceMatch, MockRekognition, never } from './mock-rekognition.js';
import { FakeVisionService } from '../../src/vision/fake.js';

const ACCESS_KEY_ID = 'AKIATESTEXAMPLE7Q2W';
const SECRET = 'tEsT/Secret+AccessKey0123456789abcdefWXYZ';
const JPEG = FakeVisionService.encode({ person: 'alice' });

let env: TestEnv;
let admin: Api;
let reviewer: Api;
let mock: MockRekognition;

const awsWithKey = { provider: 'aws-rekognition', region: 'eu-west-1', accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET } as const;
const settingsRow = async () => (await env.ctx.db.select().from(organizations).where(eq(organizations.id, env.org.id)))[0];
const auditOf = async (action: string) => json<{ items: AuditLogEntryDTO[] }>(await admin.get('/audit-log', { action })).items;

beforeAll(async () => {
  env = await createTestEnv();
  admin = await staffApi(env, 'admin');
  reviewer = await staffApi(env, 'reviewer');
  mock = new MockRekognition(() => faceMatch(99.9));
  env.ctx.verifiers = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: (cfg) => mock.factory(cfg), retryBackoffMs: 1 })] });
});
afterAll(async () => env?.close());

describe('externalVerifier settings', () => {
  it('is off by default: provider none, nothing active, no key', async () => {
    const s = json<OrgSettingsDTO>(await admin.get('/settings'));
    expect(s.externalVerifier).toEqual({
      provider: 'none',
      region: null,
      useEnvCredentials: false,
      accessKeyIdSet: false,
      accessKeyIdHint: null,
      useFor: { checkIn: false, resume: false, suspectedSwap: false },
      active: false,
      enabledAt: null,
    });
    const info = json<ExternalVerifierInfoDTO>(await admin.get('/verifiers'));
    expect(info).toEqual({ providers: [{ id: 'aws-rekognition', name: 'Amazon Rekognition (Amazon Web Services)', location: 'cloud', available: true }], envCredentialsAllowed: false, timeoutMs: 4000 });
  });

  it('validates provider, region and credentials (nothing stored on error)', async () => {
    const issues = async (externalVerifier: unknown) => {
      const r = await admin.put('/settings', { externalVerifier });
      expect(r.statusCode, r.body).toBe(400);
      return (r.json().details as { path: string }[]).map((d) => d.path);
    };
    expect(await issues({ provider: 'aws-rekognition' })).toEqual(expect.arrayContaining(['externalVerifier.region', 'externalVerifier.accessKeyId']));
    expect(await issues({ provider: 'aws-rekognition', region: 'eu-west-1' })).toEqual(['externalVerifier.accessKeyId']);
    expect(await issues({ provider: 'aws-rekognition', region: 'eu-west-1', accessKeyId: ACCESS_KEY_ID })).toEqual(['externalVerifier.secretAccessKey']);
    expect(await issues({ provider: 'aws-rekognition', region: 'Frankfurt', accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET })).toEqual(['externalVerifier.region']);
    expect(await issues({ provider: 'aws-rekognition', region: 'eu-west-1', accessKeyId: 'akia-lower', secretAccessKey: SECRET })).toEqual(['externalVerifier.accessKeyId']);
    expect(await issues({ provider: 'aws-rekognition', region: 'eu-west-1', useEnvCredentials: true })).toEqual(['externalVerifier.useEnvCredentials']);
    expect(await issues({ provider: 'azure-face' })).toEqual(['externalVerifier.provider']);
    expect(await issues({ provider: 'none', accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET })).toEqual(['externalVerifier.provider']);
    expect(await issues({ ...awsWithKey, clearCredentials: true })).toEqual(['externalVerifier.clearCredentials']);
    expect(await issues({ ...awsWithKey, apiEndpoint: 'https://evil.example' })).toEqual(['externalVerifier']); // strict: unknown keys refused
    expect((await reviewer.put('/settings', { externalVerifier: awsWithKey })).statusCode).toBe(403);
    expect((await settingsRow()).settings.externalVerifier).toBeUndefined();
    expect(await auditOf('settings.')).toHaveLength(0);
  });

  it('stores the key pair encrypted, never returns or audits it, and audits the change', async () => {
    const s = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: awsWithKey }));
    expect(s.externalVerifier).toEqual({
      provider: 'aws-rekognition',
      region: 'eu-west-1',
      useEnvCredentials: false,
      accessKeyIdSet: true,
      accessKeyIdHint: '7Q2W',
      useFor: { checkIn: false, resume: false, suspectedSwap: false },
      active: false, // configured, but not used for any decision yet
      enabledAt: null,
    });
    const row = await settingsRow();
    const raw = JSON.stringify(row.settings);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(ACCESS_KEY_ID);
    const enc = row.settings.externalVerifier!.credentialsEnc!;
    expect(decryptVerifierCredentials(env.ctx.keyring, env.org.id, enc)).toEqual({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET });
    // bound to this organisation (AAD)
    expect(() => decryptVerifierCredentials(env.ctx.keyring, '00000000-0000-4000-8000-000000000000', enc)).toThrow();

    const get = await admin.get('/settings');
    expect(get.body).not.toContain(SECRET);
    expect(get.body).not.toContain(ACCESS_KEY_ID);
    const [entry] = await auditOf('settings.');
    expect(entry.meta.fields).toEqual(['externalVerifier']);
    expect(entry.meta.externalVerifier).toEqual({
      from: { provider: 'none', region: null, useEnvCredentials: false, credentialsSet: false, useFor: { checkIn: false, resume: false, suspectedSwap: false }, active: false },
      to: { provider: 'aws-rekognition', region: 'eu-west-1', useEnvCredentials: false, credentialsSet: true, useFor: { checkIn: false, resume: false, suspectedSwap: false }, active: false },
      credentials: 'set',
    });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain(enc);

    // partial updates keep the stored key (write-only: omitted = unchanged)
    const again = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: { region: 'eu-central-1' } }));
    expect(again.externalVerifier).toMatchObject({ region: 'eu-central-1', accessKeyIdSet: true });
    expect((await settingsRow()).settings.externalVerifier!.credentialsEnc).toBe(enc);
  });

  it('records when it becomes active (consent gate) and keeps that time while the provider stays the same', async () => {
    env.clock.advance(60_000);
    const t1 = env.clock.t;
    const on = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: { useFor: { checkIn: true, resume: true } } }));
    expect(on.externalVerifier).toMatchObject({ active: true, enabledAt: t1, useFor: { checkIn: true, resume: true, suspectedSwap: false } });
    env.clock.advance(60_000);
    const more = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: { useFor: { suspectedSwap: true } }, privacyContact: 'dpo@test.example' }));
    expect(more.externalVerifier.enabledAt).toBe(t1); // still the same provider: unchanged
    const [entry] = await auditOf('settings.');
    expect(entry.meta.fields).toEqual(expect.arrayContaining(['privacyContact', 'externalVerifier']));
    expect(entry.meta.externalVerifier).toMatchObject({ credentials: 'unchanged', to: { active: true, useFor: { suspectedSwap: true } } });
  });
});

describe('candidate privacy notice', () => {
  const notice = async () => json<PrivacyNoticeDTO>(await env.app.inject({ method: 'GET', url: `/api/public/privacy-notice?token=${env.session.token}` }));

  it('names the provider while it is active, and not otherwise', async () => {
    const n = await notice();
    const line = n.monitored.find((m) => m.includes('Amazon Rekognition'));
    expect(line).toMatch(/may be sent to Amazon Rekognition \(Amazon Web Services\), an external face-comparison service used by Test University/);
    expect(line).toContain('never decides on its own that you are a different person');
    expect(n.sections.find((s) => s.heading === 'Who can see your data')!.body).toContain('also processed by Amazon Rekognition');

    const saved = (await settingsRow()).settings.externalVerifier!;
    await env.ctx.db
      .update(organizations)
      .set({ settings: { ...(await settingsRow()).settings, externalVerifier: { ...saved, useFor: { checkIn: false, resume: false, suspectedSwap: false } } } })
      .where(eq(organizations.id, env.org.id));
    const off = await notice();
    expect(JSON.stringify(off)).not.toContain('Rekognition');
    expect(JSON.stringify(off)).not.toContain('external face-comparison');
    await env.ctx.db
      .update(organizations)
      .set({ settings: { ...(await settingsRow()).settings, externalVerifier: saved } })
      .where(eq(organizations.id, env.org.id));
    expect(JSON.stringify(await notice())).toContain('Rekognition');
  });
});

describe('POST /verifiers/test (mocked Rekognition)', () => {
  it('compares the uploaded image with itself using the saved settings, and audits it', async () => {
    mock.handler = () => faceMatch(99.99);
    const before = mock.inputs.length;
    const r = json<ExternalVerifierTestResultDTO>(await admin.jpeg('/verifiers/test', JPEG, 'POST'));
    expect(r).toMatchObject({ ok: true, provider: 'aws-rekognition', faceFound: true, similarity: 0.9999, error: null });
    expect(mock.inputs.length).toBe(before + 1);
    const input = mock.inputs.at(-1)!;
    expect(Buffer.from(input.SourceImage!.Bytes!).equals(JPEG)).toBe(true);
    expect(Buffer.from(input.TargetImage!.Bytes!).equals(JPEG)).toBe(true);
    expect(mock.configs.at(-1)).toEqual({ region: 'eu-central-1', credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET } });
    const [entry] = await auditOf('external_verifier.');
    expect(entry).toMatchObject({ action: 'external_verifier.tested', targetType: 'organization', meta: { provider: 'aws-rekognition', region: 'eu-central-1', ok: true, faceFound: true, error: null } });
  });

  it('reports provider errors (fail open) instead of throwing', async () => {
    env.clock.advance(1000); // audit entries are listed newest first
    mock.handler = () => {
      throw new AccessDeniedException({ message: 'User is not authorized to perform: rekognition:CompareFaces', $metadata: { httpStatusCode: 403 } });
    };
    const r = json<ExternalVerifierTestResultDTO>(await admin.jpeg('/verifiers/test', JPEG, 'POST'));
    expect(r).toMatchObject({ ok: false, faceFound: false, similarity: null, error: { code: 'auth', message: expect.stringContaining('rekognition:CompareFaces') } });
    expect((await auditOf('external_verifier.'))[0].meta).toMatchObject({ ok: false, error: 'auth' });
    mock.handler = () => faceMatch(99.9);
  });

  it('requires an admin, a JPEG and a configured provider', async () => {
    expect((await reviewer.jpeg('/verifiers/test', JPEG, 'POST')).statusCode).toBe(403);
    expect((await reviewer.get('/verifiers')).statusCode).toBe(403);
    expect((await admin.jpeg('/verifiers/test', Buffer.from('not a jpeg'), 'POST')).statusCode).toBe(415);
    expect((await admin.post('/verifiers/test', { image: 'x' })).statusCode).toBe(415);
    const other = await otherOrg(env);
    const res = await other.api.jpeg('/verifiers/test', JPEG, 'POST');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('verifier_not_configured');
  });
});

describe('maybeExternalSecondOpinion (integration seam)', () => {
  const images = { reference: [Buffer.from('ref-jpeg')], probe: Buffer.from('probe-jpeg') };

  it('asks the provider only for enabled decision points and candidates who consented after enablement', async () => {
    const org = (await settingsRow()) as typeof env.org;
    const enabledAt = orgSettings(org).externalVerifier.enabledAt!;
    const after = new Date(enabledAt + 1000);
    mock.handler = () => faceMatch(98.5);
    const n0 = mock.inputs.length;
    const ok = await maybeExternalSecondOpinion(env.ctx, env.org.id, 'resume', images, { consentAcceptedAt: after, sessionId: env.session.id });
    expect(ok).toMatchObject({ status: 'ok', provider: 'aws-rekognition', kind: 'resume', similarity: 0.985, faceFound: true, faceCount: 1 });
    expect(mock.inputs.length).toBe(n0 + 1);
    // accepts the org row too (no extra query) and epoch-ms consent times
    expect(await maybeExternalSecondOpinion(env.ctx, org, 'suspected_swap', images, { consentAcceptedAt: enabledAt })).toMatchObject({ status: 'ok' });

    // consent before enablement (the candidate's notice did not name the provider) / missing consent
    expect(await maybeExternalSecondOpinion(env.ctx, org, 'resume', images, { consentAcceptedAt: enabledAt - 1 })).toBeNull();
    expect(await maybeExternalSecondOpinion(env.ctx, org, 'resume', images, { consentAcceptedAt: null })).toBeNull();
    // no images
    expect(await maybeExternalSecondOpinion(env.ctx, org, 'resume', { reference: [], probe: images.probe }, { consentAcceptedAt: after })).toBeNull();
    // provider disabled server-wide
    const cfg = env.ctx.config.externalVerifiers;
    env.ctx.config.externalVerifiers = { ...cfg, allowedProviders: [] };
    try {
      expect(await maybeExternalSecondOpinion(env.ctx, org, 'resume', images, { consentAcceptedAt: after })).toBeNull();
    } finally {
      env.ctx.config.externalVerifiers = cfg;
    }
    expect(mock.inputs.length).toBe(n0 + 2);
  });

  it('returns null when the decision point is not enabled or nothing is configured', async () => {
    const org = (await settingsRow()) as typeof env.org;
    const s = orgSettings(org).externalVerifier;
    const only = { ...org, settings: { ...org.settings, externalVerifier: { ...s, useFor: { checkIn: true, resume: false, suspectedSwap: false } } } };
    const n0 = mock.inputs.length;
    expect(await maybeExternalSecondOpinion(env.ctx, only, 'resume', images, { consentAcceptedAt: Date.now() + 1e12 })).toBeNull();
    expect(await maybeExternalSecondOpinion(env.ctx, only, 'suspected_swap', images, { consentAcceptedAt: Date.now() + 1e12 })).toBeNull();
    const other = await otherOrg(env);
    expect(await maybeExternalSecondOpinion(env.ctx, other.org.id, 'check_in', images, { consentAcceptedAt: Date.now() })).toBeNull();
    expect(await maybeExternalSecondOpinion(env.ctx, '00000000-0000-4000-8000-00000000abcd', 'check_in', images, { consentAcceptedAt: Date.now() })).toBeNull();
    expect(mock.inputs.length).toBe(n0);
  });

  it('fails open: a provider failure becomes an error opinion and the internal decision stands', async () => {
    const org = (await settingsRow()) as typeof env.org;
    const consentAcceptedAt = orgSettings(org).externalVerifier.enabledAt! + 1;
    mock.handler = () => never();
    const timedOut = await maybeExternalSecondOpinion(env.ctx, org, 'suspected_swap', images, { consentAcceptedAt, timeoutMs: 50 });
    expect(timedOut).toMatchObject({ status: 'error', provider: 'aws-rekognition', error: 'timeout', kind: 'suspected_swap' });
    const fused = fuseWithExternal({ decision: 'mismatch', similarity: 0.12 }, timedOut, fusionPolicyFor({ match: 0.45, mismatch: 0.28 }));
    expect(fused).toMatchObject({ decision: 'mismatch', needsHumanReview: false, outcome: 'external_unusable' });
    expect(fused.explanation).toContain('could not be asked (timeout');
    mock.handler = () => faceMatch(99.9);
  });
});

describe('switching off', () => {
  it('provider none removes the stored key and deactivates; audit says removed', async () => {
    env.clock.advance(1000);
    const s = json<OrgSettingsDTO>(await admin.put('/settings', { externalVerifier: { provider: 'none' } }));
    expect(s.externalVerifier).toMatchObject({ provider: 'none', accessKeyIdSet: false, accessKeyIdHint: null, active: false, enabledAt: null });
    expect((await settingsRow()).settings.externalVerifier!.credentialsEnc).toBeNull();
    const [entry] = await auditOf('settings.');
    expect(entry.meta.externalVerifier).toMatchObject({ credentials: 'removed', to: { provider: 'none', active: false } });
    expect(await maybeExternalSecondOpinion(env.ctx, env.org.id, 'resume', { reference: [JPEG], probe: JPEG }, { consentAcceptedAt: Date.now() + 1e12 })).toBeNull();
  });
});

describe('server-level switches', () => {
  it('EXTERNAL_VERIFIERS=none refuses the provider; EXTERNAL_VERIFIER_ENV_CREDENTIALS allows the server credential chain', async () => {
    const off = await createTestEnv({ env: { EXTERNAL_VERIFIERS: 'none' } });
    try {
      const a = await staffApi(off, 'admin');
      const r = await a.put('/settings', { externalVerifier: { ...awsWithKey, useFor: { checkIn: true } } });
      expect(r.statusCode).toBe(400);
      expect(r.json().details).toEqual([{ path: 'externalVerifier.provider', message: expect.stringMatching(/not available on this server/) }]);
      expect(json<ExternalVerifierInfoDTO>(await a.get('/verifiers')).providers[0].available).toBe(false);
    } finally {
      await off.close();
    }
    const envCreds = await createTestEnv({ env: { EXTERNAL_VERIFIER_ENV_CREDENTIALS: 'true', EXTERNAL_VERIFIER_TIMEOUT_MS: '2500' } });
    try {
      const m = new MockRekognition(() => faceMatch(99));
      envCreds.ctx.verifiers = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: m.factory })] });
      const a = await staffApi(envCreds, 'admin');
      const s = json<OrgSettingsDTO>(await a.put('/settings', { externalVerifier: { provider: 'aws-rekognition', region: 'us-east-1', useEnvCredentials: true, useFor: { checkIn: true } } }));
      expect(s.externalVerifier).toMatchObject({ useEnvCredentials: true, accessKeyIdSet: false, active: true });
      expect(json<ExternalVerifierInfoDTO>(await a.get('/verifiers'))).toMatchObject({ envCredentialsAllowed: true, timeoutMs: 2500 });
      expect(json<ExternalVerifierTestResultDTO>(await a.jpeg('/verifiers/test', JPEG, 'POST')).ok).toBe(true);
      expect(m.configs).toEqual([{ region: 'us-east-1', credentials: null }]);
      // a stored key and the server's credentials are exclusive
      expect((await a.put('/settings', { externalVerifier: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET } })).json().details[0].path).toBe('externalVerifier.useEnvCredentials');
    } finally {
      await envCreds.close();
    }
  });
});
