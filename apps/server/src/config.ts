import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Server configuration from environment variables, with safe development defaults.
 * In production (NODE_ENV=production) secrets are mandatory and the server refuses to start without them.
 */
export interface Config {
  env: 'production' | 'development' | 'test';
  isProduction: boolean;
  port: number;
  host: string;
  /** Public origin used to build candidate access links (no trailing slash). */
  publicUrl: string;
  databaseUrl: string;
  /** 32-byte AES key for evidence / templates / tokens. */
  evidenceKey: Buffer;
  /** Previous keys still accepted for decryption (rotation). */
  evidenceKeysOld: Buffer[];
  /** Secret used to sign staff session cookies. */
  sessionSecret: string;
  cookieSecure: boolean;
  /** Fastify trustProxy: false, true (every hop — spoofable), or the proxy's addresses / CIDRs. */
  trustProxy: boolean | string;
  /** The default evidence store (STORAGE_DRIVER, STORAGE_DIR, S3_*): storage location `default`. */
  storage: StorageBackendConfig;
  /**
   * Every evidence storage location, `default` (= `storage`) first, then those listed in STORAGE_LOCATIONS
   * (data residency: an organisation chooses where its new evidence images are stored; docs/OPERATIONS.md §2).
   */
  storageLocations: StorageLocationConfig[];
  redisUrl: string | null;
  /** Postgres pool per process (PG_POOL_MAX, default 20) and per-statement timeout (PG_STATEMENT_TIMEOUT_MS, default 60 s; 0 = off). */
  db: { poolMax: number; statementTimeoutMs: number };
  modelsDir: string;
  /**
   * Vision worker threads (VISION_WORKERS; 0 = analyse on the main thread). null = derived from VISION_THREADS
   * (total CPU threads for face analysis, default CPU count - 1) by the vision service. docs/PERFORMANCE.md.
   */
  visionWorkers: number | null;
  /** In-process mode only (VISION_WORKERS=0): analyses in flight (VISION_CONCURRENCY). */
  visionConcurrency: number;
  /**
   * Where face analysis runs (VISION_DRIVER): 'local' (default) = the worker-thread pool in this process (the settings
   * above); 'remote' = dedicated vision workers over HTTP (src/vision-worker, vision/remote.ts; docs/OPERATIONS.md §2).
   */
  visionDriver: 'local' | 'remote';
  /**
   * VISION_DRIVER=remote: VISION_WORKER_URLS (comma-separated base URLs; a DNS name stands for all its addresses),
   * VISION_WORKER_TOKEN (shared secret, ≥ 24 characters, the same on every worker), VISION_WORKER_TIMEOUT_MS (longest
   * wait for one analysis, queue included; default 30 000). null with the local driver.
   */
  visionRemote: { urls: string[]; token: string; timeoutMs: number } | null;
  /**
   * When this instance is too busy to take more exam starts (services/capacity.ts, docs/OPERATIONS.md §5):
   * CAPACITY_MAX_VISION_WAIT_MS (2000) expected wait of a new identity sample in the face-analysis queue,
   * CAPACITY_MAX_EVENT_LOOP_MS (200) event-loop delay p99, CAPACITY_MAX_DB_WAITING (5) requests waiting for a
   * Postgres connection.
   */
  capacity: { maxVisionWaitMs: number; maxEventLoopP99Ms: number; maxDbWaiting: number };
  /** Bearer token for GET /metrics (METRICS_TOKEN, ≥ 24 characters); null = /metrics is not served. */
  metricsToken: string | null;
  /**
   * Admission at exam start (services/candidate-actions.ts): while this instance is at capacity (services/capacity.ts)
   * a start is deferred — 503 start_deferred + Retry-After, the candidate app retries on its own and the exam clock
   * has not started — for at most EXAM_START_MAX_DEFER_SEC (300) in total, then it is let through.
   * EXAM_START_ADMISSION=false turns it off.
   */
  examStartAdmission: { enabled: boolean; maxDeferMs: number };
  /**
   * LOAD_AWARE_SAMPLING (default true): while the face-analysis queue is long, routine identity samples are spaced out,
   * at most to the Balanced sampling intensity (services/identity-evidence.ts loadAwareDelayMs).
   */
  loadAwareSampling: boolean;
  webDistDir: string;
  bootstrap: { email: string | null; password: string | null; orgName: string };
  logLevel: string;
  /** Enable background sweeper (heartbeat timeouts, clock expiry, stale checks). */
  sweeperEnabled: boolean;
  sweeperIntervalMs: number;
  /** Staff session idle timeout / absolute lifetime (STAFF_SESSION_IDLE_MIN, default 60; STAFF_SESSION_MAX_HOURS, default 12). */
  staffSessionIdleMs: number;
  staffSessionMaxMs: number;
  /**
   * Per-session caps on candidate-driven storage (services/session-limits.ts):
   * SESSION_MAX_EVIDENCE_ITEMS (1500), SESSION_MAX_EVIDENCE_MB (300), SESSION_MAX_CHECKS_PER_HOUR (30).
   */
  sessionLimits: { maxEvidenceItems: number; maxEvidenceBytes: number; maxChecksPerHour: number };
  /** SMTP server for email alerts (SMTP_*). null = email alerts unavailable. */
  smtp: SmtpConfig | null;
  /** Outgoing webhooks (services/webhooks.ts). */
  webhooks: WebhookConfig;
  /** Integration API /api/v1 (API-key authenticated). */
  integrationApi: { rateLimitPerMinute: number };
  /** Optional external second-opinion face verifiers (src/verifiers, docs/EXTERNAL_VERIFIER.md). */
  externalVerifiers: ExternalVerifiersConfig;
  /** Warnings produced while loading (printed at startup). */
  warnings: string[];
}

