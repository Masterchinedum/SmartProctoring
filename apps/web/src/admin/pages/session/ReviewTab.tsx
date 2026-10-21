import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  groupIncidents,
  RESOLUTION_INFO,
  SESSION_OUTCOME_INFO,
  SESSION_REVIEW_OUTCOMES,
  type BulkReviewResultDTO,
  type EventDTO,
  type Incident,
  type ReviewResolution,
  type SessionDetailDTO,
  type SessionReviewOutcome,
} from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { useAuth } from '../../auth';
import { useNow } from '../../lib/clock';
import { formatDateTime } from '../../lib/format';
import { bulkEligible, incidentResolutions, resolveBlocker, sortIncidents } from '../../lib/review';
import { CategoryBadge, ReviewBadge, SeverityBadge } from '../../components/Badges';
import { EmptyState, ErrorState, Loading } from '../../components/Common';
import { Modal } from '../../components/Modal';
import { DueBadge, OutcomeBadge, ReviewStateBadge } from '../../components/ReviewBits';
import { Clock } from '../../components/Time';

/** Everything a reviewer does on one session: the review itself, incidents decided together, and bulk decisions. */
export function ReviewTab({ d, onOpenEvent, focusIncidentId }: { d: SessionDetailDTO; onOpenEvent: (id: string) => void; focusIncidentId: string | null }) {
  const id = d.summary.id;
  const q = useQuery({ queryKey: qk.sessionEvents(id), queryFn: () => api.sessionEvents(id), retry: shouldRetry });
  const now = useNow(false);
  const incidents = useMemo(() => sortIncidents(groupIncidents(q.data?.items ?? [], { now })), [q.data, now]);
  const byId = useMemo(() => new Map((q.data?.items ?? []).map((e) => [e.id, e])), [q.data]);
  return (
    <div className="stack" data-testid="review-tab">
      <SessionReviewPanel d={d} />
      <section className="stack" aria-labelledby="incidents-title">
        <h2 id="incidents-title" className="h3">
          Incidents
        </h2>
        <p className="small muted">Flags close in time (within 30 seconds of each other) are grouped, so you can judge what happened in that moment as a whole, with technical problems and poor conditions alongside.</p>
        {q.isPending ? (
          <Loading label="Loading events…" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : incidents.length === 0 ? (
          <EmptyState title="No flags in this session" icon="✓" />
        ) : (
          <ol className="incident-list">
            {incidents.map((inc) => (
              <IncidentCard key={inc.id} sessionId={id} incident={inc} events={inc.eventIds.map((e) => byId.get(e)!).filter(Boolean)} onOpenEvent={onOpenEvent} focus={inc.id === focusIncidentId} />
            ))}
          </ol>
        )}
      </section>
      {q.data ? <BulkDecision sessionId={id} events={q.data.items} /> : null}
    </div>
  );
}

function useReviewInvalidation(sessionId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.session(sessionId), exact: true });
    void qc.invalidateQueries({ queryKey: qk.sessionEvents(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.timeline(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.report(sessionId) });
    void qc.invalidateQueries({ queryKey: qk.reviewQueueAll });
    void qc.invalidateQueries({ queryKey: ['event'] });
  };
}

/* ------------------------------------------------------------------ the session's review */

