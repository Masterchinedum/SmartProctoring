/**
 * Scheduling windows and candidate recovery (roadmap #13).
 *
 *  - A session may carry a scheduling window (`exam_sessions.window_starts_at` / `window_ends_at`, either bound open).
 *    The exam can be STARTED only inside it. The check-in (privacy notice, camera and identity check) may begin
 *    CHECK_IN_LEAD_MS before the window opens, so a candidate can be ready at the opening time. An exam that started
 *    inside its window is never cut off when the window closes: pauses, reconnections and the rest of the exam clock
 *    run as usual.
 *  - Staff reschedule a session that has not started (POST /api/admin/sessions/:id/reschedule; integrations
 *    PUT /api/v1/sessions/:id/window), and set a window on assignment.
 *  - Staff reopen an ended exam for recovery (POST /api/admin/sessions/:id/reopen): `reopenEligibility` holds the
 *    rules the server enforces and the staff app explains.
 *
 * Times are epoch milliseconds; the candidate and staff apps show them in the viewer's own time zone.
 */
import { z } from 'zod';
import type { SessionEndReason, SessionStatus } from './session';

/** A session's scheduling window. Either bound may be open (null). */
export interface SessionWindow {
  startsAt: number | null;
  endsAt: number | null;
}

/** The check-in may begin this long before the window opens (so the candidate can start right at the opening time). */
export const CHECK_IN_LEAD_MS = 30 * 60_000;
/** A window must be at least this long. */
export const MIN_WINDOW_MS = 5 * 60_000;
/** Windows can be scheduled at most this far ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 2 * 366 * 24 * 3600_000;

/**
 * Where `now` falls relative to a window:
 *  - before_check_in: too early even for the check-in (more than CHECK_IN_LEAD_MS before the opening);
 *  - check_in: the check-in may be done, the exam cannot start yet;
 *  - open: the exam can be started (also: no window, or no opening time);
 *  - closed: the window has closed — an exam that has not started can no longer start (one in progress continues).
 */
export type WindowPhase = 'before_check_in' | 'check_in' | 'open' | 'closed';

export function windowPhase(w: SessionWindow | null | undefined, now: number): WindowPhase {
  if (!w) return 'open';
  if (w.endsAt != null && now >= w.endsAt) return 'closed';
  if (w.startsAt != null && now < w.startsAt - CHECK_IN_LEAD_MS) return 'before_check_in';
  if (w.startsAt != null && now < w.startsAt) return 'check_in';
  return 'open';
}

/** The next instant (after `now`) at which windowPhase changes, or null when it never changes again. */
export function nextWindowBoundary(w: SessionWindow | null | undefined, now: number): number | null {
  if (!w) return null;
  const points = [w.startsAt != null ? w.startsAt - CHECK_IN_LEAD_MS : null, w.startsAt, w.endsAt].filter((t): t is number => t != null && t > now);
  return points.length ? Math.min(...points) : null;
}

/** True when a session row has a window (either bound set). */
export function hasWindow(w: SessionWindow | null | undefined): w is SessionWindow {
  return !!w && (w.startsAt != null || w.endsAt != null);
}

/**
 * A window staff or an integration want to set, as of `now`: null when acceptable, else a plain-language reason.
 * (Clearing it — both bounds null — is always acceptable.)
 */
export function windowProblem(w: SessionWindow, now: number): string | null {
  const { startsAt, endsAt } = w;
  for (const t of [startsAt, endsAt]) {
    if (t != null && (!Number.isFinite(t) || t < 0)) return 'Enter a valid date and time.';
    if (t != null && t > now + MAX_SCHEDULE_AHEAD_MS) return 'Windows can be scheduled at most two years ahead.';
  }
  if (startsAt != null && endsAt != null && endsAt <= startsAt) return 'The window must close after it opens.';
  if (startsAt != null && endsAt != null && endsAt - startsAt < MIN_WINDOW_MS) return 'The window must be at least 5 minutes long.';
  if (endsAt != null && endsAt <= now) return 'The closing time has already passed.';
  return null;
}

/** An instant in requests: epoch milliseconds, or an ISO 8601 date-time with a time zone (e.g. 2026-11-02T09:00:00Z). */
export const timestampInputSchema = z
  .union([z.number().int().min(0).max(8.64e15), z.string().datetime({ offset: true })])
  .transform((v) => (typeof v === 'number' ? v : Date.parse(v)))
  .describe('Epoch milliseconds, or an ISO 8601 date-time with a time zone (e.g. 2026-11-02T09:00:00Z).');

/** Descriptions are published in the integration API's OpenAPI document (./openapi.ts). */
export const sessionWindowInputSchema = z
  .object({
    startsAt: timestampInputSchema.nullable().default(null).describe('From when the candidate can start (null or omitted: open). The check-in may begin 30 minutes earlier.'),
    endsAt: timestampInputSchema.nullable().default(null).describe('Until when the candidate can start (null or omitted: open). An exam that started in time is never cut off.'),
  })
  .describe('A scheduling window: the candidate can start the exam only inside it. At least 5 minutes long, closing in the future, at most two years ahead.');
