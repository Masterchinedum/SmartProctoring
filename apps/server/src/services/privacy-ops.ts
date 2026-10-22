/**
 * Showing that deletion actually happens, and the organisation's operational health at a glance:
 *
 *  - retentionPreview: what the retention job (services/retention.ts) will delete over the coming days, what is due
 *    but not yet deleted (the job is behind or failing), the sessions kept by a legal hold, and the job's last run
 *    (job_status, services/job-status.ts). Nothing is deleted. The due dates use the same SQL as the job's pre-filter
 *    (the job decides per session with the effective policy, so an invalid stored policy may make it a day apart).
 *  - opsChecks: retention, overdue privacy requests, face-analysis capacity of this instance, failing webhooks, email
 *    alerts, expiring API keys (and, for a sandbox organisation, its automatic clean-up) — each as ok / warning /
 *    failing with one sentence saying what to do.
 */
import { API_KEY_EXPIRY_WARNING_DAYS, PRIVACY_DUE_SOON_DAYS, type OpsCheckDTO, type OpsChecksDTO, type RetentionPreviewDTO } from '@sp/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { apiKeys, candidates, emailAlerts, events, examSessions, exams, organizations, privacyRequests, webhooks } from '../db/schema.js';
import { currentCapacity, type CapacityReason } from './capacity.js';
import { loadJobStatus, RETENTION_JOB, toRetentionJobStatusDTO } from './job-status.js';
import { orgKind, sandboxPurgeDays } from './quotas.js';
import { SANDBOX_PURGE_JOB } from './sandbox-purge.js';
import { OPEN_PRIVACY_STATUSES } from './privacy-requests.js';
import { DAY_MS, evidenceDaysSql, eventDaysSql } from './retention.js';

/** When a session's images are due for deletion (its end + the evidence retention days); joins exams and organizations. */
export const evidenceDueSql = sql`(${examSessions.endedAt} + make_interval(days => (${evidenceDaysSql})::int))`;
const eventsDueSql = sql`(${examSessions.endedAt} + make_interval(days => (${eventDaysSql})::int))`;
/** Images of the session not deleted yet. */
const liveEvidenceSql = sql<number>`(select count(*) from evidence where evidence.session_id = ${examSessions.id} and evidence.purged_at is null)::int`;

export async function retentionPreview(ctx: Pick<Ctx, 'db'>, orgId: string, days: number, now: number): Promise<RetentionPreviewDTO> {
  const nowDate = new Date(now);
  const until = new Date(now + days * DAY_MS);
  const pending = and(eq(examSessions.orgId, orgId), isNotNull(examSessions.endedAt), isNull(examSessions.evidencePurgedAt), eq(examSessions.legalHold, false));

  const dayExpr = sql<string>`to_char(${evidenceDueSql} at time zone 'UTC', 'YYYY-MM-DD')`;
  const [byDay, [overdue], [meta], holds, job] = await Promise.all([
    ctx.db
      .select({ date: dayExpr, sessions: sql<number>`count(*)::int`, evidenceItems: sql<number>`coalesce(sum(${liveEvidenceSql}), 0)::int` })
      .from(examSessions)
      .innerJoin(exams, eq(exams.id, examSessions.examId))
      .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
      .where(and(pending, gt(evidenceDueSql, nowDate), lte(evidenceDueSql, until)))
      // By position: the expression carries bound parameters, so a repeated copy would not match it.
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    ctx.db
      .select({ sessions: sql<number>`count(*)::int`, evidenceItems: sql<number>`coalesce(sum(${liveEvidenceSql}), 0)::int`, oldestDueAt: sql<Date | null>`min(${evidenceDueSql})` })
      .from(examSessions)
      .innerJoin(exams, eq(exams.id, examSessions.examId))
      .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
      .where(and(pending, lte(evidenceDueSql, nowDate))),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(examSessions)
      .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
      .where(
        and(
          eq(examSessions.orgId, orgId),
          isNotNull(examSessions.endedAt),
          eq(examSessions.legalHold, false),
          lte(eventsDueSql, until),
          sql`exists (select 1 from ${events} where ${events.sessionId} = ${examSessions.id})`,
        ),
      ),
    ctx.db
      .select({ sessionId: examSessions.id, candidateName: candidates.name, examTitle: exams.title, endedAt: examSessions.endedAt, evidenceItems: liveEvidenceSql })
      .from(examSessions)
      .innerJoin(exams, eq(exams.id, examSessions.examId))
      .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
      .where(and(eq(examSessions.orgId, orgId), eq(examSessions.legalHold, true)))
      .orderBy(asc(examSessions.endedAt), asc(examSessions.id))
      .limit(500),
    loadJobStatus(ctx.db, RETENTION_JOB),
  ]);
  const oldest = overdue?.oldestDueAt ? new Date(overdue.oldestDueAt).getTime() : null;
  return {
    now,
    days: byDay.map((d) => ({ date: d.date, sessions: d.sessions, evidenceItems: d.evidenceItems })),
    overdue: { sessions: overdue?.sessions ?? 0, evidenceItems: overdue?.evidenceItems ?? 0, oldestDueAt: oldest },
    eventMetadataSessions: meta?.n ?? 0,
    legalHolds: holds.map((h) => ({ sessionId: h.sessionId, candidateName: h.candidateName, examTitle: h.examTitle, endedAt: h.endedAt ? h.endedAt.getTime() : null, evidenceItems: h.evidenceItems })),
    job: toRetentionJobStatusDTO(job, now),
  };
}

