import type { LiveMessage } from '@sp/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff, type StaffPrincipal } from '../auth/staff.js';
import type { Ctx } from '../context.js';
import { staffSessions, staffUsers } from '../db/schema.js';

/** WebSocket close code sent when the staff session behind the socket is no longer valid. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/**
 * How often an open socket re-checks its staff session. `periodicMs`: in any case; `onBroadcastAfterMs`: before
 * delivering broadcasts when the last check is older than this (messages are held, in order, meanwhile).
 * Mutable for tests.
 */
export const LIVE_REVALIDATION = { periodicMs: 60_000, onBroadcastAfterMs: 5_000 };

const MAX_HELD_MESSAGES = 1000;

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
 * Sends {type:'hello'} then LiveMessage JSON frames for the staff member's organisation.
 * Server pings every 25 s; connections that miss a pong are terminated.
 * The staff session is re-validated periodically and before delivering broadcasts; after logout, revocation,
 * expiry or a disabled account the socket is closed with code 4401.
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

    const deliver = (msg: LiveMessage) => {
      if (closed || socket.readyState !== socket.OPEN) return;
      // Backpressure guard: drop messages for a client that stopped reading (it will refetch on reconnect).
      if (socket.bufferedAmount > 4 * 1024 * 1024) return;
      socket.send(JSON.stringify(msg));
    };
    const revoke = () => {
      if (closed) return;
      held.length = 0;
      cleanup();
      try {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      } catch {
        socket.terminate();
      }
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
        if (held.length < MAX_HELD_MESSAGES) held.push(msg);
        void revalidate();
        return;
      }
      deliver(msg);
    };
    const unsubscribe = ctx.bus.subscribe(staff.orgId, send);
    deliver({ type: 'hello', serverTime: ctx.now() });

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