export type SessionWindowInput = z.input<typeof sessionWindowInputSchema>;

/** POST /api/admin/sessions/:id/reschedule and PUT /api/v1/sessions/:id/window. Both bounds null clears the window. */
export const rescheduleRequestSchema = z
  .object({
    window: sessionWindowInputSchema,
    note: z.string().trim().max(1000).optional().describe('Why (recorded on the timeline and in the audit log; never sent in webhooks).'),
  })
  .describe('The new window; both bounds null clears it.');
export type RescheduleRequest = z.infer<typeof rescheduleRequestSchema>;

/* =================================================================== reopen for recovery */

/**
 * End reasons after which staff may reopen an exam for recovery. Never 'candidate_submitted' (the candidate chose to
 * finish: reopening would let them change a submitted attempt) nor 'candidate_withdrew' (consent withdrawn: the face
 * images were deleted and the candidate asked to stop).
 */
export const REOPENABLE_END_REASONS: readonly SessionEndReason[] = ['time_expired', 'staff_submitted', 'staff_terminated', 'abandoned', 'resume_limit'];

/** Minutes staff may add when reopening (the same bound as a time extension). */
export const REOPEN_MAX_ADD_MINUTES = 24 * 60;
/** A reopened exam that has started must have at least this much time left (add minutes otherwise). */
export const REOPEN_MIN_REMAINING_MS = 60_000;

export const reopenRequestSchema = z.object({
  /** Why the exam is reopened (recorded in the timeline and the audit log; never sent to integrations). */
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters').max(1000),
  /** Minutes added to the exam time (0–1440). Required when no exam time is left (e.g. after the time ran out). */
  addMinutes: z.number().int().min(0).max(REOPEN_MAX_ADD_MINUTES).default(0),
});
export type ReopenRequest = z.infer<typeof reopenRequestSchema>;

export type ReopenRefusal = 'not_ended' | 'candidate_submitted' | 'consent_withdrawn' | 'end_reason' | 'evidence_purged' | 'reference_missing' | 'review_resolved';

export interface ReopenEligibilityDTO {
  allowed: boolean;
  /** Error code the server answers with when refused (409). */
  code: ReopenRefusal | null;
  /** Plain-language reason (refused), or what reopening will do (allowed). */
  message: string;
  /** Whether the exam had started (a started exam continues after an identity check; one that never started returns to the check-in). */
  started: boolean;
  /** Exam time left now (before any minutes are added). */
  remainingMs: number;
}

export interface ReopenFacts {
  status: SessionStatus;
  endReason: SessionEndReason | null;
  startedAt: number | null;
  /** Evidence (identity reference, images) deleted under the retention policy. */
  evidencePurgedAt: number | null;
  /** A usable identity reference exists (not needed when identity is verified by staff, or when the exam never started). */
  hasReference: boolean;
  staffVerified: boolean;
  reviewResolved: boolean;
  remainingMs: number;
}

/** Whether an ended exam may be reopened for recovery, and why (not). The server enforces exactly these rules. */
export function reopenEligibility(f: ReopenFacts): ReopenEligibilityDTO {
  const started = f.startedAt != null;
  const base = { started, remainingMs: Math.max(0, f.remainingMs) };
  const refuse = (code: ReopenRefusal, message: string): ReopenEligibilityDTO => ({ ...base, allowed: false, code, message });
  if (f.status !== 'submitted' && f.status !== 'terminated') return refuse('not_ended', 'Only an exam that has ended can be reopened.');
  if (f.endReason === 'candidate_submitted') return refuse('candidate_submitted', 'The candidate submitted this exam themselves, so it cannot be reopened.');
  if (f.endReason === 'candidate_withdrew') {
    return refuse('consent_withdrawn', 'The candidate withdrew their consent and the face images of this exam were deleted, so it cannot be reopened. Arrange an alternative assessment instead.');
  }
  if (!f.endReason || !REOPENABLE_END_REASONS.includes(f.endReason)) return refuse('end_reason', 'Exams that ended this way cannot be reopened.');
  if (f.evidencePurgedAt != null) {
    return refuse('evidence_purged', 'The identity reference and images of this exam were deleted under the retention policy, so the candidate cannot be verified again. It cannot be reopened.');
  }
  if (f.reviewResolved) return refuse('review_resolved', 'The review of this exam is complete. Reopen the review first (Review tab) if the exam should continue.');
  if (started && !f.staffVerified && !f.hasReference) {
    return refuse('reference_missing', 'This exam has no usable identity reference to verify the candidate against, so it cannot be reopened.');
  }
  return {
    ...base,
    allowed: true,
    code: null,
    message: started
      ? 'The candidate continues where they stopped, after a fresh camera and identity check. Their answers are kept, and the exam clock stays stopped until the check is passed.'
      : 'The exam never started: the session returns to the check-in, and the candidate can start with the same link.',
  };
}
