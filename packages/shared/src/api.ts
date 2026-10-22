import { z } from 'zod';
import { EVENT_CATEGORIES, EVENT_TYPES, REVIEW_STATUSES, type EventCategory, type EventSource, type EventType, type ReviewStatus, type Severity } from './events';
import type { ProctoringPolicy } from './policy';
import type { CandidateEndReason, CheckPurpose, ConnectionStatus, HoldReason, PeriodKind, SessionEndReason, SessionStatus } from './session';
import { sessionWindowInputSchema, type ReopenEligibilityDTO, type SessionWindow } from './scheduling';
import type { FaceQuality, IdentityCheckTrigger, IdentityDecision, IdentityResultDTO, LivenessChallengeDTO, LivenessResultDTO } from './identity';
import type { MonitoringStatus } from './observation';
import { IDENTITY_CHECK_TRIGGERS } from './identity';
import { externalVerifierUpdateSchema, type ExternalVerifierSettingsDTO } from './verifiers';
import type { AccommodationKind, SessionAccommodationsDTO } from './accommodations';
import { MFA_REQUIREMENTS, type MfaRequirement } from './mfa';
import { reviewSlaSchema, type QueueView, type ReviewDecisionDTO, type ReviewResolution, type ReviewSlaSettings, type SessionReviewDTO, type SessionReviewSummaryDTO } from './review';
import type { EventExplanation } from './explain';
import type { Incident } from './incidents';
import { evidenceLocationSchema } from './residency';
import type { SessionRecordingSummaryDTO } from './recording';

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
  /** `recording`: a part of the exam recording (only on a recording's own evidence row; never attached to events). */
  kind: 'event_screenshot' | 'identity_probe' | 'identity_reference' | 'id_photo' | 'liveness_frame' | 'recording';
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
  review: { status: ReviewStatus; resolution: ReviewResolution | null; by: string | null; byName: string | null; at: number | null; note: string | null };
  notesCount: number;
  /** When the server received the latest version. */
  receivedAt: number;
  /** true if delivered well after it occurred (e.g. buffered during an outage). */
  deliveredLate: boolean;
}

/** GET /api/admin/events/:id — the event with what a reviewer needs to decide it. */
export interface EventDetailDTO extends EventDTO {
  /** Why it was recorded, with this exam's settings (./explain.ts). */
  explanation: EventExplanation;
  /** Review decisions, oldest first. */
  history: ReviewDecisionDTO[];
  /** The incident it belongs to (flags close in time, ./incidents.ts); null for session changes. */
  incident: Incident | null;
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
  /** What the exam records (policy.recording); absent when it records nothing. The notice above says so in words. */
  recording?: { camera: boolean; audio: boolean; screen: boolean };
}

