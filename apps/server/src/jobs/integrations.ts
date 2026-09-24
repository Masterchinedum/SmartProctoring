/**
 * Background jobs for integrations and session hygiene, registered on ctx.jobs by app.ts
 * (each run is guarded by the JobRunner's Postgres advisory lock, so one instance works at a time):
 *
 *   webhooks            every 5 s (+ kicked after commits)  services/webhooks.ts      deliverDueWebhooks
 *   email-alerts        every 10 s (+ kicked after commits) services/email-alerts.ts  runEmailAlertJob
 *   abandoned-sessions  hourly                              services/abandonment.ts   closeAbandonedSessions
 */
import type { Ctx } from '../context.js';
import { ABANDON_JOB, ABANDON_JOB_INTERVAL_MS, closeAbandonedSessions } from '../services/abandonment.js';
import { EMAIL_ALERT_JOB, EMAIL_JOB_INTERVAL_MS, runEmailAlertJob } from '../services/email-alerts.js';
import { deliverDueWebhooks, WEBHOOK_JOB } from '../services/webhooks.js';

export function registerIntegrationJobs(ctx: Ctx): void {
  ctx.jobs.register({
    name: WEBHOOK_JOB,
    intervalMs: ctx.config.webhooks.intervalMs,
    runAtStart: true,
    async run(c) {
      const r = await deliverDueWebhooks(c);
      if (r.attempted || r.disabled) c.log.info({ webhooks: r }, 'webhook deliveries');
    },
  });
  ctx.jobs.register({
    name: EMAIL_ALERT_JOB,
    intervalMs: EMAIL_JOB_INTERVAL_MS,
    runAtStart: true,
    async run(c) {
      const r = await runEmailAlertJob(c);
      if (r.emails || r.failedItems) c.log.info({ emailAlerts: r }, 'alert emails');
    },
  });
  ctx.jobs.register({
    name: ABANDON_JOB,
    intervalMs: ABANDON_JOB_INTERVAL_MS,
    runAtStart: true,
    async run(c) {
      const r = await closeAbandonedSessions(c);
      if (r.closed) c.log.info({ closed: r.closed }, 'closed abandoned sessions');
    },
  });
}
