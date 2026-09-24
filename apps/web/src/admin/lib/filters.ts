import { SEVERITY_RANK, type EventCategory, type EventDTO, type IdentityCheckDTO, type ReviewStatus, type Severity, type TimelineItemDTO } from '@sp/shared';
import { decisionCategory } from './labels';

/** Client-side filters shared by the Timeline and Events tabs. */
export interface EventFilterState {
  /** Empty = all categories. */
  categories: EventCategory[];
  /** Event type, 'identity_check' for identity checks, or '' for all. */
  type: string;
  /** Minimum severity, '' = any. */
  minSeverity: Severity | '';
  review: ReviewStatus | '';
  hideNeutral: boolean;
  onlyUnreviewed: boolean;
}

export const DEFAULT_FILTERS: EventFilterState = {
  categories: [],
  type: '',
  minSeverity: '',
  review: '',
  hideNeutral: false,
  onlyUnreviewed: false,
};

export function filtersActive(f: EventFilterState): boolean {
  return f.categories.length > 0 || f.type !== '' || f.minSeverity !== '' || f.review !== '' || f.hideNeutral || f.onlyUnreviewed;
}

export function eventMatches(e: EventDTO, f: EventFilterState): boolean {
  if (f.categories.length > 0 && !f.categories.includes(e.category)) return false;
  if (f.type && f.type !== e.type) return false;
  if (f.minSeverity && SEVERITY_RANK[e.severity] < SEVERITY_RANK[f.minSeverity]) return false;
  if (f.review && e.review.status !== f.review) return false;
  if (f.hideNeutral && e.category === 'neutral') return false;
  if (f.onlyUnreviewed && (e.review.status !== 'unreviewed' || e.category === 'neutral')) return false;
  return true;
}

/** Identity-check pseudo severity: mismatch high, uncertain medium, match info. */
export function checkSeverity(c: IdentityCheckDTO): Severity {
  if (c.decision === 'mismatch') return 'high';
  if (c.decision === 'match') return 'info';
  return 'low';
}

/**
 * Identity checks carry no review state. They are shown unless the filters exclude them:
 * category is derived from the decision (mismatch = integrity, unable/inconclusive = uncertain,
 * match = neutral); a type filter other than 'identity_check' hides them; review filters hide them.
 */
export function checkMatches(c: IdentityCheckDTO, f: EventFilterState): boolean {
  const cat = decisionCategory(c.decision);
  if (f.categories.length > 0 && !f.categories.includes(cat)) return false;
  if (f.type && f.type !== 'identity_check') return false;
  if (f.minSeverity && SEVERITY_RANK[checkSeverity(c)] < SEVERITY_RANK[f.minSeverity]) return false;
  if (f.review || f.onlyUnreviewed) return false;
  if (f.hideNeutral && cat === 'neutral') return false;
  return true;
}

export function filterTimeline(items: TimelineItemDTO[], f: EventFilterState): TimelineItemDTO[] {
  return items.filter((it) => {
    if (it.kind === 'period') return true;
    if (it.kind === 'event') return eventMatches(it.event, f);
    return checkMatches(it.check, f);
  });
}

export type EventSortKey = 'time' | 'severity' | 'duration' | 'type';

export function sortEvents(events: EventDTO[], key: EventSortKey, dir: 'asc' | 'desc'): EventDTO[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...events].sort((a, b) => {
    let d = 0;
    if (key === 'severity') d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    else if (key === 'duration') d = (a.durationMs ?? -1) - (b.durationMs ?? -1);
    else if (key === 'type') d = a.title.localeCompare(b.title);
    if (d === 0) d = a.startedAt - b.startedAt;
    if (d === 0) d = a.id.localeCompare(b.id);
    return d * mul;
  });
}

/** Distinct event types present in a list (for the type filter dropdown), sorted by title. */
export function presentTypes(events: EventDTO[]): { type: string; title: string; count: number }[] {
  const m = new Map<string, { type: string; title: string; count: number }>();
  for (const e of events) {
    const cur = m.get(e.type);
    if (cur) cur.count++;
    else m.set(e.type, { type: e.type, title: e.title, count: 1 });
  }
  return [...m.values()].sort((a, b) => a.title.localeCompare(b.title));
}

export function toggleCategory(f: EventFilterState, c: EventCategory): EventFilterState {
  const has = f.categories.includes(c);
  return { ...f, categories: has ? f.categories.filter((x) => x !== c) : [...f.categories, c] };
}
