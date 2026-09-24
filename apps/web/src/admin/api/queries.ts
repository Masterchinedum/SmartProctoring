import type { QueryClient } from '@tanstack/react-query';
import type {
  EventDTO,
  IdentityCheckDTO,
  LiveEventDTO,
  NoteDTO,
  PauseRequestDTO,
  SessionDetailDTO,
  SessionSummaryDTO,
  TimelineItemDTO,
} from '@sp/shared';
import { applyFeedEvent, applyPauseRequest, upsertSession, type DashboardState } from '../lib/liveState';
import { upsertEvent, upsertTimelineCheck, upsertTimelineEvent } from '../lib/timeline';
import type { Paged } from '@sp/shared';

/** Query keys. Everything about one session lives under ['session', id, …]. */
export const qk = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  sessionsAll: ['sessions'] as const,
  sessions: (p: object) => ['sessions', p] as const,
  session: (id: string) => ['session', id] as const,
  timeline: (id: string) => ['session', id, 'timeline'] as const,
  sessionEvents: (id: string) => ['session', id, 'events'] as const,
  report: (id: string) => ['session', id, 'report'] as const,
  event: (id: string) => ['event', id] as const,
  eventNotes: (id: string) => ['event', id, 'notes'] as const,
  compare: (eventId: string) => ['compare', eventId] as const,
  exams: ['exams'] as const,
  exam: (id: string) => ['exam', id] as const,
  examSessions: (id: string) => ['exam', id, 'sessions'] as const,
  candidates: (q: string) => ['candidates', q] as const,
  candidatesAll: ['candidates'] as const,
  candidate: (id: string) => ['candidate', id] as const,
  settings: ['settings'] as const,
  users: ['users'] as const,
  audit: (p: object) => ['audit', p] as const,
  quality: (p: object) => ['quality', p] as const,
  integrationStatus: ['integrations', 'status'] as const,
  apiKeys: ['integrations', 'api-keys'] as const,
  webhooks: ['integrations', 'webhooks'] as const,
  webhookDeliveries: (id: string) => ['integrations', 'webhooks', id, 'deliveries'] as const,
};

/* ------------------------------------------------------------------ cache patching (realtime + mutations) */

/** Event types that open/close periods: the timeline's period bands must be refetched when they arrive. */
const PERIOD_EVENT_TYPES = new Set<string>([
  'session_started',
  'session_paused',
  'session_resumed',
  'session_held',
  'hold_released',
  'session_submitted',
  'session_expired',
  'session_terminated',
  'unobserved_period',
  'reporting_interrupted',
  'checkin_completed',
]);

function refreshSessionStructure(qc: QueryClient, sessionId: string): void {
  void qc.invalidateQueries({ queryKey: qk.session(sessionId), exact: true });
  void qc.invalidateQueries({ queryKey: qk.timeline(sessionId) });
  void qc.invalidateQueries({ queryKey: qk.report(sessionId) });
}

export function applySessionSummary(qc: QueryClient, s: SessionSummaryDTO): void {
  const receivedAt = Date.now();
  const prev = qc.getQueryData<SessionDetailDTO>(qk.session(s.id))?.summary;
  if (prev && (prev.status !== s.status || prev.connection !== s.connection || prev.pauseCount !== s.pauseCount)) {
    // Periods (pause / disconnect / hold bands) changed server-side.
    refreshSessionStructure(qc, s.id);
  }
  qc.setQueryData<DashboardState>(qk.dashboard, (old) => (old ? { ...old, sessions: upsertSession(old.sessions, { ...s, receivedAt }) } : old));
  // The access link is only sent to admins on the detail / exam-assignment responses (never over the WebSocket
  // or in action results): keep the one already loaded when an update arrives without it.
  const keepLink = (prevSummary: SessionSummaryDTO | undefined): SessionSummaryDTO => (s.accessLink == null && prevSummary?.accessLink ? { ...s, accessLink: prevSummary.accessLink } : s);
  qc.setQueryData<SessionDetailDTO>(qk.session(s.id), (old) => (old ? { ...old, summary: keepLink(old.summary) } : old));
  const replaceIn = <T extends { items: SessionSummaryDTO[] }>(old: T | undefined): T | undefined =>
    old && old.items.some((x) => x.id === s.id) ? { ...old, items: old.items.map((x) => (x.id === s.id ? keepLink(x) : x)) } : old;
  qc.setQueriesData<Paged<SessionSummaryDTO>>({ queryKey: qk.sessionsAll }, replaceIn);
  qc.setQueriesData<{ items: SessionSummaryDTO[] }>({ queryKey: qk.examSessions(s.exam.id) }, replaceIn);
}

