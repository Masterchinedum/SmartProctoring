/**
 * Integration outbox hook. withSession() calls enqueueIntegrationNotifications(m) INSIDE the session
 * transaction, after the mutation's own writes. Every event change in the product goes through a
 * SessionMutation (server events via addEvent/updateEvent/closeEvent, client episodes via ingest + touchEvent,
 * sweeper timeouts/expiry, staff actions, abandonment), so this single hook sees every transition:
 *
 *   event row touched by the mutation            -> webhook notification / email alert
 *   ------------------------------------------------------------------------------------------------
 *   non-neutral event, first seen               -> event.created   (webhook minSeverity filter)
 *   non-neutral span event, closed               -> event.closed    (dedupe per end time)
 *   identity_mismatch, first seen                -> identity.mismatch
 *   session_held / hold_released, first seen     -> session.held / session.released
 *   pause_requested, first seen                  -> session.pause_requested
 *   session_submitted / session_terminated       -> session.submitted / session.terminated
 *   session_held | pause_requested | high-severity non-neutral event -> email alert (org toggles)
 *
 * The inserts run in a SAVEPOINT: if anything here fails, the integration rows are rolled back and logged, but
 * the proctoring change itself still commits (monitoring must never fail because of an integration).
 *
 * Outbound text (security review #10): client-authored free text never leaves through these trusted channels.
 * Events reported by the candidate's browser (sources client_browser / client_vision) are described with their
 * EVENT_CATALOG title/observation, never the client-supplied `observation`; other user-controlled text (the
 * candidate's pause reason) has links removed (lib/text-safety.ts). Event `details` are never forwarded.
 */
import { EVENT_CATALOG, type EventSource, type EventType, type HoldReason, type SessionStatus } from '@sp/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { events, webhooks, type EventRow } from '../db/schema.js';
import { stripUrls } from '../lib/text-safety.js';
import { enqueueEmailAlerts, HOLD_REASON_SENTENCES, isHighSeverityAlert, kickEmailAlerts, sessionStaffUrl, type EmailAlertInput } from './email-alerts.js';
import { orgSettings } from './org.js';
import type { SessionMutation } from './session-state.js';
import { enqueueWebhookNotifications, kickWebhookDelivery, type WebhookNotification } from './webhooks.js';

