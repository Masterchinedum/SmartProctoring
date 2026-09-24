import type { EventDTO, IdentityCheckDTO, PeriodDTO, TimelineItemDTO } from '@sp/shared';

export type TimelineEntry = Exclude<TimelineItemDTO, { kind: 'period' }>;

export interface TimelineGroup {
  key: string;
  /** null for items that fall outside every period (before the exam, between periods, after the end). */
  period: PeriodDTO | null;
  position: 'period' | 'before' | 'between' | 'after';
  entries: TimelineEntry[];
}

export function entryKey(e: TimelineItemDTO): string {
  if (e.kind === 'period') return `p:${e.period.id}`;
  if (e.kind === 'event') return `e:${e.event.id}`;
  return `c:${e.check.id}`;
}

/** Stable chronological comparator: by time, then periods before entries at the same instant. */
function compareItems(a: TimelineItemDTO, b: TimelineItemDTO): number {
  if (a.at !== b.at) return a.at - b.at;
  const rank = (x: TimelineItemDTO) => (x.kind === 'period' ? 0 : x.kind === 'event' ? 1 : 2);
  return rank(a) - rank(b);
}

export function sortTimeline(items: TimelineItemDTO[]): TimelineItemDTO[] {
  return [...items].sort(compareItems);
}

/**
 * Group a merged timeline into period sections. Periods partition the session: every entry goes into
 * the latest period that started at or before it and had not ended before it. Entries outside every
 * period go into 'before' / 'between' / 'after' groups so nothing is ever hidden. Period groups are
 * always emitted (even when filters leave them empty) so pauses and resumes stay visible.
 */
export function groupTimeline(items: TimelineItemDTO[]): TimelineGroup[] {
  const periods = items
    .filter((i): i is Extract<TimelineItemDTO, { kind: 'period' }> => i.kind === 'period')
    .map((i) => i.period)
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const entries = items.filter((i): i is TimelineEntry => i.kind !== 'period').sort(compareItems);

  const periodGroups: TimelineGroup[] = periods.map((p) => ({ key: `p:${p.id}`, period: p, position: 'period', entries: [] }));
  // gapGroups[i] holds entries after period i ended (and before period i+1 started); index -1 = before first.
  const before: TimelineEntry[] = [];
  const gaps = new Map<number, TimelineEntry[]>();

  for (const entry of entries) {
    let idx = -1;
    // periods are sorted: find the last one starting at or before the entry
    for (let i = periods.length - 1; i >= 0; i--) {
      if (periods[i].startedAt <= entry.at) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      before.push(entry);
      continue;
    }
    const p = periods[idx];
    if (p.endedAt == null || entry.at <= p.endedAt) {
      periodGroups[idx].entries.push(entry);
    } else {
      const list = gaps.get(idx) ?? [];
      list.push(entry);
      gaps.set(idx, list);
    }
  }

  const out: TimelineGroup[] = [];
  if (before.length) out.push({ key: 'before', period: null, position: 'before', entries: before });
  periodGroups.forEach((g, i) => {
    out.push(g);
    const gap = gaps.get(i);
    if (gap?.length) out.push({ key: `gap:${i}`, period: null, position: i === periods.length - 1 ? 'after' : 'between', entries: gap });
  });
  return out;
}

export function periodDurationMs(p: PeriodDTO, now: number): number {
  return Math.max(0, (p.endedAt ?? now) - p.startedAt);
}

/** Insert or replace an event in a timeline, keeping chronological order. */
export function upsertTimelineEvent(items: TimelineItemDTO[], event: EventDTO): TimelineItemDTO[] {
  const next = items.filter((i) => !(i.kind === 'event' && i.event.id === event.id));
  next.push({ kind: 'event', at: event.startedAt, event });
  return sortTimeline(next);
}

export function upsertTimelineCheck(items: TimelineItemDTO[], check: IdentityCheckDTO): TimelineItemDTO[] {
  const next = items.filter((i) => !(i.kind === 'identity_check' && i.check.id === check.id));
  next.push({ kind: 'identity_check', at: check.at, check });
  return sortTimeline(next);
}

/** Replace an event in a flat list (or append). */
export function upsertEvent(list: EventDTO[], event: EventDTO): EventDTO[] {
  const i = list.findIndex((e) => e.id === event.id);
  if (i === -1) return [...list, event];
  const next = list.slice();
  next[i] = event;
  return next;
}

/** Summary counts for a period group, used in section headers. */
export function groupCounts(entries: TimelineEntry[]): { integrity: number; uncertain: number; technical: number; checks: number } {
  const c = { integrity: 0, uncertain: 0, technical: 0, checks: 0 };
  for (const e of entries) {
    if (e.kind === 'identity_check') c.checks++;
    else if (e.event.category === 'integrity') c.integrity++;
    else if (e.event.category === 'uncertain') c.uncertain++;
    else if (e.event.category === 'technical') c.technical++;
  }
  return c;
}
