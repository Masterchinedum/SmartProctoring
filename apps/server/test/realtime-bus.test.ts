/**
 * RealtimeBus.hasSubscribers(): the notifier skips building messages for organisations nobody watches. With Redis
 * the answer covers every instance (PUBSUB NUMSUB, plus an immediate "first subscriber" notice).
 */
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { LocalBus, RedisBus } from '../src/realtime/bus.js';

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await wait(20);
  return fn();
}

describe('LocalBus.hasSubscribers', () => {
  it('reflects this process’s subscribers', async () => {
    const bus = new LocalBus();
    expect(bus.hasSubscribers('org-a')).toBe(false);
    const off = bus.subscribe('org-a', () => {});
    expect(bus.hasSubscribers('org-a')).toBe(true);
    expect(bus.hasSubscribers('org-b')).toBe(false);
    off();
    expect(bus.hasSubscribers('org-a')).toBe(false);
    await bus.close();
  });
});

describe.skipIf(!available)('RedisBus.hasSubscribers across instances', () => {
  it('learns about subscribers on another instance at once, and about their absence after the TTL', async () => {
    const a = await RedisBus.connect(REDIS_URL, () => {}, { remoteTtlMs: 200 });
    const b = await RedisBus.connect(REDIS_URL, () => {}, { remoteTtlMs: 200 });
    const org = `test-${randomUUID()}`;
    try {
      b.hasSubscribers(org); // first ask: unknown -> assumed true while Redis is asked
      expect(await until(() => !b.hasSubscribers(org))).toBe(true);
      const got: unknown[] = [];
      const off = a.subscribe(org, (m) => got.push(m));
      expect(a.hasSubscribers(org)).toBe(true);
      expect(await until(() => b.hasSubscribers(org))).toBe(true); // control message, no TTL wait
      b.publish(org, { type: 'hello', serverTime: 1 });
      expect(await until(() => got.length === 1)).toBe(true);
      off();
      expect(await until(() => !b.hasSubscribers(org))).toBe(true); // NUMSUB after the TTL
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe.skipIf(!available)('RedisBus.whenSubscribed', () => {
  it('resolves once messages from another instance reach the new subscriber (the staff socket says hello then)', async () => {
    const a = await RedisBus.connect(REDIS_URL, () => {}, { remoteTtlMs: 200 });
    const b = await RedisBus.connect(REDIS_URL, () => {}, { remoteTtlMs: 200 });
    const org = `test-${randomUUID()}`;
    try {
      const got: unknown[] = [];
      const off = a.subscribe(org, (m) => got.push(m));
      await a.whenSubscribed(org);
      b.publish(org, { type: 'hello', serverTime: 3 }); // published right after "ready": not lost
      expect(await until(() => got.length === 1)).toBe(true);
      off();
      await expect(a.whenSubscribed(org)).resolves.toBeUndefined(); // nothing pending after the last unsubscribe
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
