import type { FastifyPluginAsync } from 'fastify';
import { candidatesRoutes } from './candidates.js';
import { eventRoutes } from './events.js';
import { evidenceRoutes } from './evidence.js';
import { examRoutes } from './exams.js';
import { integrationRoutes } from './integrations.js';
import { metricsRoutes } from './metrics.js';
import { orgRoutes } from './org.js';
import { sessionRoutes } from './sessions.js';
import { toolRoutes } from './tools.js';
import { verifierRoutes } from './verifiers.js';

/**
 * Staff API plugin, registered by app.ts with prefix /api/admin:
 *   app.register(adminRoutes, { prefix: '/api/admin' })
 *
 * Every route is guarded with `preHandler: requireStaff(<role>)` (src/auth/staff.ts) and scoped to the
 * staff member's organisation. The endpoint index (paths, roles, DTOs) is at the end of
 * packages/shared/src/api.ts. The realtime WebSocket GET /api/admin/live is registered separately
 * (src/realtime/live-route.ts).
 *
 *   sessions.ts    dashboard, sessions list/detail/events/CSV/timeline/report/notes, lifecycle actions
 *   events.ts      org-wide event feed, event detail, review decisions, event notes
 *   evidence.ts    decrypted evidence images (audited), identity comparison view
 *   exams.ts       exams CRUD, publish/archive, exam sessions, assignments
 *   candidates.ts  candidates CRUD, approved ID photos
 *   org.ts         organisation settings, staff users, audit log
 *   metrics.ts     detection quality, offline evaluation uploads
 *   integrations.ts  API keys, webhooks (+ deliveries), email-alert test, integration status
 *   tools.ts       staff camera self-test of the identity pipeline (transient, nothing stored)
 *   verifiers.ts   external second-opinion face verifier: providers offered, test connection
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(sessionRoutes);
  await app.register(eventRoutes);
  await app.register(evidenceRoutes);
  await app.register(examRoutes);
  await app.register(candidatesRoutes);
  await app.register(orgRoutes);
  await app.register(metricsRoutes);
  await app.register(integrationRoutes);
  await app.register(toolRoutes);
  await app.register(verifierRoutes);
};

export default adminRoutes;
