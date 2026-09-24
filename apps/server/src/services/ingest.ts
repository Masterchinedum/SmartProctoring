/**
 * Candidate-reported events (POST /api/candidate/events/batch) and screenshots (PUT /evidence/:id).
 *
 * Events are idempotent upserts keyed by the client episode id; a version is applied only if it is
 * newer than the stored one (out-of-order delivery from the offline outbox is safe). Category, severity
 * and title always come from EVENT_CATALOG. Events that start inside a paused/held period, before
 * check-in or after the end are rejected; an episode running into a pause is cut at the pause start.
 * Episodes of a replaced browser instance (delivered late by the new one) are cut at the reconnect gap.
 * Screenshots count against the per-session storage budget and link only to events of the same session.
 */
import { EVENT_CATALOG, isClientReportable, type EventBatchResponse, type EventType, type EventUpsert, type EvidenceUploadResponse, type ProctoringPolicy } from '@sp/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { events, evidence, sessionPeriods, type EventRow, type ExamSession, type SessionPeriod } from '../db/schema.js';
import { conflict } from '../lib/errors.js';
import { assertInControl } from './candidate-state.js';
import { storeEvidence } from './evidence.js';
import { EVENT_SCREENSHOT_SHARE, sessionHasEvidenceCapacity, storageLimitError } from './session-limits.js';
import { BLOCKING_PERIOD_KINDS, withSession } from './session-state.js';

export const LATE_DELIVERY_MS = 30_000;
export const MAX_EVENTS_PER_SESSION = 5000;
export const MAX_EVIDENCE_PER_SESSION = 3000;
const MAX_DETAILS_BYTES = 16 * 1024;
const CHECKIN_TOLERANCE_MS = 5_000;
const FUTURE_TOLERANCE_MS = 60_000;

/** Detector toggles in the policy that disable an event type (the server drops what the rules turned off). */
function disabledByPolicy(type: EventType, p: ProctoringPolicy): boolean {
  const en = p.detection.enabled;
  switch (type) {
    case 'tab_hidden':
      return !p.browser.flagTabHidden;
    case 'window_unfocused':
      return !p.browser.flagWindowBlur;
    case 'fullscreen_exited':
      return !p.browser.requireFullscreen;
    case 'candidate_absent':
      return !en.absence;
    case 'multiple_people':
      return !en.multiplePeople;
    case 'looking_away':
    case 'repeated_looking_away':
    case 'offscreen_attention_pattern':
      return !en.lookingAway;
    case 'unusual_movement':
      return !en.movement;
    case 'face_obstructed':
      return !en.obstruction;
    case 'phone_detected':
    case 'unauthorized_object':
      return !en.objects;
    default:
      return false;
  }
}

interface Timeline {
  periods: SessionPeriod[];
  firstStart: number | null;
  endedAt: number | null;
}

function blockingPeriodAt(t: Timeline, at: number): SessionPeriod | null {
  for (const p of t.periods) {
    if (!BLOCKING_PERIOD_KINDS.includes(p.kind)) continue;
    const s = p.startedAt.getTime();
    const e = p.endedAt?.getTime() ?? Infinity;
    if (at >= s && at < e) return p;
  }
  return null;
}

/** First blocking period that starts after `from` (an episode must end before it). */
function nextBlockStart(t: Timeline, from: number): number | null {
  let best: number | null = null;
  for (const p of t.periods) {
    if (!BLOCKING_PERIOD_KINDS.includes(p.kind)) continue;
    const s = p.startedAt.getTime();
    if (s > from && (best == null || s < best)) best = s;
  }
  return best;
}

/**
 * Episodes reported by a browser instance that is no longer in control (e.g. the previous page's outbox
 * flushed by the new one) end where that instance's observation ended: at the start of the 'disconnected'
 * period of the reconnect that replaced it (or, if the episode started inside that gap, at its end).
 */
function replacedInstanceBoundary(t: Timeline, from: number): number | null {
  let best: number | null = null;
  for (const p of t.periods) {
    if (p.kind !== 'disconnected') continue;
    const s = p.startedAt.getTime();
    const e = p.endedAt?.getTime() ?? null;
    const b = s > from ? s : e != null && from < e ? e : null;
    if (b != null && (best == null || b < best)) best = b;
  }
  return best;
}

function periodKindAt(t: Timeline, at: number): string | null {
  let kind: string | null = null;
  for (const p of t.periods) {
    const s = p.startedAt.getTime();
    const e = p.endedAt?.getTime() ?? Infinity;
    if (at >= s && at < e) kind = p.kind;
  }
  return kind;
}

