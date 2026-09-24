import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EventDTO, IdentityCheckDTO } from '@sp/shared';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { filterTimeline, filtersActive, presentTypes, type EventFilterState } from '../../lib/filters';
import { formatPercent, formatSimilarity, formatTime } from '../../lib/format';
import { contextLabel, PERIOD_LABELS, qualityIssueLabel, TRIGGER_LABELS } from '../../lib/labels';
import { groupCounts, groupTimeline, type TimelineGroup } from '../../lib/timeline';
import { CategoryBadge, CategoryCounts, DecisionBadge, ReviewBadge, SeverityBadge } from '../../components/Badges';
import { EmptyState, ErrorState, KeyValueTable, Loading } from '../../components/Common';
import { EventFilterBar } from '../../components/EventFilterBar';
import { EvidenceImage } from '../../components/EvidenceImage';
import { Lightbox } from '../../components/Lightbox';
import { Clock, LiveDuration } from '../../components/Time';

export function TimelineTab({
  sessionId,
  filters,
  onFilters,
  onOpenEvent,
}: {
  sessionId: string;
  filters: EventFilterState;
  onFilters: (f: EventFilterState) => void;
  onOpenEvent: (id: string) => void;
}) {
  const q = useQuery({ queryKey: qk.timeline(sessionId), queryFn: () => api.sessionTimeline(sessionId), retry: shouldRetry });
  const items = q.data?.items;
  const events = useMemo(() => (items ?? []).filter((i) => i.kind === 'event').map((i) => (i as { event: EventDTO }).event), [items]);
  const types = useMemo(() => presentTypes(events), [events]);
  const filtered = useMemo(() => filterTimeline(items ?? [], filters), [items, filters]);
  const groups = useMemo(() => groupTimeline(filtered), [filtered]);
  const totalEntries = (items ?? []).filter((i) => i.kind !== 'period').length;
  const shownEntries = filtered.filter((i) => i.kind !== 'period').length;

  if (q.isPending) return <Loading label="Loading timeline…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  return (
    <div className="stack">
      <EventFilterBar filters={filters} onChange={onFilters} types={types} includeIdentityChecks shown={shownEntries} total={totalEntries} />
      <div className="timeline-legend small muted">
        <span className="legend-swatch observed" /> Observed period (monitoring running)
        <span className="legend-swatch unobserved" /> Unobserved period (paused, disconnected or on hold — no observations are made)
      </div>
      {groups.length === 0 ? (
        <EmptyState title="Nothing on the timeline yet">The timeline fills in once the candidate starts the readiness check.</EmptyState>
      ) : (
        <div className="timeline">
          {groups.map((g) => (
            <TimelineSection key={g.key} group={g} onOpenEvent={onOpenEvent} filtered={filtersActive(filters)} />
          ))}
        </div>
      )}
    </div>
  );
}

function sectionTitle(g: TimelineGroup): string {
  if (!g.period) {
    if (g.position === 'before') return 'Before the exam';
    if (g.position === 'after') return 'After the last period';
    return 'Between periods';
  }
  return PERIOD_LABELS[g.period.kind] ?? g.period.kind;
}

function TimelineSection({ group, onOpenEvent, filtered }: { group: TimelineGroup; onOpenEvent: (id: string) => void; filtered: boolean }) {
  const p = group.period;
  const observed = p ? p.observed : true;
  const counts = groupCounts(group.entries);
  const metaEntries = p ? Object.entries(p.meta ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '') : [];
  return (
    <section className={`tl-section ${p ? (observed ? 'observed' : 'unobserved') : 'outside'} tl-kind-${p?.kind ?? 'none'}`}>
      <header className="tl-band">
        <div className="tl-band-main">
          <span className="tl-band-title">
            {sectionTitle(group)}
            {p ? <span className="tl-band-obs">{observed ? ' — observed' : ' — unobserved'}</span> : null}
          </span>
          {p ? (
            <span className="tl-band-times">
              <Clock at={p.startedAt} /> – {p.endedAt ? <Clock at={p.endedAt} /> : <span className="ongoing-tag">now</span>} · <LiveDuration from={p.startedAt} to={p.endedAt} />
            </span>
          ) : null}
          {counts.integrity + counts.uncertain + counts.technical > 0 ? <CategoryCounts counts={counts} compact /> : null}
        </div>
        {p && !observed ? <div className="tl-band-note">Unobserved: no observations are made about this period.</div> : null}
        {p?.reason ? <div className="tl-band-reason small">Reason: {p.reason}</div> : null}
        {metaEntries.length ? (
          <div className="tl-band-meta small muted">
            <KeyValueTable data={Object.fromEntries(metaEntries)} />
          </div>
        ) : null}
      </header>
      {group.entries.length ? (
        <ol className="tl-items">
          {group.entries.map((e) =>
            e.kind === 'event' ? (
              <TimelineEventRow key={`e:${e.event.id}`} event={e.event} onOpen={() => onOpenEvent(e.event.id)} />
            ) : (
              <TimelineCheckRow key={`c:${e.check.id}`} check={e.check} />
            ),
          )}
        </ol>
      ) : (
        <div className="tl-empty small muted">{filtered ? 'No items match the filters in this period.' : observed ? 'No events in this period.' : ''}</div>
      )}
    </section>
  );
}