const SESSION_NOTIFICATIONS: Partial<Record<EventRow['type'], WebhookNotification['type']>> = {
  session_held: 'session.held',
  hold_released: 'session.released',
  pause_requested: 'session.pause_requested',
  session_submitted: 'session.submitted',
  session_terminated: 'session.terminated',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const CLIENT_SOURCES: readonly EventSource[] = ['client_browser', 'client_vision'];

/**
 * Title and observation of an event as they may appear in a webhook or an alert email: the catalog wording for
 * anything the candidate's browser reported (its free text is candidate-controlled), link-free server wording
 * otherwise.
 */
export function outboundEventText(ev: { type: EventType; source: EventSource; title: string; observation: string }): { title: string; observation: string } {
  const cat = EVENT_CATALOG[ev.type];
  if (cat && (CLIENT_SOURCES.includes(ev.source) || !ev.observation)) return { title: cat.title, observation: cat.observation };
  return { title: stripUrls(cat?.title ?? ev.title), observation: stripUrls(ev.observation) };
}

/** Candidate-written reason (pause request): kept for staff, without links. */
export function outboundReason(v: unknown, max = 300): string | null {
  const s = str(v);
  return s ? stripUrls(s.slice(0, max)) : null;
}

export async function enqueueIntegrationNotifications(m: SessionMutation): Promise<void> {
  const ids = m.touchedEventIds;
  if (ids.length === 0) return;
  const ctx = m.ctx;
  const orgId = m.session.orgId;
  try {
    const result = await m.tx.transaction(async (sp) => {
      const hooks = await sp
        .select({ id: webhooks.id, events: webhooks.events, minSeverity: webhooks.minSeverity })
        .from(webhooks)
        .where(and(eq(webhooks.orgId, orgId), eq(webhooks.active, true)));
      const settings = orgSettings(await m.org());
      const emailOn = !!ctx.mailer && settings.alertRecipients.length > 0 && (settings.emailAlerts.holds || settings.emailAlerts.pauseRequests || settings.emailAlerts.highSeverity);
      if (hooks.length === 0 && !emailOn) return { webhooks: 0, emails: 0 };

      const rows = await sp.select().from(events).where(and(inArray(events.id, ids), eq(events.sessionId, m.session.id)));
      if (rows.length === 0) return { webhooks: 0, emails: 0 };
      const [candidate, exam] = await Promise.all([m.candidate(), m.exam()]);
      const s = m.session;
      const staffUrl = sessionStaffUrl(ctx.config.publicUrl, s.id);
      const refs = {
        candidate: { id: candidate.id, name: candidate.name, externalId: candidate.externalId ?? null },
        exam: { id: exam.id, title: exam.title },
      };
      const notifications: WebhookNotification[] = [];
      const emails: EmailAlertInput[] = [];

      for (const ev of rows) {
        // Created by THIS mutation (both insert paths stamp firstReceivedAt with the mutation's clock).
        const created = ev.firstReceivedAt.getTime() === m.now;
        const startedAt = ev.startedAt.getTime();
        const endedAt = ev.endedAt?.getTime() ?? null;
        const text = outboundEventText(ev);
        const eventData = {
          id: ev.id,
          sessionId: s.id,
          type: ev.type,
          category: ev.category,
          severity: ev.severity,
          title: text.title,
          observation: text.observation,
          status: ev.status,
          startedAt,
          endedAt,
          durationMs: endedAt != null ? Math.max(0, endedAt - startedAt) : null,
          confidence: ev.confidence ?? null,
          deliveredLate: ev.deliveredLate,
          sessionStatus: s.status,
          ...refs,
          staffUrl: `${staffUrl}?event=${ev.id}`,
        };

        if (ev.category !== 'neutral') {
          if (created) notifications.push({ type: 'event.created', dedupeKey: `event.created:${ev.id}`, sessionId: s.id, data: eventData, severity: ev.severity });
          if (ev.status === 'closed' && EVENT_CATALOG[ev.type]?.span) {
            notifications.push({ type: 'event.closed', dedupeKey: `event.closed:${ev.id}:${endedAt ?? startedAt}`, sessionId: s.id, data: eventData, severity: ev.severity });
          }
          if (created && ev.type === 'identity_mismatch') notifications.push({ type: 'identity.mismatch', dedupeKey: `identity.mismatch:${ev.id}`, sessionId: s.id, data: eventData });
          if (created && emailOn && settings.emailAlerts.highSeverity && isHighSeverityAlert(ev.category, ev.severity)) {
            emails.push({ kind: 'high_severity', eventId: ev.id, sessionId: s.id, title: text.title, observation: text.observation, severity: ev.severity, occurredAt: startedAt });
          }
        }

        const sessionType = created ? SESSION_NOTIFICATIONS[ev.type] : undefined;
        if (sessionType) {
          const d = ev.details ?? {};
          const data: Record<string, unknown> = {
            sessionId: s.id,
            status: s.status as SessionStatus,
            endReason: s.endReason ?? null,
            at: startedAt,
            eventId: ev.id,
            reason: null,
            ...refs,
            staffUrl,
          };
          if (ev.type === 'session_held') data.reason = str(d.reason);
          if (ev.type === 'hold_released') {
            data.reason = str(d.reason);
            data.requireCheck = d.requireCheck !== false;
          }
          if (ev.type === 'pause_requested') data.pauseRequest = { id: str(d.requestId), reason: outboundReason(d.reason, 1000) };
          if (ev.type === 'session_submitted') data.score = s.score ? { points: s.score.points, maxPoints: s.score.maxPoints, autoGraded: s.score.autoGraded } : null;
          // Free-text staff notes are never forwarded; only the structured automatic reason.
          if (ev.type === 'session_terminated') data.reason = str(d.reason) === 'abandoned_after_inactivity' ? 'abandoned_after_inactivity' : null;
          notifications.push({ type: sessionType, dedupeKey: `${sessionType}:${ev.id}`, sessionId: s.id, data });
        }

        if (created && emailOn && ev.type === 'session_held' && settings.emailAlerts.holds) {
          const reason = str(ev.details?.reason) as HoldReason | null;
          const why = reason && HOLD_REASON_SENTENCES[reason] ? HOLD_REASON_SENTENCES[reason] : 'it needs administrator review';
          emails.push({ kind: 'hold', eventId: ev.id, sessionId: s.id, title: 'Exam on hold', observation: `The exam was put on hold because ${why}.`, severity: ev.severity, occurredAt: startedAt });
        }
        if (created && emailOn && ev.type === 'pause_requested' && settings.emailAlerts.pauseRequests) {
          const reason = outboundReason(ev.details?.reason);
          emails.push({
            kind: 'pause_request',
            eventId: ev.id,
            sessionId: s.id,
            title: 'Pause requested',
            observation: `The candidate requested a pause${reason ? ` (reason given: “${reason}”)` : ''}. It needs approval in the staff app; the candidate keeps working until then.`,
            severity: ev.severity,
            occurredAt: startedAt,
          });
        }
      }
      const w = hooks.length ? await enqueueWebhookNotifications(sp, orgId, notifications, m.now, hooks) : 0;
      const e = emailOn ? await enqueueEmailAlerts(sp, orgId, emails, m.now) : 0;
      return { webhooks: w, emails: e };
    });
    if (result.webhooks) m.onCommit(() => kickWebhookDelivery(ctx));
    if (result.emails) m.onCommit(() => kickEmailAlerts(ctx));
  } catch (err) {
    ctx.log.error({ err, sessionId: m.session.id }, 'integration outbox: could not enqueue notifications (the session change itself was kept)');
  }
}
