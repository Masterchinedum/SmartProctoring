/**
 * Abandoned-session hygiene (job 'abandoned-sessions', hourly).
 *
 * Retention only starts when a session ends, so a session that never ends would keep its check-in evidence,
 * identity reference and access link forever. Sessions of an organisation with no activity for
 * `abandonAfterDays` (org setting, default 30) are therefore closed automatically:
 *
 *   status invited | ready | paused | on_hold, or active with the exam clock stopped (e.g. stopped by a
 *   disconnect under disconnectTimerBehavior 'stop', so it can never run out)
 *   AND last activity < now - abandonAfterDays, where last activity = the latest of the session's last change
 *   (any candidate, staff or system action), its last heartbeat and — for holds — the start of the hold.
 *
 * Closing = finalizeSession(m, 'abandoned'): status 'terminated', endReason 'abandoned', no score (answers are
 * kept), open periods/events closed, a neutral `session_terminated` event with
 * details.reason 'abandoned_after_inactivity', a 'terminated' command for the candidate's browser, and a
 * `session.abandoned` audit entry (actor system). The normal retention schedule then applies from the end time.
 * Active sessions with a running clock are never touched (the sweeper submits them when time runs out).
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { examSessions, organizations, type ExamSession } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { orgSettings } from './org.js';
import { finalizeSession, withSession } from './session-state.js';

export const ABANDON_JOB = 'abandoned-sessions';
export const ABANDON_JOB_INTERVAL_MS = 3_600_000;
const DAY_MS = 24 * 3600_000;
const BATCH = 200;

const ELIGIBLE: ExamSession['status'][] = ['invited', 'ready', 'paused', 'on_hold'];

const STATUS_TEXT_FOR_ABANDON: Partial<Record<ExamSession['status'], string>> = {
  invited: 'invited but the readiness check was never completed',
  ready: 'ready but the exam was never started',
  paused: 'paused and never resumed',
  on_hold: 'on hold and the hold was never resolved',
  active: 'in progress with the exam clock stopped and no connection from the candidate',
};

/** Latest sign of life (epoch ms). */
export function lastActivityAt(s: Pick<ExamSession, 'updatedAt' | 'lastHeartbeatAt' | 'holdSince' | 'createdAt'>): number {
  return Math.max(s.createdAt.getTime(), s.updatedAt.getTime(), s.lastHeartbeatAt?.getTime() ?? 0, s.holdSince?.getTime() ?? 0);
}

export function isAbandonable(s: Pick<ExamSession, 'status' | 'runningSince'>): boolean {
  return ELIGIBLE.includes(s.status) || (s.status === 'active' && s.runningSince == null);
}

export interface AbandonSummary {
  closed: number;
  sessionIds: string[];
}

/** Close every abandoned session (all organisations). Tests call this directly. */
export async function closeAbandonedSessions(ctx: Ctx, opts: { maxSessions?: number } = {}): Promise<AbandonSummary> {
  const out: AbandonSummary = { closed: 0, sessionIds: [] };
  const max = opts.maxSessions ?? 5000;
  const orgs = await ctx.db.select({ id: organizations.id, settings: organizations.settings }).from(organizations);
  const lastActivity = sql`greatest(${examSessions.createdAt}, ${examSessions.updatedAt}, coalesce(${examSessions.lastHeartbeatAt}, ${examSessions.updatedAt}), coalesce(${examSessions.holdSince}, ${examSessions.updatedAt}))`;
  for (const org of orgs) {
    const days = orgSettings(org).abandonAfterDays;
    const cutoff = ctx.now() - days * DAY_MS;
    const seen = new Set<string>();
    while (out.closed < max) {
      const rows = await ctx.db
        .select({ id: examSessions.id })
        .from(examSessions)
        .where(
          and(
            eq(examSessions.orgId, org.id),
            or(inArray(examSessions.status, ELIGIBLE), and(eq(examSessions.status, 'active'), isNull(examSessions.runningSince))),
            lt(lastActivity, new Date(cutoff)),
          ),
        )
        .orderBy(examSessions.updatedAt)
        .limit(BATCH);
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) break;
      for (const { id } of fresh) {
        seen.add(id);
        try {
          const closed = await withSession(ctx, id, async (m) => {
            const s = m.session;
            if (!isAbandonable(s)) return false;
            const last = lastActivityAt(s);
            if (last >= m.now - days * DAY_MS) return false;
            const previousStatus = s.status;
            await finalizeSession(m, 'abandoned', {
              observation: `The session was closed automatically after ${days} days without activity (it was ${STATUS_TEXT_FOR_ABANDON[previousStatus] ?? previousStatus}). No score is recorded; any answers are kept.`,
              details: { inactiveDays: days, previousStatus, lastActivityAt: last, holdReason: s.holdReason ?? null },
              candidateMessage: 'This exam session was closed because it was not used for a long time. Contact your exam administrator if you still need to take the exam.',
            });
            await audit(m.tx, {
              orgId: s.orgId,
              actorType: 'system',
              action: 'session.abandoned',
              targetType: 'session',
              targetId: s.id,
              meta: { previousStatus, inactiveDays: days, lastActivityAt: last, holdReason: s.holdReason ?? null },
              at: m.now,
            });
            return true;
          });
          if (closed) {
            out.closed++;
            out.sessionIds.push(id);
          }
        } catch (err) {
          ctx.log.error({ err, sessionId: id }, 'abandoned-session sweep: could not close session');
        }
        if (out.closed >= max) break;
      }
      if (rows.length < BATCH) break;
    }
  }
  return out;
}
