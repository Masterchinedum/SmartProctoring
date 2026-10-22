/**
 * Reviewer workflow: what a reviewer concluded about an event (a structured resolution, not just
 * reviewed/dismissed), the final outcome of a session's review, the review queue (assignment, escalation,
 * service-level targets) and bulk / incident decisions.
 *
 * A resolution answers two separate questions, so detector quality and candidate conduct are never mixed up:
 *  - was the detection right? (`detection`: correct / wrong / unknown — the Quality page's precision uses it)
 *  - is there an integrity concern? (only `concern` says yes)
 * Each resolution implies the stored review status (`reviewed` = the observation stands, `dismissed` = a false
 * detection), so older clients and reports that only know the status keep working.
 */
import { z } from 'zod';
import type { EventCategory, ReviewStatus, Severity } from './events';

export const REVIEW_RESOLUTIONS = ['concern', 'no_concern', 'accommodation', 'technical', 'inconclusive', 'false_detection'] as const;
export type ReviewResolution = (typeof REVIEW_RESOLUTIONS)[number];

export interface ResolutionInfo {
  /** Button / badge label. */
  label: string;
  /** One line for the reviewer: when to choose it. */
  description: string;
  /** The review status it implies. */
  status: Exclude<ReviewStatus, 'unreviewed'>;
  /** Was the detection itself right? null = cannot tell (excluded from precision). */
  detectionCorrect: boolean | null;
  /** Event categories it is offered for (the server accepts it for these only). */
  categories: readonly EventCategory[];
}

const FLAGS: readonly EventCategory[] = ['integrity', 'uncertain', 'technical'];

export const RESOLUTION_INFO: Record<ReviewResolution, ResolutionInfo> = {
  concern: {
    label: 'Integrity concern',
    description: 'The evidence shows a possible breach of the exam rules that needs follow-up under your institution’s process.',
    status: 'reviewed',
    detectionCorrect: true,
    categories: ['integrity', 'uncertain'],
  },
  no_concern: {
    label: 'Accurate, no concern',
    description: 'It happened as described, but it is not a concern (e.g. thinking, permitted material, someone passing by).',
    status: 'reviewed',
    detectionCorrect: true,
    categories: FLAGS,
  },
  accommodation: {
    label: 'Covered by an accommodation',
    description: 'It is explained by an approved accommodation or policy exception for this candidate.',
    status: 'reviewed',
    detectionCorrect: true,
    categories: FLAGS,
  },
  technical: {
    label: 'Technical problem',
    description: 'A technical problem (camera, connection, device), not the candidate’s conduct.',
    status: 'reviewed',
    detectionCorrect: true,
    categories: FLAGS,
  },
  inconclusive: {
    label: 'Inconclusive',
    description: 'The evidence does not allow a conclusion either way.',
    status: 'reviewed',
    detectionCorrect: null,
    categories: FLAGS,
  },
  false_detection: {
    label: 'False detection',
    description: 'What was detected did not happen (e.g. a poster detected as a face, a dark object as a phone).',
    status: 'dismissed',
    detectionCorrect: false,
    categories: FLAGS,
  },
};

export function resolutionsFor(category: EventCategory): ReviewResolution[] {
  return REVIEW_RESOLUTIONS.filter((r) => RESOLUTION_INFO[r].categories.includes(category));
}

/** Label of a decision, for lists: the resolution when there is one, else the plain status. */
export function reviewDecisionLabel(status: ReviewStatus, resolution: ReviewResolution | null | undefined): string {
  if (resolution) return RESOLUTION_INFO[resolution].label;
  return status === 'reviewed' ? 'Reviewed' : status === 'dismissed' ? 'Dismissed' : 'Not reviewed';
}

/**
 * POST /api/admin/events/:id/review — `resolution` (preferred) or the plain `status` (older clients). A note is
 * required when the decision changes another reviewer's decision (`reason_required`).
 */
export const reviewRequestSchema = z
  .object({
    status: z.enum(['unreviewed', 'reviewed', 'dismissed']).optional(),
    resolution: z.enum(REVIEW_RESOLUTIONS).optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((v, c) => {
    if (!v.status && !v.resolution) c.addIssue({ code: 'custom', path: ['resolution'], message: 'Choose a resolution' });
    if (v.status && v.resolution && RESOLUTION_INFO[v.resolution].status !== v.status) {
      c.addIssue({ code: 'custom', path: ['status'], message: `“${RESOLUTION_INFO[v.resolution].label}” means status “${RESOLUTION_INFO[v.resolution].status}”` });
    }
  });
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/** At most this many events in one bulk or incident decision. */
export const BULK_REVIEW_MAX = 200;

/**
 * POST /api/admin/events/review-bulk — one decision for several events. Without `incidentId`, only events that are
 * safe to decide in bulk (technical problems or low severity, bulkReviewEligible); with `incidentId` (an incident's
 * id = its first event's id, ./incidents.ts), the listed events of that incident, reviewed together in context (any
 * severity).
 */
export const bulkReviewSchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1).max(BULK_REVIEW_MAX),
  resolution: z.enum(REVIEW_RESOLUTIONS),
  note: z.string().max(2000).optional(),
  incidentId: z.string().uuid().optional(),
});
export type BulkReviewRequest = z.infer<typeof bulkReviewSchema>;