export async function ingestEvents(ctx: Ctx, session: ExamSession, policy: ProctoringPolicy, instanceId: string, batch: EventUpsert[]): Promise<EventBatchResponse> {
  assertInControl(session, instanceId);
  const results: EventBatchResponse['results'] = [];
  if (batch.length === 0) return { results };

  await withSession(ctx, session.id, async (m) => {
    assertInControl(m.session, instanceId);
    const now = m.now;
    const periods = await m.tx.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, session.id)).orderBy(sessionPeriods.startedAt);
    const t: Timeline = { periods, firstStart: periods[0]?.startedAt.getTime() ?? null, endedAt: m.session.endedAt?.getTime() ?? null };
    const ids = [...new Set(batch.map((e) => e.id))];
    const existingRows = await m.tx.select().from(events).where(inArray(events.id, ids));
    const existing = new Map<string, EventRow>(existingRows.map((r) => [r.id, r]));
    const [{ n }] = await m.tx.select({ n: sql<number>`count(*)::int` }).from(events).where(eq(events.sessionId, session.id));
    let count = n;

    for (const e of batch) {
      const reject = (reason: string) => results.push({ id: e.id, result: 'rejected', reason });
      if (!isClientReportable(e.type)) {
        reject('not_client_reportable');
        continue;
      }
      if (disabledByPolicy(e.type, policy)) {
        reject('disabled_by_policy');
        continue;
      }
      const prev = existing.get(e.id);
      if (prev && prev.sessionId !== session.id) {
        reject('id_conflict');
        continue;
      }
      if (prev && prev.type !== e.type) {
        reject('type_mismatch');
        continue;
      }
      if (prev && e.version <= prev.version) {
        results.push({ id: e.id, result: 'stale' });
        continue;
      }
      if (!Number.isFinite(e.startedAt)) {
        reject('invalid_timestamp');
        continue;
      }
      if (t.firstStart == null || e.startedAt < t.firstStart - CHECKIN_TOLERANCE_MS) {
        reject('before_check_in');
        continue;
      }
      if (t.endedAt != null && e.startedAt > t.endedAt) {
        reject('after_end');
        continue;
      }
      if (e.startedAt > now + FUTURE_TOLERANCE_MS) {
        reject('in_future');
        continue;
      }
      if (blockingPeriodAt(t, e.startedAt)) {
        reject('during_unobserved_period');
        continue;
      }
      const detailsJson = JSON.stringify(e.details ?? {});
      if (detailsJson.length > MAX_DETAILS_BYTES) {
        reject('details_too_large');
        continue;
      }
      if (!prev && count >= MAX_EVENTS_PER_SESSION) {
        reject('event_limit');
        continue;
      }

      const cat = EVENT_CATALOG[e.type];
      // Normalise the end: markers are instantaneous; spans are cut at the next pause/hold and at the session end.
      let endedAt: number | null = cat.span ? (e.phase === 'close' ? (e.endedAt ?? now) : e.endedAt) : e.startedAt;
      let clamped: string | null = null;
      const block = nextBlockStart(t, e.startedAt);
      if (block != null && (endedAt == null || endedAt > block)) {
        endedAt = block;
        clamped = 'unobserved_period';
      }
      // Late updates from a browser instance that was replaced (not the one in control) never extend past
      // the reconnect gap, and never stay open: that instance can no longer close them.
      const reporter = prev?.clientInstanceId ?? e.clientInstanceId ?? instanceId;
      if (reporter !== instanceId && cat.span) {
        const b = replacedInstanceBoundary(t, e.startedAt);
        if (b != null && (endedAt == null || endedAt > b)) {
          endedAt = b;
          clamped = 'instance_replaced';
        } else if (endedAt == null) {
          endedAt = Math.max(e.startedAt, prev?.endedAt?.getTime() ?? e.startedAt);
          clamped = 'instance_replaced';
        }
      }
      if (t.endedAt != null && (endedAt == null || endedAt > t.endedAt)) {
        endedAt = t.endedAt;
        clamped = clamped ?? 'session_end';
      }
      if (endedAt != null && endedAt < e.startedAt) endedAt = e.startedAt;
      const status = endedAt != null ? 'closed' : 'open';
      const observation = e.observation?.trim().slice(0, 500) || cat.observation;
      const details = clamped ? { ...(e.details ?? {}), endClampedBy: clamped } : (e.details ?? {});
      const lastChange = endedAt ?? e.startedAt;

      if (!prev) {
        const late = now - lastChange > LATE_DELIVERY_MS;
        await m.tx.insert(events).values({
          id: e.id,
          orgId: session.orgId,
          sessionId: session.id,
          type: e.type,
          category: cat.category,
          severity: cat.severity,
          source: cat.sources.includes('client_browser') ? 'client_browser' : 'client_vision',
          status,
          title: cat.title,
          observation,
          startedAt: new Date(e.startedAt),
          endedAt: endedAt != null ? new Date(endedAt) : null,
          confidence: e.confidence,
          details,
          context: { periodKind: periodKindAt(t, e.startedAt) },
          version: e.version,
          clientInstanceId: e.clientInstanceId ?? instanceId,
          firstReceivedAt: new Date(now),
          receivedAt: new Date(now),
          deliveredLate: late,
        });
        count++;
        existing.set(e.id, { id: e.id, sessionId: session.id, type: e.type, version: e.version } as EventRow);
        m.touchEvent(e.id);
        results.push({ id: e.id, result: 'created' });
      } else {
        const late = prev.deliveredLate || (endedAt != null && prev.status === 'open' && now - endedAt > LATE_DELIVERY_MS);
        const updated = await m.tx
          .update(events)
          .set({
            status,
            observation,
            startedAt: new Date(e.startedAt),
            endedAt: endedAt != null ? new Date(endedAt) : null,
            confidence: e.confidence,
            details,
            version: e.version,
            receivedAt: new Date(now),
            deliveredLate: late,
          })
          .where(and(eq(events.id, e.id), sql`${events.version} < ${e.version}`))
          .returning({ id: events.id });
        if (updated.length) {
          existing.set(e.id, { ...prev, version: e.version });
          m.touchEvent(e.id);
          results.push({ id: e.id, result: 'updated' });
        } else results.push({ id: e.id, result: 'stale' });
      }
    }
  });
  return { results };
}

