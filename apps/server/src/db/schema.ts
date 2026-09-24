/**
 * Postgres schema (drizzle). All timestamps are timestamptz (JS Date); DTOs convert to epoch ms.
 * After editing this file run `pnpm --filter @sp/server db:generate` to produce a SQL migration in ./drizzle.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AnswerValue,
  CandidateCommand,
  CheckPurpose,
  ConnectionStatus,
  DeviceInfo,
  EmailAlertToggles,
  EventCategory,
  EventSource,
  EventType,
  FaceQuality,
  HoldReason,
  IdentityCheckTrigger,
  IdentityDecision,
  LivenessAction,
  LivenessResultDTO,
  MonitoringStatus,
  PeriodKind,
  ProctoringPolicyInput,
  QuestionType,
  ReviewStatus,
  SessionEndReason,
  SessionStatus,
  Severity,
  StaffRole,
  WebhookDeliveryStatus,
  WebhookDeliveryType,
  WebhookEventType,
} from '@sp/shared';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

/* ------------------------------------------------------------------ organisation & staff */

export interface OrgSettings {
  evidenceRetentionDays: number;
  eventRetentionDays: number;
  defaultPolicy: ProctoringPolicyInput;
  privacyContact: string;
  identityThresholds: { match: number; mismatch: number; idPhotoMatch: number; idPhotoMismatch: number; mismatchConfirmations: number };
  /** Close invited/ready/paused sessions after this many days without activity (endReason 'abandoned'). */
  abandonAfterDays: number;
  /** Email alert recipients (used only when SMTP is configured). */
  alertRecipients: string[];
  emailAlerts: EmailAlertToggles;
}

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  settings: jsonb('settings').$type<Partial<OrgSettings>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const staffUsers = pgTable(
  'staff_users',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').$type<StaffRole>().notNull(),
    passwordHash: text('password_hash').notNull(),
    disabled: boolean('disabled').notNull().default(false),
    lastLoginAt: ts('last_login_at'),
    passwordChangedAt: ts('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('staff_users_email_uq').on(sql`lower(${t.email})`), index('staff_users_org_idx').on(t.orgId)],
);

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: id(),
    /** sha256 hex of the random session token carried in the (signed) cookie. */
    tokenHash: text('token_hash').notNull(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [uniqueIndex('staff_sessions_token_uq').on(t.tokenHash), index('staff_sessions_user_idx').on(t.staffUserId)],
);

/**
 * Per-account failed-login backoff (routes/auth.ts, services/login-throttle.ts). Keyed by sha256 of the
 * normalised email that was TRIED — whether or not such an account exists — so the backoff never reveals
 * which addresses are registered. Independent of the client IP.
 */
export const loginThrottle = pgTable(
  'login_throttle',
  {
    /** sha256 hex of `login:<lower-case email>`. */
    key: text('key').primaryKey(),
    /** Consecutive failed attempts (reset after LOGIN_FAILURE_WINDOW_MS without a failure, or on success). */
    failures: integer('failures').notNull().default(0),
    lastFailureAt: ts('last_failure_at').notNull(),
    /** No password is checked for this address before this instant (429). */
    lockedUntil: ts('locked_until'),
  },
  (t) => [index('login_throttle_last_failure_idx').on(t.lastFailureAt)],
);

/* ------------------------------------------------------------------ exams */

/** exam_sessions.instance_usage (services/instance-usage.ts). Hashes only — never raw IP addresses or user agents. */
export interface InstanceUsage {
  /** The verified instance this record describes (reset when another instance is verified). */
  instanceId: string;
  /** sha256 prefix of the User-Agent first seen for this instance. */
  uaHash: string;
  /** Recent runs of consecutive requests from one network (sha256 prefix of the /24 or /64), newest last. */
  nets: { net: string; firstAt: number; lastAt: number }[];
  /** Distinct client IP hashes (sha256 prefix) seen for this instance, newest last (max 6). */
  ipHashes: string[];
  /** Heartbeat `seq` streams: each is the last seq of one monotonic sequence; `cur` is the stream used last. */
  seq: { streams: { last: number; at: number }[]; cur: number } | null;
}

export const exams = pgTable(
  'exams',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    durationSec: integer('duration_sec').notNull(),
    policy: jsonb('policy').$type<ProctoringPolicyInput>().notNull().default({}),
    status: text('status').$type<'draft' | 'published' | 'archived'>().notNull().default('draft'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('exams_org_idx').on(t.orgId)],
);

export interface QuestionOption {
  id: string;
  text: string;
}

export const questions = pgTable(
  'questions',
  {
    id: id(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    type: text('type').$type<QuestionType>().notNull(),
    prompt: text('prompt').notNull(),
    options: jsonb('options').$type<QuestionOption[]>().notNull().default([]),
    /** Never sent to candidates. */
    correct: jsonb('correct').$type<string[]>().notNull().default([]),
    points: doublePrecision('points').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('questions_exam_idx').on(t.examId, t.position)],
);

/* ------------------------------------------------------------------ candidates */

export const candidates = pgTable(
  'candidates',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    externalId: text('external_id'),
    /** Evidence row (kind id_photo) holding the encrypted approved ID photo. */
    idPhotoEvidenceId: uuid('id_photo_evidence_id'),
    /** Encrypted serialized SFace embedding(s) of the ID photo (see lib/crypto + vision serializeEmbeddings). */
    idPhotoEmbedding: bytea('id_photo_embedding'),
    idPhotoQuality: jsonb('id_photo_quality').$type<FaceQuality>(),
    idPhotoApprovedAt: ts('id_photo_approved_at'),
    idPhotoApprovedBy: uuid('id_photo_approved_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('candidates_org_idx').on(t.orgId), index('candidates_email_idx').on(t.orgId, t.email)],
);

/* ------------------------------------------------------------------ exam sessions */

/** Server-side identity aggregation state (ARCHITECTURE §4.5). */
export interface IdentityEngineState {
  consecutiveMatch: number;
  consecutiveMismatch: number;
  /** Consecutive unable_to_verify / inconclusive samples. */
  consecutiveUnable: number;
  openMismatchEventId: string | null;
  openUnverifiableEventId: string | null;
  openFeedSuspectEventId: string | null;
  lastSampleDhash: string | null;
  /** Number of consecutive samples (including the latest) with an identical dHash. */
  identicalDhashStreak: number;
  lastMatchAt: number | null;
  followUpRequestedAt: number | null;
  /** Identity check ids that contributed to the currently pending/open mismatch. */
  pendingMismatchCheckIds: string[];
}

export type SessionMonitoring = MonitoringStatus & { at: number; fps?: number; cameraState?: string; visibility?: string; fullscreen?: boolean };

export interface SessionScore {
  points: number;
  maxPoints: number;
  autoGraded: boolean;
  gradedAt: number;
  perQuestion: { questionId: string; points: number; maxPoints: number; correct: boolean | null }[];
}

export const examSessions = pgTable(
  'exam_sessions',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'cascade' }),
    /** sha256 hex of the candidate access token. */
    accessTokenHash: text('access_token_hash').notNull(),
    /** AES-GCM encrypted access token so staff can re-copy the link. */
    accessTokenEnc: bytea('access_token_enc'),
    status: text('status').$type<SessionStatus>().notNull().default('invited'),
    endReason: text('end_reason').$type<SessionEndReason>(),
    /** Policy snapshot taken when the exam starts (null => use exam policy). */
    policy: jsonb('policy').$type<ProctoringPolicyInput>(),
    durationMs: integer('duration_ms').notNull(),
    usedMs: integer('used_ms').notNull().default(0),
    runningSince: ts('running_since'),
    currentQuestionIndex: integer('current_question_index').notNull().default(0),
    consentAcceptedAt: ts('consent_accepted_at'),
    consentNoticeVersion: text('consent_notice_version'),
    consentIp: text('consent_ip'),
    consentUserAgent: text('consent_user_agent'),
    /** Browser instance currently in control (latest to start a check). */
    activeInstanceId: text('active_instance_id'),
    /** Browser instance that passed the latest check. */
    verifiedInstanceId: text('verified_instance_id'),
    lastHeartbeatAt: ts('last_heartbeat_at'),
    lastHeartbeatInstanceId: text('last_heartbeat_instance_id'),
    /** Last heartbeat from the verified instance (start of a retroactive 'disconnected' period on reconnect). */
    lastVerifiedHeartbeatAt: ts('last_verified_heartbeat_at'),
    /**
     * Where the verified browser instance's requests come from (hashed networks / user agent, heartbeat `seq`
     * streams): concurrent use of a copied instance id is detected from it (services/instance-usage.ts).
     */
    instanceUsage: jsonb('instance_usage').$type<InstanceUsage>(),
    connection: text('connection').$type<ConnectionStatus>().notNull().default('never_connected'),
    reportingInterruptedSince: ts('reporting_interrupted_since'),
    /** Open reporting_interrupted event while offline. */
    reportingEventId: uuid('reporting_event_id'),
    monitoring: jsonb('monitoring').$type<SessionMonitoring>(),
    identityState: jsonb('identity_state').$type<Partial<IdentityEngineState>>().notNull().default({}),
    lastIdentityDecision: text('last_identity_decision').$type<IdentityDecision>(),
    lastIdentityAt: ts('last_identity_at'),
    lastIdentitySimilarity: doublePrecision('last_identity_similarity'),
    holdReason: text('hold_reason').$type<HoldReason>(),
    holdSince: ts('hold_since'),
    holdMessage: text('hold_message'),
    holdCanReverify: boolean('hold_can_reverify').notNull().default(false),
    /** Status to return to when a hold that did not interrupt an exam is released (e.g. 'ready'). */
    holdPrevStatus: text('hold_prev_status').$type<SessionStatus>(),
    reEnrollAuthorized: boolean('re_enroll_authorized').notNull().default(false),
    reEnrollAuthorizedBy: uuid('re_enroll_authorized_by'),
    /** Failed ('retry') check attempts are counted from this instant. */
    checkAttemptsResetAt: ts('check_attempts_reset_at'),
    pauseCount: integer('pause_count').notNull().default(0),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    legalHold: boolean('legal_hold').notNull().default(false),
    evidencePurgedAt: ts('evidence_purged_at'),
    score: jsonb('score').$type<SessionScore>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exam_sessions_token_uq').on(t.accessTokenHash),
    index('exam_sessions_org_status_idx').on(t.orgId, t.status),
    index('exam_sessions_exam_idx').on(t.examId),
    index('exam_sessions_candidate_idx').on(t.candidateId),
    // Sweeper look-ups (jobs/sweeper.ts). Neither index contains a column the routine heartbeat writes
    // (last_heartbeat_at, monitoring, ...), so heartbeat updates stay HOT (no index maintenance per heartbeat).
    index('exam_sessions_online_idx').on(t.status).where(sql`${t.connection} = 'online'`),
    index('exam_sessions_running_idx').on(t.status).where(sql`${t.runningSince} is not null`),
  ],
);

