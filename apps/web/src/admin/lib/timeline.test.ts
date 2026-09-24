import { describe, expect, it } from 'vitest';
import type { TimelineItemDTO } from '@sp/shared';
import { makeCheck, makeEvent, makePeriod } from '../test/fixtures';
import { groupCounts, groupTimeline, sortTimeline, upsertEvent, upsertTimelineCheck, upsertTimelineEvent } from './timeline';

const T0 = 1_700_000_000_000;
const s = (n: number) => T0 + n * 1000;

function items(): TimelineItemDTO[] {
  const checkIn = makePeriod('check_in', s(0), s(60));
  const active1 = makePeriod('active', s(60), s(600));
  const paused = makePeriod('paused', s(600), s(1200));
  const resume = makePeriod('resume_check', s(1200), s(1260));
  const active2 = makePeriod('active', s(1260), null);
  return [
    { kind: 'period', at: active2.startedAt, period: active2 },
    { kind: 'period', at: checkIn.startedAt, period: checkIn },
    { kind: 'period', at: paused.startedAt, period: paused },
    { kind: 'period', at: active1.startedAt, period: active1 },
    { kind: 'period', at: resume.startedAt, period: resume },
    { kind: 'event', at: s(-30), event: makeEvent('pause_requested', s(-30)) }, // before any period
    { kind: 'event', at: s(60), event: makeEvent('session_started', s(60)) }, // exactly at a boundary
    { kind: 'event', at: s(300), event: makeEvent('multiple_people', s(300)) },
    { kind: 'event', at: s(600), event: makeEvent('session_paused', s(600)) },
    { kind: 'event', at: s(1260), event: makeEvent('session_resumed', s(1260)) },
    { kind: 'identity_check', at: s(1250), check: makeCheck('match', s(1250), { trigger: 'resume' }) },
    { kind: 'event', at: s(1400), event: makeEvent('looking_away', s(1400)) },
  ];
}

describe('groupTimeline', () => {
  it('assigns every entry to the period it falls in, in chronological order', () => {
    const groups = groupTimeline(items());
    expect(groups.map((g) => (g.period ? g.period.kind : g.position))).toEqual(['before', 'check_in', 'active', 'paused', 'resume_check', 'active']);
    const byKind = (i: number) => groups[i].entries.map((e) => (e.kind === 'event' ? e.event.type : `check:${e.check.trigger}`));
    expect(byKind(0)).toEqual(['pause_requested']);
    expect(byKind(1)).toEqual([]);
    // an entry exactly at a boundary belongs to the period that starts there
    expect(byKind(2)).toEqual(['session_started', 'multiple_people']);
    expect(byKind(3)).toEqual(['session_paused']);
    expect(byKind(4)).toEqual(['check:resume']);
    expect(byKind(5)).toEqual(['session_resumed', 'looking_away']);
  });

  it('keeps empty period groups so pauses stay visible when filtered', () => {
    const onlyPeriods = items().filter((i) => i.kind === 'period');
    const groups = groupTimeline(onlyPeriods);
    expect(groups).toHaveLength(5);
    expect(groups.every((g) => g.entries.length === 0)).toBe(true);
    expect(groups.find((g) => g.period?.kind === 'paused')?.period?.observed).toBe(false);
  });

  it('puts entries after a closed final period into an "after" group and gaps into "between"', () => {
    const a = makePeriod('active', s(0), s(100));
    const b = makePeriod('active', s(200), s(300));
    const list: TimelineItemDTO[] = [
      { kind: 'period', at: a.startedAt, period: a },
      { kind: 'period', at: b.startedAt, period: b },
      { kind: 'event', at: s(150), event: makeEvent('reporting_interrupted', s(150)) },
      { kind: 'event', at: s(400), event: makeEvent('session_submitted', s(400)) },
    ];
    const groups = groupTimeline(list);
    expect(groups.map((g) => g.position)).toEqual(['period', 'between', 'period', 'after']);
    expect(groups[1].entries).toHaveLength(1);
    expect(groups[3].entries).toHaveLength(1);
  });

  it('handles a timeline with no periods', () => {
    const groups = groupTimeline([{ kind: 'event', at: s(1), event: makeEvent('checkin_completed', s(1)) }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].position).toBe('before');
  });
});

describe('timeline patching', () => {
  it('inserts a new event in order and replaces an updated one', () => {
    const base = sortTimeline(items());
    const ev = makeEvent('phone_detected', s(500), { status: 'open', endedAt: null });
    const inserted = upsertTimelineEvent(base, ev);
    expect(inserted).toHaveLength(base.length + 1);
    const idx = inserted.findIndex((i) => i.kind === 'event' && i.event.id === ev.id);
    expect(inserted[idx - 1].at).toBeLessThanOrEqual(s(500));
    expect(inserted[idx + 1].at).toBeGreaterThanOrEqual(s(500));

    const closed = { ...ev, status: 'closed' as const, endedAt: s(530), version: 2 };
    const updated = upsertTimelineEvent(inserted, closed);
    expect(updated).toHaveLength(inserted.length);
    const found = updated.find((i) => i.kind === 'event' && i.event.id === ev.id);
    expect(found?.kind === 'event' && found.event.endedAt).toBe(s(530));
  });

  it('upserts identity checks and flat event lists', () => {
    const c = makeCheck('unable_to_verify', s(10));
    const once = upsertTimelineCheck([], c);
    const twice = upsertTimelineCheck(once, { ...c, decision: 'match' });
    expect(twice).toHaveLength(1);
    expect(twice[0].kind === 'identity_check' && twice[0].check.decision).toBe('match');

    const e = makeEvent('tab_hidden', s(5));
    expect(upsertEvent([e], { ...e, notesCount: 2 })[0].notesCount).toBe(2);
    expect(upsertEvent([], e)).toHaveLength(1);
  });

  it('counts categories and checks per group', () => {
    const groups = groupTimeline(items());
    expect(groupCounts(groups[2].entries)).toEqual({ integrity: 1, uncertain: 0, technical: 0, checks: 0 });
    expect(groupCounts(groups[4].entries).checks).toBe(1);
  });
});
