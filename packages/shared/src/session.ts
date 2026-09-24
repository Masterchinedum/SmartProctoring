/**
 * Exam session lifecycle, periods, and the exam-clock arithmetic shared by server and client.
 */

export const SESSION_STATUSES = [
  'invited', // assigned; candidate has not completed the readiness check
  'ready', // readiness + liveness passed, identity reference established; exam not yet started
  'active', // exam in progress (clock running)
  'paused', // formally paused; monitoring stopped; resume requires readiness + identity check
  'on_hold', // held for verification / administrator review; candidate cannot continue
  'submitted', // finished (by candidate, time expiry, or administrator)
  'terminated', // ended by an administrator
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const TERMINAL_STATUSES: SessionStatus[] = ['submitted', 'terminated'];

export type ConnectionStatus = 'online' | 'offline' | 'never_connected';

export const HOLD_REASONS = [
  'identity_mismatch', // strong evidence of a different person
  'identity_unverifiable', // could not verify after max attempts
  'id_photo_mismatch', // live candidate did not match approved ID photo (policy: required)
  'pause_limit', // pause exceeded configured maximum duration
  'staff', // held manually by staff
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const END_REASONS = ['candidate_submitted', 'time_expired', 'staff_submitted', 'staff_terminated'] as const;
export type EndReason = (typeof END_REASONS)[number];

/**
 * End reasons set by server housekeeping rather than by a person or the exam clock (additive to END_REASONS):
 *  - 'abandoned': an invited / ready / paused session with no activity for the organisation's `abandonAfterDays`
 *    was closed automatically (status 'terminated', no score implied). Answers are kept; retention then applies.
 * Staff-facing DTOs use SessionEndReason; the candidate contract (CandidateSessionState) keeps EndReason.
 */
export const SYSTEM_END_REASONS = ['abandoned'] as const;
export const SESSION_END_REASONS = [...END_REASONS, ...SYSTEM_END_REASONS] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * Periods partition the session timeline. Observed periods had monitoring running; unobserved periods
 * (pauses, disconnections, holds) carry no behavioural observations by design.
 */
export const PERIOD_KINDS = ['check_in', 'active', 'paused', 'disconnected', 'on_hold', 'resume_check'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const OBSERVED_PERIOD_KINDS: PeriodKind[] = ['check_in', 'active', 'resume_check'];

export const CHECK_PURPOSES = [
  'initial', // first readiness check: establishes the protected reference
  'resume', // after a formal pause
  'reconnect', // browser closed/reloaded or camera re-acquired during an active exam
  'reverify', // re-verification requested after an identity concern (hold with self-reverify)
] as const;
export type CheckPurpose = (typeof CHECK_PURPOSES)[number];

/** Exam clock. Server-authoritative; clients mirror it for display. */
export interface ExamClock {
  durationMs: number;
  /** Time consumed in completed running segments. */
  usedMs: number;
  /** Epoch ms when the current running segment started, or null if the clock is stopped. */
  runningSince: number | null;
}

export function clockRemainingMs(clock: ExamClock, now: number): number {
  const running = clock.runningSince != null ? Math.max(0, now - clock.runningSince) : 0;
  return Math.max(0, clock.durationMs - clock.usedMs - running);
}

export function clockUsedMs(clock: ExamClock, now: number): number {
  const running = clock.runningSince != null ? Math.max(0, now - clock.runningSince) : 0;
  return Math.min(clock.durationMs, clock.usedMs + running);
}

export function clockStart(clock: ExamClock, now: number): ExamClock {
  if (clock.runningSince != null) return clock;
  return { ...clock, runningSince: now };
}

export function clockStop(clock: ExamClock, now: number): ExamClock {
  if (clock.runningSince == null) return clock;
  return { ...clock, usedMs: clockUsedMs(clock, now), runningSince: null };
}

export function clockExpired(clock: ExamClock, now: number): boolean {
  return clockRemainingMs(clock, now) <= 0;
}

/** Human-friendly duration, e.g. "1h 04m", "3m 12s", "8s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** Countdown format, e.g. "1:04:09" or "04:09". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
