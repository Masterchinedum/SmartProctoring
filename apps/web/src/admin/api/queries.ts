import type { QueryClient } from '@tanstack/react-query';
import type {
  EventDTO,
  IdentityCheckDTO,
  LiveEventDTO,
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
};

/* ------------------------------------------------------------------ cache patching (realtime + mutations) */

export function applySessionSummary(qc: QueryClient, s: SessionSummaryDTO): void {
  const receivedAt = Date.now();
  qc.setQueryData<DashboardState>(qk.dashboard, (old) => (old ? { ...old, sessions: upsertSession(old.sessions, { ...s, receivedAt }) } : old));
  qc.setQueryData<SessionDetailDTO>(qk.session(s.id), (old) => (old ? { ...old, summary: s } : old));
  const replaceIn = <T extends { items: SessionSummaryDTO[] }>(old: T | undefined): T | undefined =>
    old && old.items.some((x) => x.id === s.id) ? { ...old, items: old.items.map((x) => (x.id === s.id ? s : x)) } : old;
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