/** GET /api/candidate/session */
export interface CandidateSessionState {
  serverTime: number;
  session: {
    id: string;
    status: SessionStatus;
    /** Why the exam ended; housekeeping reasons (e.g. 'abandoned') are not included (null). */
    endReason: CandidateEndReason | null;
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
    /**
     * The server wants an identity sample now (e.g. {trigger:'exam_start', inMs:0} right after /start or after a
     * passed resume / reconnect / reverify check). Same semantics as HeartbeatResponse.identitySample.
     */
    identitySample?: IdentitySampleRequestDTO | null;
    /**
     * The scheduling window (./scheduling.ts; null: none). The exam can be started only inside it; the check-in may
     * begin CHECK_IN_LEAD_MS before it opens. An exam in progress is never cut off when it closes.
     */
    window: SessionWindow | null;
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
  /** The candidate's approved accommodations for this exam, in plain words (none: empty). */
  accommodations?: string[];
  /** The exam belongs to a sandbox (practice / testing) organisation (./quotas.ts): the candidate app says so. */
  sandbox?: boolean;
  consent: { accepted: boolean; acceptedAt: number | null; notice: PrivacyNoticeDTO };
  /** Only present while the exam is active on the verified browser instance, or after submission. Never served while paused/on hold (unmonitored). */
  questions: CandidateQuestionDTO[] | null;
  answers: CandidateAnswerDTO[] | null;
}

export const consentRequestSchema = z.object({ noticeVersion: z.string(), accepted: z.literal(true) });
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

/** `isExtended`: the browser reports more than one display (Window Management API); null where it cannot tell. */
export const screenInfoSchema = z.object({ width: z.number(), height: z.number(), isExtended: z.boolean().nullable() }).partial();
export type ScreenInfo = z.infer<typeof screenInfoSchema>;

/** Connected displays as the browser reported them: 'unknown' where it cannot tell (Firefox, Safari). */
export type DisplayReport = 'single' | 'extended' | 'unknown';

export function displayReport(isExtended: unknown): DisplayReport {
  return isExtended === true ? 'extended' : isExtended === false ? 'single' : 'unknown';
}

export const deviceInfoSchema = z.object({
  cameraLabel: z.string().max(300).default(''),
  /** SHA-256 of deviceId (never the raw id). */
  cameraIdHash: z.string().max(128).default(''),
  userAgent: z.string().max(1000).default(''),
  screen: screenInfoSchema.default({}),
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
  /**
   * Attempts left if THIS attempt does not pass: `failed` after an ordinary failure, `unclear` when it fails only
   * because the pictures were not clear enough to compare (poor light, blur, distance — counted as half an attempt).
   */
  attemptsAfter?: { failed: number; unclear: number };
  /**
   * 'face' (default): camera, live-person and identity frames as below. 'attest': identity is verified by staff
   * (policy.identity.verification 'staff') — no frames are sent; with the camera on the client only confirms it works,
   * then completes the check (which usually leads to a 'staff_verification' hold).
   */
  mode?: 'face' | 'attest';
  /** Frames needed for the identity portion (frontal) — the minimum; see CheckFrameResponse.progress. */
  frontalFramesRequired: number;
  /** Upper bound of frontal frames the server accepts for this check (adaptive collection). */
  maxFrontalFrames?: number;
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
  /**
   * Adaptive frame collection: the server's running assessment after this frame. The client keeps sending
   * frontal frames while `frontalNeeded > 0` (up to StartCheckResponse.maxFrontalFrames), re-prompts any
   * liveness step whose `satisfied` is false, and calls /complete when `canComplete` is true.
   */
  progress?: CheckProgressDTO;
}

/**
 * Candidate-facing: how the collection is going, never the running identity assessment (a live verdict would let a
 * candidate abandon a check that is going badly, or tune what they show the camera). Staff see the assessment with
 * the identity check.
 */
export interface CheckProgressDTO {
  /** Usable frontal frames received so far. */
  frontalAccepted: number;
  /** More usable frontal frames wanted before the server can decide (0 = enough). */
  frontalNeeded: number;
  /** Liveness step status (index as in the challenge). */
  steps: { index: number; satisfied: boolean }[];
  /** The client may call /complete now (enough evidence either way, or limits reached). */
  canComplete: boolean;
}

/** POST /api/candidate/checks/:checkId/complete */
/**
 * Candidate-facing result of a check: the outcome, guidance and the live-person steps — never the identity decision,
 * similarity or confidence of the comparison (with the reference or the ID photo): a look-alike could use them to
 * tune their appearance across attempts. Staff see them with the identity check.
 */
export interface CompleteCheckResponse {
  outcome: 'passed' | 'retry' | 'held' | 'failed';
  message: string;
  guidance: string[];
  liveness: LivenessResultDTO | null;
  attemptsRemaining: number;
  state: CandidateSessionState;
}

/**
 * POST /api/candidate/start  (status ready -> active) => CandidateSessionState.
 * Outside the session's scheduling window: 409 `exam_window_not_open` / `exam_window_closed` (details.window); the
 * initial check (POST /api/candidate/checks, purpose 'initial') answers the same before the check-in may begin
 * (CHECK_IN_LEAD_MS before the opening) and after the closing.
 * A reconnect check started when the exam's resume policy limit is reached (policy.resume): 409 `resume_limit_reached`
 * after the exam was put on hold or ended (reload the state).
 * An exam that requires a single display (policy.browser.requireSingleDisplay) is not started while the browser reports
 * more than one: 409 `single_display_required`.
 */

/**
 * POST /api/candidate/start body. `screen`: what the browser reports about its displays at the moment of the start;
 * without it the server goes by what this browser's last check reported.
 */
export const startExamRequestSchema = z.object({ screen: screenInfoSchema.optional() });
export type StartExamRequest = z.infer<typeof startExamRequestSchema>;

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
  | { kind: 'submitted'; reason: CandidateEndReason }
  | { kind: 'require_check'; purpose: CheckPurpose; message: string }
  | { kind: 'superseded'; message: string }; // another browser instance took over

export interface HeartbeatResponse {
  serverTime: number;
  status: SessionStatus;
  remainingMs: number;
  timerRunning: boolean;
  requiredCheck: CheckPurpose | null;
  commands: CandidateCommand[];
  /**
   * Server-requested identity sample outside the routine cadence. Present (repeated on every heartbeat) until the
   * server has received a sample for it: {trigger:'exam_start', inMs:0} after the exam starts / resumes / reconnects,
   * {trigger:'server_request', inMs:0} while the identity evidence is 'suspect' and the requested faster sample is late.
   * The client takes a burst of `burstSize` frames after `inMs` with that trigger. Routine sampling follows
   * IdentitySampleResponse.nextSampleInMs.
   */
  identitySample?: IdentitySampleRequestDTO | null;
}

/** A server request for an identity sample (burst) — see HeartbeatResponse.identitySample. */
export interface IdentitySampleRequestDTO {
  trigger: IdentityCheckTrigger;
  /** Take the burst after this many ms (0 = now). */
  inMs: number;
  /** Frames in the burst (policy.identity.burstSize). */
  burstSize: number;
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
export const eventBatchRequestSchema = z.object({
  events: z.array(eventUpsertSchema).max(200),
  /** Version of the browser detectors that raised them (@sp/detection DETECTION_ENGINE_VERSION), stored on new events. */
  engineVersion: z
    .string()
    .trim()
    .max(64)
    .regex(/^[\w.+-]+$/)
    .optional(),
});
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
  /** Burst of 1–5 frames captured within ~0.6 s, sent as separate requests sharing burstId (sampleId per frame). */
  burstId: z.string().uuid().optional(),
  burstIndex: z.coerce.number().int().min(0).max(4).optional(),
  burstSize: z.coerce.number().int().min(1).max(5).optional(),
});
/**
 * Candidate-facing answer to an identity sample. It carries no identity verdict, score or evidence state — only
 * whether the image could be used and guidance about the image — so the candidate cannot watch (or probe) the
 * comparison. Staff see the decision with the identity check.
 */
export interface IdentitySampleResponse {
  /** Receipt for this request (per frame for intermediate burst frames, the burst on its last frame). */
  result: IdentitySampleReceiptDTO;
  /** The server wants the next sample sooner than the routine interval (cadence hint; no reason is given). */
  followUpInMs: number | null;
  status: SessionStatus;
  hold: HoldDTO | null;
  /** Burst bookkeeping (present when the request carried burstId). */
  burst?: { id: string; received: number; size: number; complete: boolean };
  /** Server-driven cadence: when set, send the next routine sample after this many ms. */
  nextSampleInMs?: number | null;
}

export interface IdentitySampleReceiptDTO {
  /** Identity check id (a decided sample / burst) or burst-frame id (an intermediate frame). */
  id: string;
  trigger: IdentityCheckTrigger;
  at: number;
  /** The image showed a face clearly enough to compare. Says nothing about whose face it is. */
  usable: boolean;
  /** Guidance about the image (framing, lighting) when it could not be used or the light is too poor; else empty. */
  guidance: string[];
}

/** Accumulated identity-continuity evidence (staff tooling: the camera self-test page). Never sent to candidates. */
export interface IdentityEvidenceDTO {
  /** Posterior probability that the person in view is NOT the enrolled candidate, 0..1. */
  swapProbability: number;
  state: 'consistent' | 'monitoring' | 'suspect' | 'confirmed_mismatch';
  /** Samples contributing to the current evidence window. */
  samples: number;
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
  /** Two-step sign-in set up (time it was turned on; null: not set up). */
  mfaEnabledAt?: number | null;
  /** Linked to an organisation identity provider (single sign-on; ./sso.ts). */
  ssoLinked?: boolean;
  /**
   * Created by SCIM provisioning or at a first single sign-on (just-in-time); null: created in SmartProctoring.
   * Such accounts have no password until an administrator sets one.
   */
  provisionedVia?: 'scim' | 'sso' | null;
}

export const loginRequestSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export interface SessionSummaryDTO {
  id: string;
  exam: { id: string; title: string };
  candidate: { id: string; name: string; email: string | null; externalId: string | null };
  status: SessionStatus;
  /** Includes server housekeeping reasons such as 'abandoned' (see SYSTEM_END_REASONS). */
  endReason: SessionEndReason | null;
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
  /** The exam version this attempt is pinned to (set when it starts; null before). */
  examVersion?: { id: string; number: number } | null;
  /** Kinds of the approved accommodations applied to this attempt (empty: none). Details: SessionDetailDTO.accommodations. */
  accommodations?: AccommodationKind[];
  /** Review work on this session (queue state, assignee, outcome, service-level target). */
  review?: SessionReviewSummaryDTO;
  /** Scheduling window (./scheduling.ts; null: none — the exam can be started any time). */
  window?: SessionWindow | null;
  /** Times the exam was reopened in a new browser window during the exam, since the start / last staff decision (policy.resume.maxReconnects). */
  reconnectCount?: number;
}

/** GET /api/admin/review-queue?view=&examId=&limit= */
export interface ReviewQueueDTO {
  items: SessionSummaryDTO[];
  counts: Record<QueueView, number>;
  sla: ReviewSlaSettings;
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
  /** For check-in / resume / reconnect checks: false when the live-person (liveness) part was not passed. */
  livenessPassed?: boolean | null;
  /**
   * External second opinion on this check, when the organisation enabled one (docs/EXTERNAL_VERIFIER.md). `decision`
   * above is the fused decision; `needsHumanReview` = the two opinions disagree (show it to reviewers).
   */
  secondOpinion?: IdentitySecondOpinionDTO | null;
  /** What made the decision (./governance.ts); absent for decisions made before versions were recorded. */
  versions?: IdentityDecisionVersionsDTO;
}

/** The organisation's decision configuration version and the server's calibration / recogniser model behind a decision. */
export interface IdentityDecisionVersionsDTO {
  decisionConfig: number | null;
  calibration: string | null;
  model: string | null;
}

export interface IdentitySecondOpinionDTO {
  provider: string | null;
  /** fuseWithExternal outcome, e.g. 'agree', 'resolved_by_external', 'downgraded_to_inconclusive', 'disagreement_flagged', 'external_unusable'. */
  outcome: string;
  internalDecision: IdentityDecision;
  needsHumanReview: boolean;
  /** Provider similarity 0..1 (null when it could not answer). */
  externalSimilarity: number | null;
  /** Reviewer-facing sentence naming both opinions. */
  explanation: string;
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
  /** What the browser reported about connected displays at this check. */
  displays: DisplayReport;
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
  score: SessionScoreDTO | null;
  /** Approved accommodations applied to this attempt and every exam rule they changed (null: none). */
  accommodations: SessionAccommodationsDTO | null;
  /** Identity verifications by staff (policy.identity.verification 'staff'), oldest first. */
  staffVerifications: StaffVerificationDTO[];
  /** The session's review (queue state, escalation, outcome). */
  review: SessionReviewDTO;
  /** Whether staff may reopen the exam for recovery now (POST /sessions/:id/reopen), and why (not). */
  reopen?: ReopenEligibilityDTO;
  /** What was recorded of the exam (policy.recording; ./recording.ts); null when nothing was. */
  recording?: SessionRecordingSummaryDTO | null;
}

export const STAFF_VERIFICATION_METHODS = ['video_call', 'in_person', 'id_document_on_camera', 'other'] as const;
export type StaffVerificationMethod = (typeof STAFF_VERIFICATION_METHODS)[number];
export const STAFF_VERIFICATION_METHOD_LABEL: Record<StaffVerificationMethod, string> = {
  video_call: 'Video call',
  in_person: 'In person',
  id_document_on_camera: 'ID document shown on camera',
  other: 'Other',
};

export interface StaffVerificationDTO {
  at: number;
  by: { id: string; name: string } | null;
  method: StaffVerificationMethod;
  /** The check it followed: 'initial' at check-in, else a pause / reconnection. */
  purpose: CheckPurpose | null;
  note: string | null;
}

/** An attempt's score. `regrades` (oldest first) records every administrator regrade with the score before it. */
export interface SessionScoreDTO {
  points: number;
  maxPoints: number;
  autoGraded: boolean;
  regrades: { at: number; byStaffId: string; reason: string; keysFromVersion: number; previous: { points: number; maxPoints: number } }[];
}

/** GET /api/admin/sessions/:id/events?category=&type=&severity=&review=&since= */
export const eventFilterSchema = z.object({
  category: z.enum(EVENT_CATEGORIES).optional(),
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
  /**
   * Required to release a 'staff_verification' hold: the staff member confirms they verified the candidate's identity,
   * and how (recorded as an identity_verified_by_staff event).
   */
  verification: z.object({ method: z.enum(STAFF_VERIFICATION_METHODS), note: z.string().trim().max(1000).optional() }).optional(),
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
  /** `version`: the exam version the attempt was pinned to (null when it never started). */
  exam: { id: string; title: string; durationSec: number; version?: number | null };
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
    /** The versions the session's identity decisions were made under (distinct, in order of first use); staff only. */
    versions?: { decisionConfigs: number[]; calibrations: string[]; models: string[] };
  };
  eventCounts: Record<EventCategory, { total: number; dismissed: number; reviewed: number; unreviewed: number }>;
  byType: { type: EventType; title: string; category: EventCategory; count: number; totalDurationMs: number; dismissed: number }[];
  notableEvents: EventDTO[];
  /** Narrative observations — factual, non-accusatory. */
  observations: string[];
  reviewerNotes: NoteDTO[];
  score: SessionScoreDTO | null;
  /** Approved accommodations and the exam rules they changed (null: none). */
  accommodations: SessionAccommodationsDTO | null;
  limitations: string[];
  /** The review of the session (state, outcome with its note, escalation). */
  review?: SessionReviewDTO;
  /** Flags grouped by time (./incidents.ts), oldest first. */
  incidents?: Incident[];
  /** Why each notable event was recorded (./explain.ts), by event id. */
  explanations?: Record<string, EventExplanation>;
  /** What was recorded of the exam (./recording.ts); null when nothing was. Staff only (not in the integration API). */
  recording?: SessionRecordingSummaryDTO | null;
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
  /**
   * The version candidates who start now get (null while the exam was never published). Every attempt keeps the
   * version it started with: later edits never change what a candidate already sees or how it is graded.
   */
  currentVersion: ExamVersionRefDTO | null;
}

/* ---- exam versions (immutable snapshots of what candidates see and how it is graded) */

export interface ExamVersionRefDTO {
  id: string;
  number: number;
  createdAt: number;
}

/** A question as frozen in an exam version (stable id across versions while its type is unchanged). */
export interface ExamVersionQuestionDTO {
  id: string;
  type: QuestionType;
  prompt: string;
  options: { id: string; text: string }[];
  correct: string[];
  points: number;
}

export const EXAM_VERSION_QUESTION_FIELDS = ['type', 'prompt', 'options', 'correct', 'points', 'position'] as const;
export type ExamVersionQuestionField = (typeof EXAM_VERSION_QUESTION_FIELDS)[number];
export const EXAM_VERSION_EXAM_FIELDS = ['title', 'description', 'instructions', 'durationSec', 'policy'] as const;
export type ExamVersionExamField = (typeof EXAM_VERSION_EXAM_FIELDS)[number];

/** What a version changed relative to the one before it (the first version lists every question as added). */
export interface ExamVersionChangesDTO {
  added: string[];
  removed: string[];
  changed: { questionId: string; fields: ExamVersionQuestionField[] }[];
  exam: ExamVersionExamField[];
}

export const EXAM_VERSION_REASONS = ['published', 'edited', 'started', 'migrated'] as const;
export type ExamVersionReason = (typeof EXAM_VERSION_REASONS)[number];

export interface ExamVersionSummaryDTO extends ExamVersionRefDTO {
  reason: ExamVersionReason;
  createdBy: { id: string; name: string } | null;
  /** sha256 of the canonical snapshot (null for versions created by the upgrade migration). */
  contentHash: string | null;
  changes: ExamVersionChangesDTO;
  questionCount: number;
  totalPoints: number;
  /** Attempts pinned to this version. */
  sessions: { started: number; finished: number };
  current: boolean;
}

/** GET /api/admin/exams/:id/versions/:versionId */
export interface ExamVersionDTO extends ExamVersionSummaryDTO {
  title: string;
  description: string;
  instructions: string;
  durationSec: number;
  /** The exam's own rules as stored with the version (merged with the organisation default at each start). */
  policy: Record<string, unknown>;
  questions: ExamVersionQuestionDTO[];
}

/* ---- exam export / import (GET /api/admin/exams/:id/export, POST /api/admin/exams/import) */

export const EXAM_EXPORT_FORMAT = 'smartproctoring.exam';
export const EXAM_EXPORT_FORMAT_VERSION = 1;

/** A portable exam document: questions with answer keys, duration and the exam's own rules. Imported as a new draft. */
export const examExportSchema = z.object({
  format: z.literal(EXAM_EXPORT_FORMAT),
  formatVersion: z.literal(EXAM_EXPORT_FORMAT_VERSION),
  exportedAt: z.number().optional(),
  /** Where it came from (informational; never used to link the import to the source). */
  source: z.object({ examId: z.string().optional(), version: z.number().int().nullable().optional(), title: z.string().optional() }).optional(),
  exam: examInputSchema,
});
export type ExamExport = z.infer<typeof examExportSchema>;

/* ---- regrade (POST /api/admin/exams/:id/regrade) */

/**
 * Re-score the finished attempts pinned to `sessionsOnVersionId` with the answer keys and points of
 * `keysFromVersionId` (e.g. a corrected answer key). Prompts and options stay what the candidates saw; questions the
 * keys version does not have keep their original key. Without `apply` it only previews.
 */
export const regradeRequestSchema = z.object({
  sessionsOnVersionId: z.string().uuid(),
  keysFromVersionId: z.string().uuid(),
  apply: z.boolean().default(false),
  reason: z.string().trim().min(1).max(1000),
});
export type RegradeRequest = z.infer<typeof regradeRequestSchema>;

export interface RegradeResultDTO {
  /** Whether scores were written (only with `apply`, and only for attempts whose score changes). */
  applied: boolean;
  /** Questions whose key or points differ between the two versions (by id). */
  changedQuestions: { questionId: string; prompt: string; correct: { from: string[]; to: string[] }; points: { from: number; to: number } }[];
  /** Every finished attempt on the version; `changed`: its score differs with the new keys (only those are regraded). */
  sessions: { sessionId: string; candidateName: string; before: { points: number; maxPoints: number }; after: { points: number; maxPoints: number }; changed: boolean }[];
  /** Attempts on the version that have not finished yet: they are graded with their own version's keys when they finish. */
  inProgress: number;
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
export const assignRequestSchema = z.object({
  candidateIds: z.array(z.string()).min(1).max(1000),
  /** Scheduling window for the new sessions (./scheduling.ts). A candidate's existing unfinished session keeps its own window. */
  window: sessionWindowInputSchema.optional(),
});
export interface AssignmentDTO {
  sessionId: string;
  candidateId: string;
  candidateName: string;
  accessLink: string;
  /** true when the candidate already had a not-yet-finished session for this exam (no new session was created; its link is returned). */
  existing?: boolean;
  /** The session's scheduling window (an existing session keeps its own; null: none). */
  window?: SessionWindow | null;
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
  /** The identity thresholds in use: those of the active decision configuration (./governance.ts; read-only here). */
  identityThresholds: { match: number; mismatch: number; idPhotoMatch: number; idPhotoMismatch: number; mismatchConfirmations: number };
  /** Version of the active decision configuration (GET /api/admin/decision-configs). */
  decisionConfigVersion: number;
  /**
   * Invited / ready / paused sessions with no activity for this many days are closed automatically
   * (status 'terminated', endReason 'abandoned'; answers kept, no score). Default 30.
   */
  abandonAfterDays: number;
  /** Staff email addresses that receive alert emails (only when the server has SMTP configured). */
  alertRecipients: string[];
  /** Which alerts are emailed to alertRecipients (throttled to one email per session per 5 minutes). */
  emailAlerts: EmailAlertToggles;
  /** Optional external second-opinion face verifier (./verifiers.ts, docs/EXTERNAL_VERIFIER.md). Off by default. */
  externalVerifier: ExternalVerifierSettingsDTO;
  /** Who must use two-step sign-in (./mfa.ts). Only an owner can change it. */
  requireMfa: MfaRequirement;
  /** Service-level targets for review work (./review.ts): decide held exams within minutes, flags within hours. */
  reviewSla: ReviewSlaSettings;
  /**
   * Storage location for new evidence images (./residency.ts; `default` unless an owner chose another one of the
   * server's locations, GET /evidence-storage). Only an owner can change it.
   */
  evidenceLocation: string;
  /**
   * Staff other than owners must sign in with single sign-on (./sso.ts); password sessions of other staff end. Only an
   * owner can change it, and only while an identity provider is enabled.
   */
  requireSso: boolean;
}

export interface EmailAlertToggles {
  /** Exam put on hold (identity review, pause limit, staff hold...). */
  holds: boolean;
  /** Candidate requested a pause that needs approval. */
  pauseRequests: boolean;
  /** High-severity potential integrity events (e.g. possible different person, phone visible). */
  highSeverity: boolean;
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
    /** Reviewed as "inconclusive" (the reviewer could not tell): excluded from precision. */
    inconclusive: number;
    /** Decisions by resolution (./review.ts); events decided with a plain status are not listed. */
    byResolution: Partial<Record<ReviewResolution, number>>;
    /** Events whose decision another reviewer changed (reviewer disagreement). */
    overridden: number;
    /** correct / (correct + false detections), "inconclusive" excluded; null if no decisions. Production precision proxy. */
    precision: number | null;
  }[];
  identity: {
    checks: number;
    byDecision: Record<IdentityDecision, number>;
    byTrigger: Record<string, Record<IdentityDecision, number>>;
    mismatchEventsDismissed: number;
    /** Kept by a reviewer with a conclusion ("inconclusive" not counted). */
    mismatchEventsConfirmed: number;
    mismatchEventsInconclusive: number;
  };
  /** Reviewer agreement over the period: decisions on flags, and how many changed another reviewer's decision. */
  reviewers: { decisions: number; overrides: number; overrideRate: number | null };
  offlineEvaluation: unknown | null; // { reports: [{ id, kind, createdAt, global, report }] } — latest per kind (see docs/accuracy/)
}

export interface AuditLogEntryDTO {
  id: string;
  at: number;
  /** 'api_key': an organisation API key used on the integration API (/api/v1); actorId is the key id. */
  actorType: 'staff' | 'candidate' | 'system' | 'api_key' | 'scim';
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
  | { type: 'pause_request'; sessionId: string; request: PauseRequestDTO }
  /** A staff note was added to a session (session-level notes; event notes arrive as 'event' updates). */
  | { type: 'note'; sessionId: string; note: NoteDTO };

export const ACCESS_LINK_PATH = '/take/'; // full link: `${PUBLIC_URL}/take/${accessToken}`

export type { IdentityCheckTrigger };

/* =================================================================== staff endpoint index
 *
 * Auth (no prefix):
 *   POST /api/auth/login   {email,password}        -> { user, org, security } | MfaChallengeResponse (two-step sign-in)
 *   POST /api/auth/login/mfa {code}|{recoveryCode}  -> { user, org, security }   (needs the challenge cookie)
 *   POST /api/auth/logout                          -> { ok: true }
 *   GET  /api/auth/me                              -> { user: StaffUserDTO, org: StaffOrgDTO, security: StaffSecurityDTO }   (401 if not logged in; org.kind / org.sandbox: ./quotas.ts)
 *   POST /api/auth/mfa/totp/setup                  -> TotpSetupDTO        (allowed while enrolment is required)
 *   POST /api/auth/mfa/totp/confirm {code,currentCode?} -> RecoveryCodesDTO
 *   POST /api/auth/mfa/recovery-codes {code}       -> RecoveryCodesDTO
 *   POST /api/auth/mfa/disable {password,code}     -> { ok }   (409 when the organisation requires it)
 *   POST /api/admin/users/:id/mfa/reset            -> StaffUserDTO   [admin; an owner's only by an owner; not oneself]
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
 *   POST /sessions/:id/reschedule {window:{startsAt,endsAt},note?} -> SessionSummaryDTO (not started yet; 409 already_started) [admin]
 *   POST /sessions/:id/reopen {reason,addMinutes}  -> SessionSummaryDTO   (ended exam, for recovery; 409 + ReopenRefusal code) [admin]
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
 *   POST /exams/:id/assignments {candidateIds,window?} -> { items: AssignmentDTO[] }                [admin]
 *   GET  /candidates?q=                            -> { items: CandidateDTO[] }                     [reviewer]
 *   POST /candidates  CandidateInput               -> CandidateDTO                                  [admin]
 *   GET  /candidates/:id                           -> CandidateDTO                                  [reviewer]
 *   PUT  /candidates/:id  CandidateInput           -> CandidateDTO                                  [admin]
 *   DELETE /candidates/:id                         -> { ok }  (refused while a session is active or under legal hold) [admin]
 *   PUT  /candidates/:id/id-photo  (image/jpeg)    -> IdPhotoUploadResponse                         [admin]
 *   DELETE /candidates/:id/id-photo                -> CandidateDTO                                  [admin]
 *   GET  /settings                                 -> OrgSettingsDTO                                [admin]
 *   PUT  /settings  Partial<OrgSettingsDTO>        -> OrgSettingsDTO                                [admin; requireMfa and evidenceLocation: owner]
 *   GET  /evidence-storage                         -> EvidenceStorageDTO  (storage locations, the choice, images per location; ./residency.ts) [admin]
 *   GET  /usage                                    -> OrgUsageDTO  (kind, quotas set by the operator and this month's usage; ./quotas.ts) [admin]
 *        (POST /exams, /exams/import, /candidates and /exams/:id/assignments answer 409 quota_exceeded with QuotaExceededDetails at a limit)
 *   GET  /users                                    -> { items: StaffUserDTO[] }                     [admin]
 *   POST /users {email,name,role,password}         -> StaffUserDTO                                  [admin; only owner may create owner/admin]
 *   PUT  /users/:id {name?,role?,disabled?,password?} -> StaffUserDTO                               [admin]
 *   GET  /audit-log?limit=&offset=&action=         -> Paged<AuditLogEntryDTO>                       [admin]
 *   GET  /metrics/detection-quality?from=&to=      -> DetectionQualityDTO                           [reviewer]
 *   POST /metrics/offline-evaluation  (JSON report from an eval CLI, or {kind, report}) -> { id, kind, createdAt } [admin]
 *        (DetectionQualityDTO.offlineEvaluation is then { reports: [{ id, kind, createdAt, global, report }] })
 *   POST /tools/identity-test?testId=&mode=enroll|probe|reset  (image/jpeg) -> IdentityTestResponse (camera self-test; nothing stored) [reviewer]
 *   WS   /live                                    -> LiveMessage frames                            [reviewer]
 *
 *   Integrations (types in ./integrations.ts; public integration API /api/v1/* documented in docs/INTEGRATION_API.md,
 *   its endpoint catalogue INTEGRATION_ENDPOINTS in ./integrations.ts and the OpenAPI document GET /api/v1/openapi.json):
 *   GET  /integrations/status                      -> IntegrationStatusDTO                          [admin]
 *   GET  /api-keys                                 -> { items: ApiKeyDTO[] }  (with scopes, expiresAt) [admin]
 *   POST /api-keys {name, scopes?, expiresAt?}     -> CreatedApiKeyDTO  (secret shown once; scopes default to all, expiresAt to never) [admin]
 *   POST /api-keys/:id/revoke                      -> ApiKeyDTO                                     [admin]
 *   GET  /webhooks                                 -> { items: WebhookDTO[] }                       [admin]
 *   POST /webhooks  WebhookInput                   -> CreatedWebhookDTO  (secret shown once)        [admin]
 *   GET  /webhooks/:id                             -> WebhookDTO                                    [admin]
 *   PUT  /webhooks/:id  WebhookUpdate              -> WebhookDTO   (active=true re-enables and resets the failure count) [admin]
 *   DELETE /webhooks/:id                           -> { ok: true }                                  [admin]
 *   POST /webhooks/:id/rotate-secret               -> CreatedWebhookDTO                             [admin]
 *   POST /webhooks/:id/test                        -> WebhookDeliveryDTO  (sends a 'ping' now)      [admin]
 *   GET  /webhooks/:id/deliveries                  -> { items: WebhookDeliveryDTO[] } (latest 100)  [admin]
 *   GET  /webhooks/deliveries/:id                  -> WebhookDeliveryDTO (with payload)             [admin]
 *   POST /webhooks/deliveries/:id/redeliver        -> WebhookDeliveryDTO  (same delivery id, attempted now) [admin]
 *   POST /email-alerts/test {to?}                  -> { ok: true, recipients: string[] }  (409 smtp_not_configured) [admin]
 *   (email alert recipients/toggles and abandonAfterDays are part of GET/PUT /settings)
 *
 *   Privacy operations (types in ./privacy-ops.ts; admin and owner only):
 *   GET  /privacy-requests?status=open|closed|all&candidateId= -> PrivacyRequestsDTO                [admin]
 *   POST /privacy-requests  CreatePrivacyRequest   -> PrivacyRequestDTO                             [admin]
 *   GET  /privacy-requests/:id                     -> PrivacyRequestDTO                             [admin]
 *   PUT  /privacy-requests/:id  UpdatePrivacyRequest -> PrivacyRequestDTO (status, assignee, extension, resolution) [admin]
 *   GET  /privacy-requests/:id/export              -> application/zip  (the candidate's data; audited) [admin]
 *   POST /privacy-requests/:id/erase {confirm:true} -> { request, sessionsDeleted, evidencePurged }  (erasure requests) [admin]
 *   GET  /retention/preview?days=                  -> RetentionPreviewDTO                           [admin]
 *   GET  /ops/checks                               -> OpsChecksDTO                                  [admin]
 *   (candidate: POST /api/candidate/consent/withdraw WithdrawConsentRequest -> CandidateSessionState: ends the exam, deletes its face images)
 *
 *   External second-opinion face verifier (types in ./verifiers.ts; settings = OrgSettingsDTO.externalVerifier):
 *   GET  /verifiers                                -> ExternalVerifierInfoDTO                       [admin]
 *   POST /verifiers/test  (image/jpeg)             -> ExternalVerifierTestResultDTO (image vs itself, saved settings) [admin]
 *
 *   Single sign-on and SCIM (types in ./sso.ts; requireSso = OrgSettingsDTO.requireSso via PUT /settings, owner only):
 *   GET  /sso                                      -> SsoOverviewDTO (providers, requireSso, SCIM status)   [admin]
 *   POST /sso/providers  IdentityProviderInput     -> IdentityProviderDTO  (409 sso_domain_taken)  [owner]
 *   PUT  /sso/providers/:id  IdentityProviderInput -> IdentityProviderDTO  (kind fixed; clientSecret omitted = kept, null = removed) [owner]
 *   DELETE /sso/providers/:id                      -> { ok }  (ends its sessions; 409 while it is the last one and SSO is required) [owner]
 *   POST /sso/providers/:id/test                   -> SsoTestResultDTO  (OIDC: discovery + JWKS; SAML: certificates) [admin]
 *   GET  /scim/token                               -> ScimStatusDTO                                 [admin]
 *   POST /scim/token                               -> CreatedScimTokenDTO (secret shown once; replaces the active token) [owner]
 *   DELETE /scim/token                             -> ScimStatusDTO                                 [owner]
 *   POST /users/:id/sso/unlink                     -> StaffUserDTO  (removes its identity-provider links, signs it out) [admin]
 *   Public, no staff session (prefix /api/auth/sso):
 *   POST /discover {email, next?}                  -> SsoDiscoverResponse | 404 sso_not_configured
 *   GET  /:providerId/start?next=&login_hint=      -> 302 to the identity provider (sp_sso browser-binding cookie)
 *   GET  /oidc/:providerId/callback                -> 303 to `next` (signed in) or /admin/login?sso_error=<SsoErrorCode>
 *   POST /saml/:providerId/acs  (form: SAMLResponse) -> 303 /api/auth/sso/complete?attempt=…  (the only cross-site form post)
 *   GET  /complete?attempt=                        -> 303 to `next` (signed in, same browser only) or /admin/login?sso_error=…
 *   GET  /saml/:providerId/metadata                -> SP metadata (application/samlmetadata+xml)
 *   SCIM 2.0 (prefix /scim/v2, `Authorization: Bearer sp_scim_…`, application/scim+json): GET /ServiceProviderConfig,
 *   /ResourceTypes, /Schemas; GET /Users?filter=userName eq "…"&startIndex=&count=, POST /Users, GET|PUT|PATCH|DELETE /Users/:id
 *   POST /api/auth/login answers 403 sso_required (after the right password) for non-owners when SSO is required.
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
  /**
   * Read-only: thresholds change through a decision configuration (POST /api/admin/decision-configs, approved by a
   * second administrator). Sending the values in use is accepted (a settings form posting everything back); any other
   * value is refused with 409 decision_config_required.
   */
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
  abandonAfterDays: z.number().int().min(1).max(3650).optional(),
  alertRecipients: z.array(z.string().trim().email().max(254)).max(20).optional(),
  emailAlerts: z.object({ holds: z.boolean(), pauseRequests: z.boolean(), highSeverity: z.boolean() }).partial().optional(),
  externalVerifier: externalVerifierUpdateSchema.optional(),
  /** Owner only. */
  requireMfa: z.enum(MFA_REQUIREMENTS).optional(),
  /** Owner only; needs an enabled identity provider. */
  requireSso: z.boolean().optional(),
  reviewSla: reviewSlaSchema.partial().optional(),
  /** Owner only: one of the server's storage locations (GET /evidence-storage); 400 unknown_storage_location otherwise. */
  evidenceLocation: evidenceLocationSchema.optional(),
});
export const legalHoldSchema = z.object({ enabled: z.boolean() });
export const staffSubmitSchema = z.object({ note: z.string().max(1000).optional() });
/**
 * Staff camera self-test (no data stored; transient in-memory gallery per staff user, 15 min TTL):
 *   POST /api/admin/tools/identity-test?testId=<uuid>&mode=enroll|probe|reset   body image/jpeg (none for reset)
 * Lets an operator validate the identity pipeline with their own webcam: enroll a person, then probe with
 * the same or another person and see quality, similarity and the decision the exam would make.
 */
export interface IdentityTestResponse {
  testId: string;
  mode: 'enroll' | 'probe' | 'reset';
  quality: FaceQuality | null;
  guidance: string[];
  enrolledFrames: number;
  /** Probe only: similarity to the enrolled template (max over gallery / template, as the engine uses). */
  similarity: number | null;
  decision: IdentityDecision | null;
  /** Probe only: per-sample log-likelihood ratio (positive = evidence of a different person). */
  llr: number | null;
  /** Probe only: accumulated evidence across the probes of this test (resets on enroll). */
  evidence: IdentityEvidenceDTO | null;
  timingsMs: { analyze: number };
}

export const extendTimeSchema = z.object({ minutes: z.number().int().min(1).max(24 * 60), note: z.string().max(1000).optional() });
