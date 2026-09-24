import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_CATALOG, type EventCategory, type LiveEventDTO, type SessionSummaryDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { afterSessionAction, qk } from '../api/queries';
import { useLiveMessages } from '../api/live';
import { setServerTime, useNow } from '../lib/clock';
import { formatDuration, formatPercent, formatSimilarity, formatTime } from '../lib/format';
import { CATEGORY_SHORT, HOLD_REASON_LABELS } from '../lib/labels';
import {
  BOARD_GROUP_LABELS,
  BOARD_GROUPS,
  groupSessions,
  matchesSearch,
  needsAttention,
  toDashboardState,
  type AttentionPause,
  type BoardGroup,
  type DashboardState,
  type LiveSession,
} from '../lib/liveState';
import { CategoryBadge, CategoryCounts, ConnectionBadge, DecisionBadge, ReviewBadge, StatusBadge } from '../components/Badges';
import { EmptyState, ErrorState, Loading, PageHeader, Stat } from '../components/Common';
import { EvidenceImage } from '../components/EvidenceImage';
import { Clock, Countdown, LiveDuration, RelativeTime, ReportingInterrupted } from '../components/Time';

const FLASH_MS = 10_000;

export function DashboardPage() {
  const q = useQuery<DashboardState>({
    queryKey: qk.dashboard,
    queryFn: async () => {
      const dto = await api.dashboard();
      setServerTime(dto.serverTime);
      return toDashboardState(dto, Date.now());
    },
    retry: shouldRetry,
    // The WebSocket keeps this fresh; a slow poll is a safety net only.
    refetchInterval: 60_000,
  });

  // Briefly highlight new high-severity items (feed entries and their session cards).
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const flashIds = useCallback((ids: string[]) => {
    setFlash((f) => new Set([...f, ...ids]));
    timers.current.push(
      setTimeout(() => {
        setFlash((f) => {
          const n = new Set(f);
          ids.forEach((id) => n.delete(id));
          return n;
        });
      }, FLASH_MS),
    );
  }, []);
  useLiveMessages(({ msg, isNew }) => {
    if (msg.type === 'event' && isNew && (msg.event.severity === 'high' || msg.event.category === 'integrity')) {
      flashIds([msg.event.id, msg.event.sessionId]);
    }
  });

  if (q.isPending) return <Loading label="Loading live dashboard…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <DashboardBody state={q.data} flash={flash} />;
}

