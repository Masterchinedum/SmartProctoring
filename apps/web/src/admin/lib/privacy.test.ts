import { describe, expect, it } from 'vitest';
import { NAV, staffPageTitle } from '../components/Shell';
import { dueLabel, localDate, receivedAtFromDate, retentionJobLine, validateExtension, validateNewRequest } from './privacy';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();

describe('privacy helpers', () => {
  it('says how long is left, how late a request is, or when it closed', () => {
    expect(dueLabel({ status: 'open', dueAt: NOW + 12 * DAY + 3600_000, closedAt: null }, NOW)).toBe('Due in 12 days');
    expect(dueLabel({ status: 'in_progress', dueAt: NOW + 1 * DAY, closedAt: null }, NOW)).toBe('Due in 1 day');
    expect(dueLabel({ status: 'open', dueAt: NOW + 3600_000, closedAt: null }, NOW)).toBe('Due today');
    expect(dueLabel({ status: 'open', dueAt: NOW - 3600_000, closedAt: null }, NOW)).toBe('Overdue by 1 day');
    expect(dueLabel({ status: 'open', dueAt: NOW - 3 * DAY, closedAt: null }, NOW)).toBe('Overdue by 3 days');
    expect(dueLabel({ status: 'completed', dueAt: NOW - 3 * DAY, closedAt: NOW - 5 * DAY }, NOW)).toBe('Closed 16 Oct 2026');
  });

  it('validates a new request: who it is from, a received date not in the future', () => {
    const today = localDate(NOW);
    expect(today).toBe('2026-10-21');
    const ok = { kind: 'access', subject: 'Alice Example', candidateId: '', channel: 'email', receivedOn: today, details: '' };
    expect(validateNewRequest(ok, today)).toEqual({});
    expect(validateNewRequest({ ...ok, subject: ' A ' }, today).subject).toBeDefined();
    expect(validateNewRequest({ ...ok, receivedOn: '2026-10-22' }, today).receivedOn).toMatch(/future/);
    expect(validateNewRequest({ ...ok, receivedOn: '2026-10-01' }, today)).toEqual({});
    expect(validateNewRequest({ ...ok, details: 'x'.repeat(4001) }, today).details).toBeDefined();
    // Today: the server's clock; an earlier day: noon local time that day.
    expect(receivedAtFromDate(today, today)).toBeUndefined();
    expect(receivedAtFromDate('', today)).toBeUndefined();
    expect(receivedAtFromDate('2026-10-01', today)).toBe(new Date(2026, 9, 1, 12).getTime());
  });

  it('validates a deadline extension: longer than before, within the maximum, with a reason', () => {
    expect(validateExtension('30', 'Records need retrieving from archive.', null)).toBeNull();
    expect(validateExtension('0', 'Records need retrieving from archive.', null)).toMatch(/1 to 60/);
    expect(validateExtension('61', 'Records need retrieving from archive.', null)).toMatch(/1 to 60/);
    expect(validateExtension('20', 'Records need retrieving from archive.', 30)).toMatch(/already extended by 30/);
    expect(validateExtension('40', 'short', 30)).toMatch(/reason/);
  });

  it('describes the retention job’s last run', () => {
    const base = { lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, lastError: null, lastSummary: null, stale: true };
    expect(retentionJobLine(base, NOW)).toBe('The retention job has not run yet.');
    const ran = { ...base, lastStartedAt: NOW - 600_000, lastFinishedAt: NOW - 600_000, lastSuccessAt: NOW - 600_000, stale: false, lastSummary: { sessionsEvidencePurged: 2, evidenceItemsPurged: 14, sessionsEventMetadataPurged: 0, skippedLegalHold: 1, failures: 0 } };
    expect(retentionJobLine(ran, NOW)).toBe('Last run 10m ago: 14 evidence items of 2 sessions deleted.');
    expect(retentionJobLine({ ...ran, lastSummary: { ...ran.lastSummary, failures: 1 } }, NOW)).toContain('1 to retry');
    expect(retentionJobLine({ ...ran, lastError: 'database unavailable' }, NOW)).toContain('failed: database unavailable');
    expect(retentionJobLine({ ...ran, lastSuccessAt: NOW - 4 * 3600_000, stale: true }, NOW)).toContain('No successful run for over 3 hours.');
  });

  it('is in the navigation for administrators, with its own page title', () => {
    expect(NAV.find((n) => n.to === '/admin/privacy')).toMatchObject({ label: 'Privacy', adminOnly: true });
    expect(staffPageTitle('/admin/privacy')).toBe('Privacy — SmartProctoring staff');
  });
});
