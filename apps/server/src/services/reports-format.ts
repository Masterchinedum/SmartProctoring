/**
 * Text helpers for reports and review views: time-zone aware clock times, pluralisation, lists.
 * Server-generated sentences use these so wording stays consistent (and factual).
 */
import { formatDuration } from '@sp/shared';

export { formatDuration };

/** A valid IANA time zone, or 'UTC'. */
export function resolveTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export interface Clock {
  timeZone: string;
  /** "14:05 UTC" (with the date, "25 Sep 14:05 UTC", when it is not the reference day). */
  time(ms: number): string;
  /** "24 Sep 2026, 14:05 UTC" */
  dateTime(ms: number): string;
}

/** Clock-time formatter for a time zone; `refMs` is the session's first day (dates are shown for other days). */
export function makeClock(timeZone: string, refMs: number | null): Clock {
  const tz = resolveTimeZone(timeZone);
  const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz, timeZoneName: 'short' });
  const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: tz });
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz });
  const fullFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz, timeZoneName: 'short' });
  const refDay = refMs != null ? dayKeyFmt.format(refMs) : null;
  return {
    timeZone: tz,
    time(ms) {
      const t = timeFmt.format(ms);
      return refDay != null && dayKeyFmt.format(ms) !== refDay ? `${dayFmt.format(ms)} ${t}` : t;
    },
    dateTime(ms) {
      return fullFmt.format(ms);
    },
  };
}

/** "1 pause", "3 pauses", "1 time", ... */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** "a", "a and b", "a, b and c" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Confidence as a percentage, e.g. "87%". */
export function pct(v: number | null | undefined): string | null {
  return v == null || !Number.isFinite(v) ? null : `${Math.round(v * 100)}%`;
}

/** Lower-case the first letter of a sentence fragment (for embedding catalog titles in sentences). */
export function lcFirst(s: string): string {
  return s.length ? s[0].toLowerCase() + s.slice(1) : s;
}

export function capFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