function SessionReviewPanel({ d }: { d: SessionDetailDTO }) {
  const { user } = useAuth();
  const r = d.review;
  const sessionId = d.summary.id;
  const invalidate = useReviewInvalidation(sessionId);
  const isAdmin = user.role !== 'reviewer';
  const [dialog, setDialog] = useState<null | 'escalate' | 'reopen'>(null);
  const [outcome, setOutcome] = useState<SessionReviewOutcome | null>(null);
  const [note, setNote] = useState('');
  const formId = useId();
  const assign = useMutation({ mutationFn: (assigneeId: string | null) => api.assignReview(sessionId, assigneeId), onSuccess: invalidate });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users, enabled: isAdmin && r.state !== 'resolved', retry: shouldRetry });
  const resolve = useMutation({
    mutationFn: () => api.resolveReview(sessionId, outcome!, note.trim() || undefined),
    onSuccess: () => {
      setOutcome(null);
      setNote('');
      invalidate();
    },
  });
  const blocker = resolveBlocker(d.summary, r, user.role);
  const undecided = r.undecided.integrity + r.undecided.uncertain + r.undecided.technical;
  const noteRequired = outcome != null && outcome !== 'no_concerns';

  return (
    <section className="card stack" aria-labelledby="review-title" data-testid="session-review">
      <div className="row">
        <h2 id="review-title" className="h3">
          Review of this exam
        </h2>
        <ReviewStateBadge state={r.state} />
        {r.due ? <DueBadge due={r.due} /> : null}
      </div>
      <p className="small">
        {undecided ? (
          <>
            <strong>{undecided}</strong> flag{undecided === 1 ? '' : 's'} not decided yet ({r.undecided.integrity} integrity, {r.undecided.uncertain} uncertain, {r.undecided.technical} technical).
          </>
        ) : (
          'Every flag is decided.'
        )}
      </p>

      {r.state !== 'resolved' ? (
        <div className="row tight" data-testid="review-assignment">
          <span>{r.assignee ? <>Assigned to <strong>{r.assignee.name}</strong>{r.assignedAt ? <span className="muted"> since {formatDateTime(r.assignedAt)}</span> : null}</> : 'Nobody is assigned.'}</span>
          {r.assignee?.id !== user.id ? (
            <button type="button" className="btn btn-sm" disabled={assign.isPending} onClick={() => assign.mutate(user.id)}>
              Assign to me
            </button>
          ) : null}
          {r.assignee && (r.assignee.id === user.id || isAdmin) ? (
            <button type="button" className="btn btn-sm" disabled={assign.isPending} onClick={() => assign.mutate(null)}>
              Unassign
            </button>
          ) : null}
          {isAdmin && users.data ? (
            <label className="inline small">
              Assign to
              <select value={r.assignee?.id ?? ''} onChange={(e) => e.target.value && assign.mutate(e.target.value)} disabled={assign.isPending}>
                <option value="">Choose…</option>
                {users.data.items
                  .filter((u) => !u.disabled)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
          {r.state !== 'escalated' ? (
            <button type="button" className="btn btn-sm" onClick={() => setDialog('escalate')}>
              Escalate…
            </button>
          ) : null}
        </div>
      ) : null}
      {assign.isError ? <div className="banner banner-danger" role="alert">{errorMessage(assign.error)}</div> : null}

      {r.escalation ? (
        <div className="banner banner-warning small" data-testid="review-escalation">
          <strong>Escalated</strong> by {r.escalation.by?.name ?? 'staff'} on {formatDateTime(r.escalation.at)}: {r.escalation.note}
        </div>
      ) : null}

      {r.state === 'resolved' && r.resolution ? (
        <div className="stack" data-testid="review-outcome">
          <div className="row">
            <OutcomeBadge outcome={r.resolution.outcome} />
            <span className="small muted">
              by {r.resolution.by?.name ?? 'staff'} · {formatDateTime(r.resolution.at)}
            </span>
          </div>
          {r.resolution.note ? <blockquote className="review-note">{r.resolution.note}</blockquote> : null}
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => setDialog('reopen')}>
              Reopen the review…
            </button>
          </div>
        </div>
      ) : blocker ? (
        <p className="small muted" data-testid="resolve-blocker">
          {blocker}
        </p>
      ) : (
        <form
          className="stack"
          aria-labelledby={`${formId}-legend`}
          onSubmit={(e) => {
            e.preventDefault();
            if (outcome && (!noteRequired || note.trim())) resolve.mutate();
          }}
          data-testid="resolve-review"
        >
          <fieldset className="resolution-options">
            <legend id={`${formId}-legend`}>Outcome of the review</legend>
            {SESSION_REVIEW_OUTCOMES.map((o) => (
              <label key={o} className={`resolution-option${outcome === o ? ' selected' : ''}`}>
                <input type="radio" name={`${formId}-outcome`} value={o} checked={outcome === o} onChange={() => setOutcome(o)} data-testid={`outcome-${o}`} />
                <span>
                  <strong>{SESSION_OUTCOME_INFO[o].label}</strong>
                  <span className="muted small"> — {SESSION_OUTCOME_INFO[o].description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            {noteRequired ? 'Note (required)' : 'Note (optional)'}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={2} required={noteRequired} data-testid="outcome-note" />
          </label>
          {resolve.isError ? <div className="banner banner-danger" role="alert">{errorMessage(resolve.error)}</div> : null}
          <div className="row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!outcome || (noteRequired && !note.trim()) || resolve.isPending} data-testid="resolve-submit">
              {resolve.isPending ? 'Saving…' : 'Resolve the review'}
            </button>
          </div>
          <p className="small muted">The outcome is a staff decision recorded in the timeline, the report and the audit log; integrations receive it (without the note).</p>
        </form>
      )}
      {dialog ? <NoteDialog sessionId={sessionId} kind={dialog} onClose={() => setDialog(null)} onDone={invalidate} /> : null}
    </section>
  );
}

function NoteDialog({ sessionId, kind, onClose, onDone }: { sessionId: string; kind: 'escalate' | 'reopen'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => (kind === 'escalate' ? api.escalateReview(sessionId, note.trim()) : api.reopenReview(sessionId, note.trim())),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const ok = note.trim().length >= 5;
  return (
    <Modal
      title={kind === 'escalate' ? 'Escalate the review' : 'Reopen the review'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={m.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!ok || m.isPending} onClick={() => m.mutate()}>
            {kind === 'escalate' ? 'Escalate' : 'Reopen'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          {kind === 'escalate'
            ? 'An escalated review goes to the administrators’ queue and is resolved by an administrator. Say what needs a second look.'
            : 'The outcome is cleared (it stays in the audit log) and the review is back in the queue. Say why.'}
        </p>
        <label>
          Reason
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} data-testid="review-dialog-note" />
        </label>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ incidents */

function IncidentCard({ sessionId, incident, events, onOpenEvent, focus }: { sessionId: string; incident: Incident; events: EventDTO[]; onOpenEvent: (id: string) => void; focus: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus && ref.current) {
      ref.current.scrollIntoView({ block: 'center' });
      ref.current.focus();
    }
  }, [focus]);
  return (
    <li className={`incident card stack incident-${incident.category}${focus ? ' focused' : ''}`} ref={ref} tabIndex={-1} aria-label={`Incident at ${formatDateTime(incident.startedAt)}: ${incident.title}`} data-testid="incident">
      <div className="row">
        <CategoryBadge category={incident.category} />
        <SeverityBadge severity={incident.severity} />
        <span className="small">
          <Clock at={incident.startedAt} /> – <Clock at={incident.endedAt} />
          {incident.open ? <span className="badge badge-warning">Ongoing</span> : null}
        </span>
        {incident.undecided ? <span className="badge badge-warning">{incident.undecided} undecided</span> : <span className="badge badge-success">All decided</span>}
      </div>
      <div>
        <strong>{incident.title}</strong>
      </div>
      <ul className="incident-events">
        {events.map((e) => (
          <li key={e.id} className="row tight">
            <CategoryBadge category={e.category} />
            <button type="button" className="link-btn" aria-haspopup="dialog" onClick={() => onOpenEvent(e.id)}>
              {e.title}
            </button>
            <span className="small muted">
              <Clock at={e.startedAt} />
            </span>
            <ReviewBadge status={e.review.status} resolution={e.review.resolution} />
          </li>
        ))}
      </ul>
      {incident.undecided && incident.eventIds.length > 1 ? <DecideTogether sessionId={sessionId} incident={incident} events={events} /> : null}
    </li>
  );
}

function DecideTogether({ sessionId, incident, events }: { sessionId: string; incident: Incident; events: EventDTO[] }) {
  const invalidate = useReviewInvalidation(sessionId);
  const [resolution, setResolution] = useState<ReviewResolution | ''>('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.reviewEventsBulk({ eventIds: events.filter((e) => e.review.status === 'unreviewed').map((e) => e.id), resolution: resolution as ReviewResolution, note: note.trim() || undefined, incidentId: incident.id }),
    onSuccess: () => {
      setResolution('');
      setNote('');
      invalidate();
    },
  });
  return (
    <form
      className="row decide-together"
      onSubmit={(e) => {
        e.preventDefault();
        if (resolution) m.mutate();
      }}
    >
      <label className="inline small">
        Decide the undecided ones together
        <select value={resolution} onChange={(e) => setResolution(e.target.value as ReviewResolution)} data-testid="incident-resolution">
          <option value="">Choose a conclusion…</option>
          {incidentResolutions(incident).map((r) => (
            <option key={r} value={r}>
              {RESOLUTION_INFO[r].label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline small grow">
        Note
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What did you check?" />
      </label>
      <button type="submit" className="btn btn-sm btn-primary" disabled={!resolution || m.isPending} data-testid="incident-decide">
        {m.isPending ? 'Saving…' : 'Decide'}
      </button>
      <BulkOutcome result={m.data} error={m.error} />
    </form>
  );
}

function BulkOutcome({ result, error }: { result: BulkReviewResultDTO | undefined; error: unknown }) {
  if (error) return <div className="banner banner-danger small" role="alert">{errorMessage(error)}</div>;
  if (!result) return null;
  const others = result.skipped.filter((s) => s.reason === 'decided_by_someone_else').length;
  const notApplicable = result.skipped.filter((s) => s.reason === 'resolution_not_applicable').length;
  return (
    <div className="small" role="status">
      {result.updated.length} decided.
      {others ? ` ${others} left as decided by another reviewer (change those one at a time, with a reason).` : ''}
      {notApplicable ? ` ${notApplicable} kept: that conclusion does not apply to them.` : ''}
    </div>
  );
}

/* ------------------------------------------------------------------ bulk */

function BulkDecision({ sessionId, events }: { sessionId: string; events: EventDTO[] }) {
  const eligible = bulkEligible(events);
  const invalidate = useReviewInvalidation(sessionId);
  const [resolution, setResolution] = useState<ReviewResolution | ''>('');
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.reviewEventsBulk({ eventIds: eligible.map((e) => e.id), resolution: resolution as ReviewResolution, note: note.trim() || undefined }),
    onSuccess: () => {
      setResolution('');
      setNote('');
      invalidate();
    },
  });
  if (!eligible.length && !m.data) return null;
  return (
    <section className="card stack" aria-labelledby="bulk-title" data-testid="bulk-decision">
      <h2 id="bulk-title" className="h3">
        Technical and low-severity flags
      </h2>
      <p className="small muted">
        {eligible.length} undecided technical problem{eligible.length === 1 ? '' : 's'} or low-severity observation{eligible.length === 1 ? '' : 's'} can be decided together. Higher-severity flags are decided one at a time or as an incident.
      </p>
      {eligible.length ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (resolution) m.mutate();
          }}
        >
          <label className="inline small">
            Conclusion
            <select value={resolution} onChange={(e) => setResolution(e.target.value as ReviewResolution)} data-testid="bulk-resolution">
              <option value="">Choose…</option>
              {(['technical', 'no_concern', 'inconclusive', 'false_detection'] as const).map((r) => (
                <option key={r} value={r}>
                  {RESOLUTION_INFO[r].label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline small grow">
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="e.g. “Old laptop camera, intermittent.”" />
          </label>
          <button type="submit" className="btn btn-sm btn-primary" disabled={!resolution || m.isPending} data-testid="bulk-decide">
            Decide {eligible.length}
          </button>
        </form>
      ) : null}
      <BulkOutcome result={m.data} error={m.error} />
    </section>
  );
}
