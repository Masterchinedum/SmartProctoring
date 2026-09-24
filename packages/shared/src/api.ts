import { z } from 'zod';
import { EVENT_TYPES, REVIEW_STATUSES, type EventCategory, type EventSource, type EventType, type ReviewStatus, type Severity } from './events';
import type { ProctoringPolicy } from './policy';
import type { CheckPurpose, ConnectionStatus, EndReason, HoldReason, PeriodKind, SessionStatus } from './session';
import type { FaceQuality, IdentityCheckTrigger, IdentityDecision, IdentityResultDTO, LivenessChallengeDTO, LivenessResultDTO } from './identity';
import type { MonitoringStatus } from './observation';
import { IDENTITY_CHECK_TRIGGERS } from './identity';

/**
 * HTTP API contract. Paths are relative to the server origin.
 *
 *  Candidate API  : /api/candidate/*   auth: `Authorization: Bearer <accessToken>` (token from invite link)
 *  Staff API      : /api/admin/*       auth: httpOnly session cookie `sp_session` (from /api/auth/login)
 *  Staff realtime : GET /api/admin/live  (WebSocket, same cookie)  -> LiveMessage JSON frames
 *  Public         : /api/health, /api/public/privacy-notice
 *
 * Errors: non-2xx with body ApiError.
 * Binary uploads (JPEG) use `Content-Type: image/jpeg` raw bodies with metadata in the query string.
 */

export interface ApiError {
  error: string; // machine code, e.g. 'not_found', 'invalid_state', 'validation_failed'
  message: string; // human readable
  details?: unknown;
}

/* =================================================================== shared DTOs */

export interface EvidenceRefDTO {
  id: string;
  kind: 'event_screenshot' | 'identity_probe' | 'identity_reference' | 'id_photo' | 'liveness_frame';
  capturedAt: number;
  /** false once purged by retention policy */
  available: boolean;
  purgedAt: number | null;
  /** Staff URL: GET /api/admin/evidence/:id (image/jpeg). */
  url: string;
}

export interface EventDTO {
  id: string;
  sessionId: string;
  type: EventType;
  category: EventCategory;
  severity: Severity;
  source: EventSource;
  status: 'open' | 'closed';
  title: string;
  observation: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  /** 0..1, null for markers where confidence is meaningless (lifecycle). */
  confidence: number | null;
  details: Record<string, unknown>;
  /** Surrounding context, e.g. { precededBy: ['session_resumed'], periodKind: 'active' }. */
  context: Record<string, unknown>;
  evidence: EvidenceRefDTO[];
  review: { status: ReviewStatus; by: string | null; byName: string | null; at: number | null; note: string | null };
  notesCount: number;
  /** When the server received the latest version. */
  receivedAt: number;
  /** true if delivered well after it occurred (e.g. buffered during an outage). */
  deliveredLate: boolean;
}

export interface PeriodDTO {
  id: string;
  kind: PeriodKind;
  observed: boolean;
  startedAt: number;
  endedAt: number | null;
  reason: string | null;
  meta: Record<string, unknown>;
}

