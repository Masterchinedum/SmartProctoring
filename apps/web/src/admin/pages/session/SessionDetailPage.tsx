import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventDTO, SessionDetailDTO, TimelineItemDTO } from '@sp/shared';
import { tabProps } from '../../../lib/a11y';
import { api, shouldRetry } from '../../api/client';
import { qk } from '../../api/queries';
import { DEFAULT_FILTERS, type EventFilterState } from '../../lib/filters';
import { formatDateTime, formatSimilarity } from '../../lib/format';
import { formatScore } from '../../lib/examVersions';
import { kindsSummary } from '../../lib/accommodations';
import { END_REASON_LABELS, HOLD_REASON_LABELS } from '../../lib/labels';
import { describeWindow } from '../../lib/scheduling';
import { ConnectionBadge, DecisionBadge, StatusBadge } from '../../components/Badges';
import { ErrorState, Loading } from '../../components/Common';
import { AccommodationsCard } from '../../components/AccommodationsCard';
import { EventDrawer } from '../../components/EventDetail';
import { Clock, Countdown, LastHeartbeat, RelativeTime, ReportingInterrupted } from '../../components/Time';
import { MonitoringLine } from '../DashboardPage';
import { PauseDecisionBanner, SessionActions } from './SessionActions';
import { TimelineTab } from './TimelineTab';
import { EventsTab } from './EventsTab';
import { IdentityTab } from './IdentityTab';
import { DevicesTab, NotesTab, PeriodsTab } from './MiscTabs';
import { ReviewTab } from './ReviewTab';
import { RecordingTab } from './RecordingTab';
import { describeRecordingSummary } from '../../lib/recording';

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
  { id: 'recording', label: 'Recording' },
  { id: 'identity', label: 'Identity' },
  { id: 'review', label: 'Review' },
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
  // From the event drawer: the Review tab with that incident in focus.
  const openIncident = useCallback(
    (incidentId: string) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('event');
        next.set('tab', 'review');
        next.set('incident', incidentId);
        return next;
      }),
    [setParams],
  );

  if (detail.isPending) return <Loading label="Loading session…" />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const d = detail.data;

  // Seed the drawer from whatever list already holds the event.
  const initialEvent = openEventId ? findCachedEvent(qc.getQueryData(qk.timeline(id)), qc.getQueryData(qk.sessionEvents(id)), openEventId) : undefined;
  const notesCount = d.notes.length;
  // The Recording tab exists only for a session with recording segments (policy.recording).
  const recording = d.recording ?? null;
  const tabs = TABS.filter((t) => t.id !== 'recording' || recording);
  const shownTab: TabId = tab === 'recording' && !recording ? 'timeline' : tab;
  const seekParam = Number(params.get('t'));
  const seekTo = shownTab === 'recording' && Number.isFinite(seekParam) && seekParam > 0 ? seekParam : null;
  // From an event (Timeline / Events tab): the Recording tab, 10 s before it.
  const watchRecording =
    recording && recording.available > 0
      ? (at: number) =>
          setParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set('tab', 'recording');
            next.set('t', String(Math.round(at)));
            next.delete('event');
            return next;
          })
      : undefined;
  const tabCount: Partial<Record<TabId, number>> = {
    identity: d.identityChecks.length,
    periods: d.periods.length,
    devices: d.devices.length,
    notes: notesCount,
    review: d.review.undecided.integrity + d.review.undecided.uncertain + d.review.undecided.technical,
  };

  return (
    <div className="stack session-detail">
      <SessionHeader d={d} receivedAt={detail.dataUpdatedAt} />
      <AccommodationsCard acc={d.accommodations} verifications={d.staffVerifications} started={d.summary.startedAt != null} />
      <PauseDecisionBanner d={d} />
      <SessionActions d={d} />
      {/* WAI-ARIA tabs: ←/→/Home/End move between tabs (automatic activation); Tab moves into the panel. */}
      <div className="tabs" role="tablist" aria-label="Session details">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${shownTab === t.id ? ' active' : ''}`}
            {...tabProps(
              'session',
              tabs.map((x) => x.id),
              t.id,
              shownTab,
              (id) => setParam('tab', id),
            )}
          >
            {t.label}
            {tabCount[t.id] ? (
              <span className="tab-count">
                <span className="visually-hidden">(</span>
                {tabCount[t.id]}
                <span className="visually-hidden">)</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="tab-panel" role="tabpanel" id="session-panel" aria-labelledby={`session-tab-${shownTab}`} tabIndex={0}>
        {shownTab === 'timeline' ? <TimelineTab sessionId={id} filters={filters} onFilters={setFilters} onOpenEvent={openEvent} onWatch={watchRecording} /> : null}
        {shownTab === 'events' ? <EventsTab sessionId={id} filters={filters} onFilters={setFilters} onOpenEvent={openEvent} onWatch={watchRecording} /> : null}
        {shownTab === 'recording' && recording ? <RecordingTab sessionId={id} summary={recording} seekTo={seekTo} onOpenEvent={openEvent} /> : null}
        {shownTab === 'identity' ? <IdentityTab d={d} onOpenEvent={openEvent} /> : null}
        {shownTab === 'review' ? <ReviewTab d={d} onOpenEvent={openEvent} focusIncidentId={params.get('incident')} /> : null}
        {shownTab === 'periods' ? <PeriodsTab d={d} /> : null}
        {shownTab === 'devices' ? <DevicesTab d={d} /> : null}
        {shownTab === 'notes' ? <NotesTab d={d} onOpenEvent={openEvent} /> : null}
      </div>
      {openEventId ? <EventDrawer key={openEventId} eventId={openEventId} sessionId={id} initial={initialEvent} onClose={closeEvent} onOpenIncident={openIncident} /> : null}
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
            {s.examVersion ? <span title="Every attempt keeps the exam version it started with"> (version {s.examVersion.number})</span> : null}
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
          {s.accommodations?.length ? (
            <span className="badge badge-info" title={kindsSummary(s.accommodations)}>
              Accommodations
            </span>
          ) : null}
        </div>
      </div>
      {s.reportingInterruptedSince ? <ReportingInterrupted since={s.reportingInterruptedSince} /> : null}
      {s.hold ? (
        s.hold.reason === 'recovery' ? (
          <div className="banner banner-warning" data-testid="recovery-banner">
            <strong>Reopened for recovery</strong> {formatDateTime(s.hold.since)}. The exam continues once the candidate passes a fresh camera and identity check with the same link; the
            exam clock stays stopped until then.
            {s.hold.message ? <div className="small">Message shown to the candidate: “{s.hold.message}”</div> : null}
          </div>
        ) : s.hold.canReverify ? (
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
        {s.startedAt == null && !terminal ? (
          <Fact label="Can be started">
            <span data-testid="session-window">{describeWindow(s.window ?? null, receivedAt || Date.now())}</span>
          </Fact>
        ) : null}
        <Fact label="Started">{s.startedAt ? formatDateTime(s.startedAt) : <span className="muted">Not started</span>}</Fact>
        {s.endedAt ? <Fact label="Ended">{formatDateTime(s.endedAt)}</Fact> : null}
        <Fact label="Pauses">{s.pauseCount}</Fact>
        {s.reconnectCount ? (
          <Fact label="Reopened in a new window">
            {s.reconnectCount}
            {d.policy.resume.maxReconnects != null ? <span className="muted small"> of {d.policy.resume.maxReconnects} allowed</span> : null}
          </Fact>
        ) : null}
        <Fact label="Score">
          {d.score ? (
            <>
              {formatScore(d.score)}
              {!d.score.autoGraded ? <span className="muted small"> (includes manually graded questions)</span> : null}
              {d.score.regrades.length ? (
                <div className="small muted" data-testid="score-regrades">
                  {d.score.regrades.map((r) => (
                    <div key={r.at} title={r.reason}>
                      Regraded {formatDateTime(r.at)} with the keys of v{r.keysFromVersion} (was {formatScore(r.previous)})
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </Fact>
        {d.recording ? (
          <Fact label="Recording">
            <span data-testid="session-recording">{d.recording.available > 0 ? describeRecordingSummary(d.recording) : 'Deleted'}</span>
          </Fact>
        ) : null}
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
        <Fact label="Last heartbeat">
          <LastHeartbeat s={s} />
        </Fact>
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
