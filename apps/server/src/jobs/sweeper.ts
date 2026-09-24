/**
 * Background sweeper (every ~5 s):
 *  - heartbeat timeout  => connection offline; during an active exam a reporting_interrupted event
 *    (startedAt = last heartbeat) and, if policy.connection.disconnectTimerBehavior = 'stop', the clock stops
 *    at the last heartbeat;
 *  - clock expiry        => auto-submit (session_expired + session_submitted, endReason time_expired);
 *  - stale checks        => expired;
 *  - identity bursts whose remaining frames never arrived => decided on the frames received (identity-samples.ts).
 * Runs via JobRunner (one instance at a time, pg advisory lock); each session change runs under its row lock.
 */
import { clockExpired } from '@sp/shared';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import type { JobDefinition } from './runner.js';
import { checks, examSessions } from '../db/schema.js';
import { sessionClock } from '../services/dto.js';
import { decideStaleBurstsForAll } from '../services/identity-samples.js';
import { finalizeSession, withSession } from '../services/session-state.js';

const MIN_HEARTBEAT_TIMEOUT_MS = 10_000;
const BATCH = 200;

export async function sweepOnce(ctx: Ctx): Promise<{ timedOut: number; expired: number; checksExpired: number; burstsDecided: number }> {
  const now = ctx.now();
  let timedOut = 0;
  let expired = 0;

  // 1. Heartbeat timeouts (per-exam policy; the SQL pre-filter uses the minimum allowed timeout).
  const stale = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.connection, 'online'), lt(examSessions.lastHeartbeatAt, new Date(now - MIN_HEARTBEAT_TIMEOUT_MS)), inArray(examSessions.status, ['invited', 'ready', 'active', 'paused', 'on_hold'])))
    .limit(BATCH);
  for (const { id } of stale) {
    try {
      const changed = await withSession(ctx, id, async (m) => {
        const s = m.session;
        if (s.connection !== 'online' || !s.lastHeartbeatAt) return false;
        const policy = await m.policy();
        const last = s.lastHeartbeatAt.getTime();
        if (m.now - last <= policy.connection.heartbeatTimeoutSec * 1000) return false;
        m.set({ connection: 'offline' });
        if (s.status === 'active') {
          const ev = await m.addEvent({
            type: 'reporting_interrupted',
            open: true,
            startedAt: last,
            details: { lastHeartbeatAt: last, instanceId: s.lastHeartbeatInstanceId, timerBehavior: policy.connection.disconnectTimerBehavior },
          });
          m.set({ reportingEventId: ev.id, reportingInterruptedSince: new Date(Math.min(last, s.reportingInterruptedSince?.getTime() ?? Infinity)) });
          if (policy.connection.disconnectTimerBehavior === 'stop') m.clockStop(Math.max(last, s.runningSince?.getTime() ?? last));
        }
        return true;
      });
      if (changed) timedOut++;
    } catch (err) {
      ctx.log.error({ err, sessionId: id }, 'sweeper: heartbeat timeout failed');
    }
  }

  // 2. Clock expiry.
  const due = await ctx.db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(
      and(
        inArray(examSessions.status, ['active', 'paused']),
        isNotNull(examSessions.runningSince),
        sql`${examSessions.usedMs} + (extract(epoch from (${new Date(now)}::timestamptz - ${examSessions.runningSince})) * 1000) >= ${examSessions.durationMs}`,
      ),
    )
    .limit(BATCH);
  for (const { id } of due) {
    try {
      const done = await withSession(ctx, id, async (m) => {
        if (!['active', 'paused'].includes(m.session.status) || !clockExpired(sessionClock(m.session), m.now)) return false;
        await finalizeSession(m, 'time_expired');
        return true;
      });
      if (done) expired++;
    } catch (err) {
      ctx.log.error({ err, sessionId: id }, 'sweeper: expiry failed');
    }
  }

  // 3. Stale checks.
  const ex = await ctx.db
    .update(checks)
    .set({ status: 'expired', completedAt: new Date(now) })
    .where(and(eq(checks.status, 'open'), lt(checks.expiresAt, new Date(now - 10_000))))
    .returning({ id: checks.id });

  // 4. Identity bursts whose remaining frames never arrived are decided on the frames received.
  const burstsDecided = await decideStaleBurstsForAll(ctx);

  return { timedOut, expired, checksExpired: ex.length, burstsDecided };
}

/** The sweeper as a JobRunner job (registered by app.ts). */
export function sweeperJob(intervalMs: number): JobDefinition {
  return {
    name: 'sweeper',
    intervalMs,
    runAtStart: true,
    async run(ctx) {
      const r = await sweepOnce(ctx);
      if (r.timedOut || r.expired) ctx.log.info(r, 'sweeper');
    },
  };
}
