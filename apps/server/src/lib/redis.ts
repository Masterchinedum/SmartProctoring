import type { Redis } from 'ioredis';

/**
 * Redis connection for the shared rate-limit store (@fastify/rate-limit's RedisStore), so request limits
 * (login, candidate endpoints, integration API, ...) are counted across every server instance instead of per
 * process. Same connection pattern as realtime/bus.ts (lazy connect, awaited before the server starts), but
 * tuned for a request-path dependency: commands fail fast instead of queueing while Redis is unreachable
 * (the limiter then lets the request through — `skipOnError` — and the error is logged; per-account login
 * backoff lives in Postgres and keeps working).
 */
export async function connectRateLimitRedis(url: string, onError: (err: Error) => void = () => {}): Promise<Redis> {
  const { Redis } = await import('ioredis');
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