/** Per-session queue of commands delivered to the candidate browser with the next heartbeat. */
export const sessionCommands = pgTable(
  'session_commands',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    /** null => any instance that is in control; otherwise only this instance. */
    targetInstanceId: text('target_instance_id'),
    command: jsonb('command').$type<CandidateCommand>().notNull(),
    createdAt: ts('created_at').notNull(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [index('session_commands_pending_idx').on(t.sessionId, t.deliveredAt)],
);

export const sessionPeriods = pgTable(
  'session_periods',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<PeriodKind>().notNull(),
    observed: boolean('observed').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    reason: text('reason'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('session_periods_session_idx').on(t.sessionId, t.startedAt)],
);

export const pauseRequests = pgTable(
  'pause_requests',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    requestedAt: ts('requested_at').notNull(),
    reason: text('reason'),
    status: text('status').$type<'pending' | 'approved' | 'denied' | 'cancelled'>().notNull().default('pending'),
    decidedAt: ts('decided_at'),
    decidedBy: uuid('decided_by'),
    decisionNote: text('decision_note'),
  },
  (t) => [index('pause_requests_session_idx').on(t.sessionId, t.requestedAt)],
);

/* ------------------------------------------------------------------ identity */

export const identityReferences = pgTable(
  'identity_references',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id').notNull(),
    version: integer('version').notNull(),
    /** Encrypted serialized embeddings (null once purged). */
    embeddingsEnc: bytea('embeddings_enc'),
    embeddingCount: integer('embedding_count').notNull(),
    quality: jsonb('quality').$type<FaceQuality>(),
    liveness: jsonb('liveness').$type<LivenessResultDTO>(),
    idPhoto: jsonb('id_photo').$type<{ decision: IdentityDecision; similarity: number | null }>(),
    /** Evidence ids (kind identity_reference): [full frame, face crop]. */
    imageEvidenceIds: jsonb('image_evidence_ids').$type<string[]>().notNull().default([]),
    /** Scene/device context at enrolment (brightness, camera) for neutral environment comparisons. */
    environment: jsonb('environment').$type<{ imageBrightness: number | null; faceBrightness: number | null; cameraLabel: string; cameraIdHash: string }>(),
    checkId: uuid('check_id'),
    /** Staff member who authorised a re-enrolment (null for the initial reference). */
    authorizedBy: uuid('authorized_by'),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull(),
    supersededAt: ts('superseded_at'),
    supersededReason: text('superseded_reason'),
    supersededBy: uuid('superseded_by'),
    purgedAt: ts('purged_at'),
  },
  (t) => [index('identity_references_session_idx').on(t.sessionId, t.version)],
);