export type StorageBackendConfig =
  | { driver: 'fs'; dir: string }
  | {
      driver: 's3';
      bucket: string;
      region: string;
      endpoint: string | null;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      forcePathStyle: boolean;
      prefix: string;
    };

/** One place where evidence blobs can be stored (operator configuration; staff only choose among these). */
export interface StorageLocationConfig {
  /** `default`, or a name from STORAGE_LOCATIONS (lower case letters, digits and hyphens). */
  name: string;
  /** Shown to staff, e.g. "EU (Frankfurt)". STORAGE_LABEL / STORAGE_LOCATION_<NAME>_LABEL. */
  label: string;
  storage: StorageBackendConfig;
}

export const DEFAULT_STORAGE_LOCATION = 'default';
/** Location names: lower case, start with a letter, hyphen-separated words, at most 32 characters. */
export const STORAGE_LOCATION_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STORAGE_LOCATION_FIELDS = ['DRIVER', 'LABEL', 'DIR', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE', 'S3_PREFIX'] as const;

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = implicit TLS (usually port 465); false = STARTTLS when offered (587/25). */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** From header, e.g. `SmartProctoring <alerts@example.com>`. */
  from: string;
}

export interface WebhookConfig {
  /** Allow webhook URLs that resolve to private / loopback / link-local addresses (dev/test only). */
  allowPrivateNetworks: boolean;
  /** Only https:// webhook URLs (always in production). */
  requireHttps: boolean;
  /** Per-request timeout (connect + response). */
  timeoutMs: number;
  /** Attempts per delivery before it is marked failed (exponential backoff 30 s -> 6 h in between). */
  maxAttempts: number;
  /** Consecutive failed attempts after which a webhook is disabled automatically ... */
  disableAfterFailures: number;
  /** ... provided it has been failing (no success) for at least this long. */
  disableMinFailingMs: number;
  /** Delivery job interval. */
  intervalMs: number;
}

/**
 * Server-level bounds for the external face verifier. Each organisation still has to switch it on (Settings →
 * Integrations; off by default) — these only limit what administrators may choose.
 */
