import { describe, expect, it } from 'vitest';
import type { TimelineItemDTO } from '@sp/shared';
import { makeCheck, makeEvent, makePeriod } from '../test/fixtures';
import { checkMatches, DEFAULT_FILTERS, eventMatches, filtersActive, filterTimeline, presentTypes, sortEvents, toggleCategory } from './filters';

const reviewed = { status: 'reviewed' as const, by: 'u', byName: 'R', at: 1, note: null };

describe('eventMatches', () => {
  const phone = makeEvent('phone_detected', 10);
  const absent = makeEvent('candidate_absent', 20, { review: reviewed });
  const unverifiable = makeEvent('identity_unverifiable', 30);
  const paused = makeEvent('session_paused', 40);
  const camera = makeEvent('camera_disconnected', 50);
  const all = [phone, absent, unverifiable, paused, camera];

  it('passes everything with default filters', () => {
    expect(all.every((e) => eventMatches(e, DEFAULT_FILTERS))).toBe(true);
    expect(filtersActive(DEFAULT_FILTERS)).toBe(false);
  });

  it('filters by multiple categories', () => {
    const f = toggleCategory(toggleCategory(DEFAULT_FILTERS, 'uncertain'), 'technical');
    expect(all.filter((e) => eventMatches(e, f)).map((e) => e.type)).toEqual(['identity_unverifiable', 'camera_disconnected']);
    expect(toggleCategory(f, 'uncertain').categories).toEqual(['technical']);
  });

  it('filters by type, minimum severity and review status', () => {
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, type: 'phone_detected' }))).toEqual([phone]);
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, minSeverity: 'high' }))).toEqual([phone]);
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, minSeverity: 'medium' })).map((e) => e.type)).toEqual([
      'phone_detected',
      'candidate_absent',
      'identity_unverifiable',
      'camera_disconnected',
    ]);
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, review: 'reviewed' }))).toEqual([absent]);
  });

  it('hides neutral events and, for "only unreviewed", neutral + reviewed ones', () => {
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, hideNeutral: true }))).not.toContain(paused);
    expect(all.filter((e) => eventMatches(e, { ...DEFAULT_FILTERS, onlyUnreviewed: true })).map((e) => e.type)).toEqual([
      'phone_detected',
      'identity_unverifiable',
      'camera_disconnected',
    ]);
  });
});

describe('checkMatches', () => {
  it('derives a category from the decision (unable_to_verify is uncertain, never integrity)', () => {
    const integrityOnly = toggleCategory(DEFAULT_FILTERS, 'integrity');
    expect(checkMatches(makeCheck('mismatch', 1), integrityOnly)).toBe(true);
    expect(checkMatches(makeCheck('unable_to_verify', 1), integrityOnly)).toBe(false);
    expect(checkMatches(makeCheck('unable_to_verify', 1), toggleCategory(DEFAULT_FILTERS, 'uncertain'))).toBe(true);
  });
  it('hides checks for review filters, other types, and matches when hiding neutral', () => {
    expect(checkMatches(makeCheck('mismatch', 1), { ...DEFAULT_FILTERS, onlyUnreviewed: true })).toBe(false);
    expect(checkMatches(makeCheck('mismatch', 1), { ...DEFAULT_FILTERS, type: 'phone_detected' })).toBe(false);
    expect(checkMatches(makeCheck('mismatch', 1), { ...DEFAULT_FILTERS, type: 'identity_check' })).toBe(true);
    expect(checkMatches(makeCheck('match', 1), { ...DEFAULT_FILTERS, hideNeutral: true })).toBe(false);
    expect(checkMatches(makeCheck('match', 1), { ...DEFAULT_FILTERS, minSeverity: 'low' })).toBe(false);
  });
});

describe('filterTimeline', () => {
  it('always keeps periods', () => {
    const p = makePeriod('paused', 0, 10);
    const items: TimelineItemDTO[] = [
      { kind: 'period', at: 0, period: p },
      { kind: 'event', at: 1, event: makeEvent('session_paused', 1) },
      { kind: 'identity_check', at: 2, check: makeCheck('match', 2) },
    ];
    const out = filterTimeline(items, { ...DEFAULT_FILTERS, hideNeutral: true });
    expect(out.map((i) => i.kind)).toEqual(['period']);
  });
});

describe('sortEvents / presentTypes', () => {
  const a = makeEvent('looking_away', 30);
  const b = makeEvent('phone_detected', 10);
  const c = makeEvent('candidate_absent', 20, { durationMs: 60_000 });
  it('sorts by time and severity in both directions', () => {
    expect(sortEvents([a, b, c], 'time', 'asc').map((e) => e.startedAt)).toEqual([10, 20, 30]);
    expect(sortEvents([a, b, c], 'time', 'desc').map((e) => e.startedAt)).toEqual([30, 20, 10]);
    expect(sortEvents([a, b, c], 'severity', 'desc').map((e) => e.severity)).toEqual(['high', 'medium', 'low']);
    expect(sortEvents([a, b, c], 'duration', 'desc')[0]).toBe(c);
  });
  it('lists distinct types with counts', () => {
    expect(presentTypes([a, b, makeEvent('phone_detected', 40)])).toEqual([
      { type: 'phone_detected', title: 'Phone visible', count: 2 },
      { type: 'looking_away', title: 'Sustained looking away', count: 1 },
    ]);
  });
});
