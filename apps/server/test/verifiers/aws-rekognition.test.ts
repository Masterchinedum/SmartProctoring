/**
 * AWS Rekognition provider with a mocked Rekognition client (AWS is not reachable from CI; see
 * docs/EXTERNAL_VERIFIER.md §8 for a live smoke test with real credentials), and the registry around it
 * (credentials, caching, circuit breaker).
 */
import { AccessDeniedException, ImageTooLargeException, InternalServerError, InvalidParameterException, ProvisionedThroughputExceededException, ThrottlingException } from '@aws-sdk/client-rekognition';
import { describe, expect, it } from 'vitest';
import type { ExternalVerifiersConfig } from '../../src/config.js';
import { createKeyring } from '../../src/lib/crypto.js';
import { AwsRekognitionVerifier, classifyAwsError, mapCompareFacesOutput } from '../../src/verifiers/aws-rekognition.js';
import { awsRekognitionProvider, VerifierRegistry } from '../../src/verifiers/registry.js';
import { DEFAULT_EXTERNAL_VERIFIER_SETTINGS, encryptVerifierCredentials, type ExternalVerifierStoredSettings } from '../../src/verifiers/settings.js';
import { ExternalVerifierError } from '../../src/verifiers/types.js';
import { awsError, faceMatch, faceMatches, MockRekognition, never, noFacesFound, untilAborted } from './mock-rekognition.js';

const REF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PROBE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const CREDS = { accessKeyId: 'AKIAEXAMPLEKEY12345', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

function verifier(mock: MockRekognition, opts: { timeoutMs?: number; backoff?: number } = {}) {
  return new AwsRekognitionVerifier({ region: 'eu-west-1', credentials: CREDS, defaultTimeoutMs: opts.timeoutMs ?? 4000, createClient: mock.factory, retryBackoffMs: opts.backoff ?? 1 });
}

async function rejection(p: Promise<unknown>): Promise<ExternalVerifierError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExternalVerifierError);
  return err as ExternalVerifierError;
}

