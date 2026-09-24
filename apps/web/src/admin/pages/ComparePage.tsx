import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { EVENT_CATALOG, type IdentityComparisonDTO, type TimelineItemDTO } from '@sp/shared';
import { api, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { offsetLabel, precedingFacts, scalePosition } from '../lib/compare';
import { formatDateTime, formatPercent, formatSimilarity, formatTime } from '../lib/format';
import { DECISION_LABELS, PERIOD_LABELS, qualityIssueLabel, SWAP_CONTEXT_TYPES, TRIGGER_LABELS } from '../lib/labels';
import { CategoryBadge, DecisionBadge, SeverityBadge } from '../components/Badges';
import { ErrorState, Loading } from '../components/Common';
import { EventContext, NotesThread, ReviewPanel } from '../components/EventDetail';
import { EvidenceImage } from '../components/EvidenceImage';
import { Lightbox, type LightboxItem } from '../components/Lightbox';
import { LiveDuration } from '../components/Time';

export function ComparePage() {
  const { id = '', eventId = '' } = useParams();
  const cmp = useQuery({ queryKey: qk.compare(eventId), queryFn: () => api.compare(eventId), retry: shouldRetry });
  const ev = useQuery({ queryKey: qk.event(eventId), queryFn: () => api.event(eventId), retry: shouldRetry });
  const session = useQuery({ queryKey: qk.session(id), queryFn: () => api.session(id), retry: shouldRetry });

  if (cmp.isPending || ev.isPending) return <Loading label="Loading comparison…" />;
  if (cmp.isError) return <ErrorState error={cmp.error} onRetry={() => void cmp.refetch()} />;
  if (ev.isError) return <ErrorState error={ev.error} onRetry={() => void ev.refetch()} />;
  const c = cmp.data;
  const e = ev.data;
  const candidateName = session.data?.summary.candidate.name;

  return (
    <div className="stack compare-page">
      <div className="page-back no-print">
        <Link to={`/admin/sessions/${id}?event=${encodeURIComponent(eventId)}`}>← Back to session</Link>
      </div>
      <div className="card">
        <div className="row">
          <CategoryBadge category={e.category} long />
          <SeverityBadge severity={e.severity} />
          {e.status === 'open' ? <span className="badge badge-warning">Ongoing</span> : null}
        </div>
        <h1 className="compare-title">
          Identity comparison — {e.title}
          {candidateName ? <span className="muted"> · {candidateName}</span> : null}
        </h1>
        <p>{e.observation}</p>
        <div className="small muted">
          Started {formatDateTime(e.startedAt)} · duration <LiveDuration from={e.startedAt} to={e.endedAt} />
          {e.confidence != null ? <> · confidence {formatPercent(e.confidence)}</> : null}
        </div>
      </div>

      <ReviewerGuidance type={e.type} />

      <div className="compare-grid">
        <ReferenceColumn c={c} />
        <ProbesColumn c={c} />
      </div>

      <SimilarityScale c={c} />

      <div className="grid-2">
        <SurroundingTimeline items={c.surrounding} eventStart={e.startedAt} eventId={e.id} />
        <div className="stack">
          <EnvironmentNotes notes={c.environmentNotes} />
          <div className="card">
            <h3>Recorded context</h3>
            <EventContext context={e.context} />
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Review</h3>
          <ReviewPanel event={e} />
        </div>
        <div className="card">
          <h3>Notes</h3>
          <NotesThread eventId={e.id} sessionId={id} />
        </div>
      </div>
    </div>
  );
}

function ReviewerGuidance({ type }: { type: string }) {
  return (
    <div className="guidance">
      <div className="guidance-title">How to review a possible person swap</div>
      <ol className="guidance-list">
        <li>Compare stable facial features in the reference and later images: face shape, eyes, eyebrows, nose, mouth, ears, hairline.</li>
        <li>
          Changes in <strong>clothing, hairstyle, glasses, background, camera angle or lighting are not evidence</strong> of a different person. They are shown below as
          context only.
        </li>
        <li>
          Images marked <strong>“Could not verify (image quality)”</strong> were not clear enough to compare. They are <strong>not</strong> evidence of a different person.
        </li>
        <li>Check the surrounding timeline: a swap is more plausible right after a pause, the face leaving the view, or a camera interruption — but none of these prove it.</li>
        <li>If you cannot reach a dependable conclusion, add a note and escalate (e.g. verify by video call) rather than dismissing or confirming.</li>
      </ol>
      {type === 'identity_unverifiable' ? (
        <div className="banner banner-info small">
          This event means the system <strong>could not verify</strong> identity — typically due to lighting, distance, blur or face angle. It is not a mismatch.
        </div>
      ) : null}
      {EVENT_CATALOG[type as keyof typeof EVENT_CATALOG]?.reviewerNote ? (
        <div className="small muted">Note: {EVENT_CATALOG[type as keyof typeof EVENT_CATALOG].reviewerNote}</div>
      ) : null}
    </div>
  );
}

function ReferenceColumn({ c }: { c: IdentityComparisonDTO }) {
  const [open, setOpen] = useState<number | null>(null);
  const items: LightboxItem[] = c.reference.images.map((img) => ({ evidence: img, caption: `Reference (${c.reference.purpose}) — captured ${formatDateTime(img.capturedAt)}` }));
  return (
    <section className="card compare-col">
      <h2>Original reference</h2>
      <div className="small muted">
        Established {formatDateTime(c.reference.createdAt)} · {c.reference.purpose}
      </div>
      {c.reference.images.length === 0 ? (
        <div className="muted">No reference images available.</div>
      ) : (
        <div className="compare-images">
          {c.reference.images.map((img, i) => (
            <figure key={img.id} className="compare-figure">
              <EvidenceImage evidence={img} size="large" onOpen={() => setOpen(i)} />
              <figcaption className="small">
                <strong>Reference</strong> · {formatDateTime(img.capturedAt)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {open != null ? <Lightbox items={items} index={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function ProbesColumn({ c }: { c: IdentityComparisonDTO }) {
  const [open, setOpen] = useState<number | null>(null);
  const probes = [...c.probes].sort((a, b) => a.check.at - b.check.at);
  const withImg = probes.filter((p) => p.image);
  const items: LightboxItem[] = withImg.map((p) => ({
    evidence: p.image!,
    caption: `${TRIGGER_LABELS[p.check.trigger]} — ${DECISION_LABELS[p.check.decision]}${p.check.similarity != null ? `, similarity ${formatSimilarity(p.check.similarity)}` : ''}`,
  }));
  return (
    <section className="card compare-col">
      <h2>Later images</h2>
      <div className="small muted">Identity samples taken after the reference, compared against it.</div>
      {probes.length === 0 ? (
        <div className="muted">No later samples are linked to this event.</div>
      ) : (
        <div className="compare-images">
          {probes.map((p) => (
            <figure key={p.check.id} className={`compare-figure probe-${p.check.decision}`}>
              <EvidenceImage evidence={p.image} size="large" onOpen={p.image ? () => setOpen(withImg.indexOf(p)) : undefined} />
              <figcaption className="small stack-tight">
                <div>
                  <strong>{formatTime(p.check.at)}</strong> · {TRIGGER_LABELS[p.check.trigger] ?? p.check.trigger}
                </div>
                <div>
                  <DecisionBadge decision={p.check.decision} /> {p.check.similarity != null ? <span>similarity {formatSimilarity(p.check.similarity)}</span> : null}
                </div>
                {p.check.quality?.issues.length ? <div className="muted">Quality: {p.check.quality.issues.map(qualityIssueLabel).join(', ')}</div> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {open != null ? <Lightbox items={items} index={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function SimilarityScale({ c }: { c: IdentityComparisonDTO }) {
  const { match, mismatch } = c.similarity.thresholds;
  const points = c.probes.filter((p) => p.check.similarity != null);
  return (
    <section className="card">
      <h3>Similarity to the reference</h3>
      <div className="sim-scale" aria-label="Similarity scale">
        <div className="sim-zone zone-mismatch" style={{ left: 0, width: `${scalePosition(mismatch)}%` }}>
          <span>Possible different person</span>
        </div>
        <div className="sim-zone zone-inconclusive" style={{ left: `${scalePosition(mismatch)}%`, width: `${scalePosition(match) - scalePosition(mismatch)}%` }}>
          <span>Inconclusive</span>
        </div>
        <div className="sim-zone zone-match" style={{ left: `${scalePosition(match)}%`, width: `${100 - scalePosition(match)}%` }}>
          <span>Same person</span>
        </div>
        <div className="sim-threshold" style={{ left: `${scalePosition(mismatch)}%` }} title={`Mismatch threshold ${formatSimilarity(mismatch)}`}>
          <span>{formatSimilarity(mismatch)}</span>
        </div>
        <div className="sim-threshold" style={{ left: `${scalePosition(match)}%` }} title={`Match threshold ${formatSimilarity(match)}`}>
          <span>{formatSimilarity(match)}</span>
        </div>
        {points.map((p) => (
          <div
            key={p.check.id}
            className={`sim-point point-${p.check.decision}`}
            style={{ left: `${scalePosition(p.check.similarity!)}%` }}
            title={`${formatTime(p.check.at)} — ${DECISION_LABELS[p.check.decision]} (${formatSimilarity(p.check.similarity)})`}
          />
        ))}
      </div>
      <div className="sim-axis small muted">
        <span>0.00</span>
        <span>1.00</span>
      </div>
      <div className="small">
        {c.similarity.min != null ? (
          <>
            Range of later samples: <strong>{formatSimilarity(c.similarity.min)}</strong> – <strong>{formatSimilarity(c.similarity.max)}</strong>.{' '}
          </>
        ) : (
          'No similarity could be computed for the later samples (image quality). '
        )}
        <span className="muted">
          Cosine similarity of face templates. ≥ {formatSimilarity(match)} is treated as the same person; below {formatSimilarity(mismatch)} (with a usable image) as possibly a
          different person; in between is inconclusive. Images that fail the quality check get no score and are “could not verify”.
        </span>
      </div>
    </section>
  );
}

function SurroundingTimeline({ items, eventStart, eventId }: { items: TimelineItemDTO[]; eventStart: number; eventId: string }) {
  const sorted = useMemo(() => [...items].sort((a, b) => a.at - b.at), [items]);
  const facts = useMemo(() => precedingFacts(items, eventStart), [items, eventStart]);
  return (
    <section className="card">
      <h3>What happened around this time</h3>
      <ul className="facts-list">
        {facts.map((f) => (
          <li key={f.key} className={f.item ? 'yes' : 'no'}>
            <span className="fact-q">{f.question}</span>{' '}
            {f.item ? (
              <strong>
                Yes — {offsetLabel(f.item.at, eventStart)} before ({formatTime(f.item.at)})
              </strong>
            ) : (
              <span className="muted">Not in the ±10 minute window</span>
            )}
          </li>
        ))}
      </ul>
      <ol className="surrounding">
        {sorted.map((it, i) => {
          const isThis = it.kind === 'event' && it.event.id === eventId;
          const relevant =
            (it.kind === 'event' && SWAP_CONTEXT_TYPES.includes(it.event.type)) ||
            (it.kind === 'period' && !it.period.observed) ||
            (it.kind === 'identity_check' && it.check.decision !== 'match');
          return (
            <li key={i} className={`sur-item${isThis ? ' this' : ''}${relevant ? ' relevant' : ''}${it.kind === 'period' && !it.period.observed ? ' unobserved' : ''}`}>
              <span className="sur-offset mono">{offsetLabel(it.at, eventStart)}</span>
              <span className="sur-time muted small">{formatTime(it.at)}</span>
              <span className="sur-body">
                {it.kind === 'period' ? (
                  <>
                    <strong>{PERIOD_LABELS[it.period.kind]}</strong> period {it.period.observed ? '(observed)' : '(unobserved — no observations made)'}
                    {it.period.endedAt ? <span className="muted"> until {formatTime(it.period.endedAt)}</span> : null}
                  </>
                ) : it.kind === 'event' ? (
                  <>
                    <span className={`cat-dot cat-dot-${it.event.category}`} aria-hidden /> <strong>{it.event.title}</strong>
                    {isThis ? <span className="badge badge-info">this event</span> : null}
                    {it.event.durationMs != null ? <span className="muted"> · {Math.round(it.event.durationMs / 1000)} s</span> : null}
                  </>
                ) : (
                  <>
                    Identity check ({TRIGGER_LABELS[it.check.trigger]}) — <DecisionBadge decision={it.check.decision} />
                    {it.check.similarity != null ? <span className="muted"> {formatSimilarity(it.check.similarity)}</span> : null}
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EnvironmentNotes({ notes }: { notes: string[] }) {
  return (
    <section className="card env-notes">
      <h3>Environment differences</h3>
      <div className="context-only-label">Context only — not evidence of a different person</div>
      {notes.length ? (
        <ul>
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : (
        <div className="muted small">No environment differences were recorded.</div>
      )}
    </section>
  );
}
