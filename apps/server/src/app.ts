import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config.js';
import type { Ctx } from './context.js';
import { createDatabase, migrate, type Database } from './db/index.js';
import { createKeyring } from './lib/crypto.js';
import { HttpError } from './lib/errors.js';
import { LoadMonitor } from './lib/load-monitor.js';
import { appLoggerOptions } from './lib/log-redact.js';
import { connectRateLimitRedis, RATE_LIMIT_NAMESPACE } from './lib/redis.js';
import { createStorage, type BlobStorage } from './lib/storage.js';
import { createBus, type RealtimeBus } from './realtime/bus.js';
import { liveRoute } from './realtime/live-route.js';
import { LiveNotifier } from './realtime/notifier.js';
import { adminRoutes } from './routes/admin/index.js';
import { authRoutes } from './routes/auth.js';
import { candidateRoutes } from './routes/candidate/index.js';
import { publicRoutes } from './routes/public.js';
import { bootstrapAdmin } from './services/bootstrap.js';
import { JobRunner } from './jobs/runner.js';
import { registerIntegrationJobs } from './jobs/integrations.js';
import { createSmtpMailer, type Mailer } from './lib/mailer.js';
import { integrationApiRoutes } from './routes/v1/index.js';
import { sweeperJob } from './jobs/sweeper.js';
import { DEFAULT_RETENTION_INTERVAL_MS, runRetentionExclusive } from './services/retention.js';
import { createVerifierRegistry, type VerifierRegistry } from './verifiers/registry.js';
import type { VisionService } from './vision/types.js';

export interface BuildAppOptions {
  config?: Config;
  /** Existing database (pool + drizzle). Created from config.databaseUrl when omitted (and closed with the app). */
  database?: Database;
  vision?: VisionService;
  storage?: BlobStorage;
  bus?: RealtimeBus;
  /** Clock override (tests). */
  now?: () => number;
  /** Fastify logger option (default: pino at config.logLevel). */
  logger?: FastifyServerOptions['logger'];
  /** Apply migrations at startup (default true). */
  migrate?: boolean;
  /** Start background jobs (default config.sweeperEnabled). */
  jobs?: boolean;
  /** Create the bootstrap owner from BOOTSTRAP_ADMIN_* when no staff exist (default true). */
  bootstrap?: boolean;
  /** Serve the web app from config.webDistDir (default true). */
  serveWeb?: boolean;
  /** Outgoing email for alerts (default: SMTP from config.smtp, or none). Tests pass a MemoryMailer. */
  mailer?: Mailer | null;
  /**
   * Redis client for the shared rate-limit store (default: connected from config.redisUrl when set; null = keep
   * the counters in memory, per instance).
   */
  rateLimitRedis?: Redis | null;
  /** Key prefix for the rate-limit counters in Redis (default `sp:rl:`; tests use a unique one). */
  rateLimitNamespace?: string;
  /** External second-opinion verifier providers (default: AWS Rekognition with the real SDK; tests pass mocks). */
  verifiers?: VerifierRegistry;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
}

