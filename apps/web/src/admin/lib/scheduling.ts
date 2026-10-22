import { hasWindow, MAX_SCHEDULE_AHEAD_MS, REOPEN_MAX_ADD_MINUTES, REOPEN_MIN_REMAINING_MS, windowPhase, windowProblem, type SessionWindow } from '@sp/shared';
import { formatDate, formatDuration } from './format';

/**
 * Scheduling windows and recovery in the staff app (packages/shared/src/scheduling.ts): the window fields of the
 * assignment panel and the reschedule dialog (`<input type="datetime-local">`, the staff member's own time zone),
 * the window summary on the session page, and the reopen dialog's minutes.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Epoch ms -> the value of a datetime-local input in local time ("2026-11-02T09:00"); '' for none. */
export function toLocalInput(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) -> epoch ms; null when empty; NaN when it is not a date and time. */
export function fromLocalInput(text: string): number | null {
  const v = text.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s, 0);
  // Reject impossible dates (e.g. 31 February rolls over).
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return NaN;
  return date.getTime();
}

export interface WindowFormValues {
  opens: string;
  closes: string;
}

export type WindowFormResult = { ok: true; window: SessionWindow | null } | { ok: false; field: 'opens' | 'closes'; error: string };

/** Validate the two inputs as of `now` (the same rules as the server). Both empty = no window. */
export function parseWindowForm(v: WindowFormValues, now: number): WindowFormResult {
  const startsAt = fromLocalInput(v.opens);
  const endsAt = fromLocalInput(v.closes);
  if (startsAt != null && Number.isNaN(startsAt)) return { ok: false, field: 'opens', error: 'Enter a date and time.' };
  if (endsAt != null && Number.isNaN(endsAt)) return { ok: false, field: 'closes', error: 'Enter a date and time.' };
  const w = { startsAt, endsAt };
  if (!hasWindow(w)) return { ok: true, window: null };
  const problem = windowProblem(w, now);
  if (problem) {
    // Too far ahead: the field that is; every other rule is about the closing time.
    const field = problem.includes('two years') && startsAt != null && (endsAt == null || startsAt > now + MAX_SCHEDULE_AHEAD_MS) ? 'opens' : 'closes';
    return { ok: false, field, error: problem };
  }
  return { ok: true, window: w };
}

/** "2 Nov 2026, 09:00" (local time, minutes). */
export function formatWindowTime(ms: number): string {
  const d = new Date(ms);
  return `${formatDate(ms)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The viewer's time zone name (e.g. "Europe/London"), for labels. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  } catch {
    return 'local time';
  }
}

/** One line for the session page: when the exam can be started, and whether that is now. */
export function describeWindow(w: SessionWindow | null | undefined, now: number): string {
  if (!w || !hasWindow(w)) return 'Any time (no window)';
  const range =
    w.startsAt != null && w.endsAt != null
      ? `${formatWindowTime(w.startsAt)} – ${formatWindowTime(w.endsAt)}`
      : w.startsAt != null
        ? `From ${formatWindowTime(w.startsAt)}`
        : `Until ${formatWindowTime(w.endsAt!)}`;
  const phase = windowPhase(w, now);
  const state = phase === 'closed' ? 'closed' : phase === 'open' ? 'open now' : `opens in ${formatDuration(w.startsAt! - now)}`;
  return `${range} (${state})`;
}

/** Minutes typed into the reopen dialog: a whole number 0–1440, at least enough to leave a minute of exam time. */
export function parseReopenMinutes(text: string, remainingMs: number, started: boolean): { ok: true; minutes: number } | { ok: false; error: string } {
  const t = text.trim();
  const n = t === '' ? 0 : Number(t);
  if (!Number.isInteger(n) || n < 0 || n > REOPEN_MAX_ADD_MINUTES) return { ok: false, error: `Enter a whole number of minutes between 0 and ${REOPEN_MAX_ADD_MINUTES}.` };
  if (started && remainingMs + n * 60_000 < REOPEN_MIN_REMAINING_MS) return { ok: false, error: 'No exam time is left: add at least 1 minute so the candidate can continue.' };
  return { ok: true, minutes: n };
}
