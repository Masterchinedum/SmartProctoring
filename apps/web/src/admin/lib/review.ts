import {
  bulkReviewEligible,
  isFlagCategory,
  resolutionsFor,
  SEVERITY_RANK,
  TERMINAL_STATUSES,
  type EventDTO,
  type Incident,
  type QueueView,
  type ReviewDueDTO,
  type ReviewResolution,
  type SessionReviewDTO,
  type SessionReviewSummaryDTO,
  type SessionSummaryDTO,
  type StaffRole,
} from '@sp/shared';

export const QUEUE_VIEW_LABELS: Record<QueueView, string> = {
  mine: 'Assigned to me',
  unassigned: 'Unassigned',
  escalated: 'Escalated',
  overdue: 'Overdue',
  all: 'All waiting',
  resolved: 'Resolved',
};

export const REVIEW_STATE_LABELS: Record<SessionReviewSummaryDTO['state'], string> = {
  none: 'Not picked up',
  open: 'In review',
  escalated: 'Escalated',
  resolved: 'Resolved',
};

/** "under a minute", "12 min", "3 h 5 min", "2 d 4 h": precise enough for a review target. */
export function coarseDuration(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** "Hold decision due in 12 min" / "Hold decision overdue by 5 min" / "Flag decisions due in 2 d 4 h". */
export function dueText(due: ReviewDueDTO, now: number): string {
  const what = due.kind === 'hold' ? 'Hold decision' : 'Flag decisions';
  if (now > due.dueAt) return `${what} overdue by ${coarseDuration(now - due.dueAt)}`;
  return `${what} due in ${coarseDuration(due.dueAt - now)}`;
}

/** danger: overdue; warning: less than a quarter of the target left; else neutral. */
export function dueTone(due: ReviewDueDTO, now: number): 'danger' | 'warning' | 'neutral' {
  if (now > due.dueAt) return 'danger';
  const total = due.dueAt - due.since;
  return total > 0 && due.dueAt - now < total / 4 ? 'warning' : 'neutral';
}

/** Why a session's review cannot be resolved yet (null: it can). */
export function resolveBlocker(summary: Pick<SessionSummaryDTO, 'status'>, review: Pick<SessionReviewDTO, 'state' | 'undecided'>, role: StaffRole): string | null {
  if (review.state === 'resolved') return null;
  if (!TERMINAL_STATUSES.includes(summary.status)) return 'The exam has not ended yet. The review can be resolved once it has.';
  const n = review.undecided.integrity + review.undecided.uncertain + review.undecided.technical;
  if (n > 0) return `${n} flag${n === 1 ? ' is' : 's are'} not decided yet. Decide every flag first (incidents and the bulk decision below help).`;
  if (review.state === 'escalated' && role === 'reviewer') return 'This review was escalated: an administrator resolves it.';
  return null;
}

/** Undecided flags that may be decided in bulk (technical problems, low severity). */
export function bulkEligible(events: readonly EventDTO[]): EventDTO[] {
  return events.filter((e) => isFlagCategory(e.category) && e.review.status === 'unreviewed' && bulkReviewEligible(e));
}

/** Resolutions offered for deciding an incident together: those of its most serious category. */
export function incidentResolutions(incident: Pick<Incident, 'category'>): ReviewResolution[] {
  return resolutionsFor(incident.category);
}

/** Highest severity first, then oldest: the order a reviewer should look at a session's incidents in. */
export function sortIncidents(list: readonly Incident[]): Incident[] {
  return [...list].sort((a, b) => (b.undecided > 0 ? 1 : 0) - (a.undecided > 0 ? 1 : 0) || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.startedAt - b.startedAt);
}
