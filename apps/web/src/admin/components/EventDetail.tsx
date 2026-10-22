import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORY_LABELS,
  EVENT_CATALOG,
  isFlagCategory,
  RESOLUTION_INFO,
  resolutionsFor,
  reviewDecisionLabel,
  type EventDetailDTO,
  type EventDTO,
  type EvidenceRefDTO,
  type NoteDTO,
  type ReviewDecisionDTO,
  type ReviewResolution,
  type SessionDetailDTO,
} from '@sp/shared';
import { useDialogFocus } from '../../lib/a11y';
import { api, errorMessage, shouldRetry } from '../api/client';
import { applyEvent, qk } from '../api/queries';
import { formatDateTime, formatPercent } from '../lib/format';
import { contextLabel, PERIOD_LABELS, reviewerGuidance, SOURCE_LABELS, TRIGGER_LABELS } from '../lib/labels';
import { mismatchEvidence } from '../lib/cameraTest';
import { useAuth } from '../auth';
import { CategoryBadge, ReviewBadge, SeverityBadge } from './Badges';
import { ExplanationPanel } from './Explanation';
import { ErrorState, KeyValueTable, Loading } from './Common';
import { evidenceAlt, EvidenceImage } from './EvidenceImage';
import { Lightbox, type LightboxItem } from './Lightbox';
import { Clock, LiveDuration, RelativeTime } from './Time';

export const COMPARABLE_TYPES = ['identity_mismatch', 'identity_unverifiable'];

/** Right-hand drawer with everything about one event. */
/** The event as listed (EventDTO) until its detail (explanation, history, incident) has loaded. */
type EventView = EventDTO & Partial<Pick<EventDetailDTO, 'explanation' | 'history' | 'incident'>>;

