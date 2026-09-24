import type { LiveMessage } from '@sp/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getStaff, requireStaff } from '../auth/staff.js';

/**
 * GET /api/admin/live (WebSocket). Authenticated by the staff cookie before the upgrade.
 * Sends {type:'hello'} then LiveMessage JSON frames for the staff member's organisation.
 * Server pings every 25 s; connections that miss a pong are terminated.
 */
export const liveRoute: FastifyPluginAsync = async (app) => {
  app.get('/api/admin/live', { websocket: true, preHandler: requireStaff('reviewer') }, (socket, req) => {
    const staff = getStaff(req);
    const ctx = app.ctx;
    let alive = true;
    const send = (msg: LiveMessage) => {
      if (socket.readyState === socket.OPEN) {
        // Backpressure guard: drop messages for a client that stopped reading (it will refetch on reconnect).
        if (socket.bufferedAmount > 4 * 1024 * 1024) return;
        socket.send(JSON.stringify(msg));
      }
    };
    const unsubscribe = ctx.bus.subscribe(staff.orgId, send);
    send({ type: 'hello', serverTime: ctx.now() });

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
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
};
