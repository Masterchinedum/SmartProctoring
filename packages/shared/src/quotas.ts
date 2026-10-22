/**
 * Organisation kinds and per-organisation quotas (roadmap #15).
 *
 * An organisation is a `production` tenant (the default; every organisation created before this feature) or a
 * `sandbox`: a trial / integration-testing tenant whose data is deleted automatically after `purgeAfterDays`
 * (default 14) and that is clearly marked as "not for real candidates" in the staff app, the candidate app, alert
 * emails and webhooks (`sandbox: true` in the envelope).
 *
 * Quotas are set by the server operator (`org:create` / `org:set`, docs/OPERATIONS.md), never by staff:
 *  - `exams`: exams that are not archived (drafts and published exams; archiving one frees a place);
 *  - `candidates`: candidate records;
 *  - `sessionsPerMonth`: exam sessions created (assignments, staff app and integration API) in the current calendar
 *    month **in UTC**; the count starts again at 00:00 UTC on the first day of the next month. Sessions deleted later
 *    (a candidate erased, the sandbox clean-up) still count for the month they were created in.
 * `null` = no limit. Production organisations have no limits unless the operator sets some; a sandbox gets
 * SANDBOX_DEFAULT_QUOTAS. A refused creation answers 409 `quota_exceeded` with QuotaExceededDetails.
 */

export const ORG_KINDS = ['production', 'sandbox'] as const;
export type OrgKind = (typeof ORG_KINDS)[number];

export const QUOTA_KINDS = ['exams', 'candidates', 'sessionsPerMonth'] as const;
export type QuotaKind = (typeof QUOTA_KINDS)[number];

/** A limit per quota; null = unlimited. */
export type OrgQuotas = Record<QuotaKind, number | null>;

export const PRODUCTION_DEFAULT_QUOTAS: Readonly<OrgQuotas> = { exams: null, candidates: null, sessionsPerMonth: null };
/** Modest limits for a sandbox (trial / integration testing) unless the operator sets others. */
export const SANDBOX_DEFAULT_QUOTAS: Readonly<OrgQuotas> = { exams: 5, candidates: 50, sessionsPerMonth: 100 };
/** A sandbox's data is deleted this many days after it was last used, unless the operator sets another period. */
export const DEFAULT_SANDBOX_PURGE_DAYS = 14;
export const MAX_SANDBOX_PURGE_DAYS = 365;
/** Usage at or above this share of a limit is shown as a warning. */
export const QUOTA_WARNING_RATIO = 0.8;
/** Largest limit an operator can set (larger = use "unlimited"). */
export const MAX_QUOTA = 10_000_000;

export const QUOTA_LABELS: Record<QuotaKind, string> = {
  exams: 'Exams (drafts and published)',
  candidates: 'Candidates',
  sessionsPerMonth: 'Exam sessions created this month',
};

export type QuotaLevel = 'ok' | 'warning' | 'reached';

/** `reached` at or over the limit, `warning` from QUOTA_WARNING_RATIO of it, `ok` otherwise (and always without a limit). */
export function quotaLevel(used: number, limit: number | null): QuotaLevel {
  if (limit == null) return 'ok';
  if (used >= limit) return 'reached';
  return used >= limit * QUOTA_WARNING_RATIO ? 'warning' : 'ok';
}

/** The calendar month (UTC) containing `now`: `month` as YYYY-MM, its start and when the count starts again. */
export function quotaMonth(now: number): { month: string; startsAt: number; resetsAt: number } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { month: `${y}-${String(m + 1).padStart(2, '0')}`, startsAt: Date.UTC(y, m, 1), resetsAt: Date.UTC(y, m + 1, 1) };
}

export interface QuotaUsageDTO {
  quota: QuotaKind;
  /** null = no limit. */
  limit: number | null;
  used: number;
  level: QuotaLevel;
}

/** GET /api/admin/usage [admin] — the organisation's usage against its limits. */
export interface OrgUsageDTO {
  kind: OrgKind;
  /** The current calendar month in UTC (sessionsPerMonth). */
  period: { month: string; startsAt: number; resetsAt: number };
  quotas: QuotaUsageDTO[];
  /** Sandbox only: data is deleted this many days after it was last used. */
  sandbox: { purgeAfterDays: number } | null;
}

/** The organisation as the staff app sees it (GET /api/auth/me `org`). */
export interface StaffOrgDTO {
  id: string;
  name: string;
  kind: OrgKind;
  /** Sandbox only (the staff app shows a banner). */
  sandbox: { purgeAfterDays: number } | null;
}

/** `details` of a 409 `quota_exceeded` answer. */
export interface QuotaExceededDetails {
  quota: QuotaKind;
  limit: number;
  /** In use (exams, candidates) or created this month (sessionsPerMonth) before the request. */
  used: number;
  /** What the request would have added. */
  requested: number;
  /** sessionsPerMonth: when the monthly count starts again (epoch ms, 00:00 UTC on the 1st); null otherwise. */
  resetsAt: number | null;
  kind: OrgKind;
}

const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString('en-GB')} ${v === 1 ? one : many}`;

/** "1 November 2026" (UTC). */
export function quotaResetDate(resetsAt: number): string {
  return new Date(resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The plain-language sentence staff see when a creation is refused (the server sends it as the error message). */
export function quotaExceededMessage(d: QuotaExceededDetails): string {
  const who = d.kind === 'sandbox' ? 'This sandbox organisation' : 'Your organisation';
  const raise = d.kind === 'sandbox' ? 'Ask your SmartProctoring operator if you need a higher limit.' : 'Ask your SmartProctoring operator to raise the limit.';
  const left = Math.max(0, d.limit - d.used);
  switch (d.quota) {
    case 'exams':
      return `${who} can have at most ${n(d.limit, 'exam')} (drafts and published exams count, archived ones do not); ${d.used.toLocaleString('en-GB')} in use. Archive an exam you no longer need, or ${raise.charAt(0).toLowerCase()}${raise.slice(1)}`;
    case 'candidates':
      return `${who} can have at most ${n(d.limit, 'candidate')}; ${d.used.toLocaleString('en-GB')} in use${d.requested > 1 ? `, so ${n(d.requested, 'more')} cannot be added` : ''}. Delete candidates you no longer need, or ${raise.charAt(0).toLowerCase()}${raise.slice(1)}`;
    case 'sessionsPerMonth': {
      const when = d.resetsAt != null ? ` The count starts again on ${quotaResetDate(d.resetsAt)} (00:00 UTC).` : '';
      const ask = d.requested > 1 ? `This would create ${n(d.requested, 'exam session')}, but only ${left.toLocaleString('en-GB')} more can be created this month` : 'No more exam sessions can be created this month';
      return `${ask}: ${who.charAt(0).toLowerCase()}${who.slice(1)} can create ${n(d.limit, 'exam session')} a month and has created ${d.used.toLocaleString('en-GB')}.${when} ${raise}`;
    }
  }
}
