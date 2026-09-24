import { EVENT_CATALOG, type EventDTO, type EventType, type IdentityCheckDTO, type IdentityDecision, type PeriodDTO, type PeriodKind, type SessionSummaryDTO } from '@sp/shared';

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

export function makeEvent(type: EventType, startedAt: number, patch: Partial<EventDTO> = {}): EventDTO {
  const c = EVENT_CATALOG[type];
  return {
    id: nextId('ev'),
    sessionId: 's1',
    type,
    category: c.category,
    severity: c.severity,
    source: c.sources[0],
    status: 'closed',
    title: c.title,
    observation: c.observation,
    startedAt,
    endedAt: c.span ? startedAt + 5000 : null,
    durationMs: c.span ? 5000 : null,
    confidence: 0.8,
    details: {},
    context: {},
    evidence: [],
    review: { status: 'unreviewed', by: null, byName: null, at: null, note: null },
    notesCount: 0,
    receivedAt: startedAt + 1000,
    deliveredLate: false,
    ...patch,
  };
}

export function makeCheck(decision: IdentityDecision, at: number, patch: Partial<IdentityCheckDTO> = {}): IdentityCheckDTO {
  return {
    id: nextId('chk'),
    trigger: 'periodic',
    decision,
    similarity: decision === 'unable_to_verify' ? null : decision === 'match' ? 0.6 : decision === 'mismatch' ? 0.1 : 0.33,
    confidence: 0.9,
    quality: null,
    at,
    probeEvidence: null,
    context: { precededBy: [], periodKind: 'active', secondsSincePreviousMatch: null },
    ...patch,
  };
}

export function makePeriod(kind: PeriodKind, startedAt: number, endedAt: number | null): PeriodDTO {
  return {
    id: nextId('p'),
    kind,
    observed: kind === 'active' || kind === 'check_in' || kind === 'resume_check',
    startedAt,
    endedAt,
    reason: null,
    meta: {},
  };
}

export function makeSession(patch: Partial<SessionSummaryDTO> = {}): SessionSummaryDTO {
  return {
    id: nextId('sess'),
    exam: { id: 'e1', title: 'Algebra final' },
    candidate: { id: nextId('cand'), name: 'Ada Lovelace', email: 'ada@example.com', externalId: null },
    status: 'active',
    endReason: null,
    connection: 'online',
    lastHeartbeatAt: 1000,
    reportingInterruptedSince: null,
    monitoring: null,
    identity: { lastDecision: null, lastAt: null, lastSimilarity: null },
    remainingMs: 60 * 60_000,
    timerRunning: true,
    startedAt: 1000,
    endedAt: null,
    pauseCount: 0,
    counts: { integrity: 0, uncertain: 0, technical: 0, unreviewed: 0, open: 0, highSeverity: 0 },
    pendingPauseRequest: null,
    hold: null,
    accessLink: null,
    ...patch,
  };
}
