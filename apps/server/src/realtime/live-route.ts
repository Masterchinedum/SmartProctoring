import type { LiveMessage } from '@sp/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff, type StaffPrincipal } from '../auth/staff.js';
import type { Ctx } from '../context.js';
import { staffSessions, staffUsers } from '../db/schema.js';

/** WebSocket close code sent when the staff session behind the socket is no longer valid. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
/**
 * WebSocket close code sent when messages for this client had to be dropped (it fell too far behind): the client
 * reconnects at once and refetches its views (web admin api/live.tsx). Never drop silently.
 */
export const WS_CLOSE_RESYNC = 4408;

/**
 * How often an open socket re-checks its staff session. `periodicMs`: in any case; `onBroadcastAfterMs`: before
 * delivering broadcasts when the last check is older than this (messages are held, in order, meanwhile).
 * Mutable for tests.
 */
export const LIVE_REVALIDATION = { periodicMs: 60_000, onBroadcastAfterMs: 5_000 };

/**
 * Per-socket limits (mutable for tests): broadcasts held while the staff session is re-validated, and bytes queued
 * for a client that stopped reading. Beyond either the socket is closed with WS_CLOSE_RESYNC.
 */
export const LIVE_LIMITS = { maxHeldMessages: 1000, maxBufferedBytes: 4 * 1024 * 1024 };

/** Is the staff session still valid: not logged out / revoked / expired, user not disabled, same organisation? */
export async function staffSessionStillValid(ctx: Pick<Ctx, 'db' | 'now'>, staff: Pick<StaffPrincipal, 'staffSessionId' | 'id' | 'orgId'>): Promise<boolean> {
  const [row] = await ctx.db
    .select({ userId: staffUsers.id, orgId: staffUsers.orgId, disabled: staffUsers.disabled })
    .from(staffSessions)
    .innerJoin(staffUsers, eq(staffUsers.id, staffSessions.staffUserId))
    .where(and(eq(staffSessions.id, staff.staffSessionId), gt(staffSessions.expiresAt, new Date(ctx.now()))));
  return !!row && !row.disabled && row.userId === staff.id && row.orgId === staff.orgId;
}

/**
 * GET /api/admin/live (WebSocket). Authenticated by the staff cookie before the upgrade.
 * Sends {type:'hello'} once the subscription is live (the client refetches its views then), then LiveMessage JSON
 * frames for the staff member's organisation.
 * Server pings every 25 s; connections that miss a pong are terminated.
 * The staff session is re-validated periodically and before delivering broadcasts; after logout, revocation,
 * expiry or a disabled account the socket is closed with code 4401. A client that falls too far behind (held
 * broadcasts or send buffer over LIVE_LIMITS) is closed with 4408 so it reconnects and resyncs.
 */
export const liveRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/live', { websocket: true, preHandler: requireStaff('reviewer') }, (socket, req) => {
    const staff = getStaff(req);
    const ctx = app.ctx;
    let alive = true;
    let closed = false;
    let lastValidated = Date.now();
    let checking: Promise<boolean> | null = null;
    const held: LiveMessage[] = [];

    const closeWith = (code: number, reason: string) => {
      if (closed) return;
      held.length = 0;
      cleanup();
      try {
        socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    };
    const revoke = () => closeWith(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
    // Messages would have to be dropped: tell the client to reconnect and refetch instead of losing them silently.
    const resync = (why: 'backpressure' | 'held_overflow') => {
      ctx.log.warn({ staffId: staff.id, why }, 'live: client fell behind; closing for resync');
      closeWith(WS_CLOSE_RESYNC, 'resync');
    };
    const deliver = (msg: LiveMessage) => {
      if (closed || socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > LIVE_LIMITS.maxBufferedBytes) return resync('backpressure');
      socket.send(JSON.stringify(msg));
    };
    const revalidate = (): Promise<boolean> => {
      checking ??= staffSessionStillValid(ctx, staff)
        .catch((err) => {
          // A database hiccup is not a logout: keep the socket, try again later.
          ctx.log.warn({ err }, 'live: staff session re-validation failed');
          return true;
        })
        .then((ok) => {
          checking = null;
          lastValidated = Date.now();
          if (!ok) revoke();
          else for (const m of held.splice(0)) deliver(m);
          return ok;
        });
      return checking;
    };
    const send = (msg: LiveMessage) => {
      if (closed) return;
      if (checking || Date.now() - lastValidated >= LIVE_REVALIDATION.onBroadcastAfterMs) {
        // Hold this broadcast batch until the staff session is confirmed (order preserved).
        if (held.length >= LIVE_LIMITS.maxHeldMessages) return resync('held_overflow');
        held.push(msg);
        void revalidate();
        return;
      }
      deliver(msg);
    };
    const unsubscribe = ctx.bus.subscribe(staff.orgId, send);
    // 'hello' = "subscribed": the client refetches its snapshot on it, so a change committed between its first
    // load and this subscription is not missed (with Redis: only once the SUBSCRIBE is confirmed).
    void Promise.resolve(ctx.bus.whenSubscribed?.(staff.orgId))
      .catch(() => {})
      .then(() => deliver({ type: 'hello', serverTime: ctx.now() }));

    const recheck = setInterval(() => void revalidate(), LIVE_REVALIDATION.periodicMs);
    recheck.unref?.();
    const ping = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* closed */
      }
    }, 25_000);
    ping.unref?.();
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (raw: Buffer) => {
      // Clients may send {"type":"ping"}; reply with hello (serverTime) so they can measure skew.
      alive = true;
      if (raw.length < 200 && raw.toString().includes('ping')) send({ type: 'hello', serverTime: ctx.now() });
    });
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(recheck);
      unsubscribe();
    }
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
};
