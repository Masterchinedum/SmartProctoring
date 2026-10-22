/**
 * Scheduling windows (packages/shared/src/scheduling.ts), server side.
 *
 *  - A session's window is `exam_sessions.window_starts_at` / `window_ends_at` (either may be null = open).
 *  - Starting the exam (candidate-actions.ts startSession) is refused outside it: 409 `exam_window_not_open` /
 *    `exam_window_closed` with `details.window`, which the candidate app turns into an "opens on … / closed on …" screen
 *    in the candidate's own time. The initial check (checks.ts startCheck) may begin CHECK_IN_LEAD_MS before the
 *    opening and is refused after the closing.
 *  - Only the START is bounded: an exam that started inside its window continues until its clock runs out, through
 *    pauses and reconnections, however late the window closes. Consent and reconnect checks before the start (a page
 *    reload on the ready screen) are not restricted either.
 *  - The window can be set when the session is created (assignment, staff or integration API) and changed by
 *    `rescheduleSession` until the exam starts: audited, with a neutral `session_rescheduled` timeline event
 *    (→ `session.rescheduled` webhook).
 *  - Abandoned-session housekeeping (abandonment.ts) counts inactivity from the end of the window at the earliest.
 */
import { CHECK_IN_LEAD_MS, hasWindow, windowPhase, windowProblem, type SessionSummaryDTO, type SessionWindow } from '@sp/shared';
import type { Ctx } from '../context.js';
import type { ExamSession } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { conflict, invalidState, notFound, validationFailed } from '../lib/errors.js';
import { loadSessionSummary, sessionWindow } from './dto.js';
import { TERMINAL, withSession } from './session-state.js';

export { sessionWindow };

/** Column values for a window (null clears it). */
export function windowColumns(w: SessionWindow | null): Pick<ExamSession, 'windowStartsAt' | 'windowEndsAt'> {
  return { windowStartsAt: w?.startsAt != null ? new Date(w.startsAt) : null, windowEndsAt: w?.endsAt != null ? new Date(w.endsAt) : null };
}

/** A window from a request, validated as of `now` (400 validation_failed with a plain reason). Both bounds null => null. */
export function acceptWindow(input: SessionWindow | null | undefined, now: number): SessionWindow | null {
  if (!input || !hasWindow(input)) return null;
  const problem = windowProblem(input, now);
  if (problem) throw validationFailed(problem, [{ path: 'window', message: problem }]);
  return { startsAt: input.startsAt, endsAt: input.endsAt };
}

export const WINDOW_NOT_OPEN_MESSAGE = 'This exam is not open yet. Please come back at the time shown on this page, using the same link.';
export const WINDOW_CLOSED_MESSAGE = 'The time for starting this exam has passed. Contact your exam administrator if you still need to take it.';

/**
 * Throws 409 unless the window allows `action` now: 'check_in' from CHECK_IN_LEAD_MS before the opening until the
 * closing, 'start' from the opening until the closing. `requestedAt` (a start deferred by the busy-server admission)
 * is when the candidate first asked: a start the server itself held back is not refused because the window closed
 * meanwhile.
 */
export function assertWindowAllows(s: Pick<ExamSession, 'windowStartsAt' | 'windowEndsAt'>, action: 'check_in' | 'start', now: number, requestedAt: number = now): void {
  const w = sessionWindow(s);
  if (!w) return;
  const details = { window: w, checkInFrom: w.startsAt != null ? w.startsAt - CHECK_IN_LEAD_MS : null };
  if (windowPhase(w, Math.min(now, requestedAt)) === 'closed') throw conflict('exam_window_closed', WINDOW_CLOSED_MESSAGE, details);
  const phase = windowPhase(w, now);
  if (phase === 'before_check_in' || (action === 'start' && phase === 'check_in')) throw conflict('exam_window_not_open', WINDOW_NOT_OPEN_MESSAGE, details);
}

/** Who reschedules: a staff member (staff API) or an organisation API key (integration API). */
export interface ScheduleActor {
  type: 'staff' | 'api_key';
  id: string;
  orgId: string;
  ip?: string | null;
  /** API key name (audit meta). */
  name?: string;
}

const sameWindow = (a: SessionWindow | null, b: SessionWindow | null) => (a?.startsAt ?? null) === (b?.startsAt ?? null) && (a?.endsAt ?? null) === (b?.endsAt ?? null);

/**
 * Set, change or clear (both bounds null) the window of a session that has not started. Unchanged: nothing recorded.
 * 409 `already_started` once the exam started; 409 `invalid_state` once it ended.
 */
export async function rescheduleSession(ctx: Ctx, sessionId: string, actor: ScheduleActor, input: SessionWindow, note?: string | null): Promise<SessionSummaryDTO> {
  await withSession(ctx, sessionId, async (m) => {
    const s = m.session;
    if (s.orgId !== actor.orgId) throw notFound('Session not found', 'session_not_found');
    if (TERMINAL.includes(s.status)) throw invalidState('The exam has ended, so it cannot be rescheduled. Reopen it for recovery instead, if appropriate.', { status: s.status });
    if (s.startedAt) throw conflict('already_started', 'The exam has already started, so its window can no longer be changed. An exam in progress is never cut off by its window.', { status: s.status });
    const window = acceptWindow(input, m.now);
    const previousWindow = sessionWindow(s);
    if (sameWindow(window, previousWindow)) return;
    m.set(windowColumns(window));
    const text = note?.trim() || null;
    await m.addEvent({
      type: 'session_rescheduled',
      source: 'staff',
      details: { window, previousWindow, note: text, by: actor.id, via: actor.type === 'api_key' ? 'integration_api' : 'staff_app' },
    });
    await audit(m.tx, {
      orgId: s.orgId,
      actorType: actor.type,
      actorId: actor.id,
      action: actor.type === 'api_key' ? 'api.session.rescheduled' : 'session.rescheduled',
      targetType: 'session',
      targetId: s.id,
      meta: { window, previousWindow, note: text, status: s.status, ...(actor.name ? { apiKey: actor.name } : {}) },
      ip: actor.ip ?? null,
      at: m.now,
    });
  });
  const dto = await loadSessionSummary(ctx, ctx.db, sessionId);
  if (!dto) throw notFound('Session not found', 'session_not_found');
  return dto;
}