describe('AwsRekognitionVerifier', () => {
  it('calls CompareFaces with the first reference as source, threshold 0 and QualityFilter AUTO; maps 0–100 to 0..1', async () => {
    const mock = new MockRekognition(() => faceMatch(99.46));
    const v = verifier(mock);
    const r = await v.compare({ reference: [REF, Buffer.from('second')], probe: PROBE });
    expect(mock.inputs).toHaveLength(1);
    expect(mock.inputs[0]).toEqual({ SourceImage: { Bytes: REF }, TargetImage: { Bytes: PROBE }, SimilarityThreshold: 0, QualityFilter: 'AUTO' });
    expect(mock.configs).toEqual([{ region: 'eu-west-1', credentials: CREDS }]);
    expect(r).toMatchObject({ similarity: 0.9946, faceFound: true, faceCount: 1 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    // raw is sanitised: counts and scores only (no bytes, boxes, landmarks or poses)
    expect(r.raw).toEqual({ faceMatches: 1, unmatchedFaces: 0, similarities: [99.46], sourceFaceConfidence: 99.9, attempts: 1 });
    expect(mock.signals[0]).toBeInstanceOf(AbortSignal);
    // the client is created once and reused
    await v.compare({ reference: [REF], probe: PROBE });
    expect(mock.configs).toHaveLength(1);
    v.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.destroyed).toBe(1);
  });

  it('reports the largest face when the probe shows several faces', async () => {
    const mock = new MockRekognition(() => faceMatches([12, 0.1], [98, 0.45], [40, 0.2]));
    const r = await verifier(mock).compare({ reference: [REF], probe: PROBE });
    expect(r).toMatchObject({ similarity: 0.98, faceFound: true, faceCount: 3 });
    expect(mapCompareFacesOutput(faceMatches([97, 0.1], [3, 0.5]), 5, 1)).toMatchObject({ similarity: 0.03, faceCount: 2 });
  });

  it('maps "no face" (InvalidParameterException or empty face lists) to faceFound=false', async () => {
    const invalid = new MockRekognition(() => {
      throw new InvalidParameterException({ message: 'Request has invalid parameters', $metadata: {} });
    });
    expect(await verifier(invalid).compare({ reference: [REF], probe: PROBE })).toMatchObject({ faceFound: false, similarity: 0, faceCount: 0, raw: { reason: 'no_face_detected' } });
    expect(invalid.inputs).toHaveLength(1); // not retried
    const empty = new MockRekognition(() => noFacesFound());
    expect(await verifier(empty).compare({ reference: [REF], probe: PROBE })).toMatchObject({ faceFound: false, similarity: 0, faceCount: 0 });
  });

  it('retries a throttled call once with backoff, then gives up', async () => {
    const once = new MockRekognition((_, call) => {
      if (call === 1) throw new ThrottlingException({ message: 'Rate exceeded', $metadata: { httpStatusCode: 400 } });
      return faceMatch(97);
    });
    const r = await verifier(once, { backoff: 5 }).compare({ reference: [REF], probe: PROBE });
    expect(r).toMatchObject({ similarity: 0.97, raw: { attempts: 2 } });
    expect(once.inputs).toHaveLength(2);

    const always = new MockRekognition(() => {
      throw new ProvisionedThroughputExceededException({ message: 'Provisioned rate exceeded', $metadata: {} });
    });
    const err = await rejection(verifier(always).compare({ reference: [REF], probe: PROBE }));
    expect(err.code).toBe('throttled');
    expect(err.message).toContain('ProvisionedThroughputExceededException');
    expect(always.inputs).toHaveLength(2);

    // HTTP 429 without a known exception name is throttling too
    expect(classifyAwsError(awsError('SomethingNew', 'slow down', 429))).toBe('throttled');
  });

  it('does not retry when the backoff would not fit in the deadline', async () => {
    const mock = new MockRekognition(() => {
      throw new ThrottlingException({ message: 'Rate exceeded', $metadata: {} });
    });
    const err = await rejection(verifier(mock, { backoff: 10_000, timeoutMs: 200 }).compare({ reference: [REF], probe: PROBE }));
    expect(err.code).toBe('throttled');
    expect(mock.inputs).toHaveLength(1);
  });

  it('times out (default 4 s, per call override) even when the client ignores the abort signal', async () => {
    const stuck = new MockRekognition(() => never());
    const t0 = Date.now();
    const err = await rejection(verifier(stuck).compare({ reference: [REF], probe: PROBE }, { timeoutMs: 60 }));
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('No answer within 60 ms');
    expect(err.latencyMs).toBeGreaterThanOrEqual(50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(stuck.signals[0]?.aborted).toBe(true);

    const polite = new MockRekognition((_, __, signal) => untilAborted(signal));
    expect((await rejection(verifier(polite, { timeoutMs: 40 }).compare({ reference: [REF], probe: PROBE }))).code).toBe('timeout');
    expect(new AwsRekognitionVerifier({ region: 'eu-west-1', credentials: null, defaultTimeoutMs: 4000 })).toBeDefined();
  });

  it('classifies auth, image, network and provider errors (no retry) and fails open to the caller', async () => {
    const cases: [unknown, string][] = [
      [new AccessDeniedException({ message: 'User: arn:aws:iam::123456789012:user/x is not authorized to perform: rekognition:CompareFaces', $metadata: { httpStatusCode: 403 } }), 'auth'],
      [awsError('UnrecognizedClientException', 'The security token included in the request is invalid.'), 'auth'],
      [awsError('InvalidSignatureException', 'Signature expired'), 'auth'],
      [Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' }), 'auth'],
      [new ImageTooLargeException({ message: 'Image size is too large.', $metadata: {} }), 'invalid_image'],
      [Object.assign(new Error('getaddrinfo ENOTFOUND rekognition.eu-west-1.amazonaws.com'), { code: 'ENOTFOUND' }), 'network'],
      [new InternalServerError({ message: 'Internal server error', $metadata: { httpStatusCode: 500 } }), 'provider_error'],
    ];
    for (const [thrown, code] of cases) {
      const mock = new MockRekognition(() => {
        throw thrown;
      });
      const err = await rejection(verifier(mock).compare({ reference: [REF], probe: PROBE }));
      expect(err.code, String((thrown as Error).name)).toBe(code);
      expect(mock.inputs).toHaveLength(1);
      // never echoes credentials
      expect(err.message).not.toContain(CREDS.secretAccessKey);
      expect(err.message.length).toBeLessThanOrEqual(300);
    }
    // a client factory that fails (e.g. SDK credential resolution) is an error too, and is retried on the next call
    let calls = 0;
    const flaky = new AwsRekognitionVerifier({
      region: 'eu-west-1',
      credentials: CREDS,
      defaultTimeoutMs: 1000,
      createClient: () => {
        calls++;
        if (calls === 1) throw awsError('CredentialsProviderError', 'no credentials');
        return new MockRekognition(() => faceMatch(99));
      },
    });
    expect((await rejection(flaky.compare({ reference: [REF], probe: PROBE }))).code).toBe('auth');
    expect((await flaky.compare({ reference: [REF], probe: PROBE })).similarity).toBe(0.99);
  });

  it('rejects missing images without calling the provider', async () => {
    const mock = new MockRekognition(() => faceMatch(99));
    expect((await rejection(verifier(mock).compare({ reference: [], probe: PROBE }))).code).toBe('invalid_image');
    expect((await rejection(verifier(mock).compare({ reference: [REF], probe: Buffer.alloc(0) }))).code).toBe('invalid_image');
    expect(mock.inputs).toHaveLength(0);
  });
});

describe('VerifierRegistry', () => {
  const keyring = createKeyring(Buffer.alloc(32, 7));
  const config = (over: Partial<ExternalVerifiersConfig> = {}) => ({ externalVerifiers: { allowedProviders: ['aws-rekognition'], allowEnvCredentials: false, timeoutMs: 4000, ...over } });
  const ORG = '00000000-0000-4000-8000-000000000001';
  const settings = (over: Partial<ExternalVerifierStoredSettings> = {}): ExternalVerifierStoredSettings => ({
    ...DEFAULT_EXTERNAL_VERIFIER_SETTINGS,
    provider: 'aws-rekognition',
    region: 'eu-central-1',
    credentialsEnc: encryptVerifierCredentials(keyring, ORG, CREDS),
    accessKeyIdHint: '2345',
    useFor: { checkIn: true, resume: true, suspectedSwap: true },
    enabledAt: 1,
    ...over,
  });

  it('decrypts the stored key for the client, uses the default chain with server credentials, and caches per settings', async () => {
    const mock = new MockRekognition(() => faceMatch(99));
    const reg = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: mock.factory })] });
    const deps = { keyring, config: config({ allowEnvCredentials: true }) };
    const stored = settings();
    const r = await reg.compare(deps, ORG, stored, { reference: [REF], probe: PROBE });
    expect(r).toMatchObject({ provider: 'aws-rekognition', providerName: 'Amazon Rekognition (Amazon Web Services)', similarity: 0.99 });
    expect(mock.configs.at(-1)).toEqual({ region: 'eu-central-1', credentials: CREDS });
    expect(reg.verifierFor(deps, ORG, stored)).toBe(reg.verifierFor(deps, ORG, { ...stored }));
    // a new key (new ciphertext) builds a new client
    expect(reg.verifierFor(deps, ORG, settings())).not.toBe(reg.verifierFor(deps, ORG, stored));
    const env = settings({ useEnvCredentials: true, credentialsEnc: null });
    await reg.compare(deps, ORG, env, { reference: [REF], probe: PROBE });
    expect(mock.configs.at(-1)).toEqual({ region: 'eu-central-1', credentials: null });
    expect(mock.destroyed).toBeGreaterThanOrEqual(1); // the previous instance of this organisation was closed
    reg.close();
  });

  it('refuses incomplete or unavailable configurations (not_configured)', async () => {
    const reg = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: new MockRekognition(() => faceMatch(99)).factory })] });
    const deps = { keyring, config: config() };
    const code = async (s: ExternalVerifierStoredSettings, d = deps) => (await rejection(reg.compare(d, ORG, s, { reference: [REF], probe: PROBE }))).code;
    expect(await code(settings({ provider: 'none' }))).toBe('not_configured');
    expect(await code(settings({ region: null }))).toBe('not_configured');
    expect(await code(settings({ credentialsEnc: null }))).toBe('not_configured');
    expect(await code(settings({ useEnvCredentials: true, credentialsEnc: null }))).toBe('not_configured'); // server does not allow it
    expect(await code(settings(), { keyring, config: config({ allowedProviders: [] }) })).toBe('not_configured');
    // ciphertext of another organisation (AAD mismatch) / another key
    expect(await code(settings({ credentialsEnc: encryptVerifierCredentials(keyring, '00000000-0000-4000-8000-000000000002', CREDS) }))).toBe('not_configured');
    expect(await code(settings({ credentialsEnc: encryptVerifierCredentials(createKeyring(Buffer.alloc(32, 9)), ORG, CREDS) }))).toBe('not_configured');
  });

  it('pauses calls after consecutive failures (circuit breaker); the staff test bypasses it; success resets', async () => {
    let t = 1_000_000;
    let fail = true;
    const mock = new MockRekognition(() => {
      if (fail) throw awsError('ServiceUnavailableException', 'down', 503);
      return faceMatch(99);
    });
    const reg = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: mock.factory })], breaker: { failures: 3, cooldownMs: 60_000 }, now: () => t });
    const deps = { keyring, config: config() };
    const call = (bypassBreaker = false) => reg.compare(deps, ORG, settings(), { reference: [REF], probe: PROBE }, { bypassBreaker });
    for (let i = 0; i < 3; i++) expect((await rejection(call())).code).toBe('provider_error');
    expect(mock.inputs).toHaveLength(3);
    const paused = await rejection(call());
    expect(paused.code).toBe('unavailable');
    expect(mock.inputs).toHaveLength(3); // not called
    expect((await rejection(call(true))).code).toBe('provider_error'); // the admin's test still reaches the provider
    expect(mock.inputs).toHaveLength(4);
    t += 61_000; // half-open after the cooldown
    fail = false;
    expect((await call()).similarity).toBe(0.99);
    fail = true;
    expect((await rejection(call())).code).toBe('provider_error'); // counter was reset: not paused after one failure
    expect((await rejection(call())).code).toBe('provider_error');
    // image problems do not count
    const imgReg = new VerifierRegistry({
      providers: [
        awsRekognitionProvider({
          createClient: new MockRekognition(() => {
            throw new ImageTooLargeException({ message: 'too large', $metadata: {} });
          }).factory,
        }),
      ],
      breaker: { failures: 1, cooldownMs: 60_000 },
    });
    for (let i = 0; i < 3; i++) expect((await rejection(imgReg.compare(deps, ORG, settings(), { reference: [REF], probe: PROBE }))).code).toBe('invalid_image');
  });
});
