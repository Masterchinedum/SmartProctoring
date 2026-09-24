/**
 * Provider registry: builds (and caches) the ExternalVerifier for an organisation's settings, and wraps calls in a
 * per-organisation circuit breaker so an unreachable provider does not add its timeout to every identity check.
 *
 * One registry per app (ctx.verifiers, created in app.ts; tests inject providers with mocked clients).
 */
import type { Config, ExternalVerifiersConfig } from '../config.js';
import type { Keyring } from '../lib/crypto.js';
import { AwsRekognitionVerifier, type AwsClientFactory } from './aws-rekognition.js';
import { decryptVerifierCredentials, type ExternalVerifierStoredSettings, type VerifierCredentials } from './settings.js';
import { ExternalVerifierError, type ExternalCompareInput, type ExternalCompareOptions, type ExternalCompareResult, type ExternalVerifier, type ExternalVerifierErrorCode } from './types.js';

export interface VerifierBuildContext {
  orgId: string;
  settings: ExternalVerifierStoredSettings;
  /** Decrypted stored key pair, or null (none stored / server credentials). */
  credentials: VerifierCredentials | null;
  config: ExternalVerifiersConfig;
}

export interface VerifierProviderFactory {
  id: string;
  displayName: string;
  /** 'cloud' = images leave your infrastructure (privacy notice, docs). */
  location: 'cloud' | 'on_premises';
  /** Build a verifier; throw ExternalVerifierError('not_configured', …) when the settings are incomplete. */
  create(c: VerifierBuildContext): ExternalVerifier;
}

/** AWS Rekognition factory. `createClient` is the test seam for a mocked Rekognition client. */
export function awsRekognitionProvider(opts: { createClient?: AwsClientFactory; retryBackoffMs?: number } = {}): VerifierProviderFactory {
  return {
    id: 'aws-rekognition',
    displayName: 'Amazon Rekognition (Amazon Web Services)',
    location: 'cloud',
    create({ settings, credentials, config }) {
      if (!settings.region) throw new ExternalVerifierError('not_configured', 'No AWS region is configured');
      if (settings.useEnvCredentials && !config.allowEnvCredentials) {
        throw new ExternalVerifierError('not_configured', "This server no longer allows the use of its own AWS credentials (EXTERNAL_VERIFIER_ENV_CREDENTIALS); enter an access key");
      }
      if (!settings.useEnvCredentials && !credentials) throw new ExternalVerifierError('not_configured', 'No AWS access key is stored');
      return new AwsRekognitionVerifier({
        region: settings.region,
        credentials: settings.useEnvCredentials ? null : credentials,
        defaultTimeoutMs: config.timeoutMs,
        createClient: opts.createClient,
        retryBackoffMs: opts.retryBackoffMs,
      });
    },
  };
}

export interface VerifierRegistryOptions {
  /** Default: [awsRekognitionProvider()]. */
  providers?: VerifierProviderFactory[];
  /** Consecutive failures that pause calls for an organisation (default 5), and for how long (default 60 s). */
  breaker?: { failures: number; cooldownMs: number };
  /** Cached verifier instances (default 100, least recently used evicted). */
  maxCached?: number;
  /** Clock for the breaker (default Date.now). */
  now?: () => number;
}

/** Failures that say nothing about the provider's health do not trip the breaker. */
const NOT_COUNTED: ExternalVerifierErrorCode[] = ['invalid_image', 'not_configured', 'unavailable'];

/** What the registry needs from ctx (pass ctx itself). */
export type VerifierDeps = { keyring: Pick<Keyring, 'decryptString'>; config: Pick<Config, 'externalVerifiers'> };

export class VerifierRegistry {
  private readonly factories = new Map<string, VerifierProviderFactory>();
  private readonly cache = new Map<string, ExternalVerifier>();
  private readonly breakers = new Map<string, { failures: number; openUntil: number }>();
  private readonly breakerCfg: { failures: number; cooldownMs: number };
  private readonly maxCached: number;
  private readonly now: () => number;

  constructor(opts: VerifierRegistryOptions = {}) {
    for (const f of opts.providers ?? [awsRekognitionProvider()]) this.factories.set(f.id, f);
    this.breakerCfg = opts.breaker ?? { failures: 5, cooldownMs: 60_000 };
    this.maxCached = Math.max(1, opts.maxCached ?? 100);
    this.now = opts.now ?? Date.now;
  }