/** Events that may be decided in bulk outside an incident: technical problems, and low-severity observations. */
export function bulkReviewEligible(e: { category: EventCategory; severity: Severity }): boolean {
  return e.category === 'technical' || e.severity === 'low' || e.severity === 'info';
}

export interface BulkReviewResultDTO {
  updated: string[];
  skipped: { id: string; reason: 'not_found' | 'not_eligible' | 'decided_by_someone_else' | 'resolution_not_applicable' | 'not_in_incident' | 'unchanged' }[];
}

/** One decision in an event's review history (oldest first). */
export interface ReviewDecisionDTO {
  id: string;
  at: number;
  reviewerId: string | null;
  reviewerName: string | null;
  status: ReviewStatus;
  resolution: ReviewResolution | null;
  note: string | null;
  /** Changed the decision of another reviewer (a disagreement). */
  overrides: boolean;
  /** Part of a bulk or incident decision. */
  bulk: boolean;
}

/* ------------------------------------------------------------------ session review (queue) */

export const SESSION_REVIEW_OUTCOMES = ['no_concerns', 'concerns', 'inconclusive', 'technical_issues'] as const;
export type SessionReviewOutcome = (typeof SESSION_REVIEW_OUTCOMES)[number];

export const SESSION_OUTCOME_INFO: Record<SessionReviewOutcome, { label: string; description: string }> = {
  no_concerns: { label: 'No integrity concerns', description: 'The review found nothing that needs follow-up.' },
  concerns: { label: 'Integrity concerns — refer', description: 'Refer the attempt under your institution’s academic-integrity process.' },
  inconclusive: { label: 'Inconclusive', description: 'The evidence does not allow a conclusion; record why in the note.' },
  technical_issues: { label: 'Technical issues affected the exam', description: 'Problems outside the candidate’s control may have affected the attempt (consider a re-sit or adjustment).' },
};

export const SESSION_REVIEW_STATES = ['open', 'escalated', 'resolved'] as const;
export type SessionReviewState = (typeof SESSION_REVIEW_STATES)[number];

/** Service-level targets for review work (organisation settings). */
export interface ReviewSlaSettings {
  /** A held exam should be decided (released / terminated) within this many minutes. */
  holdMinutes: number;
  /** Flags should be decided within this many hours of arriving. */
  flagHours: number;
}
export const DEFAULT_REVIEW_SLA: ReviewSlaSettings = Object.freeze({ holdMinutes: 15, flagHours: 72 });
export const reviewSlaSchema = z.object({
  holdMinutes: z.number().int().min(1).max(24 * 60),
  flagHours: z.number().int().min(1).max(30 * 24),
});

export const QUEUE_VIEWS = ['mine', 'unassigned', 'escalated', 'overdue', 'all', 'resolved'] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];
export const reviewQueueQuerySchema = z.object({
  view: z.enum(QUEUE_VIEWS).default('all'),
  examId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const assignReviewSchema = z.object({ assigneeId: z.string().uuid().nullable() });
export const escalateReviewSchema = z.object({ note: z.string().trim().min(5, 'Say why it needs escalating').max(2000) });
export const resolveReviewSchema = z.object({ outcome: z.enum(SESSION_REVIEW_OUTCOMES), note: z.string().max(2000).optional() });
export const reopenReviewSchema = z.object({ note: z.string().trim().min(5, 'Say why the review is reopened').max(2000) });

export interface ReviewDueDTO {
  /** What the target applies to: a decision on a held exam, or decisions on flags. */
  kind: 'hold' | 'flags';
  /** When the clock started (hold start, or the oldest undecided flag's arrival). */
  since: number;
  dueAt: number;
  overdue: boolean;
}

/** A session's review state, in every session summary (dashboard, lists, queue). */
export interface SessionReviewSummaryDTO {
  /** 'none': nobody has picked it up yet (no assignment, escalation or outcome). */
  state: SessionReviewState | 'none';
  assignee: { id: string; name: string } | null;
  outcome: SessionReviewOutcome | null;
  /** Undecided flags by category. */
  undecided: { integrity: number; uncertain: number; technical: number };
  /** Highest severity among undecided flags. */
  topSeverity: Severity | null;
  /** The service-level target that applies now (null: nothing waiting). */
  due: ReviewDueDTO | null;
}

/** The full review state of one session (session detail). */
export interface SessionReviewDTO extends SessionReviewSummaryDTO {
  assignedAt: number | null;
  escalation: { at: number; by: { id: string; name: string } | null; note: string } | null;
  resolution: { outcome: SessionReviewOutcome; note: string | null; at: number; by: { id: string; name: string } | null } | null;
}
