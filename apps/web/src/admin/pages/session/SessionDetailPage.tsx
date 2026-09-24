import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventDTO, SessionDetailDTO, TimelineItemDTO } from '@sp/shared';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { DEFAULT_FILTERS, type EventFilterState } from '../../lib/filters';
import { formatDateTime, formatSimilarity } from '../../lib/format';
import { END_REASON_LABELS, HOLD_REASON_LABELS } from '../../lib/labels';
import { ConnectionBadge, DecisionBadge, StatusBadge } from '../../components/Badges';
import { ErrorState, Loading } from '../../components/Common';
import { EventDrawer } from '../../components/EventDetail';
import { Clock, Countdown, RelativeTime, ReportingInterrupted } from '../../components/Time';
import { MonitoringLine } from '../DashboardPage';
import { PauseDecisionBanner, SessionActions } from './SessionActions';
import { TimelineTab } from './TimelineTab';
import { EventsTab } from './EventsTab';
import { IdentityTab } from './IdentityTab';
import { DevicesTab, NotesTab, PeriodsTab } from './MiscTabs';

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
  { id: 'identity', label: 'Identity' },
  { id: 'periods', label: 'Periods' },
  { id: 'devices', label: 'Devices' },
  { id: 'notes', label: 'Notes' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function SessionDetailPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'timeline') as TabId;
  const openEventId = params.get('event');
  const qc = useQueryClient();
  const [filters, setFilters] = useState<EventFilterState>(DEFAULT_FILTERS);

  const detail = useQuery({ queryKey: qk.session(id), queryFn: () => api.session(id), retry: shouldRetry, refetchInterval: 60_000 });

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: key === 'tab' },
      );
    },
    [setParams],
  );
  const openEvent = useCallback((eventId: string) => setParam('event', eventId), [setParam]);
  const closeEvent = useCallback(() => setParam('event', null), [setParam]);

  if (detail.isPending) return <Loading label="Loading session…" />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const d = detail.data;

  // Seed the drawer from whatever list already holds the event.
  const initialEvent = openEventId ? findCachedEvent(qc.getQueryData(qk.timeline(id)), qc.getQueryData(qk.sessionEvents(id)), openEventId) : undefined;
  const notesCount = d.notes.length;
  const tabCount: Partial<Record<TabId, number>> = {
    identity: d.identityChecks.length,
    periods: d.periods.length,
    devices: d.devices.length,
    notes: notesCount,
  };

  return (
    <div className="stack session-detail">
      <SessionHeader d={d} receivedAt={detail.dataUpdatedAt} />
      <PauseDecisionBanner d={d} />
      <SessionActions d={d} />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setParam('tab', t.id)}>
            {t.label}
            {tabCount[t.id] ? <span className="tab-count">{tabCount[t.id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="tab-panel">
        {tab === 'timeline' ? <TimelineTab sessionId={id} filters={filters} onFilters={setFilters} onOpenEvent={openEvent} /> : null}
        {tab === 'events' ? <EventsTab sessionId={id} filters={filters} onFilters={setFilters} onOpenEvent={openEvent} /> : null}
        {tab === 'identity' ? <IdentityTab d={d} onOpenEvent={openEvent} /> : null}
        {tab === 'periods' ? <PeriodsTab d={d} /> : null}
        {tab === 'devices' ? <DevicesTab d={d} /> : null}
        {tab === 'notes' ? <NotesTab d={d} onOpenEvent={openEvent} /> : null}
      </div>
      {openEventId ? <EventDrawer key={openEventId} eventId={openEventId} sessionId={id} initial={initialEvent} onClose={closeEvent} /> : null}
    </div>
  );
}

function findCachedEvent(timeline: { items: TimelineItemDTO[] } | undefined, events: { items: EventDTO[] } | undefined, eventId: string): EventDTO | undefined {
  const fromList = events?.items.find((e) => e.id === eventId);
  if (fromList) return fromList;
  for (const it of timeline?.items ?? []) if (it.kind === 'event' && it.event.id === eventId) return it.event;
  return undefined;
}

function SessionHeader({ d, receivedAt }: { d: SessionDetailDTO; receivedAt: number }) {
  const s = d.summary;
  const terminal = s.status === 'submitted' || s.status === 'terminated';
  const legalHold = s.legalHold;
  return (
    <div className="card session-header">
      <div className="sh-top">
        <div>
          <div className="page-back">
            <Link to="/admin/sessions">← Sessions</Link>
          </div>
          <h1>{s.candidate.name}</h1>
          <div className="muted">
            <Link to={`/admin/exams/${s.exam.id}`}>{s.exam.title}</Link>
            {s.candidate.email ? <> · {s.candidate.email}</> : null}
            {s.candidate.externalId ? <> · ID {s.candidate.externalId}</> : null} ·{' '}
            <Link to={`/admin/candidates/${s.candidate.id}`}>Candidate profile</Link>
          </div>
        </div>
        <div className="sh-badges">
          <StatusBadge status={s.status} />
          {!terminal ? <ConnectionBadge connection={s.connection} /> : null}
          {s.endReason ? <span className="badge">{END_REASON_LABELS[s.endReason]}</span> : null}
          {legalHold ? <span className="badge badge-info" title="Evidence is not purged while legal hold is on">Legal hold</span> : null}
        </div>
      </div>
      {s.reportingInterruptedSince ? <ReportingInterrupted since={s.reportingInterruptedSince} /> : null}
      {s.hold ? (
        s.hold.canReverify ? (
          <div className="banner banner-warning">
            <strong>Waiting for the candidate to re-verify.</strong> The exam stays on hold until the candidate passes a fresh camera and identity check (original hold:{' '}
            {HOLD_REASON_LABELS[s.hold.reason] ?? s.hold.reason}, since {formatDateTime(s.hold.since)}).
            {s.hold.message ? <div className="small">Message shown to the candidate: “{s.hold.message}”</div> : null}
          </div>
        ) : (
          <div className="banner banner-danger">
            <strong>On hold:</strong> {HOLD_REASON_LABELS[s.hold.reason] ?? s.hold.reason} — since {formatDateTime(s.hold.since)} (<RelativeTime at={s.hold.since} />).
            {s.hold.message ? <div className="small">Message shown to the candidate: “{s.hold.message}”</div> : null}
          </div>
        )
      ) : null}
      <div className="facts">
        <Fact label="Time remaining">
          {terminal ? <span className="muted">—</span> : <Countdown remainingMs={s.remainingMs} timerRunning={s.timerRunning} receivedAt={receivedAt || Date.now()} />}
        </Fact>
        <Fact label="Started">{s.startedAt ? formatDateTime(s.startedAt) : <span className="muted">Not started</span>}</Fact>
        {s.endedAt ? <Fact label="Ended">{formatDateTime(s.endedAt)}</Fact> : null}
        <Fact label="Pauses">{s.pauseCount}</Fact>
        <Fact label="Score">
          {d.score ? (
            <>
              {d.score.points} / {d.score.maxPoints}
              {!d.score.autoGraded ? <span className="muted small"> (includes manually graded questions)</span> : null}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </Fact>
        <Fact label="Consent">
          {d.consent.acceptedAt ? (
            <>
              {formatDateTime(d.consent.acceptedAt)}
              {d.consent.noticeVersion ? <span className="muted small"> · notice {d.consent.noticeVersion}</span> : null}
            </>
          ) : (
            <span className="muted">Not yet given</span>
          )}
        </Fact>
        <Fact label="Last heartbeat">{s.lastHeartbeatAt ? <RelativeTime at={s.lastHeartbeatAt} /> : <span className="muted">—</span>}</Fact>
        <Fact label="Last identity check">
          {s.identity.lastDecision ? (
            <>
              <DecisionBadge decision={s.identity.lastDecision} /> {s.identity.lastAt ? <Clock at={s.identity.lastAt} /> : null}
              {s.identity.lastSimilarity != null ? <span className="muted small"> · {formatSimilarity(s.identity.lastSimilarity)}</span> : null}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </Fact>
      </div>
      {s.status === 'active' ? (
        <div className="sh-monitor">
          <span className="muted small">Live monitoring:</span> <MonitoringLine s={s} />
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <div className="fact-label">{label}</div>
      <div className="fact-value">{children}</div>
    </div>
  );
}