export interface EvidenceQuery {
  eventId?: string | null;
  capturedAt?: number | null;
  reason?: string | null;
}

export async function uploadEventEvidence(ctx: Ctx, session: ExamSession, policy: ProctoringPolicy, instanceId: string, evidenceId: string, q: EvidenceQuery, jpeg: Buffer): Promise<EvidenceUploadResponse> {
  const [prev] = await ctx.db.select({ id: evidence.id, sessionId: evidence.sessionId }).from(evidence).where(eq(evidence.id, evidenceId));
  if (prev) {
    if (prev.sessionId !== session.id) throw conflict('id_conflict', 'Evidence id already used');
    return { stored: true, duplicate: true };
  }
  assertInControl(session, instanceId);
  if (!policy.evidence.screenshots) return { stored: false, duplicate: false };
  const now = ctx.now();
  const capturedAt = q.capturedAt != null && Number.isFinite(q.capturedAt) ? Math.min(q.capturedAt, now + FUTURE_TOLERANCE_MS) : now;
  const periods = await ctx.db.select().from(sessionPeriods).where(eq(sessionPeriods.sessionId, session.id));
  const t: Timeline = { periods, firstStart: periods.length ? Math.min(...periods.map((p) => p.startedAt.getTime())) : null, endedAt: session.endedAt?.getTime() ?? null };
  // No observations are kept for unobserved (paused / held) time, before check-in or after the end.
  if (blockingPeriodAt(t, capturedAt) || t.firstStart == null || capturedAt < t.firstStart - CHECKIN_TOLERANCE_MS || (t.endedAt != null && capturedAt > t.endedAt + 5_000)) {
    return { stored: false, duplicate: false };
  }
  const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(evidence).where(and(eq(evidence.sessionId, session.id), eq(evidence.kind, 'event_screenshot')));
  if (total >= MAX_EVIDENCE_PER_SESSION) return { stored: false, duplicate: false };
  // Per-session storage budget (config.sessionLimits); screenshots may use only part of it (session-limits.ts).
  if (!(await sessionHasEvidenceCapacity(ctx, ctx.db, session.id, { items: 1, bytes: jpeg.length }, EVENT_SCREENSHOT_SHARE))) throw storageLimitError();
  // The event link and its per-event quota are scoped to THIS session: an event id of another session is
  // never linked (the screenshot is kept unlinked) and cannot consume that event's quota.
  let eventId: string | null = q.eventId ?? null;
  if (eventId) {
    const [ev] = await ctx.db.select({ sessionId: events.sessionId }).from(events).where(eq(events.id, eventId));
    if (ev && ev.sessionId !== session.id) eventId = null;
  }
  if (eventId) {
    const [{ perEvent }] = await ctx.db
      .select({ perEvent: sql<number>`count(*)::int` })
      .from(evidence)
      .where(and(eq(evidence.eventId, eventId), eq(evidence.sessionId, session.id)));
    if (perEvent >= policy.evidence.maxScreenshotsPerEvent + 2) return { stored: false, duplicate: false };
  }
  const { duplicate } = await storeEvidence(ctx, ctx.db, {
    id: evidenceId,
    orgId: session.orgId,
    sessionId: session.id,
    candidateId: session.candidateId,
    eventId,
    kind: 'event_screenshot',
    reason: q.reason ?? null,
    capturedAt,
    data: jpeg,
    clientInstanceId: instanceId,
  });
  if (eventId) {
    const [ev] = await ctx.db.select({ id: events.id, sessionId: events.sessionId }).from(events).where(eq(events.id, eventId));
    if (ev && ev.sessionId === session.id) ctx.live.eventChanged(ev.id, session.id);
  }
  return { stored: true, duplicate };
}
