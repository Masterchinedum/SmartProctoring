/**
 * Email alerts to the organisation's alert recipients (Settings → Integrations), only when SMTP is configured.
 *
 * Enqueue: services/integration-events.ts inserts one `email_alerts` row per alert-worthy occurrence (hold,
 * pause request needing approval, high-severity potential integrity event) inside the session transaction,
 * according to the org's `emailAlerts` toggles. (eventId, kind) is unique, so replays never enqueue twice.
 *
 * Send (job 'email-alerts', every 10 s under the JobRunner advisory lock, kicked after commits): for each session
 * with due items, at most ONE email per session per 5 minutes — the first alert goes out right away, anything
 * that follows within 5 minutes is collected into a single digest sent when the window opens. Failed sends are
 * retried (1, 5, 15, 30 min; 5 attempts). Emails are plain text + simple HTML with a link to the session in the
 * staff app; they never contain images, face data or similarity scores. Rows are deleted after 30 days.
 */
import { SEVERITY_RANK, type HoldReason, type Severity } from '@sp/shared';
import { and, asc, eq, inArray, lt, lte, max, ne } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { candidates, emailAlerts, examSessions, exams, organizations, type EmailAlert, type EmailAlertKind, type OrgSettings } from '../db/schema.js';
import { headerSafe, type MailMessage } from '../lib/mailer.js';
import { orgSettings } from './org.js';

export const EMAIL_ALERT_JOB = 'email-alerts';
export const EMAIL_JOB_INTERVAL_MS = 10_000;
/** At most one email per session per this window. */
export const EMAIL_THROTTLE_MS = 5 * 60_000;
/** Wait after the n-th failed send (index n-1); the 5th failure is final. */
export const EMAIL_RETRY_MS = [60_000, 300_000, 900_000, 1_800_000];
export const EMAIL_MAX_ATTEMPTS = EMAIL_RETRY_MS.length + 1;
export const EMAIL_ALERT_RETENTION_MS = 30 * 24 * 3600_000;
const SESSIONS_PER_RUN = 100;

export const HOLD_REASON_SENTENCES: Record<HoldReason, string> = {
  identity_mismatch: 'a possible different person was observed and needs review',
  identity_unverifiable: 'the candidate’s identity could not be verified after several attempts (image quality; not evidence of a different person)',
  id_photo_mismatch: 'the live image may not match the approved ID photo and needs review',
  pause_limit: 'the pause was longer than the exam rules allow',
  staff: 'a staff member placed it on hold',
  id_photo_unverifiable: 'the live image could not be compared dependably with the approved ID photo (image quality; not evidence of a different person)',
};

export function alertKindEnabled(s: Pick<OrgSettings, 'emailAlerts'>, kind: EmailAlertKind): boolean {
  return kind === 'hold' ? s.emailAlerts.holds : kind === 'pause_request' ? s.emailAlerts.pauseRequests : s.emailAlerts.highSeverity;
}

/** Whether a new event of this severity/category is a "high severity" alert. */
export function isHighSeverityAlert(category: string, severity: Severity): boolean {
  return category !== 'neutral' && SEVERITY_RANK[severity] >= SEVERITY_RANK.high;
}

export interface EmailAlertInput {
  kind: EmailAlertKind;
  eventId: string;
  sessionId: string;
  title: string;
  observation: string;
  severity: Severity;
  occurredAt: number;
}