export interface CheckLivenessSpec {
  challengeId: string;
  steps: { index: number; action: LivenessAction | 'center'; instruction: string }[];
  targetYawDeg: number;
  targetPitchDeg: number;
}

export const checks = pgTable(
  'checks',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<CheckPurpose>().notNull(),
    clientInstanceId: text('client_instance_id').notNull(),
    device: jsonb('device').$type<DeviceInfo>().notNull(),
    status: text('status').$type<'open' | 'passed' | 'retry' | 'held' | 'failed' | 'expired'>().notNull().default('open'),
    attempt: integer('attempt').notNull().default(1),
    liveness: jsonb('liveness').$type<CheckLivenessSpec | null>(),
    nonce: text('nonce').notNull(),
    issuedAt: ts('issued_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    completedAt: ts('completed_at'),
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [index('checks_session_idx').on(t.sessionId, t.issuedAt), index('checks_open_idx').on(t.status, t.expiresAt)],
);

export interface FrameAnalysisSummary {
  faceCount: number;
  quality: FaceQuality;
  pose: { yawDeg: number; pitchDeg: number; rollDeg: number } | null;
  dhash: string;
  imageBrightness: number;
  width: number;
  height: number;
  box: { x: number; y: number; w: number; h: number } | null;
  landmarks: { x: number; y: number }[] | null;
  score: number | null;
}

export const checkFrames = pgTable(
  'check_frames',
  {
    id: id(),
    checkId: uuid('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    /** Server receipt order (liveness is verified in receipt order, not client timestamps). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    /** 'frontal' or the liveness step index as a string. */
    step: text('step').notNull(),
    action: text('action').$type<LivenessAction | 'center'>().notNull(),
    capturedAt: ts('captured_at').notNull(),
    receivedAt: ts('received_at').notNull(),
    analysis: jsonb('analysis').$type<FrameAnalysisSummary>().notNull(),
    /** Encrypted serialized embedding of the primary face (null if no face). */
    embeddingEnc: bytea('embedding_enc'),
    evidenceId: uuid('evidence_id'),
    faceCropEvidenceId: uuid('face_crop_evidence_id'),
    clientYaw: doublePrecision('client_yaw'),
    clientPitch: doublePrecision('client_pitch'),
  },
  (t) => [index('check_frames_check_idx').on(t.checkId, t.seq)],
);

export interface IdentityCheckContext {
  precededBy: string[];
  periodKind: PeriodKind | null;
  secondsSincePreviousMatch: number | null;
  [k: string]: unknown;
}

export const identityChecks = pgTable(
  'identity_checks',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    /** Client sample id (idempotency); null for check-based decisions. */
    sampleId: text('sample_id'),
    checkId: uuid('check_id'),
    trigger: text('trigger').$type<IdentityCheckTrigger>().notNull(),
    decision: text('decision').$type<IdentityDecision>().notNull(),
    similarity: doublePrecision('similarity'),
    confidence: doublePrecision('confidence').notNull(),
    quality: jsonb('quality').$type<FaceQuality | null>(),
    guidance: jsonb('guidance').$type<string[]>().notNull().default([]),
    at: ts('at').notNull(),
    receivedAt: ts('received_at').notNull(),
    probeEvidenceId: uuid('probe_evidence_id'),
    frameEvidenceId: uuid('frame_evidence_id'),
    referenceId: uuid('reference_id'),
    dhash: text('dhash'),
    clientInstanceId: text('client_instance_id'),
    context: jsonb('context').$type<IdentityCheckContext>().notNull().default({ precededBy: [], periodKind: null, secondsSincePreviousMatch: null }),
    eventId: uuid('event_id'),
    /** Stored response for idempotent replays of the same sampleId. */
    response: jsonb('response').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('identity_checks_sample_uq').on(t.sessionId, t.sampleId),
    index('identity_checks_session_idx').on(t.sessionId, t.at),
    index('identity_checks_event_idx').on(t.eventId),
  ],
);

/* ------------------------------------------------------------------ events & evidence */

export const events = pgTable(
  'events',
  {
    /** Client episode id, or server-generated. */
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    type: text('type').$type<EventType>().notNull(),
    category: text('category').$type<EventCategory>().notNull(),
    severity: text('severity').$type<Severity>().notNull(),
    source: text('source').$type<EventSource>().notNull(),
    status: text('status').$type<'open' | 'closed'>().notNull(),
    title: text('title').notNull(),
    observation: text('observation').notNull(),
    startedAt: ts('started_at').notNull(),
    endedAt: ts('ended_at'),
    confidence: doublePrecision('confidence'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    version: integer('version').notNull().default(1),
    clientInstanceId: text('client_instance_id'),
    firstReceivedAt: ts('first_received_at').notNull(),
    receivedAt: ts('received_at').notNull(),
    deliveredLate: boolean('delivered_late').notNull().default(false),
    reviewStatus: text('review_status').$type<ReviewStatus>().notNull().default('unreviewed'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    reviewNote: text('review_note'),
  },
  (t) => [
    index('events_session_started_idx').on(t.sessionId, t.startedAt),
    index('events_category_idx').on(t.category),
    index('events_review_idx').on(t.reviewStatus),
    index('events_org_received_idx').on(t.orgId, t.receivedAt),
    index('events_type_idx').on(t.type),
  ],
);

export type EvidenceKind = 'event_screenshot' | 'identity_probe' | 'identity_reference' | 'id_photo' | 'liveness_frame';

export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    sessionId: uuid('session_id'),
    candidateId: uuid('candidate_id'),
    /** Not a foreign key: evidence may arrive before its event. */
    eventId: uuid('event_id'),
    identityCheckId: uuid('identity_check_id'),
    kind: text('kind').$type<EvidenceKind>().notNull(),
    /** Capture reason (onset/peak/periodic/end, face_crop, frame, ...). */
    reason: text('reason'),
    capturedAt: ts('captured_at').notNull(),
    storageKey: text('storage_key').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** sha256 of the plaintext JPEG. */
    sha256: text('sha256').notNull(),
    keyId: text('key_id').notNull(),
    contentType: text('content_type').notNull().default('image/jpeg'),
    clientInstanceId: text('client_instance_id'),
    createdAt: createdAt(),
    purgedAt: ts('purged_at'),
    purgeReason: text('purge_reason'),
  },
  (t) => [
    index('evidence_session_idx').on(t.sessionId, t.capturedAt),
    index('evidence_event_idx').on(t.eventId),
    index('evidence_candidate_idx').on(t.candidateId),
    index('evidence_purge_idx').on(t.purgedAt),
  ],
);

/* ------------------------------------------------------------------ answers, notes, audit, devices */

export const answers = pgTable(
  'answers',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id').notNull(),
    value: jsonb('value').$type<AnswerValue>(),
    clientSeq: integer('client_seq').notNull(),
    answeredAt: ts('answered_at').notNull(),
    savedAt: ts('saved_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.questionId] })],
);

export const notes = pgTable(
  'notes',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id'),
    authorId: uuid('author_id').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('notes_session_idx').on(t.sessionId, t.createdAt), index('notes_event_idx').on(t.eventId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: uuid('org_id'),
    at: ts('at').notNull(),
    actorType: text('actor_type').$type<'staff' | 'candidate' | 'system' | 'api_key'>().notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
  },
  (t) => [index('audit_log_org_at_idx').on(t.orgId, t.at), index('audit_log_target_idx').on(t.targetType, t.targetId)],
);

export const deviceRecords = pgTable(
  'device_records',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    checkId: uuid('check_id'),
    at: ts('at').notNull(),
    clientInstanceId: text('client_instance_id').notNull(),
    purpose: text('purpose').$type<CheckPurpose>().notNull(),
    cameraLabel: text('camera_label').notNull().default(''),
    cameraIdHash: text('camera_id_hash').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    screen: jsonb('screen').$type<Record<string, unknown>>().notNull().default({}),
    videoWidth: integer('video_width'),
    videoHeight: integer('video_height'),
  },
  (t) => [index('device_records_session_idx').on(t.sessionId, t.at)],
);

/** Offline evaluation reports (identity harness / detection harness) for the Detection-quality page. */
export const evaluationReports = pgTable(
  'evaluation_reports',
  {
    id: id(),
    orgId: uuid('org_id'),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
    report: jsonb('report').$type<unknown>().notNull(),
  },
  (t) => [index('evaluation_reports_kind_idx').on(t.kind, t.createdAt)],
);

/* ------------------------------------------------------------------ integrations (API keys, webhooks, email alerts) */

/** Organisation API keys for the integration API (/api/v1). Only sha256(key) is stored. */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Display prefix: `sp_live_` + the first 8 characters of the random part. */
    prefix: text('prefix').notNull(),
    /** sha256 hex of the full key. */
    keyHash: text('key_hash').notNull(),
    scope: text('scope').$type<'integration'>().notNull().default('integration'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.orgId, t.createdAt)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** Signing secret, AES-GCM encrypted with the keyring (AAD `webhook-secret:<id>`). */
    secretEnc: bytea('secret_enc').notNull(),
    events: jsonb('events').$type<WebhookEventType[]>().notNull().default([]),
    /** event.created / event.closed only for events at or above this severity. */
    minSeverity: text('min_severity').$type<Severity>().notNull().default('medium'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSuccessAt: ts('last_success_at'),
    lastFailureAt: ts('last_failure_at'),
    /** Consecutive failed attempts since the last success. */
    failureCount: integer('failure_count').notNull().default(0),
    /** First failure after the last success (null while healthy). */
    failingSince: ts('failing_since'),
    disabledAt: ts('disabled_at'),
    disabledReason: text('disabled_reason').$type<'failures' | 'staff'>(),
  },
  (t) => [index('webhooks_org_idx').on(t.orgId, t.active)],
);

