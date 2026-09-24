import { EventEmitter } from 'node:events';
import type { LiveMessage } from '@sp/shared';
import { loadRedisClass } from '../lib/redis.js';

/**
 * Staff realtime fan-out. Messages are scoped per organisation.
 * - LocalBus: in-process EventEmitter (single instance).
 * - RedisBus: Redis pub/sub so every server instance's WebSocket clients get every message.
 */
export interface RealtimeBus {
  publish(orgId: string, msg: LiveMessage): void;
  subscribe(orgId: string, handler: (msg: LiveMessage) => void): () => void;
  /**
   * Might anyone receive messages for this organisation (a staff WebSocket on this or, with Redis, another
   * instance)? Publishers use it to skip building messages nobody reads. May err on the side of `true`.
   */
  hasSubscribers(orgId: string): boolean;
  close(): Promise<void>;
}

export class LocalBus implements RealtimeBus {
  private readonly emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(orgId: string, msg: LiveMessage): void {
    // Deliver asynchronously so publishers never run subscriber code inside a DB transaction.
    queueMicrotask(() => this.emitter.emit(orgId, msg));
  }
  subscribe(orgId: string, handler: (msg: LiveMessage) => void): () => void {
    this.emitter.on(orgId, handler);
    return () => this.emitter.off(orgId, handler);
  }
  hasSubscribers(orgId: string): boolean {
    return this.emitter.listenerCount(orgId) > 0;
  }
  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

const CHANNEL_PREFIX = 'sp:live:';
/** Control channel: "an instance got its first staff subscriber for org X" (payload: org id). */
const SUBSCRIBED_CHANNEL = 'sp:live-ctl:subscribed';
/** How long a remote "anyone listening?" answer (PUBSUB NUMSUB) is trusted. */
export const REMOTE_SUBSCRIBERS_TTL_MS = 5_000;

export class RedisBus implements RealtimeBus {
  private readonly local = new EventEmitter();
  private readonly subscribedOrgs = new Map<string, number>();
  /** Per org: does any instance have subscribers (PUBSUB NUMSUB, refreshed in the background)? */
  private readonly remote = new Map<string, { has: boolean; at: number; refreshing: boolean }>();
  private constructor(
    private readonly pub: import('ioredis').Redis,
    private readonly sub: import('ioredis').Redis,
    private readonly onError: (err: Error) => void,
    private readonly remoteTtlMs: number,
  ) {
    this.local.setMaxListeners(0);
    this.sub.on('message', (channel: string, payload: string) => {
      if (channel === SUBSCRIBED_CHANNEL) {
        this.remote.set(payload, { has: true, at: Date.now(), refreshing: false });
        return;
      }
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      try {
        this.local.emit(channel.slice(CHANNEL_PREFIX.length), JSON.parse(payload) as LiveMessage);
      } catch (err) {
        this.onError(err as Error);
      }
    });
    this.sub.subscribe(SUBSCRIBED_CHANNEL).catch(this.onError);
  }

  static async connect(url: string, onError: (err: Error) => void = () => {}, busOpts: { remoteTtlMs?: number } = {}): Promise<RedisBus> {
    const Redis = await loadRedisClass(); // bundle-safe (see lib/redis.ts)
    const opts = { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true } as const;
    const pub = new Redis(url, opts);
    const sub = new Redis(url, opts);
    pub.on('error', onError);
    sub.on('error', onError);
    await Promise.all([pub.connect(), sub.connect()]);
    return new RedisBus(pub, sub, onError, busOpts.remoteTtlMs ?? REMOTE_SUBSCRIBERS_TTL_MS);
  }

  publish(orgId: string, msg: LiveMessage): void {
    this.pub.publish(CHANNEL_PREFIX + orgId, JSON.stringify(msg)).catch(this.onError);
  }

  subscribe(orgId: string, handler: (msg: LiveMessage) => void): () => void {
    this.local.on(orgId, handler);
    const n = this.subscribedOrgs.get(orgId) ?? 0;
    this.subscribedOrgs.set(orgId, n + 1);
    if (n === 0) {
      this.sub.subscribe(CHANNEL_PREFIX + orgId).catch(this.onError);
      // Other instances may be skipping this org's messages (nobody was listening): tell them at once.
      this.pub.publish(SUBSCRIBED_CHANNEL, orgId).catch(this.onError);
    }
    return () => {
      this.local.off(orgId, handler);
      const left = (this.subscribedOrgs.get(orgId) ?? 1) - 1;
      if (left <= 0) {
        this.subscribedOrgs.delete(orgId);
        this.sub.unsubscribe(CHANNEL_PREFIX + orgId).catch(this.onError);
      } else this.subscribedOrgs.set(orgId, left);
    };
  }

  hasSubscribers(orgId: string): boolean {
    if ((this.subscribedOrgs.get(orgId) ?? 0) > 0) return true;
    const now = Date.now();
    let entry = this.remote.get(orgId);
    if (!entry) this.remote.set(orgId, (entry = { has: true, at: 0, refreshing: false }));
    if (now - entry.at > this.remoteTtlMs && !entry.refreshing) {
      entry.refreshing = true;
      const e = entry;
      this.pub
        .pubsub('NUMSUB', CHANNEL_PREFIX + orgId)
        .then((r) => {
          e.has = Number((r as unknown[])[1] ?? 0) > 0;
          e.at = Date.now();
        })
        .catch((err: Error) => {
          e.has = true; // unknown: keep publishing
          this.onError(err);
        })
        .finally(() => {
          e.refreshing = false;
        });
    }
    // Unknown (first ask) or stale: assume someone listens until Redis says otherwise.
    return entry.has;
  }

  async close(): Promise<void> {
    this.local.removeAllListeners();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

export async function createBus(redisUrl: string | null, onError?: (err: Error) => void): Promise<RealtimeBus> {
  if (!redisUrl) return new LocalBus();
  return RedisBus.connect(redisUrl, onError);
}
