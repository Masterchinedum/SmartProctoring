import { describe, expect, it } from 'vitest';
import type { EventDTO, Incident } from '@sp/shared';
import { bulkEligible, coarseDuration, dueText, dueTone, incidentResolutions, resolveBlocker, sortIncidents } from './review';

const T = Date.parse('2026-10-21T10:00:00Z');

describe('review helpers', () => {
  it('describes the service-level target and how urgent it is', () => {
    const hold = { kind: 'hold' as const, since: T, dueAt: T + 15 * 60_000, overdue: false };
    expect(dueText(hold, T + 3 * 60_000)).toBe('Hold decision due in 12 min');
    expect(dueTone(hold, T + 3 * 60_000)).toBe('neutral');
    expect(dueTone(hold, T + 12 * 60_000)).toBe('warning');
    expect(dueText(hold, T + 20 * 60_000)).toBe('Hold decision overdue by 5 min');
    expect(dueTone(hold, T + 20 * 60_000)).toBe('danger');
    expect(dueText({ kind: 'flags', since: T, dueAt: T + 72 * 3_600_000, overdue: false }, T + 30 * 60_000)).toBe('Flag decisions due in 2 d 23 h');
    expect(coarseDuration(20_000)).toBe('under a minute');
    expect(coarseDuration(185 * 60_000)).toBe('3 h 5 min');
    expect(coarseDuration(120 * 60_000)).toBe('2 h');
  });

  it('says why a review cannot be resolved yet', () => {
    const open = { state: 'open' as const, undecided: { integrity: 0, uncertain: 0, technical: 0 } };
    expect(resolveBlocker({ status: 'active' }, open, 'admin')).toMatch(/has not ended/);
    expect(resolveBlocker({ status: 'submitted' }, { ...open, undecided: { integrity: 1, uncertain: 1, technical: 0 } }, 'admin')).toMatch(/^2 flags are not decided/);
    expect(resolveBlocker({ status: 'submitted' }, { ...open, state: 'escalated' }, 'reviewer')).toMatch(/administrator resolves/);
    expect(resolveBlocker({ status: 'submitted' }, { ...open, state: 'escalated' }, 'admin')).toBeNull();
    expect(resolveBlocker({ status: 'terminated' }, open, 'reviewer')).toBeNull();
  });

  it('offers bulk decisions for undecided technical and low-severity flags only', () => {
    const ev = (category: EventDTO['category'], severity: EventDTO['severity'], status: EventDTO['review']['status'] = 'unreviewed') => ({ category, severity, review: { status } }) as EventDTO;
    const list = [ev('technical', 'medium'), ev('integrity', 'low'), ev('integrity', 'medium'), ev('technical', 'low', 'reviewed'), ev('neutral', 'info')];
    expect(bulkEligible(list)).toEqual([list[0], list[1]]);
  });

  it('orders incidents: undecided first, then the most serious, then the oldest', () => {
    const inc = (id: string, severity: Incident['severity'], startedAt: number, undecided: number) => ({ id, severity, startedAt, undecided }) as Incident;
    expect(sortIncidents([inc('a', 'low', 1, 1), inc('b', 'high', 2, 0), inc('c', 'high', 3, 2), inc('d', 'medium', 0, 1)]).map((i) => i.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(incidentResolutions({ category: 'technical' })).not.toContain('concern');
  });
});
