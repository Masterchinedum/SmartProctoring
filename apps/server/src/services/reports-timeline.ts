/**
 * Merged, chronological session timeline (periods + events + identity checks), shared by the
 * timeline endpoint, the identity-comparison view and the session report.
 *
 * Ordering is deterministic:
 *   1. by time (`at`: period start, event start, check time);
 *   2. at the same instant: periods, then events, then identity checks (the order the web client uses);
 *   3. within a kind: periods by end time then id; events by first arrival at the server
 *      (firstReceivedAt) then id; identity checks by id.
 */
import type { EventDTO, IdentityCheckDTO, PeriodDTO, TimelineItemDTO } from '@sp/shared';
import { and, eq, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { events } from '../db/schema.js';
import { eventRowsToDTOs, loadIdentityCheckDTOs, loadPeriodDTOs } from './dto.js';

const KIND_RANK: Record<TimelineItemDTO['kind'], number> = { period: 0, event: 1, identity_check: 2 };

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Comparator for timeline items. `eventOrder` maps event id -> arrival rank (from
 * loadOrderedSessionEvents); without it, events at the same instant are ordered by id.
 */
export function compareTimelineItems(a: TimelineItemDTO, b: TimelineItemDTO, eventOrder?: Map<string, number>): number {
  if (a.at !== b.at) return a.at - b.at;
  const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (k !== 0) return k;
  if (a.kind === 'period' && b.kind === 'period') {
    const ea = a.period.endedAt ?? Number.MAX_SAFE_INTEGER;
    const eb = b.period.endedAt ?? Number.MAX_SAFE_INTEGER;
    return ea - eb || cmpStr(a.period.id, b.period.id);
  }
  if (a.kind === 'event' && b.kind === 'event') {
    if (eventOrder) {
      const d = (eventOrder.get(a.event.id) ?? 0) - (eventOrder.get(b.event.id) ?? 0);
      if (d !== 0) return d;
    }
    return cmpStr(a.event.id, b.event.id);
  }
  if (a.kind === 'identity_check' && b.kind === 'identity_check') return cmpStr(a.check.id, b.check.id);
  return 0;
}

/** Merge already-loaded parts into one ordered timeline. */
export function mergeTimeline(periods: PeriodDTO[], evs: EventDTO[], checks: IdentityCheckDTO[], eventOrder?: Map<string, number>): TimelineItemDTO[] {
  const items: TimelineItemDTO[] = [
    ...periods.map((period): TimelineItemDTO => ({ kind: 'period', at: period.startedAt, period })),
    ...evs.map((event): TimelineItemDTO => ({ kind: 'event', at: event.startedAt, event })),
    ...checks.map((check): TimelineItemDTO => ({ kind: 'identity_check', at: check.at, check })),
  ];
  return items.sort((a, b) => compareTimelineItems(a, b, eventOrder));
}

/** Session events in deterministic chronological order (startedAt, first arrival, id), plus extra filters. */
export async function loadOrderedSessionEvents(db: DbOrTx, sessionId: string, ...conds: (SQL | undefined)[]): Promise<EventDTO[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.sessionId, sessionId), ...conds))
    .orderBy(events.startedAt, events.firstReceivedAt, events.id);
  return eventRowsToDTOs(db, rows);
}

export interface SessionTimelineParts {
  periods: PeriodDTO[];
  events: EventDTO[];
  checks: IdentityCheckDTO[];
  items: TimelineItemDTO[];
}

/** Load everything for a session's timeline. */
export async function loadSessionTimeline(db: DbOrTx, sessionId: string): Promise<SessionTimelineParts> {
  const [periods, evs, checks] = await Promise.all([loadPeriodDTOs(db, sessionId), loadOrderedSessionEvents(db, sessionId), loadIdentityCheckDTOs(db, sessionId)]);
  const order = new Map(evs.map((e, i) => [e.id, i]));
  return { periods, events: evs, checks, items: mergeTimeline(periods, evs, checks, order) };
}

/** Does [start, end] (end null = still open) overlap the window [from, to]? */
export function overlaps(start: number, end: number | null, from: number, to: number): boolean {
  return start <= to && (end ?? Number.MAX_SAFE_INTEGER) >= from;
}

/** Timeline items overlapping a time window (spans are included when any part falls inside). Keeps order. */
export function timelineWindow(items: TimelineItemDTO[], from: number, to: number): TimelineItemDTO[] {
  return items.filter((i) => {
    if (i.kind === 'period') return overlaps(i.period.startedAt, i.period.endedAt, from, to);
    if (i.kind === 'event') return overlaps(i.event.startedAt, i.event.endedAt, from, to);
    return i.at >= from && i.at <= to;
  });
}
