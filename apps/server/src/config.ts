import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
  trustProxy: boolean | string;
  storage:
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
  redisUrl: string | null;
  modelsDir: string;
  visionConcurrency: number;
  webDistDir: string;
  bootstrap: { email: string | null; password: string | null; orgName: string };
  logLevel: string;
  /** Enable background sweeper (heartbeat timeouts, clock expiry, stale checks). */
  sweeperEnabled: boolean;
  sweeperIntervalMs: number;
  /** Staff session idle timeout / absolute lifetime. */
  staffSessionIdleMs: number;
  staffSessionMaxMs: number;
  /** SMTP server for email alerts (SMTP_*). null = email alerts unavailable. */
  smtp: SmtpConfig | null;
  /** Outgoing webhooks (services/webhooks.ts). */
  webhooks: WebhookConfig;
  /** Integration API /api/v1 (API-key authenticated). */
  integrationApi: { rateLimitPerMinute: number };
  /** Warnings produced while loading (printed at startup). */
  warnings: string[];
}

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

function decodeKey(name: string, b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded (got ${buf.length} bytes). Generate with: openssl rand -base64 32`);
  return buf;
}

function resolvePath(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
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

  const driver = (env.STORAGE_DRIVER ?? 'fs').toLowerCase();
  let storage: Config['storage'];
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

  const port = int(env.PORT, 8080);
  const publicUrl = (env.PUBLIC_URL || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
  if (!publicUrl) throw new Error('PUBLIC_URL is required in production (used to build candidate links).');

  const trustProxyRaw = env.TRUST_PROXY;
  const trustProxy: boolean | string =
    trustProxyRaw == null || trustProxyRaw === '' ? false : ['true', '1', 'yes'].includes(trustProxyRaw.toLowerCase()) ? true : ['false', '0', 'no'].includes(trustProxyRaw.toLowerCase()) ? false : trustProxyRaw;

  const cookieSecure = bool(env.COOKIE_SECURE, isProduction);
  if (isProduction && !cookieSecure) warnings.push('COOKIE_SECURE=false in production: staff cookies will be sent over plain HTTP.');

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
    redisUrl: env.REDIS_URL || null,
    modelsDir: resolvePath(env.MODELS_DIR || 'models', root),
    visionConcurrency: int(env.VISION_CONCURRENCY ?? env.VISION_THREADS, 0),
    webDistDir: resolvePath(env.WEB_DIST_DIR || '../web/dist', root),
    bootstrap: {
      email: env.BOOTSTRAP_ADMIN_EMAIL || null,
      password: env.BOOTSTRAP_ADMIN_PASSWORD || null,
      orgName: env.BOOTSTRAP_ORG_NAME || 'My Organisation',
    },
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    sweeperEnabled: bool(env.SWEEPER_ENABLED, nodeEnv !== 'test'),
    sweeperIntervalMs: int(env.SWEEPER_INTERVAL_MS, 5000),
    staffSessionIdleMs: int(env.STAFF_SESSION_IDLE_MIN, 8 * 60) * 60_000,
    staffSessionMaxMs: int(env.STAFF_SESSION_MAX_HOURS, 7 * 24) * 3_600_000,
    smtp,
    webhooks,
    integrationApi: { rateLimitPerMinute: Math.max(1, int(env.API_RATE_LIMIT_PER_MINUTE, 600)) },
    warnings,
  };
}
