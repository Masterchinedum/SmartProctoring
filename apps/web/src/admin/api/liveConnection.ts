import type { LiveMessage } from '@sp/shared';
import { isSessionEndedClose } from '../lib/auth-errors';

/**
 * The staff realtime socket's lifecycle, independent of React (api/live.tsx wires it to the query cache).
 *
 *  - Resync on every connection: the server sends 'hello' once the subscription is live; the first 'hello' of each
 *    socket refetches the live views. A change committed between the page's first load (or a disconnect) and the
 *    subscription is never published to this client, so the refetch is the only way to see it. Messages that
 *    arrive while the refetch is in flight are re-applied when it lands (its snapshot may predate them).
 *  - 4408 (server: this client fell behind and messages would have been dropped): reconnect at once — the new
 *    socket's 'hello' refetches. Repeated 4408s right after connecting fall back to the backoff.
 *  - 4401 (staff session ended): `onSessionEnded` (re-check sign-in), then the normal backoff.
 *  - Anything else: exponential backoff with jitter.
 */

export type LiveStatus = 'connecting' | 'open' | 'reconnecting';

/** Close code: the server had to drop messages for this client; reconnect and refetch (apps/server live-route.ts). */
export const LIVE_RESYNC_CLOSE_CODE = 4408;
/** A socket that lived at least this long before a 4408 reconnects immediately; shorter-lived ones back off. */
export const RESYNC_IMMEDIATE_AFTER_MS = 5_000;

/** Backoff: 1 s, 2 s, 4 s … capped at 30 s, with ±20 % jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** The part of a WebSocket the connection uses (a browser WebSocket, or a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export interface LiveConnectionOptions {
  createSocket: () => SocketLike;
  /** Apply a message. `replay`: re-applied after a resync fetch landed (already announced once). */
  onMessage: (msg: LiveMessage, replay: boolean) => void;
  /** Refetch the live views (dashboard, session lists, open session); settles when done. */
  resync: () => Promise<unknown>;
  onStatus: (status: LiveStatus, nextRetryAt: number | null) => void;
  /** The server closed with 4401. */
  onSessionEnded: () => void;
  random?: () => number;
  now?: () => number;
}

export class LiveConnection {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private fastResyncs = 0;
  private openedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Messages received while the current resync fetch is in flight. */
  private replay: LiveMessage[] | null = null;
  private readonly now: () => number;

  constructor(private readonly o: LiveConnectionOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const s = this.ws;
    this.ws = null;
    if (s) {
      s.onopen = null;
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** Reconnect now (user action) unless a socket is open or connecting. */
  reconnectNow(): void {
    if (this.disposed || (this.ws && this.ws.readyState <= OPEN)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.o.onStatus('connecting', null);
    this.connect();
  }

  private reconnectIn(delay: number): void {
    if (this.disposed) return;
    this.o.onStatus('reconnecting', this.now() + delay);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private scheduleReconnect(): void {
    const delay = backoffMs(this.attempt, this.o.random);
    this.attempt += 1;
    this.reconnectIn(delay);
  }

  private connect(): void {
    if (this.disposed) return;
    this.retryTimer = null;
    let socket: SocketLike;
    try {
      socket = this.o.createSocket();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    let synced = false;
    socket.onopen = () => {
      if (this.disposed || this.ws !== socket) return;
      this.attempt = 0;
      this.openedAt = this.now();
      this.o.onStatus('open', null);
    };
    socket.onmessage = (e) => {
      if (this.ws !== socket || typeof e.data !== 'string') return;
      let msg: LiveMessage;
      try {
        msg = JSON.parse(e.data) as LiveMessage;
      } catch {
        return;
      }
      this.o.onMessage(msg, false);
      this.replay?.push(msg);
      if (msg.type === 'hello' && !synced) {
        // Subscribed: catch up on anything committed before (first load, or while disconnected).
        synced = true;
        this.startResync();
      }
    };
    socket.onclose = (ev) => {
      if (this.ws !== socket) return;
      this.ws = null;
      if (isSessionEndedClose(ev.code)) this.o.onSessionEnded();
      if (ev.code === LIVE_RESYNC_CLOSE_CODE) {
        const lived = this.openedAt > 0 ? this.now() - this.openedAt : 0;
        this.fastResyncs = lived >= RESYNC_IMMEDIATE_AFTER_MS ? 0 : this.fastResyncs + 1;
        if (this.fastResyncs === 0) {
          // At once, and without the "disconnected" banner: this is a planned resync, not an outage.
          this.attempt = 0;
          this.o.onStatus('connecting', null);
          this.retryTimer = setTimeout(() => this.connect(), 0);
          return;
        }
        this.attempt = Math.max(this.attempt, this.fastResyncs - 1);
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  private startResync(): void {
    const buffer: LiveMessage[] = [];
    this.replay = buffer;
    void Promise.resolve()
      .then(() => this.o.resync())
      .catch(() => undefined)
      .then(() => {
        if (this.replay === buffer) this.replay = null;
        if (this.disposed) return;
        for (const m of buffer) this.o.onMessage(m, true);
      });
  }
}
