import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QUEUE_VIEWS, type QueueView, type SessionSummaryDTO } from '@sp/shared';
import { tabProps } from '../../lib/a11y';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { useAuth } from '../auth';
import { QUEUE_VIEW_LABELS } from '../lib/review';
import { CategoryCounts, SeverityBadge, StatusBadge } from '../components/Badges';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/Common';
import { ReviewSummaryCell } from '../components/ReviewBits';
import { TimeOfDay } from '../components/Time';

const EMPTY: Record<QueueView, string> = {
  mine: 'Nothing is assigned to you.',
  unassigned: 'Every waiting review has someone on it.',
  escalated: 'No escalated reviews.',
  overdue: 'Nothing is past its review target.',
  all: 'Nothing is waiting for review.',
  resolved: 'No resolved reviews yet.',
};

/**
 * The review queue: exams on hold, with undecided flags, or with an open or escalated review — ordered by the
 * review target (overdue first). Assign yourself, then work through the session's Review tab.
 */
export function ReviewQueuePage() {
  const [params, setParams] = useSearchParams();
  const view = (QUEUE_VIEWS.includes(params.get('view') as QueueView) ? params.get('view') : 'all') as QueueView;
  const q = useQuery({
    queryKey: qk.reviewQueue({ view }),
    queryFn: () => api.reviewQueue({ view }),
    placeholderData: keepPreviousData,
    retry: shouldRetry,
    refetchInterval: 30_000,
  });
  const setView = (v: QueueView) => setParams(v === 'all' ? {} : { view: v }, { replace: true });
  const sla = q.data?.sla;
  return (
    <div className="stack">
      <PageHeader
        title="Review queue"
        subtitle={
          sla
            ? `Exams waiting for a staff decision, most urgent first. Targets: decide a held exam within ${sla.holdMinutes} min and flags within ${sla.flagHours} h.`
            : 'Exams waiting for a staff decision, most urgent first.'
        }
      />
      <div className="tabs" role="tablist" aria-label="Review queue views">
        {QUEUE_VIEWS.map((v) => (
          <button key={v} type="button" className={`tab${view === v ? ' active' : ''}`} {...tabProps('queue', QUEUE_VIEWS, v, view, setView)}>
            {QUEUE_VIEW_LABELS[v]}
            {q.data ? (
              <span className={`tab-count${v === 'overdue' && q.data.counts.overdue ? ' tab-count-danger' : ''}`}>
                <span className="visually-hidden">(</span>
                {q.data.counts[v]}
                <span className="visually-hidden">)</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id="queue-panel" aria-labelledby={`queue-tab-${view}`} tabIndex={0}>
        {q.isPending ? (
          <Loading label="Loading the review queue…" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.items.length === 0 ? (
          <EmptyState title={EMPTY[view]} icon="✓" />
        ) : (
          <div className="table-wrap">
            <table className="table" data-testid="review-queue">
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Exam</th>
                  <th scope="col">Status</th>
                  <th scope="col">Undecided flags</th>
                  <th scope="col">Review</th>
                  <th scope="col">Ended</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((s) => (
                  <QueueRow key={s.id} s={s} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function QueueRow({ s }: { s: SessionSummaryDTO }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: () => api.assignReview(s.id, user.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.reviewQueueAll });
      void qc.invalidateQueries({ queryKey: qk.session(s.id), exact: true });
    },
  });
  const r = s.review;
  return (
    <tr data-testid="queue-row">
      <td>
        <Link to={`/admin/sessions/${s.id}?tab=review`}>{s.candidate.name}</Link>
        {s.candidate.externalId ? <div className="small muted">{s.candidate.externalId}</div> : null}
      </td>
      <td>{s.exam.title}</td>
      <td>
        <StatusBadge status={s.status} />
      </td>
      <td>
        {r ? (
          <div className="row tight">
            <CategoryCounts counts={r.undecided} compact />
            {r.topSeverity ? <SeverityBadge severity={r.topSeverity} /> : null}
          </div>
        ) : null}
      </td>
      <td>
        <ReviewSummaryCell review={r} />
      </td>
      <td className="nowrap">{s.endedAt ? <TimeOfDay at={s.endedAt} /> : <span className="muted">In progress</span>}</td>
      <td>
        {r && r.state !== 'resolved' && r.assignee?.id !== user.id ? (
          <button type="button" className="btn btn-sm" disabled={assign.isPending} onClick={() => assign.mutate()}>
            Assign to me
          </button>
        ) : null}
        {assign.isError ? <div className="small text-danger" role="alert">{errorMessage(assign.error)}</div> : null}
      </td>
    </tr>
  );
}
