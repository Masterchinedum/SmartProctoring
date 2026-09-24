import { EventEmitter } from 'node:events';
import type { LiveMessage } from '@sp/shared';

/**
 * Staff realtime fan-out. Messages are scoped per organisation.
 * - LocalBus: in-process EventEmitter (single instance).
 * - RedisBus: Redis pub/sub so every server instance's WebSocket clients get every message.
 */
export interface RealtimeBus {
  publish(orgId: string, msg: LiveMessage): void;
  subscribe(orgId: string, handler: (msg: LiveMessage) => void): () => void;
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
  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

const CHANNEL_PREFIX = 'sp:live:';

export class RedisBus implements RealtimeBus {
  private readonly local = new EventEmitter();
  private readonly subscribedOrgs = new Map<string, number>();
  private constructor(
    private readonly pub: import('ioredis').Redis,
    private readonly sub: import('ioredis').Redis,
    private readonly onError: (err: Error) => void,
  ) {
    this.local.setMaxListeners(0);
    this.sub.on('message', (channel: string, payload: string) => {
      if (!channel.startsWith(CHANNEL_PREFIX)) return;
      try {
        this.local.emit(channel.slice(CHANNEL_PREFIX.length), JSON.parse(payload) as LiveMessage);
      } catch (err) {
        this.onError(err as Error);
      }
    });
  }

  static async connect(url: string, onError: (err: Error) => void = () => {}): Promise<RedisBus> {
    const { Redis } = await import('ioredis');
    const opts = { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true } as const;
    const pub = new Redis(url, opts);
    const sub = new Redis(url, opts);
    pub.on('error', onError);
    sub.on('error', onError);
    await Promise.all([pub.connect(), sub.connect()]);
    return new RedisBus(pub, sub, onError);
  }

  publish(orgId: string, msg: LiveMessage): void {
    this.pub.publish(CHANNEL_PREFIX + orgId, JSON.stringify(msg)).catch(this.onError);
  }

  subscribe(orgId: string, handler: (msg: LiveMessage) => void): () => void {
    this.local.on(orgId, handler);
    const n = this.subscribedOrgs.get(orgId) ?? 0;
    this.subscribedOrgs.set(orgId, n + 1);
    if (n === 0) this.sub.subscribe(CHANNEL_PREFIX + orgId).catch(this.onError);
    return () => {
      this.local.off(orgId, handler);
      const left = (this.subscribedOrgs.get(orgId) ?? 1) - 1;
      if (left <= 0) {
        this.subscribedOrgs.delete(orgId);
        this.sub.unsubscribe(CHANNEL_PREFIX + orgId).catch(this.onError);
      } else this.subscribedOrgs.set(orgId, left);
    };
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