/* ------------------------------------------------------------------ operational checks */

/** Due images still there this long after their date: the hourly job should have deleted them. */
const OVERDUE_WARNING_MS = 2 * 3600_000;
const OVERDUE_FAILING_MS = DAY_MS;

const CAPACITY_TEXT: Record<CapacityReason, string> = {
  vision_unavailable: 'no face-analysis worker is running',
  vision_queue_long: 'the face-analysis queue is long',
  event_loop_lagging: 'the server is slow to respond',
  database_pool_exhausted: 'requests are waiting for a database connection',
};

/** An expired key last used this close to its expiry was probably still in use: the connected system now fails. */
const EXPIRED_IN_USE_WINDOW_MS = 7 * DAY_MS;

const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

function ago(now: number, t: number): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export async function opsChecks(ctx: Ctx, orgId: string, now: number): Promise<OpsChecksDTO> {
  const nowDate = new Date(now);
  const [preview, [requests], hooks, [mail], keys, [org]] = await Promise.all([
    retentionPreview(ctx, orgId, 1, now),
    ctx.db
      .select({
        overdue: sql<number>`count(*) filter (where ${privacyRequests.dueAt} < ${nowDate})::int`,
        dueSoon: sql<number>`count(*) filter (where ${privacyRequests.dueAt} >= ${nowDate} and ${privacyRequests.dueAt} < ${new Date(now + PRIVACY_DUE_SOON_DAYS * DAY_MS)})::int`,
        open: sql<number>`count(*)::int`,
      })
      .from(privacyRequests)
      .where(and(eq(privacyRequests.orgId, orgId), inArray(privacyRequests.status, OPEN_PRIVACY_STATUSES))),
    ctx.db
      .select({ active: webhooks.active, failingSince: webhooks.failingSince, disabledReason: webhooks.disabledReason })
      .from(webhooks)
      .where(eq(webhooks.orgId, orgId)),
    ctx.db
      .select({
        failed: sql<number>`count(*) filter (where ${emailAlerts.status} = 'failed' and ${emailAlerts.createdAt} > ${new Date(now - DAY_MS)})::int`,
        stuck: sql<number>`count(*) filter (where ${emailAlerts.status} = 'pending' and ${emailAlerts.createdAt} < ${new Date(now - 30 * 60_000)})::int`,
      })
      .from(emailAlerts)
      .where(eq(emailAlerts.orgId, orgId)),
    ctx.db
      .select({ name: apiKeys.name, expiresAt: apiKeys.expiresAt, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .orderBy(asc(apiKeys.expiresAt)),
    ctx.db.select({ kind: organizations.kind, sandboxPurgeDays: organizations.sandboxPurgeDays }).from(organizations).where(eq(organizations.id, orgId)),
  ]);
  const checks: OpsCheckDTO[] = [];

  const job = preview.job;
  checks.push(
    job.lastStartedAt == null
      ? { id: 'retention_job', label: 'Retention job', status: 'warning', detail: 'The retention job has not run yet. It runs hourly on a server with background jobs enabled (SWEEPER_ENABLED).' }
      : job.lastError
        ? { id: 'retention_job', label: 'Retention job', status: 'failing', detail: `The last run failed: ${job.lastError}. Check the server log; images due for deletion are kept until a run succeeds.` }
        : job.stale
          ? {
              id: 'retention_job',
              label: 'Retention job',
              status: 'warning',
              detail: `No successful run since ${job.lastSuccessAt ? ago(now, job.lastSuccessAt) : 'the start'}. Make sure at least one server runs background jobs (SWEEPER_ENABLED).`,
            }
          : job.lastSummary?.failures
            ? { id: 'retention_job', label: 'Retention job', status: 'warning', detail: `Last run ${ago(now, job.lastSuccessAt!)}: ${job.lastSummary.failures} session(s) could not be deleted and will be retried. Check the evidence storage.` }
            : { id: 'retention_job', label: 'Retention job', status: 'ok', detail: `Last run ${ago(now, job.lastSuccessAt!)}.` },
  );

  const od = preview.overdue;
  const late = od.oldestDueAt != null ? now - od.oldestDueAt : 0;
  checks.push(
    od.sessions === 0
      ? { id: 'retention_overdue', label: 'Deletion on schedule', status: 'ok', detail: 'No images are past their deletion date.' }
      : {
          id: 'retention_overdue',
          label: 'Deletion on schedule',
          status: late > OVERDUE_FAILING_MS ? 'failing' : late > OVERDUE_WARNING_MS ? 'warning' : 'ok',
          detail: `${od.evidenceItems} image(s) of ${od.sessions} session(s) are past their deletion date (oldest ${ago(now, od.oldestDueAt!)}).${late > OVERDUE_WARNING_MS ? ' See the retention job above.' : ' The next hourly run deletes them.'}`,
        },
  );

  checks.push(
    requests.overdue > 0
      ? { id: 'privacy_requests', label: 'Privacy requests', status: 'failing', detail: `${requests.overdue} request(s) are past their legal deadline. Answer them, or record an extension with its reason.` }
      : requests.dueSoon > 0
        ? { id: 'privacy_requests', label: 'Privacy requests', status: 'warning', detail: `${requests.dueSoon} request(s) are due within ${PRIVACY_DUE_SOON_DAYS} days.` }
        : { id: 'privacy_requests', label: 'Privacy requests', status: 'ok', detail: requests.open ? `${requests.open} open request(s), none due within ${PRIVACY_DUE_SOON_DAYS} days.` : 'No open requests.' },
  );

  const cap = currentCapacity(ctx);
  checks.push(
    cap.accepting
      ? { id: 'capacity', label: 'Face analysis (this server)', status: 'ok', detail: 'This server is accepting exam starts.' }
      : {
          id: 'capacity',
          label: 'Face analysis (this server)',
          status: cap.reasons.includes('vision_unavailable') ? 'failing' : 'warning',
          detail: `This server is holding back exam starts: ${cap.reasons.map((r) => CAPACITY_TEXT[r]).join(', ')}. See OPERATIONS.md (capacity).`,
        },
  );

  const disabled = hooks.filter((h) => !h.active && h.disabledReason === 'failures').length;
  const failing = hooks.filter((h) => h.active && h.failingSince).length;
  checks.push(
    disabled
      ? { id: 'webhooks', label: 'Webhooks', status: 'failing', detail: `${disabled} webhook(s) were switched off after repeated failures. Fix the receiver, then re-enable them on the Integrations page.` }
      : failing
        ? { id: 'webhooks', label: 'Webhooks', status: 'warning', detail: `${failing} webhook(s) are failing; deliveries are retried. See the Integrations page.` }
        : { id: 'webhooks', label: 'Webhooks', status: 'ok', detail: hooks.length ? 'All webhooks are delivering.' : 'No webhooks configured.' },
  );

  checks.push(
    !ctx.mailer
      ? { id: 'email_alerts', label: 'Email alerts', status: 'ok', detail: 'Email alerts are not configured (SMTP_URL); staff see alerts on the dashboard.' }
      : mail.failed || mail.stuck
        ? {
            id: 'email_alerts',
            label: 'Email alerts',
            status: 'warning',
            detail: `${mail.failed} alert email(s) failed in the last 24 h${mail.stuck ? `, ${mail.stuck} waiting for over 30 minutes` : ''}. Check the SMTP settings and the server log.`,
          }
        : { id: 'email_alerts', label: 'Email alerts', status: 'ok', detail: 'Alert emails are being sent.' },
  );

  const exp = (k: (typeof keys)[number]) => k.expiresAt?.getTime() ?? Infinity;
  const usable = keys.filter((k) => exp(k) > now);
  const expiring = usable.filter((k) => exp(k) <= now + API_KEY_EXPIRY_WARNING_DAYS * DAY_MS);
  const expiredInUse = keys.filter((k) => exp(k) <= now && k.lastUsedAt != null && k.lastUsedAt.getTime() >= exp(k) - EXPIRED_IN_USE_WINDOW_MS);
  checks.push(
    expiredInUse.length
      ? {
          id: 'api_keys',
          label: 'API keys',
          status: 'failing',
          detail: `${expiredInUse.length} API key(s) expired while still in use (“${expiredInUse[0].name}” on ${utcDate(exp(expiredInUse[0]))}): the connected system now gets “API key expired” errors. Create a new key for it on the Integrations page, then revoke the expired one.`,
        }
      : expiring.length
        ? {
            id: 'api_keys',
            label: 'API keys',
            status: 'warning',
            detail: `${expiring.length} API key(s) expire within ${API_KEY_EXPIRY_WARNING_DAYS} days (“${expiring[0].name}” on ${utcDate(exp(expiring[0]))}). Create a replacement on the Integrations page, update the connected system, then revoke the old key.`,
          }
        : {
            id: 'api_keys',
            label: 'API keys',
            status: 'ok',
            detail: usable.length ? `${usable.length} active API key(s); none expire within ${API_KEY_EXPIRY_WARNING_DAYS} days.` : 'No active API keys.',
          },
  );

  if (orgKind(org) === 'sandbox') checks.push(sandboxPurgeCheck(toRetentionJobStatusDTO(await loadJobStatus(ctx.db, SANDBOX_PURGE_JOB), now), sandboxPurgeDays(org), now));

  return { now, checks };
}

/** A sandbox organisation's automatic clean-up (services/sandbox-purge.ts), from its job_status row. */
function sandboxPurgeCheck(job: ReturnType<typeof toRetentionJobStatusDTO>, days: number, now: number): OpsCheckDTO {
  const label = 'Sandbox clean-up';
  const rule = `This sandbox’s exam sessions, images and candidates are deleted ${days} days after their last use.`;
  if (job.lastStartedAt == null) return { id: 'sandbox_purge', label, status: 'warning', detail: `The clean-up has not run yet. It runs hourly on a server with background jobs enabled (SWEEPER_ENABLED). ${rule}` };
  if (job.lastError) return { id: 'sandbox_purge', label, status: 'failing', detail: `The last clean-up failed: ${job.lastError}. Check the server log. ${rule}` };
  if (job.stale) return { id: 'sandbox_purge', label, status: 'warning', detail: `No successful clean-up since ${job.lastSuccessAt ? ago(now, job.lastSuccessAt) : 'the start'}. Make sure at least one server runs background jobs (SWEEPER_ENABLED). ${rule}` };
  const failures = (job.lastSummary as { failures?: number } | null)?.failures ?? 0;
  if (failures) return { id: 'sandbox_purge', label, status: 'warning', detail: `Last run ${ago(now, job.lastSuccessAt!)}: ${failures} item(s) could not be deleted and will be retried. Check the evidence storage. ${rule}` };
  return { id: 'sandbox_purge', label, status: 'ok', detail: `Last run ${ago(now, job.lastSuccessAt!)}. ${rule}` };
}
