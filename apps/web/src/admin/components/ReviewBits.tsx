import { SESSION_OUTCOME_INFO, type ReviewDueDTO, type SessionReviewOutcome, type SessionReviewSummaryDTO } from '@sp/shared';
import { useNow } from '../lib/clock';
import { formatDateTime } from '../lib/format';
import { dueText, dueTone, REVIEW_STATE_LABELS } from '../lib/review';

const TONE_CLASS = { danger: 'badge badge-danger', warning: 'badge badge-warning', neutral: 'badge' } as const;

/** The review target that applies now, updating live ("Hold decision due in 4 min" / "… overdue by 2 min"). */
export function DueBadge({ due }: { due: ReviewDueDTO }) {
  const now = useNow(true);
  return (
    <span className={TONE_CLASS[dueTone(due, now)]} title={`Since ${formatDateTime(due.since)}; target ${formatDateTime(due.dueAt)}`} data-testid="review-due">
      {dueText(due, now)}
    </span>
  );
}

const STATE_CLASS: Record<SessionReviewSummaryDTO['state'], string> = { none: 'badge', open: 'badge badge-info', escalated: 'badge badge-warning', resolved: 'badge badge-success' };

export function ReviewStateBadge({ state }: { state: SessionReviewSummaryDTO['state'] }) {
  return <span className={STATE_CLASS[state]}>{REVIEW_STATE_LABELS[state]}</span>;
}

const OUTCOME_CLASS: Record<SessionReviewOutcome, string> = {
  no_concerns: 'badge badge-success',
  concerns: 'badge badge-danger',
  inconclusive: 'badge badge-warning',
  technical_issues: 'badge badge-technical',
};

export function OutcomeBadge({ outcome }: { outcome: SessionReviewOutcome }) {
  return (
    <span className={OUTCOME_CLASS[outcome]} title={SESSION_OUTCOME_INFO[outcome].description}>
      {SESSION_OUTCOME_INFO[outcome].label}
    </span>
  );
}

/** Compact review status for lists: outcome when resolved, else state, assignee and the target. */
export function ReviewSummaryCell({ review }: { review: SessionReviewSummaryDTO | undefined }) {
  if (!review) return <span className="muted">—</span>;
  const undecided = review.undecided.integrity + review.undecided.uncertain + review.undecided.technical;
  return (
    <div className="stack tight">
      <div className="row tight">
        {review.state === 'resolved' && review.outcome ? <OutcomeBadge outcome={review.outcome} /> : <ReviewStateBadge state={review.state} />}
        {undecided ? <span className="small muted">{undecided} undecided</span> : null}
      </div>
      {review.assignee ? <span className="small">→ {review.assignee.name}</span> : null}
      {review.due ? <DueBadge due={review.due} /> : null}
    </div>
  );
}
