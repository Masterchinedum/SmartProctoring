/**
 * Security review #11: with REDIS_URL the rate-limit counters are shared by every server instance (Redis store),
 * instead of each process counting on its own. Needs a Redis at TEST_REDIS_URL (default 127.0.0.1:6379; skipped otherwise).
 */
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStorage } from '../src/lib/storage.js';
import { LocalBus } from '../src/realtime/bus.js';
import { FakeVisionService } from '../src/vision/fake.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisAvailable(): Promise<boolean> {
  const r = new Redis(REDIS_URL, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on('error', () => {});
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

const available = await redisAvailable();

describe.skipIf(!available)('rate limits shared through Redis', () => {
  let env: TestEnv;
  let admin: Redis;
  const namespace = `sp:rl:test:${randomBytes(6).toString('hex')}:`;
  const apps: FastifyInstance[] = [];

  const instance = async (opts: { redis?: boolean; client?: Redis } = {}) => {
    const app = await buildApp({
      config: { ...env.config, redisUrl: opts.redis === false ? null : REDIS_URL },
      database: env.ctx.database,
      vision: new FakeVisionService(),
      storage: new MemoryStorage(),
      bus: new LocalBus(),
      migrate: false,
      jobs: false,
      bootstrap: false,
      serveWeb: false,
      rateLimitNamespace: namespace,
      ...(opts.client ? { rateLimitRedis: opts.client } : {}),
    });
    apps.push(app);
    return app;
  };
  const notice = (app: FastifyInstance, ip: string) => app.inject({ method: 'GET', url: '/api/public/privacy-notice', query: { token: env.session.token }, remoteAddress: ip });

  beforeAll(async () => {
    env = await createTestEnv();
    admin = new Redis(REDIS_URL);
  });
  afterAll(async () => {
    for (const a of apps) await a.close();
    const keys = await admin.keys(`${namespace}*`);
    if (keys.length) await admin.del(...keys);
    admin.disconnect();
    await env?.close();
  });

  it('counts requests to any instance against one limit (60/min privacy notice per IP)', async () => {
    const a = await instance();
    const b = await instance();
    const ip = '198.51.100.7';
    for (let i = 0; i < 30; i++) {
      expect((await notice(a, ip)).statusCode).toBe(200);
      expect((await notice(b, ip)).statusCode).toBe(200);
    }
    // 61st request overall: refused by whichever instance receives it.
    const limited = await notice(a, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect((await notice(b, ip)).statusCode).toBe(429);
    // Another client address has its own budget.
    expect((await notice(b, '198.51.100.8')).statusCode).toBe(200);
    // The counters live in Redis under our namespace.
    expect((await admin.keys(`${namespace}*`)).length).toBeGreaterThan(0);
  });

  it('without Redis each instance counts separately (the previous behaviour)', async () => {
    const a = await instance({ redis: false });
    const b = await instance({ redis: false });
    const ip = '198.51.100.9';
    for (let i = 0; i < 40; i++) expect((await notice(a, ip)).statusCode).toBe(200);
    for (let i = 0; i < 40; i++) expect((await notice(b, ip)).statusCode).toBe(200);
  });

  it('lets requests through when Redis stops answering (fail open, logged)', async () => {
    const client = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    client.on('error', () => {});
    await client.connect();
    const a = await instance({ client });
    expect((await notice(a, '198.51.100.10')).statusCode).toBe(200);
    client.disconnect();
    expect((await notice(a, '198.51.100.10')).statusCode).toBe(200);
  });
});