export async function enqueueEmailAlerts(db: DbOrTx, orgId: string, items: EmailAlertInput[], now: number): Promise<number> {
  if (items.length === 0) return 0;
  const rows = await db
    .insert(emailAlerts)
    .values(
      items.map((i) => ({
        orgId,
        sessionId: i.sessionId,
        kind: i.kind,
        eventId: i.eventId,
        title: i.title.slice(0, 300),
        observation: i.observation.slice(0, 1000),
        severity: i.severity,
        occurredAt: new Date(i.occurredAt),
        status: 'pending' as const,
        attempts: 0,
        nextAttemptAt: new Date(now),
        createdAt: new Date(now),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: emailAlerts.id });
  return rows.length;
}

/* ------------------------------------------------------------------ composing */

export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function sessionStaffUrl(publicUrl: string, sessionId: string): string {
  return `${publicUrl}/admin/sessions/${sessionId}`;
}

export interface DigestContext {
  orgName: string;
  sessionId: string;
  candidate: { name: string; externalId: string | null };
  exam: { title: string };
  staffUrl: string;
}

/** One email for a session's pending alerts (oldest first). Observational wording, no images. */
export function composeAlertEmail(c: DigestContext, items: Pick<EmailAlert, 'title' | 'observation' | 'occurredAt'>[], to: string[]): MailMessage {
  const who = `${c.candidate.name} — ${c.exam.title}`;
  const subject = headerSafe(`[SmartProctoring] ${items.length === 1 ? items[0].title : `${items.length} alerts`}: ${who}`);
  const lines = items.map((i) => `• ${formatUtc(i.occurredAt.getTime())} — ${i.title}: ${i.observation}`);
  const text = [
    `SmartProctoring alert for ${c.orgName}`,
    '',
    `Candidate: ${c.candidate.name}${c.candidate.externalId ? ` (external ID ${c.candidate.externalId})` : ''}`,
    `Exam: ${c.exam.title}`,
    '',
    ...lines,
    '',
    'Open the session in the staff app (sign-in required) to review the timeline and evidence:',
    c.staffUrl,
    '',
    'These are observations for human review, not conclusions. For privacy, alert emails never contain images.',
    'You receive this email because your address is an alert recipient in SmartProctoring (Settings → Integrations).',
  ].join('\n');
  const html = [
    '<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#1f2933;line-height:1.5">',
    `<p style="margin:0 0 12px"><strong>SmartProctoring alert</strong> for ${escapeHtml(c.orgName)}</p>`,
    `<p style="margin:0 0 12px">Candidate: <strong>${escapeHtml(c.candidate.name)}</strong>${c.candidate.externalId ? ` (external ID ${escapeHtml(c.candidate.externalId)})` : ''}<br>Exam: ${escapeHtml(c.exam.title)}</p>`,
    '<ul style="padding-left:18px;margin:0 0 12px">',
    ...items.map((i) => `<li style="margin-bottom:6px"><span style="color:#52606d">${escapeHtml(formatUtc(i.occurredAt.getTime()))}</span> — <strong>${escapeHtml(i.title)}</strong>: ${escapeHtml(i.observation)}</li>`),
    '</ul>',
    `<p style="margin:0 0 16px"><a href="${escapeHtml(c.staffUrl)}" style="display:inline-block;background:#2f5bea;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open the session</a></p>`,
    '<p style="margin:0;color:#52606d;font-size:12px">These are observations for human review, not conclusions. For privacy, alert emails never contain images. You receive this email because your address is an alert recipient in SmartProctoring (Settings → Integrations).</p>',
    '</body></html>',
  ].join('');
  return { to, subject, text, html };
}

export function composeTestEmail(orgName: string, publicUrl: string, to: string[], sentBy: string): MailMessage {
  const url = `${publicUrl}/admin/integrations`;
  return {
    to,
    subject: `[SmartProctoring] Test email for ${orgName}`,
    text: `This is a test email from SmartProctoring for ${orgName}, sent by ${sentBy}.\n\nEmail alerts are working. Alert settings: ${url}\n`,
    html: `<p>This is a test email from SmartProctoring for ${escapeHtml(orgName)}, sent by ${escapeHtml(sentBy)}.</p><p>Email alerts are working. <a href="${escapeHtml(url)}">Alert settings</a></p>`,
  };
}

/* ------------------------------------------------------------------ sending */

export interface EmailRunSummary {
  emails: number;
  itemsSent: number;
  /** Sessions whose alerts wait for the 5-minute window. */
  deferred: number;
  failedItems: number;
  skippedItems: number;
}

async function markItems(db: DbOrTx, ids: string[], fields: Partial<typeof emailAlerts.$inferInsert>): Promise<void> {
  if (ids.length) await db.update(emailAlerts).set(fields).where(inArray(emailAlerts.id, ids));
}

/** One send run (the 'email-alerts' job; tests call it directly). */
export async function sendDueEmailAlerts(ctx: Ctx): Promise<EmailRunSummary> {
  const sum: EmailRunSummary = { emails: 0, itemsSent: 0, deferred: 0, failedItems: 0, skippedItems: 0 };
  const now = ctx.now();
  const due = await ctx.db
    .selectDistinct({ sessionId: emailAlerts.sessionId, orgId: emailAlerts.orgId })
    .from(emailAlerts)
    .where(and(eq(emailAlerts.status, 'pending'), lte(emailAlerts.nextAttemptAt, new Date(now))))
    .limit(SESSIONS_PER_RUN);

  for (const { sessionId, orgId } of due) {
    try {
      const pending = await ctx.db
        .select()
        .from(emailAlerts)
        .where(and(eq(emailAlerts.sessionId, sessionId), eq(emailAlerts.status, 'pending')))
        .orderBy(asc(emailAlerts.occurredAt), asc(emailAlerts.createdAt));
      if (pending.length === 0) continue;
      const ids = pending.map((p) => p.id);
      if (!ctx.mailer) {
        await markItems(ctx.db, ids, { status: 'skipped', lastError: 'Email (SMTP) is not configured on the server' });
        sum.skippedItems += ids.length;
        continue;
      }
      // Throttle: at most one email per session per EMAIL_THROTTLE_MS.
      const [{ lastSent }] = await ctx.db
        .select({ lastSent: max(emailAlerts.sentAt) })
        .from(emailAlerts)
        .where(and(eq(emailAlerts.sessionId, sessionId), eq(emailAlerts.status, 'sent')));
      if (lastSent && now - lastSent.getTime() < EMAIL_THROTTLE_MS) {
        await markItems(ctx.db, ids, { nextAttemptAt: new Date(lastSent.getTime() + EMAIL_THROTTLE_MS) });
        sum.deferred++;
        continue;
      }
      const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId));
      const settings = orgSettings(org);
      const enabled = pending.filter((p) => alertKindEnabled(settings, p.kind));
      const off = pending.filter((p) => !alertKindEnabled(settings, p.kind));
      if (off.length) {
        await markItems(
          ctx.db,
          off.map((p) => p.id),
          { status: 'skipped', lastError: 'This alert type was turned off' },
        );
        sum.skippedItems += off.length;
      }
      if (enabled.length === 0) continue;
      if (!org || settings.alertRecipients.length === 0) {
        await markItems(
          ctx.db,
          enabled.map((p) => p.id),
          { status: 'skipped', lastError: 'No alert recipients are configured' },
        );
        sum.skippedItems += enabled.length;
        continue;
      }
      const [info] = await ctx.db
        .select({ candidateName: candidates.name, externalId: candidates.externalId, examTitle: exams.title })
        .from(examSessions)
        .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
        .innerJoin(exams, eq(exams.id, examSessions.examId))
        .where(eq(examSessions.id, sessionId));
      if (!info) continue; // session deleted (rows cascade)
      const message = composeAlertEmail(
        {
          orgName: org.name,
          sessionId,
          candidate: { name: info.candidateName, externalId: info.externalId ?? null },
          exam: { title: info.examTitle },
          staffUrl: sessionStaffUrl(ctx.config.publicUrl, sessionId),
        },
        enabled,
        settings.alertRecipients,
      );
      const enabledIds = enabled.map((p) => p.id);
      try {
        await ctx.mailer.send(message);
        await markItems(ctx.db, enabledIds, { status: 'sent', sentAt: new Date(now), attempts: Math.max(...enabled.map((p) => p.attempts)) + 1, lastError: null });
        sum.emails++;
        sum.itemsSent += enabled.length;
      } catch (err) {
        const attempts = Math.max(...enabled.map((p) => p.attempts)) + 1;
        const final = attempts >= EMAIL_MAX_ATTEMPTS;
        const lastError = ((err as Error)?.message ?? String(err)).slice(0, 500);
        await markItems(ctx.db, enabledIds, final ? { status: 'failed', attempts, lastError } : { attempts, lastError, nextAttemptAt: new Date(now + EMAIL_RETRY_MS[attempts - 1]) });
        if (final) sum.failedItems += enabled.length;
        ctx.log.warn({ sessionId, attempts, err: lastError }, 'alert email could not be sent');
      }
    } catch (err) {
      ctx.log.error({ err, sessionId }, 'email alerts: session failed');
    }
  }
  return sum;
}