export function applyEvent(qc: QueryClient, ev: EventDTO, names?: { candidateName: string; examTitle: string }): { isNew: boolean } {
  let isNew = false;
  if (names) {
    const live: LiveEventDTO = { ...ev, candidateName: names.candidateName, examTitle: names.examTitle };
    qc.setQueryData<DashboardState>(qk.dashboard, (old) => {
      if (!old) return old;
      const r = applyFeedEvent(old.recentEvents, live);
      isNew = r.isNew;
      return { ...old, recentEvents: r.feed };
    });
  } else {
    // Mutation result (e.g. review): update the feed entry in place if present.
    qc.setQueryData<DashboardState>(qk.dashboard, (old) =>
      old && old.recentEvents.some((e) => e.id === ev.id)
        ? { ...old, recentEvents: old.recentEvents.map((e) => (e.id === ev.id ? { ...e, ...ev } : e)) }
        : old,
    );
  }
  qc.setQueryData<EventDTO>(qk.event(ev.id), (old) => (old ? ev : old));
  qc.setQueryData<{ items: TimelineItemDTO[] }>(qk.timeline(ev.sessionId), (old) => (old ? { items: upsertTimelineEvent(old.items, ev) } : old));
  qc.setQueryData<{ items: EventDTO[] }>(qk.sessionEvents(ev.sessionId), (old) => (old ? { items: upsertEvent(old.items, ev) } : old));
  if (names && PERIOD_EVENT_TYPES.has(ev.type)) refreshSessionStructure(qc, ev.sessionId);
  return { isNew };
}

export function applyIdentityCheck(qc: QueryClient, sessionId: string, check: IdentityCheckDTO): void {
  qc.setQueryData<{ items: TimelineItemDTO[] }>(qk.timeline(sessionId), (old) => (old ? { items: upsertTimelineCheck(old.items, check) } : old));
  qc.setQueryData<SessionDetailDTO>(qk.session(sessionId), (old) => {
    if (!old) return old;
    const others = old.identityChecks.filter((c) => c.id !== check.id);
    return { ...old, identityChecks: [...others, check].sort((a, b) => a.at - b.at) };
  });
}

/** A session note (realtime 'note' message, or the author's own POST result): appended once. */
export function applyNote(qc: QueryClient, sessionId: string, note: NoteDTO): void {
  qc.setQueryData<SessionDetailDTO>(qk.session(sessionId), (old) =>
    old && !old.notes.some((n) => n.id === note.id) ? { ...old, notes: [...old.notes, note].sort((a, b) => a.createdAt - b.createdAt) } : old,
  );
  void qc.invalidateQueries({ queryKey: qk.report(sessionId) });
}

export function applyPauseRequestMessage(qc: QueryClient, sessionId: string, request: PauseRequestDTO): void {
  qc.setQueryData<DashboardState>(qk.dashboard, (old) =>
    old ? { ...old, sessions: old.sessions.map((s) => (s.id === sessionId ? applyPauseRequest(s, request) : s)) } : old,
  );
  qc.setQueryData<SessionDetailDTO>(qk.session(sessionId), (old) => {
    if (!old) return old;
    const others = old.pauseRequests.filter((r) => r.id !== request.id);
    return { ...old, summary: applyPauseRequest(old.summary, request), pauseRequests: [...others, request].sort((a, b) => a.requestedAt - b.requestedAt) };
  });
}

/** After a staff action on a session: patch summary, then refetch the parts the server recomputed. */
export function afterSessionAction(qc: QueryClient, s: SessionSummaryDTO | undefined, sessionId: string): void {
  if (s && typeof s === 'object' && 'id' in s) applySessionSummary(qc, s);
  void qc.invalidateQueries({ queryKey: qk.session(sessionId) });
  void qc.invalidateQueries({ queryKey: qk.dashboard });
}
