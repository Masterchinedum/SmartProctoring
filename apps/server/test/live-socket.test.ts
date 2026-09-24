/**
 * Staff WebSocket (/api/admin/live) never drops messages silently (P2-6): when a client falls too far behind —
 * too many broadcasts held while its staff session is re-validated, or too much queued for a client that stopped
 * reading — the socket is closed with 4408 ('resync'), and the admin client reconnects at once and refetches.
 * 'hello' is sent once the subscription is live (P2-5: the client refetches its snapshot on it).
 */
import type { LiveMessage } from '@sp/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_LIMITS, LIVE_REVALIDATION, WS_CLOSE_RESYNC } from '../src/realtime/live-route.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let port: number;
beforeAll(async () => {
  env = await createTestEnv();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(async () => env?.close());

const savedRevalidation = { ...LIVE_REVALIDATION };
const savedLimits = { ...LIVE_LIMITS };
afterEach(() => {
  Object.assign(LIVE_REVALIDATION, savedRevalidation);
  Object.assign(LIVE_LIMITS, savedLimits);
});

async function openSocket(cookie: string) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/admin/live`, { headers: { cookie } });
  const msgs: LiveMessage[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('message', (d) => {
      msgs.push(JSON.parse(String(d)));
      resolve();
    });
    ws.on('error', reject);
  });
  return { ws, msgs, closed };
}

const note = (i: number): LiveMessage => ({ type: 'hello', serverTime: i });

describe('live socket: no silent drops', () => {
  it('the first message is hello, and a broadcast published right after it is delivered', async () => {
    const s = await openSocket(await env.login('reviewer'));
    expect(s.msgs[0].type).toBe('hello');
    env.ctx.bus.publish(env.org.id, note(7));
    const got = () => s.msgs.some((m) => m.type === 'hello' && m.serverTime === 7);
    for (let i = 0; i < 100 && !got(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(got()).toBe(true);
    s.ws.close();
  });

  it('closes with 4408 (resync) instead of dropping broadcasts beyond the held-message limit', async () => {
    const s = await openSocket(await env.login('reviewer'));
    LIVE_REVALIDATION.onBroadcastAfterMs = 0; // every broadcast is held until the staff session is re-checked
    LIVE_LIMITS.maxHeldMessages = 3;
    for (let i = 0; i < 10; i++) env.ctx.bus.publish(env.org.id, note(100 + i));
    expect(await s.closed).toBe(WS_CLOSE_RESYNC);
    // Nothing after the overflow was delivered as if the stream were complete.
    expect(s.msgs.filter((m) => m.type === 'hello' && m.serverTime >= 100 && m.serverTime < 200)).toEqual([]);
  });

  it('closes with 4408 (resync) instead of dropping messages for a client that stopped reading', async () => {
    const s = await openSocket(await env.login('reviewer'));
    LIVE_LIMITS.maxBufferedBytes = -1; // pretend the send buffer is over the limit
    env.ctx.bus.publish(env.org.id, note(200));
    expect(await s.closed).toBe(WS_CLOSE_RESYNC);
  });
});
