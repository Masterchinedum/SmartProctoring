import type { FastifyPluginAsync } from 'fastify';

/**
 * Staff API plugin, registered by app.ts with prefix /api/admin:
 *   app.register(adminRoutes, { prefix: '/api/admin' })
 *
 * Owned by the admin-API agent. Guard every route with `preHandler: requireStaff(<role>)`
 * (src/auth/staff.ts) and read the principal with getStaff(req). Services: app.ctx (src/context.ts).
 * The realtime WebSocket GET /api/admin/live is registered separately (src/realtime/live-route.ts).
 */
export const adminRoutes: FastifyPluginAsync = async (_app) => {
  // Routes are registered here by the admin-API module.
};

export default adminRoutes;