export const JPEG_BODY_LIMIT = 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' ws: wss: blob: data:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    // Never log candidate access tokens (/take/<token>, ?token=, Authorization): lib/log-redact.ts.
    logger: opts.logger ?? appLoggerOptions(config.logLevel),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => Math.random().toString(36).slice(2, 12),
  });
  for (const w of config.warnings) app.log.warn(w);

  const owned: { database?: Database; vision?: VisionService; bus?: RealtimeBus; storage?: BlobStorage; rateLimitRedis?: Redis } = {};
  const database = opts.database ?? (owned.database = createDatabase(config.databaseUrl, { max: config.db.poolMax, statementTimeoutMs: config.db.statementTimeoutMs }));
  if (opts.migrate !== false) await migrate(database);

  let vision = opts.vision;
  if (!vision) {
    const { createVisionService } = await import('./vision/index.js');
    // Worker-thread pool by default (VISION_WORKERS / VISION_THREADS): inference never blocks the event loop.
    vision = owned.vision = await createVisionService({
      modelsDir: config.modelsDir,
      workers: config.visionWorkers ?? undefined,
      concurrency: config.visionWorkers === 0 ? config.visionConcurrency || undefined : undefined,
      onWorkerExit: ({ code, error }) => app.log.error({ err: error, code }, 'vision worker exited unexpectedly; restarting it'),
    });
  }
  const storage = opts.storage ?? (owned.storage = createStorage(config.storage));
  const bus = opts.bus ?? (owned.bus = await createBus(config.redisUrl, (err) => app.log.error({ err }, 'redis bus error')));
  const keyring = createKeyring(config.evidenceKey, config.evidenceKeysOld);
  const ownedMailer = opts.mailer === undefined && config.smtp ? createSmtpMailer(config.smtp) : null;

  const ctx = {
    config,
    database,
    db: database.db,
    vision,
    storage,
    keyring,
    bus,
    now: opts.now ?? (() => Date.now()),
    log: app.log,
    mailer: opts.mailer !== undefined ? opts.mailer : ownedMailer,
    verifiers: opts.verifiers ?? createVerifierRegistry(),
  } as Omit<Ctx, 'live' | 'jobs'> as Ctx;
  ctx.live = new LiveNotifier(ctx);
  ctx.jobs = new JobRunner(ctx);
  ctx.jobs.register(sweeperJob(config.sweeperIntervalMs));
  // Hourly evidence / event-metadata retention (services/retention.ts). Also runnable via `retention:run`.
  ctx.jobs.register({
    name: 'retention',
    intervalMs: DEFAULT_RETENTION_INTERVAL_MS,
    runAtStart: true,
    async run(c) {
      const summary = await runRetentionExclusive(c);
      if (summary && (summary.sessionsEvidencePurged || summary.sessionsEventMetadataPurged || summary.failures.length)) {
        const { sessions: _omit, ...rest } = summary;
        c.log.info({ retention: rest }, 'retention run completed');
      }
    },
  });
  // Webhook delivery, email alerts, abandoned-session hygiene (jobs/integrations.ts).
  registerIntegrationJobs(ctx);
  app.decorate('ctx', ctx);
  app.decorateRequest('staff', null);
  app.decorateRequest('apiKey', null);

  await app.register(fastifyCookie, { secret: config.sessionSecret });
  // With REDIS_URL the counters live in Redis, so every limit applies across all server instances (not per
  // process). A Redis failure lets requests through (skipOnError) rather than failing them; it is logged.
  const rateLimitRedis =
    opts.rateLimitRedis !== undefined
      ? opts.rateLimitRedis
      : config.redisUrl
        ? (owned.rateLimitRedis = await connectRateLimitRedis(config.redisUrl, (err) => app.log.error({ err }, 'redis rate-limit store error')))
        : null;
  await app.register(fastifyRateLimit, {
    global: false,
    ...(rateLimitRedis ? { redis: rateLimitRedis, nameSpace: opts.rateLimitNamespace ?? RATE_LIMIT_NAMESPACE, skipOnError: true } : {}),
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} s.`,
    }),
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.addContentTypeParser(['image/jpeg', 'image/jpg'], { parseAs: 'buffer', bodyLimit: JPEG_BODY_LIMIT }, (_req, body, done) => done(null, body));

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    reply.header('Content-Security-Policy', CSP);
    if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send(err.toBody());
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', message: 'Request validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const e = err as { statusCode?: number; code?: string; message: string; error?: string; name?: string };
    if (e.name === 'VisionInputError') return reply.status(400).send({ error: 'invalid_image', message: 'The image could not be read. Please try again.' });
    if (e.name === 'VisionBusyError') return reply.status(503).header('Retry-After', '2').send({ error: 'vision_busy', message: 'The server is busy analysing images. Please retry in a moment.' });
    if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') return reply.status(400).send({ error: 'validation_failed', message: 'Request body is required' });
    if (e.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: e.message });
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) return reply.status(413).send({ error: 'payload_too_large', message: 'Request body is too large' });
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.statusCode === 415) return reply.status(415).send({ error: 'unsupported_media_type', message: e.message });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'An unexpected error occurred' });
  });

  await app.register(publicRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(candidateRoutes, { prefix: '/api/candidate' });
  await app.register(liveRoute);
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(integrationApiRoutes, { prefix: '/api/v1' });

  const webIndex = join(config.webDistDir, 'index.html');
  const serveWeb = opts.serveWeb !== false && existsSync(webIndex);
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      index: false,
      wildcard: true,
      cacheControl: false,
      // @fastify/static >= 10 passes the FastifyReply (not the raw response).
      setHeaders(reply, path) {
        if (path.includes(`${join('/', 'assets', '/')}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        else if (path.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
        else reply.header('Cache-Control', 'public, max-age=86400');
      },
    });
  } else if (opts.serveWeb !== false) {
    app.log.info(`web app not found at ${config.webDistDir} (build apps/web to serve it from this server)`);
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path === '/api' || !serveWeb || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${path} not found` });
    }
    // SPA fallback: client-side routes (/take/:token, /admin/...) get index.html.
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  if (opts.bootstrap !== false) await bootstrapAdmin(ctx);
  // Warns (at most once a minute) when this instance is at its knee: event loop lagging, DB pool or vision queue.
  const loadMonitor = new LoadMonitor({ pool: database.pool, vision, log: app.log });
  if (opts.jobs ?? config.sweeperEnabled) {
    app.addHook('onReady', async () => {
      ctx.jobs.start();
      loadMonitor.start();
    });
  }

  app.addHook('onClose', async () => {
    loadMonitor.stop();
    await ctx.jobs.stop();
    ctx.live.close();
    await owned.bus?.close();
    await owned.rateLimitRedis?.quit().catch(() => {});
    await owned.vision?.close();
    await owned.storage?.close?.();
    await ownedMailer?.close?.();
    if (!opts.verifiers) ctx.verifiers.close();
    await owned.database?.close();
  });

  return app;
}
