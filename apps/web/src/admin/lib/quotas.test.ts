import type { OrgUsageDTO } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { sandboxBannerText, usageFootnote, usageRow, usageWarnings } from './quotas';

const usage = (quotas: [number, number | null][], kind: OrgUsageDTO['kind'] = 'sandbox'): OrgUsageDTO => {
  const keys = ['exams', 'candidates', 'sessionsPerMonth'] as const;
  return {
    kind,
    period: { month: '2026-10', startsAt: Date.UTC(2026, 9, 1), resetsAt: Date.UTC(2026, 10, 1) },
    quotas: quotas.map(([used, limit], i) => ({ quota: keys[i], used, limit, level: limit == null ? 'ok' : used >= limit ? 'reached' : used >= limit * 0.8 ? 'warning' : 'ok' })),
    sandbox: kind === 'sandbox' ? { purgeAfterDays: 14 } : null,
  };
};

describe('sandbox and quota helpers', () => {
  it('shows the sandbox banner only for a sandbox, with its clean-up period', () => {
    expect(sandboxBannerText({ kind: 'sandbox', sandbox: { purgeAfterDays: 14 } })).toBe('Sandbox — data is deleted after 14 days; not for real candidates.');
    expect(sandboxBannerText({ kind: 'sandbox', sandbox: { purgeAfterDays: 1 } })).toBe('Sandbox — data is deleted after 1 day; not for real candidates.');
    expect(sandboxBannerText({ kind: 'sandbox' })).toBe('Sandbox — data is deleted after a few days; not for real candidates.');
    expect(sandboxBannerText({ kind: 'production', sandbox: null })).toBeNull();
    expect(sandboxBannerText({})).toBeNull();
  });

  it('describes usage against a limit, and without one', () => {
    expect(usageRow({ quota: 'candidates', used: 12, limit: 50, level: 'ok' })).toEqual({ quota: 'candidates', label: 'Candidates', text: '12 of 50', percent: 24, level: 'ok' });
    expect(usageRow({ quota: 'sessionsPerMonth', used: 1234, limit: null, level: 'ok' })).toEqual({ quota: 'sessionsPerMonth', label: 'Exam sessions created this month', text: '1,234 (no limit)', percent: null, level: 'ok' });
    expect(usageRow({ quota: 'exams', used: 7, limit: 5, level: 'reached' })).toMatchObject({ text: '7 of 5', percent: 100, level: 'reached' });
    expect(usageRow({ quota: 'exams', used: 0, limit: 0, level: 'reached' })).toMatchObject({ percent: 100 });
  });

  it('warns from 80 % and at the limit, naming the monthly reset', () => {
    expect(usageWarnings(usage([[1, 5], [10, 50], [79, 100]]))).toEqual([]);
    expect(usageWarnings(usage([[4, 5], [50, 50], [100, 100]]))).toEqual([
      'Nearly at the limit: exams (drafts and published) — 4 of 5.',
      'Limit reached: candidates — 50 of 50. Nothing more can be created.',
      'Limit reached: exam sessions created this month — 100 of 100. Nothing more can be created until 1 November 2026.',
    ]);
    expect(usageWarnings(usage([[400, null], [10_000, null], [5, null]], 'production'))).toEqual([]);
  });

  it('says when the monthly count starts again (UTC) and who sets the limits', () => {
    expect(usageFootnote(usage([[1, 5], [1, 50], [1, 100]]))).toBe(
      'Exam sessions are counted per calendar month in UTC: the count starts again on 1 November 2026 at 00:00 UTC. The limits are set by your SmartProctoring operator.',
    );
    expect(usageFootnote(usage([[1, null], [1, null], [1, null]], 'production'))).toContain('Your organisation has no limits; the numbers are for information.');
  });
});