function DashboardBody({ state, flash }: { state: DashboardState; flash: Set<string> }) {
  const groups = useMemo(() => groupSessions(state.sessions), [state.sessions]);
  const attention = useMemo(() => needsAttention(state), [state]);
  const unreviewed = state.sessions.reduce((n, s) => n + s.counts.unreviewed, 0);
  return (
    <div className="stack dashboard">
      <PageHeader title="Live" subtitle="Exams in progress, paused and on hold, plus exams that ended in the last 24 hours. Updates arrive in real time." />
      <div className="stats-row">
        <Stat label="Active" value={groups.active.length} tone="success" />
        <Stat label="Paused" value={groups.paused.length} tone="warning" />
        <Stat label="On hold" value={groups.on_hold.length} tone={groups.on_hold.length ? 'danger' : undefined} />
        <Stat label="Disconnected" value={groups.disconnected.length} tone={groups.disconnected.length ? 'danger' : undefined} />
        <Stat label="Not started" value={groups.not_started.length} />
        <Stat label="Completed (24 h)" value={groups.completed.length} />
        <Stat label="Unreviewed flags" value={unreviewed} tone={unreviewed ? 'warning' : undefined} hint="Non-neutral events not yet reviewed, across listed sessions" />
      </div>
      <NeedsAttention pauses={attention.pauses} holds={attention.holds} />
      <div className="dashboard-grid">
        <SessionBoard groups={groups} flash={flash} />
        <FlagsFeed events={state.recentEvents} flash={flash} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ needs attention */

function NeedsAttention({ pauses, holds }: { pauses: AttentionPause[]; holds: ReturnType<typeof needsAttention>['holds'] }) {
  if (!pauses.length && !holds.length) {
    return (
      <section className="card attention attention-empty">
        <h2>Needs attention</h2>
        <div className="muted">Nothing needs a decision right now. Pause requests that require approval and exams on hold will appear here.</div>
      </section>
    );
  }
  return (
    <section className="card attention">
      <h2>
        Needs attention <span className="count-pill">{pauses.length + holds.length}</span>
      </h2>
      <div className="attention-list">
        {pauses.map((p) => (
          <PauseRequestItem key={p.request.id} item={p} />
        ))}
        {holds.map((h) => (
          <div key={h.sessionId} className="attention-item hold">
            <div className="attention-main">
              <div>
                <span className="badge badge-danger">On hold</span> <strong>{h.candidateName}</strong> <span className="muted">— {h.examTitle}</span>
              </div>
              <div className="small">
                {HOLD_REASON_LABELS[h.hold.reason] ?? h.hold.reason} · since <Clock at={h.hold.since} /> (<RelativeTime at={h.hold.since} />)
                {h.hold.canReverify ? <span className="muted"> · candidate may re-verify themselves</span> : null}
              </div>
              {h.hold.message ? <div className="muted small">{h.hold.message}</div> : null}
            </div>
            <Link className="btn btn-primary btn-sm" to={`/admin/sessions/${h.sessionId}`}>
              Review
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

function PauseRequestItem({ item }: { item: AttentionPause }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: (approve: boolean) => api.decidePause(item.sessionId, item.request.id, approve, note.trim() || undefined),
    onSuccess: (s) => afterSessionAction(qc, s, item.sessionId),
  });
  return (
    <div className="attention-item pause">
      <div className="attention-main">
        <div>
          <span className="badge badge-warning">Pause request</span> <strong>{item.candidateName}</strong> <span className="muted">— {item.examTitle}</span>
        </div>
        <div className="small">
          Requested <Clock at={item.request.requestedAt} /> (<RelativeTime at={item.request.requestedAt} />)
          {item.request.reason ? (
            <>
              {' '}
              · Reason: <q>{item.request.reason}</q>
            </>
          ) : (
            <span className="muted"> · no reason given</span>
          )}
        </div>
        {m.isError ? <div className="text-danger small">{errorMessage(m.error)}</div> : null}
      </div>
      <input type="text" className="attention-note" placeholder="Note to candidate (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <div className="row nowrap">
        <button type="button" className="btn btn-primary btn-sm" disabled={m.isPending} onClick={() => m.mutate(true)}>
          Approve
        </button>
        <button type="button" className="btn btn-sm" disabled={m.isPending} onClick={() => m.mutate(false)}>
          Deny
        </button>
        <Link className="btn btn-sm" to={`/admin/sessions/${item.sessionId}`}>
          Open
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ session board */

type BoardFilter = 'all' | BoardGroup;

function SessionBoard({ groups, flash }: { groups: Record<BoardGroup, LiveSession[]>; flash: Set<string> }) {
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [search, setSearch] = useState('');
  const [showCompleted, setShowCompleted] = useState(false);
  const visibleGroups = filter === 'all' ? BOARD_GROUPS : [filter];
  const total = BOARD_GROUPS.reduce((n, g) => n + groups[g].length, 0);
  return (
    <section className="board">
      <div className="board-toolbar">
        <div className="chips" role="tablist" aria-label="Session status">
          <button type="button" role="tab" aria-selected={filter === 'all'} className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
            All <span className="chip-count">{total}</span>
          </button>
          {BOARD_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={filter === g}
              className={`chip chip-group-${g}${filter === g ? ' on' : ''}`}
              onClick={() => setFilter(g)}
            >
              {BOARD_GROUP_LABELS[g]} <span className="chip-count">{groups[g].length}</span>
            </button>
          ))}
        </div>
        <input type="text" className="board-search" placeholder="Search candidate or exam…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search sessions" />
      </div>
      {total === 0 ? (
        <EmptyState title="No exam sessions right now">
          Assign candidates to a published exam on the <Link to="/admin/exams">Exams</Link> page; their sessions appear here as soon as they open the link.
        </EmptyState>
      ) : null}
      {visibleGroups.map((g) => {
        const list = groups[g].filter((s) => matchesSearch(s, search));
        if (filter === 'all' && list.length === 0) return null;
        const collapsed = g === 'completed' && filter === 'all' && !showCompleted && !search;
        return (
          <div key={g} className={`board-group board-group-${g}`}>
            <h3 className="board-group-title">
              {BOARD_GROUP_LABELS[g]} <span className="muted">({list.length})</span>
              {g === 'completed' && filter === 'all' && !search ? (
                <button type="button" className="link-btn" onClick={() => setShowCompleted((x) => !x)}>
                  {showCompleted ? 'Hide' : 'Show'}
                </button>
              ) : null}
            </h3>
            {collapsed ? null : list.length === 0 ? (
              <div className="muted small">No sessions{search ? ' match the search' : ''}.</div>
            ) : (
              <div className="session-cards">
                {list.map((s) => (
                  <SessionCard key={s.id} s={s} flash={flash.has(s.id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function SessionCard({ s, flash }: { s: LiveSession; flash: boolean }) {
  return (
    <Link to={`/admin/sessions/${s.id}`} className={`session-card sc-${s.status}${s.connection === 'offline' ? ' sc-offline' : ''}${flash ? ' flash' : ''}`}>
      <div className="sc-head">
        <div className="sc-who">
          <div className="sc-name">{s.candidate.name}</div>
          <div className="muted small sc-exam">{s.exam.title}</div>
        </div>
        <div className="sc-badges">
          <StatusBadge status={s.status} />
          {s.status !== 'submitted' && s.status !== 'terminated' ? <ConnectionBadge connection={s.connection} /> : null}
        </div>
      </div>
      {s.reportingInterruptedSince ? <ReportingInterrupted since={s.reportingInterruptedSince} /> : null}
      {s.hold ? <div className="sc-alert danger">On hold: {HOLD_REASON_LABELS[s.hold.reason] ?? s.hold.reason}</div> : null}
      {s.pendingPauseRequest ? (
        <div className="sc-alert warning">
          Pause requested <RelativeTime at={s.pendingPauseRequest.requestedAt} /> — awaiting decision
        </div>
      ) : null}
      <MonitoringLine s={s} />
      <IdentityLine identity={s.identity} />
      <div className="sc-foot">
        <span className="sc-timer" title="Exam time remaining">
          ⏱ <Countdown remainingMs={s.remainingMs} timerRunning={s.timerRunning} receivedAt={s.receivedAt} />
        </span>
        <span className="muted small">
          {s.pauseCount} {s.pauseCount === 1 ? 'pause' : 'pauses'}
        </span>
        <CategoryCounts counts={s.counts} compact />
        {s.counts.unreviewed > 0 ? <span className="badge badge-warning">{s.counts.unreviewed} unreviewed</span> : null}
      </div>
    </Link>
  );
}

export function MonitoringLine({ s }: { s: SessionSummaryDTO }) {
  const now = useNow(true);
  const m = s.monitoring;
  if (s.status === 'paused') return <div className="sc-monitor muted">Monitoring stopped — paused (unobserved)</div>;
  if (s.status === 'on_hold') return <div className="sc-monitor muted">Monitoring stopped — on hold</div>;
  if (s.status === 'submitted' || s.status === 'terminated') return <div className="sc-monitor muted">Exam ended {s.endedAt ? formatTime(s.endedAt) : ''}</div>;
  if (s.status === 'invited' || s.status === 'ready') return <div className="sc-monitor muted">{s.status === 'ready' ? 'Check-in passed — not started yet' : 'Has not started the readiness check'}</div>;
  if (!m) return <div className="sc-monitor muted">No monitoring status received yet</div>;
  const stale = now - m.at > 15_000;
  if (s.connection !== 'online') {
    return (
      <div className="sc-monitor muted">
        <span className="mon-dot mon-dot-off" aria-hidden />
        Not reporting — last status “{m.label || 'Monitoring'}” {formatDuration(now - m.at)} ago
      </div>
    );
  }
  return (
    <div className={`sc-monitor mon-${m.state}`}>
      <span className={`mon-dot mon-dot-${m.state}`} aria-hidden />
      <span className="mon-label">{m.label || 'Monitoring'}</span>
      <span className="muted small">
        {' '}
        · {m.faces} {m.faces === 1 ? 'face' : 'faces'}
        {stale ? <> · as of {formatDuration(now - m.at)} ago</> : null}
      </span>
      {m.open?.length ? (
        <div className="mon-open">
          {m.open.slice(0, 3).map((t) => (
            <span key={t} className="chip static small">
              {(EVENT_CATALOG as Record<string, { title: string }>)[t]?.title ?? t}
            </span>
          ))}
          {m.open.length > 3 ? <span className="muted small">+{m.open.length - 3}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function IdentityLine({ identity }: { identity: SessionSummaryDTO['identity'] }) {
  if (!identity.lastDecision) return <div className="sc-identity muted small">No identity check yet</div>;
  return (
    <div className="sc-identity small">
      <span className="muted">Identity:</span> <DecisionBadge decision={identity.lastDecision} />{' '}
      {identity.lastAt ? <RelativeTime at={identity.lastAt} /> : null}
      {identity.lastSimilarity != null ? <span className="muted"> · similarity {formatSimilarity(identity.lastSimilarity)}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ flags feed */

const FEED_CATEGORIES: EventCategory[] = ['integrity', 'uncertain', 'technical'];

function FlagsFeed({ events, flash }: { events: LiveEventDTO[]; flash: Set<string> }) {
  const navigate = useNavigate();
  const [cats, setCats] = useState<EventCategory[]>([]);
  const [onlyUnreviewed, setOnlyUnreviewed] = useState(false);
  const list = events.filter((e) => (cats.length === 0 || cats.includes(e.category)) && (!onlyUnreviewed || e.review.status === 'unreviewed'));
  return (
    <section className="feed card">
      <div className="feed-head">
        <h2>Live flags</h2>
        <div className="chips">
          {FEED_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cats.includes(c)}
              className={`chip chip-${c}${cats.includes(c) ? ' on' : ''}`}
              onClick={() => setCats((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]))}
            >
              <span className={`cat-dot cat-dot-${c}`} aria-hidden />
              {CATEGORY_SHORT[c]}
            </button>
          ))}
          <label className="inline small">
            <input type="checkbox" checked={onlyUnreviewed} onChange={(e) => setOnlyUnreviewed(e.target.checked)} /> Unreviewed
          </label>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="muted feed-empty">{events.length === 0 ? 'No flags yet. New observations appear here as they arrive.' : 'No flags match the filter.'}</div>
      ) : (
        <ol className="feed-list">
          {list.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className={`feed-item feed-${e.category}${flash.has(e.id) ? ' flash' : ''}`}
                onClick={() => navigate(`/admin/sessions/${e.sessionId}?event=${encodeURIComponent(e.id)}`)}
              >
                {e.evidence.length ? <EvidenceImage evidence={e.evidence.find((x) => x.kind === 'event_screenshot') ?? e.evidence[0]} size="thumb" alt="" /> : null}
                <div className="feed-body">
                  <div className="feed-title">
                    <CategoryBadge category={e.category} />
                    <strong>{e.title}</strong>
                    {e.severity === 'high' ? <span className="badge badge-danger">High</span> : null}
                  </div>
                  <div className="small">
                    {e.candidateName} <span className="muted">· {e.examTitle}</span>
                  </div>
                  <div className="small muted feed-meta">
                    <Clock at={e.startedAt} /> · {e.endedAt == null ? <span className="ongoing-tag">ongoing <LiveDuration from={e.startedAt} to={null} ongoingLabel={false} /></span> : <LiveDuration from={e.startedAt} to={e.endedAt} />}
                    {e.confidence != null ? <> · {formatPercent(e.confidence)} confidence</> : null}
                    {e.deliveredLate ? <span className="badge badge-technical">Delivered late</span> : null}
                    {e.review.status !== 'unreviewed' ? <ReviewBadge status={e.review.status} /> : null}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
