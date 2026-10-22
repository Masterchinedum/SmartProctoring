/**
 * Incidents: a session's flags grouped by time, so a reviewer judges what happened in one moment as a whole (a
 * phone, then looking down, then the face leaving the view) instead of one event type at a time.
 *
 * Flags (integrity, uncertain, technical) whose time spans overlap or lie within `gapMs` of each other form one
 * incident. Technical problems and uncertain observations are grouped with the integrity events they coincide
 * with on purpose: a camera dropping out or poor light at the same moment is exactly the context a reviewer needs.
 * A long-running flag (poor light for ten minutes, a virtual camera for the whole exam) extends its incident by at
 * most `chainMs` from its start, so it cannot swallow every later moment; its overlap with later flags is still
 * shown in their explanations (explain.ts). Each flag belongs to exactly one incident. Neutral session changes and
 * policy exceptions are never part of an incident.
 *
 * Pure and deterministic (same input → same incidents, ids are the first event's id): the staff app, the report
 * and the server (which validates incident decisions) all use this function.
 */
import { EVENT_CATALOG, isFlagCategory, SEVERITY_RANK, type EventCategory, type EventType, type ReviewStatus, type Severity } from './events';

/** Flags further apart than this are separate incidents. */
export const INCIDENT_GAP_MS = 30_000;
/** How far past its start one flag can extend an incident (long-running conditions do not chain everything). */
export const INCIDENT_CHAIN_MS = 60_000;

export interface IncidentEventInput {
  id: string;
  type: EventType;
  category: EventCategory;
  severity: Severity;
  startedAt: number;
  endedAt: number | null;
  review: { status: ReviewStatus };
}

export interface Incident {
  /** The id of its earliest event (stable while the incident grows). */
  id: string;
  startedAt: number;
  /** End of the latest event; `now` for an event still open. */
  endedAt: number;
  open: boolean;
  /** The most serious category among its events (integrity > uncertain > technical). */
  category: EventCategory;
  severity: Severity;
  eventIds: string[];
  /** Distinct types in order of first appearance, with counts. */
  types: { type: EventType; count: number }[];
  /** "Phone visible · Sustained looking away ×2". */
  title: string;
  undecided: number;
}

const CATEGORY_RANK: Partial<Record<EventCategory, number>> = { integrity: 3, uncertain: 2, technical: 1 };

export function groupIncidents<E extends IncidentEventInput>(events: readonly E[], opts: { now: number; gapMs?: number; chainMs?: number }): Incident[] {
  const gap = opts.gapMs ?? INCIDENT_GAP_MS;
  const chain = opts.chainMs ?? INCIDENT_CHAIN_MS;
  const flags = events
    .filter((e) => isFlagCategory(e.category))
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const groups: E[][] = [];
  let end = -Infinity;
  for (const e of flags) {
    const eEnd = Math.min(Math.max(e.startedAt, e.endedAt ?? opts.now), e.startedAt + chain);
    if (groups.length && e.startedAt <= end + gap) {
      groups[groups.length - 1].push(e);
      end = Math.max(end, eEnd);
    } else {
      groups.push([e]);
      end = eEnd;
    }
  }
  return groups.map((g) => {
    const types: { type: EventType; count: number }[] = [];
    for (const e of g) {
      const t = types.find((x) => x.type === e.type);
      if (t) t.count++;
      else types.push({ type: e.type, count: 1 });
    }
    const top = g.reduce((a, b) => ((CATEGORY_RANK[b.category] ?? 0) > (CATEGORY_RANK[a.category] ?? 0) ? b : a));
    const sev = g.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
    return {
      id: g[0].id,
      startedAt: g[0].startedAt,
      endedAt: Math.max(...g.map((e) => Math.max(e.startedAt, e.endedAt ?? opts.now))),
      open: g.some((e) => e.endedAt == null),
      category: top.category,
      severity: sev.severity,
      eventIds: g.map((e) => e.id),
      types,
      title: types.map((t) => `${EVENT_CATALOG[t.type]?.title ?? t.type}${t.count > 1 ? ` ×${t.count}` : ''}`).join(' · '),
      undecided: g.filter((e) => e.review.status === 'unreviewed').length,
    };
  });
}

/** The incident containing an event (null for neutral events / unknown ids). */
export function incidentOf(incidents: readonly Incident[], eventId: string): Incident | null {
  return incidents.find((i) => i.eventIds.includes(eventId)) ?? null;
}