export interface ExternalVerifiersConfig {
  /** EXTERNAL_VERIFIERS: providers organisations may enable (comma list, default `aws-rekognition`; `none` = feature off). */
  allowedProviders: string[];
  /**
   * EXTERNAL_VERIFIER_ENV_CREDENTIALS: organisations may use the server's own AWS credentials (default credential
   * chain: IAM role, AWS_* environment, shared config) instead of storing a key. Default false (the operator pays and
   * the images go to the operator's AWS account — enable it only for single-tenant deployments).
   */
  allowEnvCredentials: boolean;
  /** EXTERNAL_VERIFIER_TIMEOUT_MS: per comparison, retries included (default 4000, 500–30000). */
  timeoutMs: number;
}

const here = dirname(fileURLToPath(import.meta.url));

/** apps/server directory, whether running from src/ (tsx) or dist/ (bundled). */
export function serverRoot(): string {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, dflt: number): number {
  if (v == null || v === '') return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer in environment: ${v}`);
  return n;
}

/** EXTERNAL_VERIFIERS: unset = `aws-rekognition`; `none` / `off` / empty = no provider. */
function parseProviderList(v: string | undefined): string[] {
  if (v == null) return ['aws-rekognition'];
  const list = v
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (list.some((p) => p === 'none' || p === 'off' || p === 'false')) return [];
  return [...new Set(list)];
}

/** Minimum length of VISION_WORKER_TOKEN (as METRICS_TOKEN): a random secret, e.g. `openssl rand -hex 32`. */
export const MIN_VISION_WORKER_TOKEN_LENGTH = 24;

/** VISION_DRIVER / VISION_WORKER_*: the remote vision driver's settings (null = local driver). */
function parseVisionRemote(env: NodeJS.ProcessEnv): Config['visionRemote'] {
  const driver = (env.VISION_DRIVER || 'local').trim().toLowerCase();
  if (driver === 'local') return null;
  if (driver !== 'remote') throw new Error(`Unknown VISION_DRIVER: ${env.VISION_DRIVER} (expected local or remote)`);
  const urls = (env.VISION_WORKER_URLS ?? '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  if (!urls.length) throw new Error('VISION_DRIVER=remote requires VISION_WORKER_URLS (e.g. http://vision:8090).');
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`VISION_WORKER_URLS: not a URL: ${raw}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`VISION_WORKER_URLS: ${raw} must start with http:// or https://`);
    if (u.username || u.password || u.search || u.hash) throw new Error(`VISION_WORKER_URLS: ${raw} must be a plain base URL (no credentials, query or fragment); the token goes in VISION_WORKER_TOKEN`);
  }
  const token = env.VISION_WORKER_TOKEN ?? '';
  if (token.length < MIN_VISION_WORKER_TOKEN_LENGTH) throw new Error(`VISION_DRIVER=remote requires VISION_WORKER_TOKEN of at least ${MIN_VISION_WORKER_TOKEN_LENGTH} characters (e.g. openssl rand -hex 32), the same value as on the vision workers.`);
  return { urls: [...new Set(urls)], token, timeoutMs: Math.min(120_000, Math.max(1_000, int(env.VISION_WORKER_TIMEOUT_MS, 30_000))) };
}