export function EventDrawer({ eventId, sessionId, initial, onClose, onOpenIncident }: { eventId: string; sessionId: string; initial?: EventDTO; onClose: () => void; onOpenIncident?: (incidentId: string) => void }) {
  const q = useQuery<EventView>({
    queryKey: qk.event(eventId),
    queryFn: () => api.event(eventId),
    placeholderData: initial,
    retry: shouldRetry,
  });
  // Focus moves into the drawer (its heading once loaded), stays there, Escape closes it (unless a
  // lightbox / dialog is open above it) and the focus returns to the row that opened it.
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, { onEscape: onClose, initialFocus: () => ref.current?.querySelector<HTMLElement>('.drawer-head button') });

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={q.data ? `Event details: ${q.data.title}` : 'Event details'} ref={ref}>
        <div className="drawer-head">
          <span className="muted small">Event details</span>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="drawer-body">
          {q.data ? (
            <EventDetailBody event={q.data} sessionId={sessionId} onOpenIncident={onOpenIncident} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <Loading />
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function EventDetailBody({ event, sessionId, onOpenIncident }: { event: EventView; sessionId: string; onOpenIncident?: (incidentId: string) => void }) {
  const catalog = EVENT_CATALOG[event.type];
  const canCompare = COMPARABLE_TYPES.includes(event.type);
  const guidance = reviewerGuidance(event);
  const flag = isFlagCategory(event.category);
  const incident = event.incident && event.incident.eventIds.length > 1 ? event.incident : null;
  return (
    <div className="stack event-detail">
      <div>
        <div className="row event-detail-badges">
          <CategoryBadge category={event.category} long />
          <SeverityBadge severity={event.severity} />
          {flag ? <ReviewBadge status={event.review.status} resolution={event.review.resolution} /> : null}
          {event.status === 'open' ? <span className="badge badge-warning">Ongoing</span> : null}
        </div>
        <h2 className="event-title">{event.title}</h2>
        <p className="event-observation">{event.observation}</p>
        {event.type === 'identity_unverifiable' ? (
          <div className="banner banner-info small">Could not verify is <strong>not</strong> evidence of a different person — the image was not clear enough to compare.</div>
        ) : null}
      </div>

      <KeyValueTable
        rows={[
          ['Started', <Clock key="s" at={event.startedAt} />],
          ['Ended', event.endedAt ? <Clock key="e" at={event.endedAt} /> : <span key="e" className="badge badge-warning">Ongoing</span>],
          ['Duration', catalog?.span === false ? <span key="d" className="muted">Instant</span> : <LiveDuration key="d" from={event.startedAt} to={event.endedAt} />],
          ['Confidence', event.confidence == null ? <span key="c" className="muted">n/a</span> : <ConfidenceBar key="c" value={event.confidence} />],
          ['Source', SOURCE_LABELS[event.source] ?? event.source],
          [
            'Received',
            <span key="r">
              {formatDateTime(event.receivedAt)}
              {event.deliveredLate ? (
                <span className="badge badge-technical late-badge" title="Buffered in the candidate’s browser during a connection problem and delivered later with its original timestamps.">
                  Delivered late
                </span>
              ) : null}
            </span>,
          ],
          ['Category', CATEGORY_LABELS[event.category]],
        ]}
      />

      {canCompare ? (
        <Link className="btn btn-primary" to={`/admin/sessions/${sessionId}/compare/${event.id}`}>
          Compare images
        </Link>
      ) : null}

      {event.explanation ? <ExplanationPanel explanation={event.explanation} /> : null}

      {incident ? (
        <div className="incident-note" data-testid="event-incident">
          <div>
            <strong>Part of an incident</strong> with {incident.eventIds.length - 1} other flag{incident.eventIds.length === 2 ? '' : 's'} close in time: {incident.title}.
            {incident.undecided ? <span className="muted"> {incident.undecided} not decided yet.</span> : null}
          </div>
          {onOpenIncident ? (
            <button type="button" className="btn btn-sm" onClick={() => onOpenIncident(incident.id)}>
              Review the incident together
            </button>
          ) : null}
        </div>
      ) : null}

      {guidance ? (
        <div className="guidance">
          <div className="guidance-title">Reviewer guidance</div>
          {guidance}
        </div>
      ) : null}

      <section>
        <h3>Screenshots</h3>
        <EvidenceGallery evidence={event.evidence} emptyText="No screenshots were captured for this event." context={event.title} />
        {flag && event.evidence.length && !canCompare ? <BaselineCompare sessionId={sessionId} event={event} /> : null}
      </section>

      {event.type === 'identity_mismatch' ? <MismatchEvidenceSection details={event.details} /> : null}

      <section>
        <h3>Details</h3>
        <KeyValueTable data={event.details} />
      </section>

      <section>
        <h3>Context</h3>
        <EventContext context={event.context} />
      </section>

      <section>
        <h3>Review</h3>
        {flag ? (
          <ReviewPanel event={event} />
        ) : (
          <p className="muted small">{event.category === 'exception' ? 'A policy exception' : 'A session change'} is context for reviewers; it needs no decision.</p>
        )}
        {event.history?.length ? <DecisionHistory history={event.history} /> : null}
      </section>

      <section>
        <h3>Notes {event.notesCount ? <span className="muted">({event.notesCount})</span> : null}</h3>
        <NotesThread eventId={event.id} sessionId={sessionId} />
      </section>
    </div>
  );
}

/** How the identity evidence accumulated (identity engine v2): one row per sample, LLR > 0 = evidence of a different person. */
function MismatchEvidenceSection({ details }: { details: Record<string, unknown> }) {
  const ev = mismatchEvidence(details);
  if (!ev) return null;
  return (
    <section data-testid="mismatch-evidence">
      <h3>How the evidence accumulated</h3>
      <p className="small muted">
        {ev.posterior != null ? <>Probability of a different person: <strong>{formatPercent(ev.posterior)}</strong>. </> : null}
        {ev.llrSum != null ? <>Accumulated log-likelihood ratio {ev.llrSum.toFixed(2)} (positive = evidence of a different person). </> : null}
        Each identity sample is a short burst of camera frames compared with the protected reference.
      </p>
      <table className="events-table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Why sampled</th>
            <th scope="col">Similarity</th>
            <th scope="col">LLR</th>
          </tr>
        </thead>
        <tbody>
          {ev.samples.map((x, i) => (
            <tr key={i}>
              <td>{x.at != null ? <Clock at={x.at} /> : '—'}</td>
              <td>{x.trigger ? (TRIGGER_LABELS as Record<string, string>)[x.trigger] ?? x.trigger : '—'}</td>
              <td>{x.similarity != null ? x.similarity.toFixed(2) : '—'}</td>
              <td>{x.llr != null ? (x.llr >= 0 ? '+' : '') + x.llr.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="confidence">
      <span className="confidence-track" aria-hidden>
        <span className="confidence-fill" style={{ width: `${pct}%` }} />
      </span>
      {formatPercent(value)}
    </span>
  );
}

export function EventContext({ context }: { context: Record<string, unknown> }) {
  const precededBy = Array.isArray(context.precededBy) ? (context.precededBy as unknown[]).map(String) : [];
  const rest = Object.fromEntries(
    Object.entries(context)
      .filter(([k]) => k !== 'precededBy')
      .map(([k, v]) => {
        if (k === 'trigger' && typeof v === 'string') return [k, (TRIGGER_LABELS as Record<string, string>)[v] ?? v];
        if (k === 'periodKind' && typeof v === 'string') return ['during', (PERIOD_LABELS as Record<string, string>)[v] ?? v];
        return [k, v];
      }),
  );
  if (precededBy.length === 0 && Object.keys(rest).length === 0) return <div className="muted small">No surrounding context recorded.</div>;
  return (
    <div className="stack">
      {precededBy.length ? (
        <div>
          <div className="muted small">Shortly before this:</div>
          <div className="row context-chips">
            {precededBy.map((p) => (
              <span key={p} className="chip static">
                {contextLabel(p)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {Object.keys(rest).length ? <KeyValueTable data={rest} /> : null}
    </div>
  );
}

export function EvidenceGallery({
  evidence,
  emptyText,
  captions,
  context,
}: {
  evidence: EvidenceRefDTO[];
  emptyText: string;
  captions?: string[];
  /** What the images belong to (e.g. the event title), used in their text alternatives. */
  context?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!evidence.length) return <div className="muted small">{emptyText}</div>;
  const items: LightboxItem[] = evidence.map((e, i) => ({ evidence: e, caption: captions?.[i] ?? context, alt: evidenceAlt(e, context ?? captions?.[i]) }));
  return (
    <>
      <div className="gallery">
        {evidence.map((e, i) => (
          <EvidenceImage key={e.id} evidence={e} size="medium" onOpen={() => setOpen(i)} caption context={context ?? captions?.[i]} />
        ))}
      </div>
      {open != null ? <Lightbox items={items} index={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** The reviewer's conclusion (structured resolution), with the reason required to change someone else's decision. */
export function ReviewPanel({ event }: { event: EventView }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const formId = useId();
  const [resolution, setResolution] = useState<ReviewResolution | null>(null);
  const [note, setNote] = useState('');
  const r = event.review;
  const decidedByOther = r.status !== 'unreviewed' && r.by != null && r.by !== user.id;
  const onSuccess = (ev: EventDetailDTO) => {
    qc.setQueryData(qk.event(ev.id), ev);
    applyEvent(qc, ev);
    setNote('');
    setResolution(null);
    void qc.invalidateQueries({ queryKey: qk.session(ev.sessionId), exact: true });
    void qc.invalidateQueries({ queryKey: qk.eventNotes(ev.id) });
    void qc.invalidateQueries({ queryKey: qk.report(ev.sessionId) });
    void qc.invalidateQueries({ queryKey: qk.reviewQueueAll });
  };
  const decide = useMutation({ mutationFn: () => api.reviewEvent(event.id, { resolution: resolution!, note: note.trim() || undefined }), onSuccess });
  const reset = useMutation({ mutationFn: () => api.reviewEvent(event.id, { status: 'unreviewed', note: note.trim() || undefined }), onSuccess });
  const options = resolutionsFor(event.category);
  const changes = resolution != null && !(r.status === RESOLUTION_INFO[resolution].status && r.resolution === resolution);
  const reasonNeeded = decidedByOther;
  const busy = decide.isPending || reset.isPending;
  const error = decide.error ?? reset.error;
  return (
    <div className="stack review-panel" data-testid="review-panel">
      <div className="row">
        <ReviewBadge status={r.status} resolution={r.resolution} />
        {r.status !== 'unreviewed' && r.at ? (
          <span className="muted small">
            by {r.byName ?? 'staff'} · <RelativeTime at={r.at} />
          </span>
        ) : null}
      </div>
      {r.note ? <blockquote className="review-note">{r.note}</blockquote> : null}
      <form
        className="stack"
        aria-labelledby={`${formId}-legend`}
        onSubmit={(e) => {
          e.preventDefault();
          if (resolution && changes && (!reasonNeeded || note.trim())) decide.mutate();
        }}
      >
        <fieldset className="resolution-options">
          <legend id={`${formId}-legend`}>{r.status === 'unreviewed' ? 'Your conclusion' : 'Change the decision'}</legend>
          {options.map((o) => (
            <label key={o} className={`resolution-option${resolution === o ? ' selected' : ''}`}>
              <input type="radio" name={`${formId}-resolution`} value={o} checked={resolution === o} onChange={() => setResolution(o)} data-testid={`resolution-${o}`} />
              <span>
                <strong>{RESOLUTION_INFO[o].label}</strong>
                <span className="muted small"> — {RESOLUTION_INFO[o].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          {reasonNeeded ? `Reason for changing ${r.byName ?? 'another reviewer'}’s decision (required)` : 'Note (optional)'}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={2}
            required={reasonNeeded}
            placeholder="What did you check? e.g. “Second face is a photo on the wall.”"
            data-testid="review-note"
          />
        </label>
        <div className="row">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !resolution || !changes || (reasonNeeded && !note.trim())} data-testid="record-decision">
            {decide.isPending ? 'Saving…' : 'Record decision'}
          </button>
          {r.status !== 'unreviewed' ? (
            <button type="button" className="btn btn-sm" disabled={busy || (reasonNeeded && !note.trim())} onClick={() => reset.mutate()}>
              Reset to not reviewed
            </button>
          ) : null}
        </div>
      </form>
      <div className="muted small">A conclusion about one observation, not about the candidate. The final outcome of the exam is recorded on the session’s Review tab.</div>
      {error ? (
        <div className="banner banner-danger" role="alert">
          {errorMessage(error)}
        </div>
      ) : null}
    </div>
  );
}

/** Every decision on the event, oldest first: who, what, why, and whether it changed someone else's decision. */
export function DecisionHistory({ history }: { history: ReviewDecisionDTO[] }) {
  return (
    <details className="decision-history" data-testid="decision-history" open={history.some((h) => h.overrides)}>
      <summary>
        Decision history ({history.length}){history.some((h) => h.overrides) ? <span className="badge badge-warning">Reviewers disagreed</span> : null}
      </summary>
      <ol className="stack">
        {history.map((h) => (
          <li key={h.id} className="small">
            <strong>{reviewDecisionLabel(h.status, h.resolution)}</strong> — {h.reviewerName ?? 'Staff'}, {formatDateTime(h.at)}
            {h.overrides ? <span className="badge badge-warning">Changed another reviewer’s decision</span> : null}
            {h.bulk ? <span className="badge">Decided together</span> : null}
            {h.note ? <div className="review-note">{h.note}</div> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * One-click comparison with how the candidate normally looked: the identity reference taken at check-in next to this
 * event's first screenshot.
 */
function BaselineCompare({ sessionId, event }: { sessionId: string; event: EventView }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const session = qc.getQueryData<SessionDetailDTO>(qk.session(sessionId));
  const ref = session?.references.find((r) => r.images.length) ?? null;
  if (!ref) return null;
  return (
    <div className="stack">
      <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="baseline-compare">
        {open ? 'Hide the comparison' : 'Compare with the start of the exam'}
      </button>
      {open ? (
        <div className="baseline-compare">
          <div className="baseline-side">
            <EvidenceImage evidence={ref.images[0]} size="medium" context="Check-in reference" />
            <div className="small muted">At check-in ({formatDateTime(ref.createdAt)})</div>
          </div>
          <div className="baseline-side">
            <EvidenceImage evidence={event.evidence[0]} size="medium" context={event.title} />
            <div className="small muted">This event ({formatDateTime(event.evidence[0].capturedAt)})</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function NotesThread({ eventId, sessionId }: { eventId: string; sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.eventNotes(eventId), queryFn: () => api.eventNotes(eventId), retry: shouldRetry });
  const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: () => api.addEventNote(eventId, text.trim()),
    onSuccess: (note) => {
      qc.setQueryData<{ items: NoteDTO[] }>(qk.eventNotes(eventId), (old) => ({ items: [...(old?.items ?? []), note] }));
      qc.setQueryData<EventDTO>(qk.event(eventId), (old) => (old ? { ...old, notesCount: old.notesCount + 1 } : old));
      setText('');
      void qc.invalidateQueries({ queryKey: qk.session(sessionId), exact: true });
    },
  });
  return (
    <div className="stack">
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <NoteList notes={q.data.items} empty="No notes yet." />}
      <form
        className="stack note-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) m.mutate();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a note for other reviewers…"
          aria-label="Add a note for other reviewers"
          maxLength={5000}
          rows={2}
        />
        <div className="row">
          <button type="submit" className="btn btn-sm" disabled={!text.trim() || m.isPending}>
            {m.isPending ? 'Adding…' : 'Add note'}
          </button>
          {m.isError ? (
            <span className="text-danger small" role="alert">
              {errorMessage(m.error)}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}

export function NoteList({ notes, empty, showEventLink }: { notes: NoteDTO[]; empty: string; showEventLink?: (eventId: string) => React.ReactNode }) {
  if (!notes.length) return <div className="muted small">{empty}</div>;
  return (
    <ul className="notes">
      {[...notes]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((n) => (
          <li key={n.id} className="note">
            <div className="note-meta">
              <strong>{n.authorName}</strong> · <span title={formatDateTime(n.createdAt)}>{formatDateTime(n.createdAt)}</span>
              {n.eventId && showEventLink ? <> · {showEventLink(n.eventId)}</> : null}
            </div>
            <div className="note-text">{n.text}</div>
          </li>
        ))}
    </ul>
  );
}