function TimelineEventRow({ event: e, onOpen }: { event: EventDTO; onOpen: () => void }) {
  const neutral = e.category === 'neutral';
  const shot = e.evidence.find((x) => x.kind === 'event_screenshot') ?? e.evidence[0];
  return (
    <li className={`tl-item tl-event tl-cat-${e.category}${neutral ? ' tl-neutral' : ''}`}>
      <button type="button" className="tl-row" onClick={onOpen}>
        <span className="tl-time">{formatTime(e.startedAt)}</span>
        <span className={`tl-marker cat-bg-${e.category}`} aria-hidden />
        <span className="tl-content">
          <span className="tl-title-row">
            {neutral ? null : <CategoryBadge category={e.category} />}
            <strong className="tl-title">{e.title}</strong>
            {!neutral && e.severity !== 'info' ? <SeverityBadge severity={e.severity} /> : null}
            {e.status === 'open' ? <span className="badge badge-warning">Ongoing</span> : null}
            {!neutral ? <ReviewBadge status={e.review.status} /> : null}
            {e.deliveredLate ? <span className="badge badge-technical">Delivered late</span> : null}
            {e.notesCount ? <span className="badge">{e.notesCount} note{e.notesCount > 1 ? 's' : ''}</span> : null}
          </span>
          {!neutral || e.observation !== e.title ? <span className="tl-obs">{e.observation}</span> : null}
          {!neutral ? (
            <span className="tl-meta small muted">
              {e.endedAt != null || e.status === 'open' ? (
                <>
                  Duration <LiveDuration from={e.startedAt} to={e.endedAt} />
                </>
              ) : null}
              {e.confidence != null ? <> · confidence {formatPercent(e.confidence)}</> : null}
              {e.evidence.length ? <> · {e.evidence.length} image{e.evidence.length > 1 ? 's' : ''}</> : null}
            </span>
          ) : null}
        </span>
        {shot && !neutral ? <EvidenceImage evidence={shot} size="thumb" alt="" /> : null}
      </button>
    </li>
  );
}

function TimelineCheckRow({ check: c }: { check: IdentityCheckDTO }) {
  const [open, setOpen] = useState(false);
  const issues = c.quality?.issues ?? [];
  const cat = c.decision === 'mismatch' ? 'integrity' : c.decision === 'match' ? 'neutral' : 'uncertain';
  return (
    <li className={`tl-item tl-check tl-cat-${cat}`}>
      <div className="tl-row static">
        <span className="tl-time">{formatTime(c.at)}</span>
        <span className="tl-marker tl-marker-check" aria-hidden />
        <span className="tl-content">
          <span className="tl-title-row">
            <span className="tl-kind">Identity check</span>
            <span className="muted">{TRIGGER_LABELS[c.trigger] ?? c.trigger}</span>
            <DecisionBadge decision={c.decision} />
            {c.similarity != null ? <span className="small muted">similarity {formatSimilarity(c.similarity)}</span> : null}
          </span>
          {issues.length ? <span className="small muted">Image quality: {issues.map(qualityIssueLabel).join(', ')}</span> : null}
          {c.context.precededBy.length ? <span className="small muted">After: {c.context.precededBy.map(contextLabel).join(' · ')}</span> : null}
        </span>
        {c.probeEvidence ? <EvidenceImage evidence={c.probeEvidence} size="thumb" alt="Identity sample" onOpen={() => setOpen(true)} /> : null}
      </div>
      {open && c.probeEvidence ? <Lightbox items={[{ evidence: c.probeEvidence, caption: `Identity sample (${TRIGGER_LABELS[c.trigger]})` }]} index={0} onClose={() => setOpen(false)} /> : null}
    </li>
  );
}
