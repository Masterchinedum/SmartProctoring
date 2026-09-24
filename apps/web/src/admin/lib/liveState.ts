import type { DashboardDTO, HoldDTO, LiveEventDTO, PauseRequestDTO, SessionSummaryDTO } from '@sp/shared';

/** A session summary plus the client time it was received (for local countdowns). */
export type LiveSession = SessionSummaryDTO & { receivedAt: number };

export interface DashboardState {
  serverTime: number;
  sessions: LiveSession[];
  recentEvents: LiveEventDTO[];
  /** Pending items as delivered by the server; merged with what the sessions say (see needsAttention). */
  pending: DashboardDTO['pending'];
}

export const FEED_LIMIT = 100;

export function toDashboardState(dto: DashboardDTO, receivedAt: number): DashboardState {
  return {
    serverTime: dto.serverTime,
    sessions: dto.sessions.map((s) => ({ ...s, receivedAt })),
    recentEvents: dto.recentEvents.filter((e) => e.category !== 'neutral'),
    pending: dto.pending,
  };
}

export function upsertSession<T extends SessionSummaryDTO>(list: T[], s: T): T[] {
  const i = list.findIndex((x) => x.id === s.id);
  if (i === -1) return [s, ...list];
  const next = list.slice();
  next[i] = s;
  return next;
}

/**
 * Apply a live event to the flags feed. Neutral events never enter the feed. A new event is
 * prepended (arrival order, so late-delivered events surface at the top); an update replaces the
 * existing entry in place so cards don't jump around.
 */
export function applyFeedEvent(feed: LiveEventDTO[], ev: LiveEventDTO, limit = FEED_LIMIT): { feed: LiveEventDTO[]; isNew: boolean } {
  const i = feed.findIndex((e) => e.id === ev.id);
  if (ev.category === 'neutral') {
    return { feed: i === -1 ? feed : feed.filter((e) => e.id !== ev.id), isNew: false };
  }
  if (i !== -1) {
    const next = feed.slice();
    next[i] = ev;
    return { feed: next, isNew: false };
  }
  return { feed: [ev, ...feed].slice(0, limit), isNew: true };
}

/** Apply a pause-request message to a session's summary. */
export function applyPauseRequest<T extends SessionSummaryDTO>(s: T, request: PauseRequestDTO): T {
  if (request.status === 'pending') return { ...s, pendingPauseRequest: request };
  if (s.pendingPauseRequest?.id === request.id) return { ...s, pendingPauseRequest: null };
  return s;
}

/* ------------------------------------------------------------------ session board */

export const BOARD_GROUPS = ['active', 'paused', 'on_hold', 'disconnected', 'not_started', 'completed'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

export const BOARD_GROUP_LABELS: Record<BoardGroup, string> = {
  active: 'Active',
  paused: 'Paused',
  on_hold: 'On hold',
  disconnected: 'Disconnected',
  not_started: 'Not started',
  completed: 'Completed',
};

export function boardGroup(s: SessionSummaryDTO): BoardGroup {
  if (s.status === 'submitted' || s.status === 'terminated') return 'completed';
  if (s.status === 'on_hold') return 'on_hold';
  if (s.status === 'paused') return 'paused';
  if (s.status === 'active') return s.connection === 'online' ? 'active' : 'disconnected';
  return 'not_started';
}

export function groupSessions<T extends SessionSummaryDTO>(sessions: T[]): Record<BoardGroup, T[]> {
  const out = Object.fromEntries(BOARD_GROUPS.map((g) => [g, [] as T[]])) as Record<BoardGroup, T[]>;
  for (const s of sessions) out[boardGroup(s)].push(s);
  const byStart = (a: T, b: T) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.candidate.name.localeCompare(b.candidate.name);
  for (const g of BOARD_GROUPS) out[g].sort(byStart);
  out.completed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return out;
}

export function matchesSearch(s: SessionSummaryDTO, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [s.candidate.name, s.candidate.email ?? '', s.candidate.externalId ?? '', s.exam.title].some((v) => v.toLowerCase().includes(needle));
}

export interface AttentionPause {
  sessionId: string;
  candidateName: string;
  examTitle: string;
  request: PauseRequestDTO;
}
export interface AttentionHold {
  sessionId: string;
  candidateName: string;
  examTitle: string;
  hold: HoldDTO;
}

/**
 * Pending pause requests and holds. Sessions are the live source of truth; entries from the initial
 * dashboard payload are kept only for sessions that aren't in the session list.
 */
export function needsAttention(state: Pick<DashboardState, 'sessions' | 'pending'>): { pauses: AttentionPause[]; holds: AttentionHold[] } {
  const known = new Set(state.sessions.map((s) => s.id));
  const pauses: AttentionPause[] = [];
  const holds: AttentionHold[] = [];
  for (const s of state.sessions) {
    if (s.pendingPauseRequest && s.pendingPauseRequest.status === 'pending') {
      pauses.push({ sessionId: s.id, candidateName: s.candidate.name, examTitle: s.exam.title, request: s.pendingPauseRequest });
    }
    if (s.status === 'on_hold' && s.hold) holds.push({ sessionId: s.id, candidateName: s.candidate.name, examTitle: s.exam.title, hold: s.hold });
  }
  for (const p of state.pending.pauseRequests) if (!known.has(p.sessionId) && p.request.status === 'pending') pauses.push(p);
  for (const h of state.pending.holds) if (!known.has(h.sessionId)) holds.push(h);
  pauses.sort((a, b) => a.request.requestedAt - b.request.requestedAt);
  holds.sort((a, b) => a.hold.since - b.hold.since);
  return { pauses, holds };
}