export interface PauseRequestDTO {
  id: string;
  requestedAt: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface HoldDTO {
  reason: HoldReason;
  since: number;
  message: string;
  /** Candidate may attempt self re-verification. */
  canReverify: boolean;
}

/* =================================================================== candidate API */

export interface CandidateQuestionDTO {
  id: string;
  index: number;
  type: QuestionType;
  prompt: string;
  options: { id: string; text: string }[];
  points: number;
}

export const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'short_text', 'long_text', 'numeric'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export type AnswerValue = string | string[] | number | null;

export interface CandidateAnswerDTO {
  questionId: string;
  value: AnswerValue;
  clientSeq: number;
  savedAt: number;
}

export interface PrivacyNoticeDTO {
  version: string;
  /** Plain-text paragraphs. */
  sections: { heading: string; body: string }[];
  retentionDays: number;
  monitored: string[];
  stored: string[];
  notStored: string[];
  contact: string;
}

/** GET /api/candidate/session */
export interface CandidateSessionState {
  serverTime: number;
  session: {
    id: string;
    status: SessionStatus;
    endReason: EndReason | null;
    remainingMs: number;
    timerRunning: boolean;
    durationMs: number;
    currentQuestionIndex: number;
    pauseCount: number;
    /** A check must be passed by THIS browser instance before the exam can continue. */
    requiredCheck: CheckPurpose | null;
    /** The client instance that has passed the latest check (if any). */
    verifiedInstanceId: string | null;
    hold: HoldDTO | null;
    pauseRequest: PauseRequestDTO | null;
  };
  exam: {
    id: string;
    title: string;
    description: string;
    instructions: string;
    durationSec: number;
    questionCount: number;
    policy: ProctoringPolicy;
  };
  candidate: { id: string; name: string; hasIdPhoto: boolean };
  consent: { accepted: boolean; acceptedAt: number | null; notice: PrivacyNoticeDTO };
  /** Only present when status is active/paused/on_hold AND this instance is verified (or status is submitted, for review). */
  questions: CandidateQuestionDTO[] | null;
  answers: CandidateAnswerDTO[] | null;
}

export const consentRequestSchema = z.object({ noticeVersion: z.string(), accepted: z.literal(true) });
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

export const deviceInfoSchema = z.object({
  cameraLabel: z.string().max(300).default(''),
  /** SHA-256 of deviceId (never the raw id). */
  cameraIdHash: z.string().max(128).default(''),
  userAgent: z.string().max(1000).default(''),
  screen: z.object({ width: z.number(), height: z.number(), isExtended: z.boolean().nullable() }).partial().default({}),
  videoWidth: z.number().optional(),
  videoHeight: z.number().optional(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/** POST /api/candidate/checks */
export const startCheckRequestSchema = z.object({
  purpose: z.enum(['initial', 'resume', 'reconnect', 'reverify']),
  clientInstanceId: z.string().min(8).max(100),
  device: deviceInfoSchema,
});
export type StartCheckRequest = z.infer<typeof startCheckRequestSchema>;

export interface StartCheckResponse {
  checkId: string;
  purpose: CheckPurpose;
  /** null when liveness policy is 'off'. */
  liveness: LivenessChallengeDTO | null;
  attemptsRemaining: number;
  /** Frames needed for the identity portion (frontal). */
  frontalFramesRequired: number;
}

/**
 * POST /api/candidate/checks/:checkId/frames?step=<index|'frontal'>&capturedAt=<ms>&nonce=<nonce>&clientYaw=<deg>&clientPitch=<deg>
 * body: image/jpeg (<= 400 KB, ~640x480)
 */
export interface CheckFrameResponse {
  accepted: boolean;
  quality: FaceQuality;
  guidance: string[];
  /** For liveness step frames: whether this frame satisfies the step. */
  stepSatisfied?: boolean;
  measured?: { yawDeg: number; pitchDeg: number };
}

/** POST /api/candidate/checks/:checkId/complete */
export interface CompleteCheckResponse {
  outcome: 'passed' | 'retry' | 'held' | 'failed';
  message: string;
  guidance: string[];
  liveness: LivenessResultDTO | null;
  identity: IdentityResultDTO | null;
  idPhoto: { decision: IdentityDecision; similarity: number | null } | null;
  attemptsRemaining: number;
  state: CandidateSessionState;
}

/** POST /api/candidate/start  (status ready -> active) => CandidateSessionState */

/** PUT /api/candidate/answers/:questionId */
export const saveAnswerRequestSchema = z.object({
  value: z.union([z.string().max(100_000), z.array(z.string().max(200)).max(100), z.number(), z.null()]),
  clientSeq: z.number().int().min(0),
  answeredAt: z.number(),
});
export type SaveAnswerRequest = z.infer<typeof saveAnswerRequestSchema>;
export interface SaveAnswerResponse {
  saved: boolean;
  /** false when a newer clientSeq was already stored. */
  applied: boolean;
  serverSeq: number;
}

/** POST /api/candidate/heartbeat */
export const heartbeatRequestSchema = z.object({
  clientInstanceId: z.string(),
  clientTime: z.number(),
  seq: z.number().int(),
  monitoring: z.object({
    state: z.enum(['ok', 'attention', 'degraded', 'off']),
    faces: z.number().int().min(0),
    label: z.string().max(200),
    open: z.array(z.string()).max(50).default([]),
    fps: z.number().optional(),
    cameraState: z.string().max(40).optional(),
  }),
  outboxSize: z.number().int().min(0).default(0),
  /** Oldest undelivered item timestamp (for "reporting delayed since"). */
  outboxOldestAt: z.number().nullable().default(null),
  currentQuestionIndex: z.number().int().min(0).optional(),
  visibility: z.enum(['visible', 'hidden']).optional(),
  fullscreen: z.boolean().optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export type CandidateCommand =
  | { kind: 'pause_approved' }
  | { kind: 'pause_denied'; note: string | null }
  | { kind: 'hold'; hold: HoldDTO }
  | { kind: 'hold_released'; requiresCheck: boolean }
  | { kind: 'terminated'; message: string }
  | { kind: 'submitted'; reason: EndReason }
  | { kind: 'require_check'; purpose: CheckPurpose; message: string }
  | { kind: 'superseded'; message: string }; // another browser instance took over

export interface HeartbeatResponse {
  serverTime: number;
  status: SessionStatus;
  remainingMs: number;
  timerRunning: boolean;
  requiredCheck: CheckPurpose | null;
  commands: CandidateCommand[];
}

/** Candidate-reported event (upsert by id, applied only if version > stored version). */
export const eventUpsertSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  phase: z.enum(['open', 'update', 'close']),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  observation: z.string().max(500).optional(),
  details: z.record(z.unknown()).default({}),
  version: z.number().int().min(1),
  clientInstanceId: z.string().optional(),
});
export type EventUpsert = z.infer<typeof eventUpsertSchema>;

/** POST /api/candidate/events/batch */
export const eventBatchRequestSchema = z.object({ events: z.array(eventUpsertSchema).max(200) });
export type EventBatchRequest = z.infer<typeof eventBatchRequestSchema>;
export interface EventBatchResponse {
  results: { id: string; result: 'created' | 'updated' | 'stale' | 'rejected'; reason?: string }[];
}

/**
 * PUT /api/candidate/evidence/:evidenceId?eventId=<uuid>&capturedAt=<ms>&reason=<onset|peak|periodic|end>
 * body: image/jpeg. Idempotent on evidenceId.
 */
export interface EvidenceUploadResponse {
  stored: boolean;
  duplicate: boolean;
}

/**
 * POST /api/candidate/identity/sample?sampleId=<uuid>&trigger=<IdentityCheckTrigger>&capturedAt=<ms>
 * body: image/jpeg. Idempotent on sampleId.
 */
export const identitySampleQuerySchema = z.object({
  sampleId: z.string().uuid(),
  trigger: z.enum(IDENTITY_CHECK_TRIGGERS),
  capturedAt: z.coerce.number(),
});
export interface IdentitySampleResponse {
  result: IdentityResultDTO;
  /** Server wants another sample soon (to confirm a non-match). */
  followUpInMs: number | null;
  status: SessionStatus;
  hold: HoldDTO | null;
}

/** POST /api/candidate/pause */
export const pauseRequestSchema = z.object({ reason: z.string().max(1000).optional() });
export interface PauseResponse {
  outcome: 'paused' | 'pending_approval' | 'denied';
  message: string;
  state: CandidateSessionState;
}

/** POST /api/candidate/pause/cancel => CandidateSessionState */
/** POST /api/candidate/submit => CandidateSessionState */

/* =================================================================== staff API */

export const STAFF_ROLES = ['owner', 'admin', 'reviewer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffUserDTO {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  disabled: boolean;
  createdAt: number;
}

export const loginRequestSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export interface SessionSummaryDTO {
  id: string;
  exam: { id: string; title: string };
  candidate: { id: string; name: string; email: string | null; externalId: string | null };
  status: SessionStatus;
  endReason: EndReason | null;
  connection: ConnectionStatus;
  lastHeartbeatAt: number | null;
  /** Set while the browser is not reporting (offline) or reports a delayed outbox. */
  reportingInterruptedSince: number | null;
  monitoring: (MonitoringStatus & { at: number }) | null;
  identity: { lastDecision: IdentityDecision | null; lastAt: number | null; lastSimilarity: number | null };
  remainingMs: number;
  timerRunning: boolean;
  startedAt: number | null;
  endedAt: number | null;
  pauseCount: number;
  counts: { integrity: number; uncertain: number; technical: number; unreviewed: number; open: number; highSeverity: number };
  pendingPauseRequest: PauseRequestDTO | null;
  hold: HoldDTO | null;
  accessLink: string | null;
  /** Evidence retention purge suspended (POST /sessions/:id/legal-hold). Optional for backwards compatibility. */
  legalHold?: boolean;
}

export interface IdentityCheckDTO {
  id: string;
  trigger: IdentityCheckTrigger;
  decision: IdentityDecision;
  similarity: number | null;
  confidence: number;
  quality: FaceQuality | null;
  at: number;
  probeEvidence: EvidenceRefDTO | null;
  /** Context at the time: what preceded this check. */
  context: { precededBy: string[]; periodKind: PeriodKind | null; secondsSincePreviousMatch: number | null };
}

export interface IdentityReferenceDTO {
  id: string;
  createdAt: number;
  active: boolean;
  supersededAt: number | null;
  supersededReason: string | null;
  images: EvidenceRefDTO[];
  quality: FaceQuality | null;
  liveness: LivenessResultDTO | null;
  idPhoto: { decision: IdentityDecision; similarity: number | null } | null;
}

export interface NoteDTO {
  id: string;
  sessionId: string;
  eventId: string | null;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
}

export interface DeviceRecordDTO {
  at: number;
  clientInstanceId: string;
  cameraLabel: string;
  cameraIdHash: string;
  userAgent: string;
  purpose: CheckPurpose;
}

/** GET /api/admin/sessions/:id */
export interface SessionDetailDTO {
  summary: SessionSummaryDTO;
  policy: ProctoringPolicy;
  periods: PeriodDTO[];
  identityChecks: IdentityCheckDTO[];
  references: IdentityReferenceDTO[];
  pauseRequests: PauseRequestDTO[];
  notes: NoteDTO[];
  devices: DeviceRecordDTO[];
  consent: { acceptedAt: number | null; noticeVersion: string | null };
  score: { points: number; maxPoints: number; autoGraded: boolean } | null;
}

/** GET /api/admin/sessions/:id/events?category=&type=&severity=&review=&since= */
export const eventFilterSchema = z.object({
  category: z.enum(['integrity', 'uncertain', 'neutral', 'technical']).optional(),
  type: z.string().optional(),
  severity: z.enum(['info', 'low', 'medium', 'high']).optional(),
  review: z.enum(REVIEW_STATUSES).optional(),
  since: z.coerce.number().optional(),
});

/** Merged chronological timeline. GET /api/admin/sessions/:id/timeline */
export type TimelineItemDTO =
  | { kind: 'period'; at: number; period: PeriodDTO }
  | { kind: 'event'; at: number; event: EventDTO }
  | { kind: 'identity_check'; at: number; check: IdentityCheckDTO };

/** POST /api/admin/events/:id/review */
export const reviewRequestSchema = z.object({ status: z.enum(REVIEW_STATUSES), note: z.string().max(2000).optional() });
/** POST /api/admin/sessions/:id/notes  and  POST /api/admin/events/:id/notes */
export const noteRequestSchema = z.object({ text: z.string().min(1).max(5000) });
/** POST /api/admin/sessions/:id/pause-requests/:requestId/decision */
export const pauseDecisionSchema = z.object({ approve: z.boolean(), note: z.string().max(1000).optional() });
/** POST /api/admin/sessions/:id/hold  (manual hold) */
export const holdRequestSchema = z.object({ note: z.string().max(1000).optional() });
/** POST /api/admin/sessions/:id/release  */
export const releaseRequestSchema = z.object({
  note: z.string().max(1000).optional(),
  /** Require the candidate to pass a fresh readiness/identity check before continuing (default true). */
  requireCheck: z.boolean().default(true),
  /** Staff confirm the person is the right candidate and authorize establishing a NEW identity reference at the next check. */
  reEnroll: z.boolean().default(false),
});
/** POST /api/admin/sessions/:id/terminate */
export const terminateRequestSchema = z.object({ reason: z.string().min(1).max(1000) });

/** GET /api/admin/identity/compare/:eventId  — evidence for a possible person swap */
export interface IdentityComparisonDTO {
  eventId: string;
  reference: { images: EvidenceRefDTO[]; createdAt: number; purpose: string };
  probes: { check: IdentityCheckDTO; image: EvidenceRefDTO | null }[];
  similarity: { min: number | null; max: number | null; thresholds: { match: number; mismatch: number } };
  /** Timeline items within +/- 10 minutes, to show whether pause / absence / camera change preceded. */
  surrounding: TimelineItemDTO[];
  /** Neutral environment differences (context only — never evidence of a person change). */
  environmentNotes: string[];
}

/** GET /api/admin/sessions/:id/report */
export interface SessionReportDTO {
  generatedAt: number;
  session: SessionSummaryDTO;
  exam: { id: string; title: string; durationSec: number };
  candidate: { id: string; name: string; email: string | null; externalId: string | null };
  totals: {
    wallClockMs: number;
    observedMs: number;
    unobservedMs: number;
    activeMs: number;
    pausedMs: number;
    disconnectedMs: number;
    heldMs: number;
    pauseCount: number;
    examTimeUsedMs: number;
  };
  periods: PeriodDTO[];
  identity: {
    referenceCreatedAt: number | null;
    checks: number;
    matches: number;
    mismatches: number;
    inconclusive: number;
    unableToVerify: number;
    idPhoto: { decision: IdentityDecision; similarity: number | null } | null;
    summary: string;
  };
  eventCounts: Record<EventCategory, { total: number; dismissed: number; reviewed: number; unreviewed: number }>;
  byType: { type: EventType; title: string; category: EventCategory; count: number; totalDurationMs: number; dismissed: number }[];
  notableEvents: EventDTO[];
  /** Narrative observations — factual, non-accusatory. */
  observations: string[];
  reviewerNotes: NoteDTO[];
  score: { points: number; maxPoints: number; autoGraded: boolean } | null;
  limitations: string[];
}

/* ---- exams, candidates, assignments */

export const questionInputSchema = z.object({
  id: z.string().optional(),
  type: z.enum(QUESTION_TYPES),
  prompt: z.string().min(1).max(20_000),
  options: z.array(z.object({ id: z.string().min(1).max(50), text: z.string().max(2000) })).default([]),
  /** single_choice: [optionId]; multiple_choice: optionIds; short_text: accepted answers (case-insensitive); numeric: [value]; long_text: [] */
  correct: z.array(z.string()).default([]),
  points: z.number().min(0).default(1),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const examInputSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).default(''),
  instructions: z.string().max(20_000).default(''),
  durationSec: z.number().int().min(60).max(24 * 3600),
  policy: z.record(z.unknown()).default({}),
  questions: z.array(questionInputSchema).default([]),
});
export type ExamInput = z.infer<typeof examInputSchema>;

export interface ExamDTO {
  id: string;
  title: string;
  description: string;
  instructions: string;
  durationSec: number;
  status: 'draft' | 'published' | 'archived';
  policy: ProctoringPolicy;
  questions: (QuestionInput & { id: string })[];
  createdAt: number;
  updatedAt: number;
  stats: { assigned: number; active: number; completed: number; flagged: number };
}

export const candidateInputSchema = z.object({
  name: z.string().min(1).max(300),
  email: z.string().email().nullable().optional(),
  externalId: z.string().max(200).nullable().optional(),
});
export interface CandidateDTO {
  id: string;
  name: string;
  email: string | null;
  externalId: string | null;
  idPhoto: { evidenceId: string; approvedAt: number; quality: FaceQuality | null } | null;
  createdAt: number;
  sessions: { id: string; examId: string; examTitle: string; status: SessionStatus }[];
}

/** POST /api/admin/exams/:id/assignments */
export const assignRequestSchema = z.object({ candidateIds: z.array(z.string()).min(1).max(1000) });
export interface AssignmentDTO {
  sessionId: string;
  candidateId: string;
  candidateName: string;
  accessLink: string;
  /** true when the candidate already had a not-yet-finished session for this exam (no new session was created; its link is returned). */
  existing?: boolean;
}

/** PUT /api/admin/candidates/:id/id-photo  body image/jpeg  => { accepted, quality, guidance } */
export interface IdPhotoUploadResponse {
  accepted: boolean;
  quality: FaceQuality;
  guidance: string[];
  candidate: CandidateDTO;
}

export interface OrgSettingsDTO {
  name: string;
  /** Default days to keep screenshots / identity references after a session ends. */
  evidenceRetentionDays: number;
  /** Days to keep event metadata (without images). */
  eventRetentionDays: number;
  defaultPolicy: ProctoringPolicy;
  privacyContact: string;
  identityThresholds: { match: number; mismatch: number; idPhotoMatch: number; idPhotoMismatch: number; mismatchConfirmations: number };
}

/** GET /api/admin/metrics/detection-quality */
export interface DetectionQualityDTO {
  from: number;
  to: number;
  byType: {
    type: EventType;
    category: EventCategory;
    total: number;
    reviewed: number;
    dismissed: number;
    unreviewed: number;
    /** reviewed / (reviewed + dismissed); null if no decisions. Production precision proxy. */
    precision: number | null;
  }[];
  identity: {
    checks: number;
    byDecision: Record<IdentityDecision, number>;
    byTrigger: Record<string, Record<IdentityDecision, number>>;
    mismatchEventsDismissed: number;
    mismatchEventsConfirmed: number;
  };
  offlineEvaluation: unknown | null; // latest stored offline evaluation report (see docs/ACCURACY.md)
}

export interface AuditLogEntryDTO {
  id: string;
  at: number;
  actorType: 'staff' | 'candidate' | 'system';
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  meta: Record<string, unknown>;
}

/* ---- realtime */

export type LiveMessage =
  | { type: 'hello'; serverTime: number }
  | { type: 'session'; session: SessionSummaryDTO }
  | { type: 'event'; event: EventDTO; candidateName: string; examTitle: string }
  | { type: 'identity_check'; sessionId: string; check: IdentityCheckDTO }
  | { type: 'pause_request'; sessionId: string; request: PauseRequestDTO };

export const ACCESS_LINK_PATH = '/take/'; // full link: `${PUBLIC_URL}/take/${accessToken}`

export type { IdentityCheckTrigger };

/* =================================================================== staff endpoint index
 *
 * Auth (no prefix):
 *   POST /api/auth/login   {email,password}        -> { user: StaffUserDTO, org: { id, name } }
 *   POST /api/auth/logout                          -> { ok: true }
 *   GET  /api/auth/me                              -> { user: StaffUserDTO, org: { id, name } }   (401 if not logged in)
 *
 * Staff API (prefix /api/admin, cookie auth; role in brackets = minimum role):
 *   GET  /dashboard                                -> DashboardDTO                                  [reviewer]
 *   GET  /sessions?status=&examId=&q=&connection=&limit=&offset= -> Paged<SessionSummaryDTO>        [reviewer]
 *   GET  /sessions/:id                             -> SessionDetailDTO                              [reviewer]
 *   GET  /sessions/:id/events?category=&type=&severity=&review=&since= -> { items: EventDTO[] }     [reviewer]
 *   GET  /sessions/:id/events.csv                  -> text/csv                                      [reviewer]
 *   GET  /sessions/:id/timeline                    -> { items: TimelineItemDTO[] }                  [reviewer]
 *   GET  /sessions/:id/report                      -> SessionReportDTO                              [reviewer]
 *   POST /sessions/:id/notes {text}                -> NoteDTO                                       [reviewer]
 *   POST /sessions/:id/pause-requests/:requestId/decision {approve,note?} -> SessionSummaryDTO     [reviewer]
 *   POST /sessions/:id/hold {note?}                -> SessionSummaryDTO                             [reviewer]
 *   POST /sessions/:id/release {note?,requireCheck,reEnroll} -> SessionSummaryDTO                   [reviewer]
 *   POST /sessions/:id/terminate {reason}          -> SessionSummaryDTO                             [admin]
 *   POST /sessions/:id/submit {note?}              -> SessionSummaryDTO   (staff-submit)            [admin]
 *   POST /sessions/:id/legal-hold {enabled}        -> SessionSummaryDTO   (suspends retention purge) [admin]
 *   POST /sessions/:id/regenerate-link             -> { accessLink }                                [admin]
 *   POST /sessions/:id/extend {minutes,note?}      -> SessionSummaryDTO   (adds exam time; accommodations) [admin]
 *   GET  /events?category=&severity=&review=&since=&limit= -> { items: LiveEventDTO[] }  (org-wide feed) [reviewer]
 *   GET  /events/:id                               -> EventDTO                                      [reviewer]
 *   POST /events/:id/review {status,note?}         -> EventDTO                                      [reviewer]
 *   GET  /events/:id/notes                         -> { items: NoteDTO[] }                          [reviewer]
 *   POST /events/:id/notes {text}                  -> NoteDTO                                       [reviewer]
 *   GET  /identity/compare/:eventId                -> IdentityComparisonDTO                         [reviewer]
 *   GET  /evidence/:id                             -> image/jpeg (decrypted; every access audit-logged) [reviewer]
 *   GET  /exams                                    -> { items: ExamDTO[] }                          [reviewer]
 *   POST /exams  ExamInput                         -> ExamDTO                                       [admin]
 *   GET  /exams/:id                                -> ExamDTO                                       [reviewer]
 *   PUT  /exams/:id  ExamInput                     -> ExamDTO                                       [admin]
 *   POST /exams/:id/publish | /exams/:id/archive   -> ExamDTO                                       [admin]
 *   GET  /exams/:id/sessions                       -> { items: SessionSummaryDTO[] }                [reviewer]
 *   POST /exams/:id/assignments {candidateIds}     -> { items: AssignmentDTO[] }                    [admin]
 *   GET  /candidates?q=                            -> { items: CandidateDTO[] }                     [reviewer]
 *   POST /candidates  CandidateInput               -> CandidateDTO                                  [admin]
 *   GET  /candidates/:id                           -> CandidateDTO                                  [reviewer]
 *   PUT  /candidates/:id  CandidateInput           -> CandidateDTO                                  [admin]
 *   DELETE /candidates/:id                         -> { ok }  (refused while a session is active)   [admin]
 *   PUT  /candidates/:id/id-photo  (image/jpeg)    -> IdPhotoUploadResponse                         [admin]
 *   DELETE /candidates/:id/id-photo                -> CandidateDTO                                  [admin]
 *   GET  /settings                                 -> OrgSettingsDTO                                [admin]
 *   PUT  /settings  Partial<OrgSettingsDTO>        -> OrgSettingsDTO                                [admin]
 *   GET  /users                                    -> { items: StaffUserDTO[] }                     [admin]
 *   POST /users {email,name,role,password}         -> StaffUserDTO                                  [admin; only owner may create owner/admin]
 *   PUT  /users/:id {name?,role?,disabled?,password?} -> StaffUserDTO                               [admin]
 *   GET  /audit-log?limit=&offset=&action=         -> Paged<AuditLogEntryDTO>                       [admin]
 *   GET  /metrics/detection-quality?from=&to=      -> DetectionQualityDTO                           [reviewer]
 *   WS   /live                                     -> LiveMessage frames                            [reviewer]
 */

export interface Paged<T> {
  items: T[];
  total: number;
}

export type LiveEventDTO = EventDTO & { candidateName: string; examTitle: string };

export interface DashboardDTO {
  serverTime: number;
  /** All non-terminal sessions plus sessions that ended in the last 24 h. */
  sessions: SessionSummaryDTO[];
  /** Latest non-neutral events across the organisation (newest first, max 100). */
  recentEvents: LiveEventDTO[];
  pending: {
    pauseRequests: { sessionId: string; candidateName: string; examTitle: string; request: PauseRequestDTO }[];
    holds: { sessionId: string; candidateName: string; examTitle: string; hold: HoldDTO }[];
  };
}

export const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  role: z.enum(STAFF_ROLES),
  password: z.string().min(10).max(200),
});
export const userUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.enum(STAFF_ROLES).optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
});
export const settingsUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  evidenceRetentionDays: z.number().int().min(1).max(3650).optional(),
  eventRetentionDays: z.number().int().min(30).max(3650).optional(),
  privacyContact: z.string().max(500).optional(),
  defaultPolicy: z.record(z.unknown()).optional(),
  identityThresholds: z
    .object({
      match: z.number().min(0).max(1),
      mismatch: z.number().min(0).max(1),
      idPhotoMatch: z.number().min(0).max(1),
      idPhotoMismatch: z.number().min(0).max(1),
      mismatchConfirmations: z.number().int().min(1).max(10),
    })
    .partial()
    .optional(),
});
export const legalHoldSchema = z.object({ enabled: z.boolean() });
export const staffSubmitSchema = z.object({ note: z.string().max(1000).optional() });
export const extendTimeSchema = z.object({ minutes: z.number().int().min(1).max(24 * 60), note: z.string().max(1000).optional() });
