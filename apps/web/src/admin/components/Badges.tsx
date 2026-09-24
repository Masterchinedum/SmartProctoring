import {
  CATEGORY_LABELS,
  type ConnectionStatus,
  type EventCategory,
  type IdentityDecision,
  type ReviewStatus,
  type SessionStatus,
  type Severity,
} from '@sp/shared';
import {
  CATEGORY_SHORT,
  CONNECTION_LABELS,
  DECISION_HELP,
  DECISION_LABELS,
  REVIEW_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
} from '../lib/labels';

export function CategoryBadge({ category, long = false }: { category: EventCategory; long?: boolean }) {
  return (
    <span className={`badge badge-${category}`} title={CATEGORY_LABELS[category]}>
      <span className={`cat-dot cat-dot-${category}`} aria-hidden />
      {long ? CATEGORY_LABELS[category] : CATEGORY_SHORT[category]}
    </span>
  );
}

const SEVERITY_CLASS: Record<Severity, string> = { info: 'badge', low: 'badge badge-info', medium: 'badge badge-warning', high: 'badge badge-danger' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`${SEVERITY_CLASS[severity]} sev-badge`} title={`Severity: ${SEVERITY_LABELS[severity]}`}>
      <span className={`sev-bars sev-${severity}`} aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

const STATUS_CLASS: Record<SessionStatus, string> = {
  invited: 'badge',
  ready: 'badge badge-info',
  active: 'badge badge-success',
  paused: 'badge badge-warning',
  on_hold: 'badge badge-danger',
  submitted: 'badge',
  terminated: 'badge badge-danger',
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={STATUS_CLASS[status]}>{STATUS_LABELS[status]}</span>;
}

const CONNECTION_CLASS: Record<ConnectionStatus, string> = {
  online: 'badge badge-success',
  offline: 'badge badge-danger',
  never_connected: 'badge',
};

export function ConnectionBadge({ connection }: { connection: ConnectionStatus }) {
  return (
    <span className={CONNECTION_CLASS[connection]} title={`Connection: ${CONNECTION_LABELS[connection]}`}>
      <span className={`conn-dot conn-${connection}`} aria-hidden />
      {CONNECTION_LABELS[connection]}
    </span>
  );
}

const DECISION_CLASS: Record<IdentityDecision, string> = {
  match: 'badge badge-success',
  mismatch: 'badge badge-integrity',
  inconclusive: 'badge badge-uncertain',
  unable_to_verify: 'badge badge-uncertain',
};

export function DecisionBadge({ decision, livenessFailed = false }: { decision: IdentityDecision; livenessFailed?: boolean }) {
  if (decision === 'unable_to_verify' && livenessFailed) {
    return (
      <span className={DECISION_CLASS[decision]} title={LIVENESS_NOT_COMPLETED_HELP}>
        Live-person check not completed
      </span>
    );
  }
  return (
    <span className={DECISION_CLASS[decision]} title={DECISION_HELP[decision]}>
      {DECISION_LABELS[decision]}
    </span>
  );
}

const LIVENESS_NOT_COMPLETED_HELP =
  'The randomized head-movement check was not completed (for example no head movement was seen, or a photo or screen was held to the camera). This is NOT evidence of a different person.';

const REVIEW_CLASS: Record<ReviewStatus, string> = {
  unreviewed: 'badge badge-warning',
  reviewed: 'badge badge-success',
  dismissed: 'badge',
};

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return <span className={REVIEW_CLASS[status]}>{REVIEW_LABELS[status]}</span>;
}

/** Compact "I 2 · U 1 · T 0" counters with category colours. */
export function CategoryCounts({ counts, compact = false }: { counts: { integrity: number; uncertain: number; technical: number }; compact?: boolean }) {
  const items: [EventCategory, number][] = [
    ['integrity', counts.integrity],
    ['uncertain', counts.uncertain],
    ['technical', counts.technical],
  ];
  return (
    <span className="cat-counts">
      {items.map(([c, n]) => (
        <span key={c} className={`cat-count cat-count-${c}${n === 0 ? ' zero' : ''}`} title={`${CATEGORY_LABELS[c]}: ${n}`}>
          <span className={`cat-dot cat-dot-${c}`} aria-hidden />
          {compact ? (
            // Not by colour alone: a visible initial, and the full category name for screen readers.
            <>
              <span aria-hidden>{CATEGORY_SHORT[c][0]}</span>
              <span className="visually-hidden">{CATEGORY_SHORT[c]}:</span> {n}
            </>
          ) : (
            `${n} ${CATEGORY_SHORT[c].toLowerCase()}`
          )}
        </span>
      ))}
    </span>
  );
}
