import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMessage } from '@sp/shared';
import { LIVE_RESYNC_CLOSE_CODE, LiveConnection, RESYNC_IMMEDIATE_AFTER_MS, type LiveStatus, type SocketLike } from './liveConnection';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: LiveMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

const hello: LiveMessage = { type: 'hello', serverTime: 1 };
const sessionMsg = (id: string): LiveMessage => ({ type: 'session', session: { id } as never });

function setup() {
  const sockets: FakeSocket[] = [];
  const applied: { msg: LiveMessage; replay: boolean }[] = [];
  const statuses: LiveStatus[] = [];
  let resolveResync: () => void = () => {};
  const resync = vi.fn(() => new Promise<void>((r) => (resolveResync = r)));
  const sessionEnded = vi.fn();
  const conn = new LiveConnection({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onMessage: (msg, replay) => applied.push({ msg, replay }),
    resync,
    onStatus: (st) => statuses.push(st),
    onSessionEnded: sessionEnded,
    random: () => 0.5,
  });
  return { conn, sockets, applied, statuses, resync, finishResync: () => resolveResync(), sessionEnded };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LiveConnection', () => {
  it('refetches the live views on the FIRST connection too (once subscribed), not only after a reconnect', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].open();
    expect(t.resync).not.toHaveBeenCalled(); // not before the server confirms the subscription
    t.sockets[0].receive(hello);
    await flush();
    expect(t.resync).toHaveBeenCalledTimes(1);
    t.sockets[0].receive(hello); // later hellos (ping replies) do not refetch again
    await flush();
    expect(t.resync).toHaveBeenCalledTimes(1);
    t.conn.stop();
  });

  it('re-applies messages that arrived while the refetch was in flight, after it lands', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].open();
    t.sockets[0].receive(hello);
    await flush();
    t.sockets[0].receive(sessionMsg('S1')); // e.g. "submitted", committed after the refetch's snapshot
    expect(t.applied.map((a) => [a.msg.type, a.replay])).toEqual([
      ['hello', false],
      ['session', false],
    ]);
    t.finishResync();
    await flush();
    expect(t.applied.map((a) => [a.msg.type, a.replay])).toEqual([
      ['hello', false],
      ['session', false],
      ['session', true],
    ]);
    t.sockets[0].receive(sessionMsg('S2')); // after the refetch: applied once
    expect(t.applied.filter((a) => a.replay)).toHaveLength(1);
    t.conn.stop();
  });

  it('refetches again after every reconnect', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].open();
    t.sockets[0].receive(hello);
    await flush();
    t.finishResync();
    t.sockets[0].serverClose(1006);
    expect(t.statuses.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1000); // backoff(0) with no jitter
    expect(t.sockets).toHaveLength(2);
    t.sockets[1].open();
    t.sockets[1].receive(hello);
    await flush();
    expect(t.resync).toHaveBeenCalledTimes(2);
    t.conn.stop();
  });

  it('4408 (resync): reconnects immediately, not after the backoff, and refetches', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].open();
    t.sockets[0].receive(hello);
    await flush();
    t.finishResync();
    vi.advanceTimersByTime(RESYNC_IMMEDIATE_AFTER_MS);
    t.sockets[0].serverClose(LIVE_RESYNC_CLOSE_CODE);
    expect(t.statuses.at(-1)).toBe('connecting'); // no "disconnected" banner for a planned resync
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(2);
    t.sockets[1].open();
    t.sockets[1].receive(hello);
    await flush();
    expect(t.resync).toHaveBeenCalledTimes(2);
    t.conn.stop();
  });

  it('4408 right after connecting again backs off (a slow client cannot loop)', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].open();
    vi.advanceTimersByTime(RESYNC_IMMEDIATE_AFTER_MS);
    t.sockets[0].serverClose(LIVE_RESYNC_CLOSE_CODE);
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(2); // first one: immediate
    t.sockets[1].open();
    t.sockets[1].serverClose(LIVE_RESYNC_CLOSE_CODE); // again at once
    vi.advanceTimersByTime(0);
    expect(t.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(t.sockets).toHaveLength(3);
    t.conn.stop();
  });

  it('4401: re-checks the sign-in and backs off; ordinary drops use the exponential backoff', async () => {
    const t = setup();
    t.conn.start();
    t.sockets[0].serverClose(4401);
    expect(t.sessionEnded).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(2);
    t.sockets[1].serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(t.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(3);
    t.conn.stop();
  });

  it('stop() closes the socket and ignores late callbacks', async () => {
    const t = setup();
    t.conn.start();
    const s = t.sockets[0];
    t.conn.stop();
    expect(s.closed).toBe(true);
    expect(s.onmessage).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });
});
