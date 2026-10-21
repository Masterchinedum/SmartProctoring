import { CHECK_IN_LEAD_MS, windowPhase, type CandidateSessionState, type SessionWindow, type WindowPhase } from '@sp/shared';

/**
 * Scheduling windows in the candidate app (packages/shared/src/scheduling.ts). Times come from the server as instants
 * and are shown in the candidate's own time zone. Before the check-in may begin, and after the window closed, an exam
 * that has not started shows a "not open yet" / "closed" screen instead of the check-in; between the check-in time and
 * the opening the ready screen waits for the opening. An exam that started is never affected.
 */

/** The window phase that keeps this session from going further, or null. */
export function blockingPhase(state: Pick<CandidateSessionState, 'session'>, serverNow: number): Extract<WindowPhase, 'before_check_in' | 'closed'> | null {
  const { status, window } = state.session;
  if (status !== 'invited' && status !== 'ready') return null;
  const phase = windowPhase(window, serverNow);
  return phase === 'before_check_in' || phase === 'closed' ? phase : null;
}

/** On the ready screen: the opening time while the exam cannot be started yet (checked in early), else null. */
export function startOpensAt(state: Pick<CandidateSessionState, 'session'>, serverNow: number): number | null {
  const w = state.session.window;
  return state.session.status === 'ready' && windowPhase(w, serverNow) === 'check_in' ? (w?.startsAt ?? null) : null;
}

/** "Monday 2 November 2026 at 09:00" style, in the candidate's locale and time zone. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function candidateTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export interface WindowScreenText {
  heading: string;
  lead: string;
  lines: string[];
}

/** What the "not open yet" / "closed" screen says (`fmt` formats an instant; the screen passes formatWhen). */
export function windowScreenText(w: SessionWindow | null, phase: 'before_check_in' | 'closed', fmt: (ms: number) => string = formatWhen, timeZone = candidateTimeZone()): WindowScreenText {
  const zone = timeZone ? `Times are shown in your time zone (${timeZone}).` : 'Times are shown in your time zone.';
  if (phase === 'closed') {
    return {
      heading: 'This exam is closed',
      lead: w?.endsAt != null ? `The time for starting this exam ended on ${fmt(w.endsAt)}.` : 'The time for starting this exam has ended.',
      lines: ['If you still need to take the exam, contact your exam administrator: they can give you a new time.', zone],
    };
  }
  const lines: string[] = [];
  if (w?.startsAt != null) lines.push(`From ${fmt(w.startsAt - CHECK_IN_LEAD_MS)} you can do the camera and identity check, so you are ready on time.`);
  if (w?.endsAt != null) lines.push(`The exam must be started by ${fmt(w.endsAt)}.`);
  lines.push('Come back then using the same link. This page also updates by itself.', zone);
  return {
    heading: 'This exam is not open yet',
    lead: w?.startsAt != null ? `This exam opens on ${fmt(w.startsAt)}.` : 'This exam is not open yet.',
    lines,
  };
}