  providers(): VerifierProviderFactory[] {
    return [...this.factories.values()];
  }

  provider(id: string): VerifierProviderFactory | undefined {
    return this.factories.get(id);
  }

  /** The (cached) verifier for an organisation's settings. Throws ExternalVerifierError('not_configured'). */
  verifierFor(deps: VerifierDeps, orgId: string, settings: ExternalVerifierStoredSettings): ExternalVerifier {
    if (settings.provider === 'none') throw new ExternalVerifierError('not_configured', 'No external verifier is configured');
    const factory = this.factories.get(settings.provider);
    if (!factory || !deps.config.externalVerifiers.allowedProviders.includes(settings.provider)) {
      throw new ExternalVerifierError('not_configured', `The provider ${settings.provider} is not available on this server`);
    }
    // The ciphertext is part of the key: new credentials (or a re-encryption) build a new client.
    const key = [orgId, settings.provider, settings.region ?? '', settings.useEnvCredentials ? 'env' : 'key', settings.credentialsEnc ?? ''].join('|');
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    let credentials: VerifierCredentials | null = null;
    if (settings.credentialsEnc && !settings.useEnvCredentials) {
      try {
        credentials = decryptVerifierCredentials(deps.keyring, orgId, settings.credentialsEnc);
      } catch {
        throw new ExternalVerifierError('not_configured', 'The stored credentials cannot be decrypted (was EVIDENCE_KEY changed?). Enter the access key again.');
      }
    }
    const verifier = factory.create({ orgId, settings, credentials, config: deps.config.externalVerifiers });
    // Drop older instances of the same organisation (settings changed) and the least recently used overall.
    for (const [k, v] of this.cache) {
      if (k.startsWith(`${orgId}|`)) {
        this.cache.delete(k);
        v.close?.();
      }
    }
    this.cache.set(key, verifier);
    while (this.cache.size > this.maxCached) {
      const [k, v] = this.cache.entries().next().value as [string, ExternalVerifier];
      this.cache.delete(k);
      v.close?.();
    }
    return verifier;
  }

  /**
   * Compare with breaker bookkeeping. Throws ExternalVerifierError on every failure (the caller fails open).
   * `bypassBreaker` (staff "test connection") always calls the provider; its outcome still updates the breaker.
   */
  async compare(
    deps: VerifierDeps,
    orgId: string,
    settings: ExternalVerifierStoredSettings,
    input: ExternalCompareInput,
    opts: ExternalCompareOptions & { bypassBreaker?: boolean } = {},
  ): Promise<ExternalCompareResult & { provider: string; providerName: string }> {
    const verifier = this.verifierFor(deps, orgId, settings);
    const bkey = `${orgId}|${settings.provider}`;
    const b = this.breakers.get(bkey);
    if (!opts.bypassBreaker && b && b.openUntil > this.now()) {
      throw new ExternalVerifierError('unavailable', `Paused after ${b.failures} consecutive failures; retrying after ${new Date(b.openUntil).toISOString()}`);
    }
    try {
      const r = await verifier.compare(input, { timeoutMs: opts.timeoutMs });
      this.breakers.delete(bkey);
      return { ...r, provider: verifier.id, providerName: verifier.displayName };
    } catch (err) {
      const e = err instanceof ExternalVerifierError ? err : new ExternalVerifierError('provider_error', String((err as Error)?.message ?? err).slice(0, 300));
      if (!NOT_COUNTED.includes(e.code)) {
        const failures = (this.breakers.get(bkey)?.failures ?? 0) + 1;
        this.breakers.set(bkey, { failures, openUntil: failures >= this.breakerCfg.failures ? this.now() + this.breakerCfg.cooldownMs : 0 });
      }
      throw e;
    }
  }

  close(): void {
    for (const v of this.cache.values()) v.close?.();
    this.cache.clear();
    this.breakers.clear();
  }
}

export function createVerifierRegistry(opts: VerifierRegistryOptions = {}): VerifierRegistry {
  return new VerifierRegistry(opts);
}
