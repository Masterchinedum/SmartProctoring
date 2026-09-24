import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CATEGORY_LABELS, EVENT_CATALOG, type EventDTO, type EvidenceRefDTO, type NoteDTO, type ReviewStatus } from '@sp/shared';
import { useDialogFocus } from '../../lib/a11y';
import { api, errorMessage, shouldRetry } from '../api/client';
import { applyEvent, qk } from '../api/queries';
import { formatDateTime, formatPercent } from '../lib/format';
import { contextLabel, PERIOD_LABELS, SOURCE_LABELS, TRIGGER_LABELS } from '../lib/labels';
import { CategoryBadge, ReviewBadge, SeverityBadge } from './Badges';
import { ErrorState, KeyValueTable, Loading } from './Common';
import { evidenceAlt, EvidenceImage } from './EvidenceImage';
import { Lightbox, type LightboxItem } from './Lightbox';
import { Clock, LiveDuration, RelativeTime } from './Time';

export const COMPARABLE_TYPES = ['identity_mismatch', 'identity_unverifiable'];

/** Right-hand drawer with everything about one event. */
export function EventDrawer({ eventId, sessionId, initial, onClose }: { eventId: string; sessionId: string; initial?: EventDTO; onClose: () => void }) {
  const q = useQuery({
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
            <EventDetailBody event={q.data} sessionId={sessionId} />
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

export function EventDetailBody({ event, sessionId }: { event: EventDTO; sessionId: string }) {
  const catalog = EVENT_CATALOG[event.type];
  const canCompare = COMPARABLE_TYPES.includes(event.type);
  return (
    <div className="stack event-detail">
      <div>
        <div className="row event-detail-badges">
          <CategoryBadge category={event.category} long />
          <SeverityBadge severity={event.severity} />
          <ReviewBadge status={event.review.status} />
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

      {catalog?.reviewerNote ? (
        <div className="guidance">
          <div className="guidance-title">Reviewer guidance</div>
          {catalog.reviewerNote}
        </div>
      ) : null}

      <section>
        <h3>Screenshots</h3>
        <EvidenceGallery evidence={event.evidence} emptyText="No screenshots were captured for this event." context={event.title} />
      </section>

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
        <ReviewPanel event={event} />
      </section>

      <section>
        <h3>Notes {event.notesCount ? <span className="muted">({event.notesCount})</span> : null}</h3>
        <NotesThread eventId={event.id} sessionId={sessionId} />
      </section>
    </div>
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

const REVIEW_ACTIONS: { status: ReviewStatus; label: string; cls: string }[] = [
  { status: 'reviewed', label: 'Mark reviewed', cls: 'btn btn-primary' },
  { status: 'dismissed', label: 'Dismiss as false positive', cls: 'btn' },
  { status: 'unreviewed', label: 'Reset to unreviewed', cls: 'btn' },
];

export function ReviewPanel({ event }: { event: EventDTO }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: (status: ReviewStatus) => api.reviewEvent(event.id, status, note.trim() || undefined),
    onSuccess: (ev) => {
      qc.setQueryData(qk.event(ev.id), ev);
      applyEvent(qc, ev);
      setNote('');
      void qc.invalidateQueries({ queryKey: qk.session(ev.sessionId), exact: true });
      void qc.invalidateQueries({ queryKey: qk.eventNotes(ev.id) });
      void qc.invalidateQueries({ queryKey: qk.report(ev.sessionId) });
    },
  });
  const r = event.review;
  return (
    <div className="stack review-panel">
      <div className="row">
        <ReviewBadge status={r.status} />
        {r.status !== 'unreviewed' && r.at ? (
          <span className="muted small">
            by {r.byName ?? 'staff'} · <RelativeTime at={r.at} />
          </span>
        ) : null}
      </div>
      {r.note ? <blockquote className="review-note">{r.note}</blockquote> : null}
      <label>
        Review note (optional)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="What did you check? e.g. “Second face is a photo on the wall.”"
        />
      </label>
      <div className="row">
        {REVIEW_ACTIONS.filter((a) => a.status !== r.status).map((a) => (
          <button key={a.status} type="button" className={`${a.cls} btn-sm`} disabled={m.isPending} onClick={() => m.mutate(a.status)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="muted small">
        <strong>Reviewed</strong>: you checked the evidence and the observation stands. <strong>Dismissed</strong>: a false positive (e.g. a poster detected as a
        face). Neither is a finding of misconduct.
      </div>
      {m.isError ? (
        <div className="banner banner-danger" role="alert">
          {errorMessage(m.error)}
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