/** Delete alert rows (they contain candidate names) 30 days after creation. */
export async function emailAlertHousekeeping(ctx: Pick<Ctx, 'db' | 'now'>): Promise<number> {
  const rows = await ctx.db
    .delete(emailAlerts)
    .where(and(ne(emailAlerts.status, 'pending'), lt(emailAlerts.createdAt, new Date(ctx.now() - EMAIL_ALERT_RETENTION_MS))))
    .returning({ id: emailAlerts.id });
  return rows.length;
}

const kickState = new WeakMap<object, { timer: NodeJS.Timeout | null; lastHousekeeping: number }>();
function stateFor(ctx: Ctx) {
  let st = kickState.get(ctx);
  if (!st) kickState.set(ctx, (st = { timer: null, lastHousekeeping: 0 }));
  return st;
}

/** The job body: send, then (hourly) housekeeping. */
export async function runEmailAlertJob(ctx: Ctx): Promise<EmailRunSummary> {
  const sum = await sendDueEmailAlerts(ctx);
  const st = stateFor(ctx);
  if (Date.now() - st.lastHousekeeping > 3_600_000) {
    st.lastHousekeeping = Date.now();
    await emailAlertHousekeeping(ctx);
  }
  return sum;
}

/** Ask the email job to run soon (no-op when background jobs are not running). */
export function kickEmailAlerts(ctx: Ctx): void {
  if (!ctx.jobs?.isStarted || !ctx.jobs.list().includes(EMAIL_ALERT_JOB)) return;
  const st = stateFor(ctx);
  if (st.timer) return;
  st.timer = setTimeout(() => {
    st.timer = null;
    void ctx.jobs.runNow(EMAIL_ALERT_JOB).catch((err) => ctx.log.warn({ err }, 'email alert kick failed'));
  }, 50);
  st.timer.unref?.();
}
