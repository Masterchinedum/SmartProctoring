import { QUOTA_LABELS, quotaResetDate, type OrgUsageDTO, type QuotaLevel, type QuotaUsageDTO, type StaffOrgDTO } from '@sp/shared';
import { pluralize } from './format';

/** The persistent staff-app banner of a sandbox organisation; null for production. */
export function sandboxBannerText(org: Partial<Pick<StaffOrgDTO, 'kind' | 'sandbox'>>): string | null {
  if (org.kind !== 'sandbox') return null;
  const days = org.sandbox?.purgeAfterDays;
  return `Sandbox — data is deleted after ${days ? pluralize(days, 'day') : 'a few days'}; not for real candidates.`;
}

export const QUOTA_LEVEL_TEXT: Record<QuotaLevel, string> = { ok: 'Within the limit', warning: 'Nearly reached', reached: 'Limit reached' };
export const QUOTA_LEVEL_CLASS: Record<QuotaLevel, string> = { ok: 'badge badge-success', warning: 'badge badge-warning', reached: 'badge badge-danger' };

export interface UsageRow {
  quota: QuotaUsageDTO['quota'];
  label: string;
  /** "12 of 50" / "12 (no limit)". */
  text: string;
  /** 0–100 (capped), null without a limit. */
  percent: number | null;
  level: QuotaLevel;
}

const num = (n: number) => n.toLocaleString('en-GB');

export function usageRow(q: QuotaUsageDTO): UsageRow {
  if (q.limit == null) return { quota: q.quota, label: QUOTA_LABELS[q.quota], text: `${num(q.used)} (no limit)`, percent: null, level: 'ok' };
  const percent = q.limit === 0 ? 100 : Math.min(100, Math.round((q.used / q.limit) * 100));
  return { quota: q.quota, label: QUOTA_LABELS[q.quota], text: `${num(q.used)} of ${num(q.limit)}`, percent, level: q.level };
}

/** One sentence per quota at or near its limit (shown above the table); empty when all are fine. */
export function usageWarnings(dto: OrgUsageDTO): string[] {
  return dto.quotas
    .filter((q) => q.limit != null && q.level !== 'ok')
    .map((q) => {
      const what = QUOTA_LABELS[q.quota].toLowerCase();
      const month = q.quota === 'sessionsPerMonth' ? ` until ${quotaResetDate(dto.period.resetsAt)}` : '';
      return q.level === 'reached'
        ? `Limit reached: ${what} — ${num(q.used)} of ${num(q.limit!)}. Nothing more can be created${month}.`
        : `Nearly at the limit: ${what} — ${num(q.used)} of ${num(q.limit!)}.`;
    });
}

/** When the monthly count starts again, and who sets the limits. */
export function usageFootnote(dto: OrgUsageDTO): string {
  const limited = dto.quotas.some((q) => q.limit != null);
  return `Exam sessions are counted per calendar month in UTC: the count starts again on ${quotaResetDate(dto.period.resetsAt)} at 00:00 UTC. ${
    limited ? 'The limits are set by your SmartProctoring operator.' : 'Your organisation has no limits; the numbers are for information.'
  }`;
}