function decodeKey(name: string, b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded (got ${buf.length} bytes). Generate with: openssl rand -base64 32`);
  return buf;
}

function resolvePath(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

/** `eu-central` -> `EU_CENTRAL` (the <NAME> part of STORAGE_LOCATION_<NAME>_*). */
export function storageLocationEnvName(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

function storageLabel(value: string | undefined, fallback: string, variable: string): string {
  const label = (value ?? '').trim() || fallback;
  if (label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error(`${variable} must be a single line of at most 80 characters (e.g. "EU (Frankfurt)").`);
  return label;
}

/** Human-readable place of a backend for error messages (no credentials). */
function storagePlace(s: StorageBackendConfig): string {
  return s.driver === 'fs' ? `directory ${s.dir}` : `bucket ${s.bucket}${s.prefix ? `/${s.prefix}` : ''}${s.endpoint ? ` at ${s.endpoint}` : ''}`;
}

/** Two backends whose blobs could mix: the same or nested directories, the same bucket with overlapping prefixes. */
function storageOverlaps(a: StorageBackendConfig, b: StorageBackendConfig): boolean {
  if (a.driver === 'fs' && b.driver === 'fs') return a.dir === b.dir || a.dir.startsWith(b.dir + sep) || b.dir.startsWith(a.dir + sep);
  if (a.driver === 's3' && b.driver === 's3') {
    if (a.bucket !== b.bucket || (a.endpoint ?? '') !== (b.endpoint ?? '')) return false;
    const [pa, pb] = [a.prefix, b.prefix];
    return pa === pb || pa === '' || pb === '' || pa.startsWith(pb + '/') || pb.startsWith(pa + '/');
  }
  return false;
}

/**
 * Evidence storage locations. `default` comes from STORAGE_DRIVER / STORAGE_DIR / S3_* (unchanged, so existing
 * deployments need nothing new; optional STORAGE_LABEL). Others are listed in STORAGE_LOCATIONS (comma-separated
 * names) and configured with STORAGE_LOCATION_<NAME>_* (NAME upper-cased, hyphens as underscores):
 * DRIVER (fs | s3, required), LABEL, DIR (fs, required), S3_BUCKET + S3_REGION (s3, required), S3_ENDPOINT,
 * S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (both or neither: neither = the default AWS credential chain),
 * S3_FORCE_PATH_STYLE, S3_PREFIX. Anything inconsistent refuses start-up with a message naming the variable.
 */
function parseStorageLocations(env: NodeJS.ProcessEnv, root: string, warnings: string[]): StorageLocationConfig[] {
  const driver = (env.STORAGE_DRIVER ?? 'fs').toLowerCase();
  let storage: StorageBackendConfig;
  if (driver === 's3') {
    if (!env.S3_BUCKET) throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
    storage = {
      driver: 's3',
      bucket: env.S3_BUCKET,
      region: env.S3_REGION || 'us-east-1',
      endpoint: env.S3_ENDPOINT || null,
      accessKeyId: env.S3_ACCESS_KEY_ID || null,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || null,
      forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
      prefix: (env.S3_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
    };
  } else if (driver === 'fs') {
    storage = { driver: 'fs', dir: resolvePath(env.STORAGE_DIR || 'storage', root) };
  } else {
    throw new Error(`Unknown STORAGE_DRIVER: ${driver} (expected fs or s3)`);
  }
  const locations: StorageLocationConfig[] = [{ name: DEFAULT_STORAGE_LOCATION, label: storageLabel(env.STORAGE_LABEL, 'Default storage', 'STORAGE_LABEL'), storage }];

  const listed = (env.STORAGE_LOCATIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of listed) {
    if (name.toLowerCase() === DEFAULT_STORAGE_LOCATION) {
      throw new Error('STORAGE_LOCATIONS: "default" is the location configured by STORAGE_DRIVER / STORAGE_DIR / S3_*; list only the other locations.');
    }
    if (!STORAGE_LOCATION_NAME_RE.test(name) || name.length > 32) {
      throw new Error(`STORAGE_LOCATIONS: invalid location name "${name}" (lower case letters, digits and hyphens, starting with a letter, at most 32 characters; e.g. eu or eu-central).`);
    }
    if (locations.some((l) => l.name === name)) throw new Error(`STORAGE_LOCATIONS lists "${name}" twice.`);
    const p = `STORAGE_LOCATION_${storageLocationEnvName(name)}_`;
    const v = (field: (typeof STORAGE_LOCATION_FIELDS)[number]): string | undefined => {
      const x = env[p + field]?.trim();
      return x ? x : undefined;
    };
    const d = v('DRIVER')?.toLowerCase();
    let s: StorageBackendConfig;
    if (!d) {
      throw new Error(`Storage location "${name}": ${p}DRIVER is required (fs or s3).`);
    } else if (d === 'fs') {
      const dir = v('DIR');
      if (!dir) throw new Error(`Storage location "${name}": ${p}DIR is required with ${p}DRIVER=fs.`);
      s = { driver: 'fs', dir: resolvePath(dir, root) };
    } else if (d === 's3') {
      const bucket = v('S3_BUCKET');
      if (!bucket) throw new Error(`Storage location "${name}": ${p}S3_BUCKET is required with ${p}DRIVER=s3.`);
      const region = v('S3_REGION');
      if (!region) throw new Error(`Storage location "${name}": ${p}S3_REGION is required with ${p}DRIVER=s3 (the bucket's region, e.g. eu-central-1).`);
      const accessKeyId = v('S3_ACCESS_KEY_ID') ?? null;
      const secretAccessKey = v('S3_SECRET_ACCESS_KEY') ?? null;
      if (!accessKeyId !== !secretAccessKey) {
        throw new Error(`Storage location "${name}": set both ${p}S3_ACCESS_KEY_ID and ${p}S3_SECRET_ACCESS_KEY, or neither (the default AWS credential chain — IAM role, AWS_* variables — is then used).`);
      }
      s = {
        driver: 's3',
        bucket,
        region,
        endpoint: v('S3_ENDPOINT') ?? null,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: bool(v('S3_FORCE_PATH_STYLE'), false),
        prefix: (v('S3_PREFIX') ?? '').replace(/^\/+|\/+$/g, ''),
      };
    } else {
      throw new Error(`Storage location "${name}": unknown ${p}DRIVER "${d}" (expected fs or s3).`);
    }
    locations.push({ name, label: storageLabel(v('LABEL'), name, `${p}LABEL`), storage: s });
  }

  // A mistyped variable would otherwise be silently ignored (e.g. STORAGE_LOCATION_EU_BUCKET for ..._S3_BUCKET).
  const prefixes = listed.map((n) => `STORAGE_LOCATION_${storageLocationEnvName(n)}_`);
  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith('STORAGE_LOCATION_') || !env[key]?.trim()) continue;
    const ofListed = prefixes.filter((p) => key.startsWith(p));
    if (ofListed.some((p) => (STORAGE_LOCATION_FIELDS as readonly string[]).includes(key.slice(p.length)))) continue;
    warnings.push(
      ofListed.length
        ? `${key} is ignored: not a storage location setting (known: ${STORAGE_LOCATION_FIELDS.join(', ')}).`
        : `${key} is ignored: its location is not listed in STORAGE_LOCATIONS.`,
    );
  }

  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const [a, b] = [locations[i], locations[j]];
      if (storageOverlaps(a.storage, b.storage)) {
        throw new Error(`Storage locations "${a.name}" and "${b.name}" point to the same place (${storagePlace(a.storage)} / ${storagePlace(b.storage)}): each location needs its own directory, or its own bucket or prefix.`);
      }
    }
  }
  return locations;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const isProduction = nodeEnv === 'production';
  const warnings: string[] = [];
  const root = serverRoot();

  let evidenceKey: Buffer;
  if (env.EVIDENCE_KEY) {
    evidenceKey = decodeKey('EVIDENCE_KEY', env.EVIDENCE_KEY);
  } else if (isProduction) {
    throw new Error('EVIDENCE_KEY is required in production (32 random bytes, base64). Refusing to start.');
  } else {
    evidenceKey = createHash('sha256').update('smartproctoring-dev-only-evidence-key').digest();
    warnings.push('EVIDENCE_KEY is not set: using a fixed DEVELOPMENT key. Evidence is NOT protected. Never use this in production.');
  }
  const evidenceKeysOld = (env.EVIDENCE_KEYS_OLD ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k, i) => decodeKey(`EVIDENCE_KEYS_OLD[${i}]`, k));

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (isProduction) throw new Error('SESSION_SECRET is required in production. Refusing to start.');
    sessionSecret = 'smartproctoring-dev-only-session-secret-change-me';
    warnings.push('SESSION_SECRET is not set: using a DEVELOPMENT secret.');
  } else if (sessionSecret.length < 32) {
    if (isProduction) throw new Error('SESSION_SECRET must be at least 32 characters.');
    warnings.push('SESSION_SECRET is shorter than 32 characters.');
  }

  const storageLocations = parseStorageLocations(env, root, warnings);
  const storage = storageLocations[0].storage;

  const port = int(env.PORT, 8080);
  const publicUrl = (env.PUBLIC_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
  if (!publicUrl) throw new Error('PUBLIC_URL is required in production (used to build candidate links).');

  // TRUST_PROXY: the reverse proxy's addresses / CIDRs / proxy-addr names ("loopback", "uniquelocal",
  // "10.0.0.2,127.0.0.1"): the client address is the last X-Forwarded-For hop added by a trusted proxy. `true`
  // trusts every hop, i.e. the LEFT-most entry, which the client writes itself unless the proxy overwrites the
  // header — clients can then pick their own IP (per-IP login rate limit, audit log). Hop counts are not
  // supported: Fastify >= 5.12 fails closed on them (nothing is trusted, every client gets the proxy's IP).
  const trustProxyRaw = env.TRUST_PROXY?.trim();
  const trustProxy: boolean | string =
    trustProxyRaw == null || trustProxyRaw === '' ? false : ['true', '1', 'yes'].includes(trustProxyRaw.toLowerCase()) ? true : ['false', '0', 'no'].includes(trustProxyRaw.toLowerCase()) ? false : trustProxyRaw;
  if (typeof trustProxy === 'string' && /^\d+$/.test(trustProxy)) {
    throw new Error(`TRUST_PROXY=${trustProxy}: hop counts are not supported. Set the address(es) of your reverse proxy, e.g. TRUST_PROXY=127.0.0.1 or TRUST_PROXY=loopback,uniquelocal.`);
  }
  if (isProduction && trustProxy === true) {
    warnings.push(
      'TRUST_PROXY=true trusts every X-Forwarded-For entry, so clients can choose their own IP address (login rate limit, audit log) unless the proxy overwrites the header. Set TRUST_PROXY to the address(es) of your reverse proxy instead (e.g. 127.0.0.1 or loopback,uniquelocal).',
    );
  }

  const cookieSecure = bool(env.COOKIE_SECURE, isProduction);
  if (isProduction && !cookieSecure) warnings.push('COOKIE_SECURE=false in production: staff cookies will be sent over plain HTTP.');
  const metricsToken = env.METRICS_TOKEN || null;
  const visionRemote = parseVisionRemote(env);
  if (metricsToken && metricsToken.length < 24) throw new Error('METRICS_TOKEN must be at least 24 characters (e.g. openssl rand -hex 24).');

  let smtp: SmtpConfig | null = null;
  if (env.SMTP_HOST) {
    if (!env.SMTP_FROM) throw new Error('SMTP_FROM is required when SMTP_HOST is set (e.g. "SmartProctoring <alerts@example.com>").');
    const secure = bool(env.SMTP_SECURE, env.SMTP_PORT === '465');
    smtp = {
      host: env.SMTP_HOST,
      port: int(env.SMTP_PORT, secure ? 465 : 587),
      secure,
      user: env.SMTP_USER || null,
      password: env.SMTP_PASSWORD || null,
      from: env.SMTP_FROM,
    };
    if (smtp.user && !smtp.password) warnings.push('SMTP_USER is set without SMTP_PASSWORD.');
  }

  const allowPrivateNetworks = bool(env.WEBHOOK_ALLOW_PRIVATE_NETWORKS, !isProduction);
  if (isProduction && allowPrivateNetworks) warnings.push('WEBHOOK_ALLOW_PRIVATE_NETWORKS=true in production: webhooks may target internal network addresses (SSRF protection off).');
  const webhooks: WebhookConfig = {
    allowPrivateNetworks,
    requireHttps: isProduction,
    timeoutMs: 10_000,
    maxAttempts: 10,
    disableAfterFailures: Math.max(1, int(env.WEBHOOK_DISABLE_AFTER_FAILURES, 20)),
    disableMinFailingMs: 3_600_000,
    intervalMs: 5_000,
  };

  return {
    env: nodeEnv,
    isProduction,
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/proctor',
    evidenceKey,
    evidenceKeysOld,
    sessionSecret,
    cookieSecure,
    trustProxy,
    storage,
    storageLocations,
    redisUrl: env.REDIS_URL || null,
    db: {
      poolMax: Math.max(2, int(env.PG_POOL_MAX, 20)),
      statementTimeoutMs: Math.max(0, int(env.PG_STATEMENT_TIMEOUT_MS, 60_000)),
    },
    modelsDir: resolvePath(env.MODELS_DIR || 'models', root),
    visionWorkers: env.VISION_WORKERS != null && env.VISION_WORKERS !== '' ? Math.max(0, int(env.VISION_WORKERS, 0)) : null,
    visionConcurrency: int(env.VISION_CONCURRENCY, 0),
    visionDriver: visionRemote ? 'remote' : 'local',
    visionRemote,
    capacity: {
      maxVisionWaitMs: Math.max(100, int(env.CAPACITY_MAX_VISION_WAIT_MS, 2000)),
      maxEventLoopP99Ms: Math.max(10, int(env.CAPACITY_MAX_EVENT_LOOP_MS, 200)),
      maxDbWaiting: Math.max(0, int(env.CAPACITY_MAX_DB_WAITING, 5)),
    },
    metricsToken,
    examStartAdmission: {
      enabled: bool(env.EXAM_START_ADMISSION, true),
      maxDeferMs: Math.min(3600, Math.max(0, int(env.EXAM_START_MAX_DEFER_SEC, 300))) * 1000,
    },
    loadAwareSampling: bool(env.LOAD_AWARE_SAMPLING, true),
    webDistDir: resolvePath(env.WEB_DIST_DIR || '../web/dist', root),
    bootstrap: {
      email: env.BOOTSTRAP_ADMIN_EMAIL || null,
      password: env.BOOTSTRAP_ADMIN_PASSWORD || null,
      orgName: env.BOOTSTRAP_ORG_NAME || 'My Organisation',
    },
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    sweeperEnabled: bool(env.SWEEPER_ENABLED, nodeEnv !== 'test'),
    sweeperIntervalMs: int(env.SWEEPER_INTERVAL_MS, 5000),
    // Staff can view biometric evidence: 60 min idle / 12 h absolute by default (security review #12).
    staffSessionIdleMs: Math.max(1, int(env.STAFF_SESSION_IDLE_MIN, 60)) * 60_000,
    staffSessionMaxMs: Math.max(1, int(env.STAFF_SESSION_MAX_HOURS, 12)) * 3_600_000,
    sessionLimits: {
      maxEvidenceItems: Math.max(1, int(env.SESSION_MAX_EVIDENCE_ITEMS, 1500)),
      maxEvidenceBytes: Math.max(1, int(env.SESSION_MAX_EVIDENCE_MB, 300)) * 1024 * 1024,
      maxChecksPerHour: Math.max(1, int(env.SESSION_MAX_CHECKS_PER_HOUR, 30)),
    },
    smtp,
    webhooks,
    integrationApi: { rateLimitPerMinute: Math.max(1, int(env.API_RATE_LIMIT_PER_MINUTE, 600)) },
    externalVerifiers: {
      allowedProviders: parseProviderList(env.EXTERNAL_VERIFIERS),
      allowEnvCredentials: bool(env.EXTERNAL_VERIFIER_ENV_CREDENTIALS, false),
      timeoutMs: Math.min(30_000, Math.max(500, int(env.EXTERNAL_VERIFIER_TIMEOUT_MS, 4_000))),
    },
    warnings,
  };
}
