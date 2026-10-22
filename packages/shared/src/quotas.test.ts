import { describe, expect, it } from 'vitest';
import { quotaExceededMessage, quotaLevel, quotaMonth, quotaResetDate } from './quotas';

describe('quotas', () => {
  it('levels: warning from 80 %, reached at the limit, never without one', () => {
    expect(quotaLevel(0, null)).toBe('ok');
    expect(quotaLevel(10_000, null)).toBe('ok');
    expect(quotaLevel(79, 100)).toBe('ok');
    expect(quotaLevel(80, 100)).toBe('warning');
    expect(quotaLevel(99, 100)).toBe('warning');
    expect(quotaLevel(100, 100)).toBe('reached');
    expect(quotaLevel(0, 0)).toBe('reached');
  });

  it('months are calendar months in UTC', () => {
    expect(quotaMonth(Date.parse('2026-10-31T23:59:59.999Z'))).toEqual({ month: '2026-10', startsAt: Date.parse('2026-10-01T00:00:00Z'), resetsAt: Date.parse('2026-11-01T00:00:00Z') });
    expect(quotaMonth(Date.parse('2026-11-01T00:00:00.000Z')).month).toBe('2026-11');
    // 23:30 on 31 December in New York is already January in UTC.
    expect(quotaMonth(Date.parse('2026-12-31T23:30:00-05:00'))).toEqual({ month: '2027-01', startsAt: Date.parse('2027-01-01T00:00:00Z'), resetsAt: Date.parse('2027-02-01T00:00:00Z') });
    expect(quotaResetDate(Date.parse('2027-02-01T00:00:00Z'))).toBe('1 February 2027');
  });

  it('says in plain words which limit was reached and what to do', () => {
    expect(quotaExceededMessage({ quota: 'candidates', limit: 1, used: 1, requested: 1, resetsAt: null, kind: 'production' })).toBe(
      'Your organisation can have at most 1 candidate; 1 in use. Delete candidates you no longer need, or ask your SmartProctoring operator to raise the limit.',
    );
    expect(quotaExceededMessage({ quota: 'exams', limit: 5, used: 5, requested: 1, resetsAt: null, kind: 'sandbox' })).toContain('This sandbox organisation can have at most 5 exams');
    expect(quotaExceededMessage({ quota: 'sessionsPerMonth', limit: 1000, used: 990, requested: 25, resetsAt: Date.parse('2026-11-01T00:00:00Z'), kind: 'production' })).toBe(
      'This would create 25 exam sessions, but only 10 more can be created this month: your organisation can create 1,000 exam sessions a month and has created 990. The count starts again on 1 November 2026 (00:00 UTC). Ask your SmartProctoring operator to raise the limit.',
    );
  });
});
