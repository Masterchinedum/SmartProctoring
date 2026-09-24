import type { Redis } from 'ioredis';

/**
 * The ioredis client class, loaded on demand (only when REDIS_URL is set). Works both under Node's ESM loader
 * (named export `Redis`) and in the tsup production bundle, where the CommonJS package becomes a chunk that only
 * has a default export (module.exports) — `const { Redis } = await import('ioredis')` is undefined there.
 */
export async function loadRedisClass(): Promise<typeof Redis> {
  const mod = (await import('ioredis')) as unknown as { Redis?: typeof Redis; default?: typeof Redis & { Redis?: typeof Redis } };
  const cls = mod.Redis ?? mod.default?.Redis ?? mod.default;
  if (typeof cls !== 'function') throw new Error('ioredis could not be loaded');
  return cls;
}

/**
 * Redis connection for the shared rate-limit store (@fastify/rate-limit's RedisStore), so request limits
 * (login, candidate endpoints, integration API, ...) are counted across every server instance instead of per
 * process. Same connection pattern as realtime/bus.ts (lazy connect, awaited before the server starts), but
 * tuned for a request-path dependency: commands fail fast instead of queueing while Redis is unreachable
 * (the limiter then lets the request through — `skipOnError` — and the error is logged; per-account login
 * backoff lives in Postgres and keeps working).
 */
export async function connectRateLimitRedis(url: string, onError: (err: Error) => void = () => {}): Promise<Redis> {
  const Redis = await loadRedisClass();
  const client = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1_000,
    connectTimeout: 5_000,
    connectionName: 'smartproctoring-rate-limit',
  });
  client.on('error', onError);
  await client.connect();
  return client;
}

/** Key prefix of the rate-limit counters in Redis. */
export const RATE_LIMIT_NAMESPACE = 'sp:rl:';