/** Durable webhook outbox: rows are enqueued in the transaction of the domain change and sent by the 'webhooks' job. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    /** Also the X-SmartProctoring-Delivery header and the envelope id (receiver idempotency key). */
    id: uuid('id').primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    eventType: text('event_type').$type<WebhookDeliveryType>().notNull(),
    /** One delivery per (webhook, dedupeKey): replays of the same domain change never enqueue twice. */
    dedupeKey: text('dedupe_key').notNull(),
    sessionId: uuid('session_id'),
    /** The JSON envelope (WebhookEnvelope) — identifiers, titles and links only, never images. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Next attempt while pending (also the lease expiry while an attempt is in flight). */
    nextAttemptAt: ts('next_attempt_at').notNull(),
    lastAttemptAt: ts('last_attempt_at'),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_dedupe_uq').on(t.webhookId, t.dedupeKey),
    index('webhook_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_created_idx').on(t.createdAt),
  ],
);

export type EmailAlertKind = 'hold' | 'pause_request' | 'high_severity';

/** Email alert queue: one row per alert-worthy occurrence; the 'email-alerts' job sends one digest per session per 5 minutes. */
export const emailAlerts = pgTable(
  'email_alerts',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<EmailAlertKind>().notNull(),
    /** The timeline event behind the alert (unique per kind: replays never enqueue twice). */
    eventId: uuid('event_id').notNull(),
    title: text('title').notNull(),
    observation: text('observation').notNull(),
    severity: text('severity').$type<Severity>().notNull(),
    occurredAt: ts('occurred_at').notNull(),
    status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull(),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    uniqueIndex('email_alerts_event_kind_uq').on(t.eventId, t.kind),
    index('email_alerts_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('email_alerts_session_idx').on(t.sessionId, t.sentAt),
    index('email_alerts_created_idx').on(t.createdAt),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type StaffUser = typeof staffUsers.$inferSelect;
export type StaffSession = typeof staffSessions.$inferSelect;
export type LoginThrottleRow = typeof loginThrottle.$inferSelect;
export type Exam = typeof exams.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
export type ExamSession = typeof examSessions.$inferSelect;
export type SessionPeriod = typeof sessionPeriods.$inferSelect;
export type PauseRequest = typeof pauseRequests.$inferSelect;
export type IdentityReference = typeof identityReferences.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type CheckFrame = typeof checkFrames.$inferSelect;
export type IdentityCheck = typeof identityChecks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type DeviceRecord = typeof deviceRecords.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type EmailAlert = typeof emailAlerts.$inferSelect;
