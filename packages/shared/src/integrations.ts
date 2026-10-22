/**
 * Integrations contract: organisation API keys, the public integration API (/api/v1/*), outgoing
 * webhooks and email alerts. Staff endpoints are listed in the endpoint index at the end of ./api.ts;
 * the integration API is documented for customers in docs/INTEGRATION_API.md.
 *
 * Privacy rules (enforced server-side):
 *  - webhook payloads and alert emails never contain images, face templates or similarity scores —
 *    only identifiers, observational titles/sentences and links into the staff app;
 *  - the integration API never returns evidence URLs (evidence stays behind staff authentication).
 */
import { z } from 'zod';
import type { EventDTO } from './api';
import { candidateInputSchema } from './api';
import { ACCOMMODATION_KINDS } from './accommodations';
import { EVENT_CATEGORIES, EVENT_SOURCES, EVENT_TYPES, GAZE_DIRECTIONS, REVIEW_STATUSES, SEVERITIES, type EventCategory, type EventType, type Severity } from './events';
import { IDENTITY_DECISIONS } from './identity';
import { REVIEW_RESOLUTIONS, SESSION_REVIEW_OUTCOMES } from './review';
import { rescheduleRequestSchema, sessionWindowInputSchema, type SessionWindow } from './scheduling';
import { HOLD_REASONS, PERIOD_KINDS, SESSION_END_REASONS, SESSION_STATUSES, type SessionEndReason, type SessionStatus } from './session';

/* =================================================================== API keys */

/** Key format: `sp_live_` + 32 random bytes base64url (43 chars). Shown once at creation. */
export const API_KEY_PREFIX = 'sp_live_';
export const API_KEY_PATTERN = /^sp_live_[A-Za-z0-9_-]{43}$/;

/**
 * What a key may do on the integration API. Every /api/v1 endpoint requires exactly one scope (INTEGRATION_ENDPOINTS);
 * a key without it gets 403 `insufficient_scope`. Keys created before scopes existed were migrated with all of these
 * (full access); a scope added later is never granted to existing keys automatically.
 */
export const API_KEY_SCOPES = ['exams:read', 'candidates:read', 'candidates:write', 'assignments:write', 'sessions:read', 'reports:read', 'events:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** The "read only" preset: every `:read` scope (no writes, and no candidates' exam links). */
export const API_KEY_READ_ONLY_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES.filter((s) => s.endsWith(':read'));

export const API_KEY_SCOPE_INFO: Record<ApiKeyScope, { label: string; description: string }> = {
  'exams:read': { label: 'Read exams', description: 'List exams (GET /exams).' },
  'candidates:read': { label: 'Read candidates', description: 'Find candidates by external id or email (GET /candidates).' },
  'candidates:write': { label: 'Create and update candidates', description: 'Create or update candidates by external id (POST /candidates).' },
  'assignments:write': {
    label: 'Assign exams and see exam links',
    description: 'Assign candidates to exams (POST /exams/{examId}/assignments) and read candidates’ personal exam links (accessLink of GET /sessions/{id}).',
  },
  'sessions:read': { label: 'Read sessions', description: 'Status, times, score and event counts of attempts (GET /sessions, GET /sessions/{id}).' },
  'reports:read': { label: 'Read reports', description: 'Final reports (GET /sessions/{id}/report).' },
  'events:read': { label: 'Read events', description: 'Proctoring event lists (GET /sessions/{id}/events).' },
};

/** A key may be created with an expiry at most this far ahead (or none). */
export const API_KEY_MAX_LIFETIME_DAYS = 1095;
/** Keys expiring within this many days are flagged (Integrations page, operational checks, Prometheus gauge). */
export const API_KEY_EXPIRY_WARNING_DAYS = 14;

/** Known scopes only, each once, in canonical order. */
export function normaliseApiKeyScopes(scopes: readonly string[]): ApiKeyScope[] {
  const set = new Set(scopes);
  return API_KEY_SCOPES.filter((s) => set.has(s));
}

export type ApiKeyState = 'active' | 'expiring' | 'expired' | 'revoked';

/** revoked > expired > expiring (within `warningDays`) > active. */
export function apiKeyState(k: { revokedAt: number | null; expiresAt: number | null }, now: number, warningDays = API_KEY_EXPIRY_WARNING_DAYS): ApiKeyState {
  if (k.revokedAt != null) return 'revoked';
  if (k.expiresAt == null) return 'active';
  if (k.expiresAt <= now) return 'expired';
  return k.expiresAt - now <= warningDays * 86_400_000 ? 'expiring' : 'active';
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  /** First characters of the key (e.g. `sp_live_AbCdEfGh`) so staff can recognise it; never the full key. */
  prefix: string;
  /** The API the key is for: always 'integration' (keys never work on the staff API). Permissions: `scopes`. */
  scope: 'integration';
  /** What the key may do (canonical order). */
  scopes: ApiKeyScope[];
  createdAt: number;
  createdBy: { id: string; name: string } | null;
  lastUsedAt: number | null;
  /** After this time the key is refused (401 api_key_expired); null = never expires. */
  expiresAt: number | null;
  revokedAt: number | null;
}

/** POST /api/admin/api-keys */
export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Default: every scope (full access). */
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1)
    .max(API_KEY_SCOPES.length * 2)
    .default([...API_KEY_SCOPES]),
  /** Epoch ms; null = never expires. The server requires a time in the future, at most API_KEY_MAX_LIFETIME_DAYS ahead. */
  expiresAt: z.number().int().positive().nullable().default(null),
});
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>;

/** POST /api/admin/api-keys — the only response that ever contains the full key. */
export interface CreatedApiKeyDTO {
  apiKey: ApiKeyDTO;
  secret: string;
}

/* =================================================================== webhooks */

export const WEBHOOK_EVENT_TYPES = [
  'event.created', // non-neutral proctoring event at/above the webhook's minSeverity (first time it is seen)
  'event.closed', // a span event subscribed via event.created ended (optional subscription)
  'session.held', // exam put on hold (identity review, pause limit, staff hold ...)
  'session.released', // hold released by staff
  'session.pause_requested', // candidate requested a pause that needs approval
  'session.submitted', // submitted (candidate, time expiry or staff) — includes the score when graded
  'session.regraded', // the score changed after an administrator corrected answer keys (exam versions) — includes the new score
  'session.terminated', // ended without submission (staff, or closed automatically after inactivity)
  'identity.mismatch', // convenience: a possible different person was observed (sent regardless of minSeverity)
  'session.reviewed', // staff completed the review of the exam — includes the outcome (never the staff note)
  'session.rescheduled', // the window in which the candidate can start the exam was set or changed — includes the window
  'session.reopened', // staff reopened an ended exam for recovery — includes how it had ended (never the staff reason)
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
/** Sent only by POST /api/admin/webhooks/:id/test. */
export type WebhookDeliveryType = WebhookEventType | 'ping';

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'event.created': 'Proctoring event observed',
  'event.closed': 'Proctoring event ended',
  'session.held': 'Exam put on hold',
  'session.released': 'Hold released',
  'session.pause_requested': 'Pause requested (needs approval)',
  'session.submitted': 'Exam submitted',
  'session.regraded': 'Score regraded',
  'session.terminated': 'Exam ended without submission',
  'identity.mismatch': 'Possible different person',
  'session.reviewed': 'Review completed (with the outcome)',
  'session.rescheduled': 'Exam rescheduled (with the new window)',
  'session.reopened': 'Exam reopened for recovery',
};

export const WEBHOOK_SIGNATURE_HEADER = 'X-SmartProctoring-Signature';
export const WEBHOOK_EVENT_HEADER = 'X-SmartProctoring-Event';
export const WEBHOOK_DELIVERY_HEADER = 'X-SmartProctoring-Delivery';

export const webhookInputSchema = z.object({
  url: z.string().trim().url().max(2000),
  description: z.string().trim().max(200).default(''),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
  /** event.created / event.closed are sent only for events at or above this severity. */
  minSeverity: z.enum(SEVERITIES).default('medium'),
  active: z.boolean().default(true),
});
export type WebhookInput = z.infer<typeof webhookInputSchema>;

export const webhookUpdateSchema = z.object({
  url: z.string().trim().url().max(2000).optional(),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length).optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  /** true re-enables a disabled webhook and resets its failure count. */
  active: z.boolean().optional(),
});
export type WebhookUpdate = z.infer<typeof webhookUpdateSchema>;

export interface WebhookDTO {
  id: string;
  url: string;
  description: string;
  events: WebhookEventType[];
  minSeverity: Severity;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Consecutive failed delivery attempts since the last success. */
  failureCount: number;
  /** Set when the webhook was switched off (by staff or automatically). */
  disabledAt: number | null;
  /** 'failures' = disabled automatically after repeated failed deliveries; 'staff' = switched off by staff. */
  disabledReason: 'failures' | 'staff' | null;
  /** Deliveries waiting to be (re)sent. */
  pendingDeliveries: number;
}

/** POST /api/admin/webhooks and /rotate-secret — the only responses that contain the signing secret. */
export interface CreatedWebhookDTO {
  webhook: WebhookDTO;
  secret: string;
}

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed';

export interface WebhookDeliveryDTO {
  id: string;
  webhookId: string;
  eventType: WebhookDeliveryType;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  /** Next scheduled attempt while pending. */
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: number;
  deliveredAt: number | null;
  sessionId: string | null;
  /** Present on GET /webhooks/deliveries/:id only. */
  payload?: WebhookEnvelope;
}

/** JSON body of every webhook request. `id` equals the X-SmartProctoring-Delivery header (idempotency key). */
export interface WebhookEnvelope<T = Record<string, unknown>> {
  id: string;
  type: WebhookDeliveryType;
  /** Epoch ms when the notification was created (not when it was sent). */
  createdAt: number;
  orgId: string;
  /** Present (`true`) only when the organisation is a sandbox: test data, not real candidates (./quotas.ts). */
  sandbox?: true;
  data: T;
}

export interface WebhookPartyRefs {
  candidate: { id: string; name: string; externalId: string | null };
  exam: { id: string; title: string };
  /** Link to the session in the staff app (login required). */
  staffUrl: string;
}

/** data of event.created / event.closed / identity.mismatch. */
export interface WebhookEventData extends WebhookPartyRefs {
  id: string;
  sessionId: string;
  type: EventType;
  category: EventCategory;
  severity: Severity;
  title: string;
  observation: string;
  status: 'open' | 'closed';
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  confidence: number | null;
  deliveredLate: boolean;
  sessionStatus: SessionStatus;
}

/** data of session.* notifications. */
export interface WebhookSessionData extends WebhookPartyRefs {
  sessionId: string;
  /** Session status after the change. */
  status: SessionStatus;
  endReason: SessionEndReason | null;
  /** When the change happened. */
  at: number;
  /** The timeline event that recorded the change. */
  eventId: string;
  /**
   * session.held / session.released: the hold reason; session.terminated: 'abandoned_after_inactivity', 'consent_withdrawn'
   * or null; session.submitted: 'too_many_reconnects' / 'offline_too_long' when the resume policy ended the exam
   * (endReason 'resume_limit'), else null; session.reopened: the end reason it had before it was reopened.
   */
  reason: string | null;
  /** session.pause_requested only. */
  pauseRequest?: { id: string | null; reason: string | null };
  /** session.released only. */
  requireCheck?: boolean;
  /** session.submitted only (null when nothing could be graded). */
  score?: { points: number; maxPoints: number; autoGraded: boolean } | null;
  /** session.rescheduled: the new window (and the previous one). */
  window?: SessionWindow | null;
  previousWindow?: SessionWindow | null;
  /** session.reopened: minutes added to the exam time. */
  addedMinutes?: number;
}

/* =================================================================== email alerts & status */

export const emailTestSchema = z.object({ to: z.string().trim().email().max(254).optional() });

/** GET /api/admin/integrations/status */
export interface IntegrationStatusDTO {
  /** Base URL of the integration API, e.g. https://proctor.example.com/api/v1 */
  apiBaseUrl: string;
  email: { available: boolean; from: string | null };
  webhooks: { httpsRequired: boolean; privateNetworksAllowed: boolean; maxAttempts: number; timeoutMs: number; disableAfterFailures: number };
}


/* =================================================================== integration API (/api/v1) */

/**
 * The public contract of /api/v1 as zod schemas. The server parses requests with them, the DTO types below are
 * inferred from them, the OpenAPI document (./openapi.ts: GET /api/v1/openapi.json and docs/openapi.json) is generated
 * from them, and the contract tests (apps/server/test/integrations/contract.test.ts) check every response against them
 * strictly: a field the server sends must be described here. Customer documentation: docs/INTEGRATION_API.md.
 */

/** Version of the integration API contract (the OpenAPI document's `info.version`). Bump it with every change. */
export const INTEGRATION_API_VERSION = '1.2.0';

const uuid = (description?: string) => (description ? z.string().uuid().describe(description) : z.string().uuid());
const epochMs = (description = 'Epoch milliseconds (UTC).') => z.number().int().describe(description);
const count = () => z.number().int().min(0);
const ms = () => z.number().min(0);
const staffLink = (description = 'Link into the staff app (staff sign-in required).') => z.string().url().describe(description);

/* ------------------------------------------------------------------ shared enums (named in the OpenAPI document) */

export const eventTypeSchema = z.enum(EVENT_TYPES).describe('Event type. New types may be added: treat an unknown type like any other observation of its category.');
export const eventCategorySchema = z
  .enum(EVENT_CATEGORIES)
  .describe(
    'integrity: a potential integrity issue; uncertain: an observation that could not be assessed reliably; technical: a technical problem; neutral: a session change; exception: the attempt ran under an approved accommodation (context, never a flag).',
  );
export const severitySchema = z.enum(SEVERITIES);
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export const endReasonSchema = z.enum(SESSION_END_REASONS);
export const accommodationKindSchema = z.enum(ACCOMMODATION_KINDS);

/** A scheduling window as returned (./scheduling.ts). */
export const sessionWindowDtoSchema = z
  .object({
    startsAt: epochMs('When the candidate can start (null: open — any time until endsAt). The check-in may begin 30 minutes earlier.').nullable(),
    endsAt: epochMs('Until when the candidate can start (null: open). An exam that started in time is never cut off.').nullable(),
  })
  .describe('The window in which the candidate can start the exam.');
const _windowMatches: [SessionWindow, z.infer<typeof sessionWindowDtoSchema>] = [{} as z.infer<typeof sessionWindowDtoSchema>, {} as SessionWindow];
void _windowMatches;

/* ------------------------------------------------------------------ errors */

export const integrationErrorSchema = z
  .object({
    error: z.string().describe('Machine-readable code, e.g. `invalid_api_key`, `api_key_expired`, `insufficient_scope`, `validation_failed`, `session_not_found`, `rate_limited`.'),
    message: z.string().describe('Human-readable explanation in English. It may change: do not parse it.'),
    details: z
      .unknown()
      .optional()
      .describe('More information when available. `validation_failed`: a list of `{ path, message }`; `insufficient_scope`: `{ requiredScope, scopes }`.'),
  })
  .describe('The body of every non-2xx response.');
export type IntegrationErrorDTO = z.infer<typeof integrationErrorSchema>;

/* ------------------------------------------------------------------ exams */

export const integrationExamDtoSchema = z
  .object({
    id: uuid(),
    title: z.string(),
    status: z.enum(['draft', 'published', 'archived']).describe('Only published exams can be assigned.'),
    durationSec: z.number().int().min(0).describe('Exam time in seconds (approved extra time comes on top, per candidate).'),
    version: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('The exam version candidates who start now get (null while the exam was never published). Each attempt keeps the version it started with.'),
  })
  .describe('An exam.');
export type IntegrationExamDTO = z.infer<typeof integrationExamDtoSchema>;

export const integrationExamsQuerySchema = z.object({
  status: z.enum(['draft', 'published', 'archived']).optional().describe('Only exams with this status (default: all).'),
});

/* ------------------------------------------------------------------ candidates */

/** POST /api/v1/candidates — upsert by externalId (when given). Same rules as the staff app's candidate form. */
export const integrationCandidateSchema = z
  .object({
    name: z.string().min(1).max(300).describe('Full name (required; surrounding spaces are removed).'),
    email: z.string().email().nullable().optional().describe('Optional email address. Omit it to keep the stored one; null removes it.'),
    externalId: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('Your own stable id for the person (student number, employee id). With it the request is an upsert: an existing candidate with this id is updated.'),
  })
  .describe('A candidate to create, or to update by `externalId`.');
// The staff app's candidate form accepts exactly the same input.
const _candidateInputCompatible: z.infer<typeof integrationCandidateSchema> = {} as z.infer<typeof candidateInputSchema>;
void _candidateInputCompatible;

export const integrationCandidateDtoSchema = z
  .object({
    id: uuid(),
    name: z.string(),
    email: z.string().nullable(),
    externalId: z.string().nullable(),
    createdAt: epochMs(),
  })
  .describe('A candidate (a person who takes exams).');
export type IntegrationCandidateDTO = z.infer<typeof integrationCandidateDtoSchema>;

export const integrationCandidateUpsertDtoSchema = z.object({
  candidate: integrationCandidateDtoSchema,
  created: z.boolean().describe('true: a new candidate was created (HTTP 201). false: the candidate with this `externalId` was updated, or was already up to date (HTTP 200).'),
});
export type IntegrationCandidateUpsertDTO = z.infer<typeof integrationCandidateUpsertDtoSchema>;

const paging = {
  limit: z.coerce.number().int().min(1).max(500).default(100).describe('Page size.'),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0).describe('Number of items to skip.'),
};

export const integrationCandidatesQuerySchema = z.object({
  externalId: z.string().max(200).optional().describe('Exact external id.'),
  email: z.string().max(254).optional().describe('Email address (case-insensitive).'),
  ...paging,
});

/* ------------------------------------------------------------------ assignments */

export const integrationAssignSchema = z
  .object({
    candidateIds: z.array(z.string().max(100)).max(1000).optional().describe('Candidate ids (as returned by POST /candidates).'),
    externalIds: z.array(z.string().trim().min(1).max(200)).max(1000).optional().describe('Your external ids (create the candidates with POST /candidates first).'),
    window: sessionWindowInputSchema
      .optional()
      .describe('Scheduling window for the new attempts (the candidate can start only inside it). A candidate’s existing unfinished attempt keeps its own window.'),
  })
  .refine((v) => (v.candidateIds?.length ?? 0) + (v.externalIds?.length ?? 0) > 0, { message: 'Provide candidateIds and/or externalIds' })
  .describe('Who to assign: at least one id in total, at most 1000 in each list.');

export const integrationAssignmentDtoSchema = z.object({
  sessionId: uuid('The attempt (session) id.'),
  candidateId: uuid(),
  candidateName: z.string(),
  externalId: z.string().nullable(),
  accessLink: z.string().describe('The candidate’s personal exam link (`https://…/take/<token>`). Treat it like a password: show it only to that candidate.'),
  existing: z.boolean().describe('true: the candidate already had a not-yet-finished attempt at this exam; its id and link are returned and nothing was created.'),
  window: sessionWindowDtoSchema.nullable().describe('The attempt’s scheduling window (an existing attempt keeps its own; null: none).'),
});
export type IntegrationAssignmentDTO = z.infer<typeof integrationAssignmentDtoSchema>;

/* ------------------------------------------------------------------ sessions */

const examRefSchema = z.object({ id: uuid(), title: z.string() });
const candidateRefSchema = z.object({ id: uuid(), name: z.string(), email: z.string().nullable(), externalId: z.string().nullable() });

export const integrationHoldDtoSchema = z
  .object({
    reason: z.enum(HOLD_REASONS),
    since: epochMs('When the hold started.'),
    message: z.string().describe('What the candidate is told.'),
    canReverify: z.boolean().describe('The candidate may verify their identity again by themselves.'),
  })
  .describe('Why and since when the attempt is on hold.');

const eventCountsSchema = z
  .object({ integrity: count(), uncertain: count(), technical: count(), unreviewed: count(), open: count(), highSeverity: count() })
  .describe('Observations awaiting or after human review — not a verdict. Dismissed events are not counted in the category totals.');

const sessionReviewStateSchema = z.enum(['none', 'open', 'escalated', 'resolved']).describe('`none`: no staff member has picked up the review yet.');

export const integrationSessionDtoSchema = z
  .object({
    id: uuid(),
    status: sessionStatusSchema,
    endReason: z
      .enum(SESSION_END_REASONS)
      .nullable()
      .describe(
        'Set once ended. `submitted`: candidate_submitted, time_expired or staff_submitted. `terminated`: staff_terminated, candidate_withdrew (no score) or abandoned (closed automatically after inactivity; no score implied).',
      ),
    exam: examRefSchema,
    examVersion: z.number().int().nullable().describe('The exam version the attempt is pinned to (null until it starts).'),
    accommodations: z.array(accommodationKindSchema).describe('Approved accommodations applied to the attempt (empty: none). Extra time is already included in the duration.'),
    candidate: candidateRefSchema,
    createdAt: epochMs(),
    startedAt: epochMs().nullable(),
    endedAt: epochMs().nullable(),
    remainingMs: ms().describe('Exam time left.'),
    timerRunning: z.boolean(),
    pauseCount: count(),
    score: z
      .object({
        points: z.number(),
        maxPoints: z.number(),
        autoGraded: z.boolean().describe('false while open questions are not graded (they are never graded automatically).'),
        regraded: count().describe('How many times an administrator regraded the attempt (see the session.regraded webhook).'),
      })
      .nullable()
      .describe('Present once answers were graded, with the answer keys of the attempt’s own exam version.'),
    counts: eventCountsSchema,
    hold: integrationHoldDtoSchema.nullable(),
    accessLink: z
      .string()
      .nullable()
      .describe('The candidate’s personal exam link: only in GET /sessions/{id}, only for keys with the `assignments:write` scope, and only while the attempt can still be taken (null otherwise).'),
    window: sessionWindowDtoSchema.nullable().describe('The scheduling window (null: none — the exam can be started any time).'),
    review: z
      .object({ state: sessionReviewStateSchema, outcome: z.enum(SESSION_REVIEW_OUTCOMES).nullable().describe('Set once resolved: a staff decision, never automated.') })
      .describe('The staff review of the attempt.'),
    staffUrl: staffLink(),
  })
  .describe('One candidate’s attempt at one exam.');
export type IntegrationSessionDTO = z.infer<typeof integrationSessionDtoSchema>;

export const integrationSessionsQuerySchema = z.object({
  examId: z.string().optional().describe('Only attempts at this exam.'),
  candidateId: z.string().optional().describe('Only this candidate’s attempts.'),
  externalId: z.string().max(200).optional().describe('Only attempts of the candidate with this external id.'),
  status: z.string().optional().describe('Comma-separated statuses, e.g. `submitted,terminated` (invited, ready, active, paused, on_hold, submitted, terminated).'),
  ...paging,
});

/* ------------------------------------------------------------------ events */

export const integrationEventDtoSchema = z
  .object({
    id: uuid(),
    sessionId: uuid(),
    type: eventTypeSchema,
    category: eventCategorySchema,
    severity: severitySchema,
    source: z.enum(EVENT_SOURCES).describe('What observed it.'),
    status: z.enum(['open', 'closed']).describe('open: still going on (events with a duration).'),
    title: z.string(),
    observation: z.string().describe('What was observed, in plain words (never a conclusion).'),
    startedAt: epochMs(),
    endedAt: epochMs().nullable(),
    durationMs: ms().nullable(),
    confidence: z.number().nullable().describe('0..1 where meaningful; null for session changes.'),
    details: z.record(z.unknown()).describe('Type-specific measurements (never face-similarity scores: such fields are null).'),
    context: z.record(z.unknown()).describe('What surrounded it, e.g. `{ "precededBy": ["session_resumed"], "periodKind": "active" }`.'),
    review: z
      .object({
        status: z.enum(REVIEW_STATUSES),
        resolution: z.enum(REVIEW_RESOLUTIONS).nullable().describe('The reviewer’s structured conclusion (null when undecided or for older plain decisions).'),
        by: z.string().nullable().describe('Staff user id.'),
        byName: z.string().nullable(),
        at: epochMs().nullable(),
        note: z.string().nullable(),
      })
      .describe('The human review of the event.'),
    notesCount: count(),
    receivedAt: epochMs('When the server received the latest version (what `since` filters on).'),
    deliveredLate: z.boolean().describe('Reported well after it happened (e.g. buffered while the candidate was offline).'),
    evidenceCount: count().describe('Evidence images kept for it (they stay in the staff app).'),
    staffUrl: staffLink('The event in the staff app (staff sign-in required).'),
  })
  .describe('A proctoring event: an observation awaiting human review, never a verdict.');
export type IntegrationEventDTO = z.infer<typeof integrationEventDtoSchema>;

/** EventDTO without evidence references (evidence images are staff-only) — kept identical to the schema at compile time. */
type IntegrationEventFromStaff = Omit<EventDTO, 'evidence'> & { evidenceCount: number; staffUrl: string };
const _eventSchemaMatchesStaffType: [IntegrationEventFromStaff, IntegrationEventDTO] = [{} as IntegrationEventDTO, {} as IntegrationEventFromStaff];
void _eventSchemaMatchesStaffType;

export const integrationEventsQuerySchema = z.object({
  category: eventCategorySchema.optional(),
  type: z.string().optional().describe('Comma-separated event types.'),
  severity: severitySchema.optional().describe('Exactly this severity.'),
  review: z.enum(REVIEW_STATUSES).optional().describe('Review status.'),
  since: z.coerce.number().optional().describe('Only events the server received (first or updated) at or after this time, epoch ms — for incremental polling.'),
});

/* ------------------------------------------------------------------ report */

const staffRefSchema = z.object({ id: z.string(), name: z.string() });
const reviewDueSchema = z.object({ kind: z.enum(['hold', 'flags']), since: epochMs(), dueAt: epochMs(), overdue: z.boolean() });
const reviewSummarySchema = z.object({
  state: sessionReviewStateSchema,
  assignee: staffRefSchema.nullable(),
  outcome: z.enum(SESSION_REVIEW_OUTCOMES).nullable(),
  undecided: z.object({ integrity: count(), uncertain: count(), technical: count() }),
  topSeverity: severitySchema.nullable(),
  due: reviewDueSchema.nullable().describe('The organisation’s review target that applies now (null: nothing waiting).'),
});
const reviewSchema = reviewSummarySchema.extend({
  assignedAt: epochMs().nullable(),
  escalation: z.object({ at: epochMs(), by: staffRefSchema.nullable(), note: z.string() }).nullable(),
  resolution: z.object({ outcome: z.enum(SESSION_REVIEW_OUTCOMES), note: z.string().nullable(), at: epochMs(), by: staffRefSchema.nullable() }).nullable(),
});
const pauseRequestSchema = z.object({
  id: uuid(),
  requestedAt: epochMs(),
  reason: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'denied', 'cancelled']),
  decidedAt: epochMs().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
});
const reportSessionSchema = z.object({
  id: uuid(),
  exam: examRefSchema,
  candidate: candidateRefSchema,
  status: sessionStatusSchema,
  endReason: endReasonSchema.nullable(),
  connection: z.enum(['online', 'offline', 'never_connected']),
  lastHeartbeatAt: epochMs().nullable(),
  reportingInterruptedSince: epochMs().nullable(),
  monitoring: z
    .object({
      state: z.enum(['ok', 'attention', 'degraded', 'off']),
      faces: count(),
      label: z.string(),
      open: z.array(eventTypeSchema),
      lookDirection: z.enum(GAZE_DIRECTIONS).nullable().optional(),
      at: epochMs(),
    })
    .nullable(),
  identity: z.object({
    lastDecision: z.enum(IDENTITY_DECISIONS).nullable(),
    lastAt: epochMs().nullable(),
    lastSimilarity: z.null().describe('Always null: face-similarity scores are never returned.'),
  }),
  remainingMs: ms(),
  timerRunning: z.boolean(),
  startedAt: epochMs().nullable(),
  endedAt: epochMs().nullable(),
  pauseCount: count(),
  counts: eventCountsSchema,
  pendingPauseRequest: pauseRequestSchema.nullable(),
  hold: integrationHoldDtoSchema.nullable(),
  accessLink: z.null().describe('Always null in reports.'),
  legalHold: z.boolean().optional(),
  window: sessionWindowDtoSchema.nullable().optional(),
  reconnectCount: count().optional().describe('Times the exam was reopened in a new browser window since the start or the last staff decision.'),
  examVersion: z.object({ id: uuid(), number: z.number().int() }).nullable().optional(),
  accommodations: z.array(accommodationKindSchema).optional(),
  review: reviewSummarySchema.optional(),
});
const categoryCountsSchema = z.object({ total: count(), dismissed: count(), reviewed: count(), unreviewed: count() });

export const integrationSessionReportDtoSchema = z
  .object({
    generatedAt: epochMs(),
    session: reportSessionSchema,
    exam: z.object({ id: uuid(), title: z.string(), durationSec: z.number().int(), version: z.number().int().nullable().optional() }),
    candidate: candidateRefSchema,
    totals: z.object({
      wallClockMs: ms(),
      observedMs: ms(),
      unobservedMs: ms(),
      activeMs: ms(),
      pausedMs: ms(),
      disconnectedMs: ms(),
      heldMs: ms(),
      pauseCount: count(),
      examTimeUsedMs: ms(),
    }),
    periods: z
      .array(
        z.object({
          id: uuid(),
          kind: z.enum(PERIOD_KINDS),
          observed: z.boolean().describe('Monitoring was running (pauses, disconnections and holds are unobserved by design).'),
          startedAt: epochMs(),
          endedAt: epochMs().nullable(),
          reason: z.string().nullable(),
          meta: z.record(z.unknown()),
        }),
      )
      .describe('The attempt’s timeline split into observed and unobserved periods.'),
    identity: z.object({
      referenceCreatedAt: epochMs().nullable(),
      checks: count(),
      matches: count(),
      mismatches: count(),
      inconclusive: count(),
      unableToVerify: count(),
      idPhoto: z.object({ decision: z.enum(IDENTITY_DECISIONS), similarity: z.null().describe('Always null.') }).nullable(),
      summary: z.string(),
    }),
    eventCounts: z.object({ integrity: categoryCountsSchema, uncertain: categoryCountsSchema, technical: categoryCountsSchema, neutral: categoryCountsSchema, exception: categoryCountsSchema }),
    byType: z.array(z.object({ type: eventTypeSchema, title: z.string(), category: eventCategorySchema, count: count(), totalDurationMs: ms(), dismissed: count() })),
    notableEvents: z.array(integrationEventDtoSchema),
    observations: z.array(z.string()).describe('Factual sentences (never a verdict).'),
    reviewerNotes: z.array(z.object({ id: uuid(), sessionId: uuid(), eventId: uuid().nullable(), authorId: z.string(), authorName: z.string(), text: z.string(), createdAt: epochMs() })),
    score: z
      .object({
        points: z.number(),
        maxPoints: z.number(),
        autoGraded: z.boolean(),
        regrades: z.array(
          z.object({ at: epochMs(), byStaffId: z.string(), reason: z.string(), keysFromVersion: z.number().int(), previous: z.object({ points: z.number(), maxPoints: z.number() }) }),
        ),
      })
      .nullable(),
    accommodations: z
      .object({
        items: z.array(z.object({ id: uuid(), kind: accommodationKindSchema, params: z.record(z.unknown()), label: z.string(), grantedAt: epochMs() })),
        extraTimeMs: ms(),
        exceptions: z
          .array(z.object({ path: z.string(), label: z.string(), from: z.unknown(), to: z.unknown(), kinds: z.array(accommodationKindSchema) }))
          .describe('Every exam rule the accommodations changed.'),
      })
      .nullable()
      .describe('Approved accommodations and the exam rules they changed (never why they were granted). null: none.'),
    limitations: z.array(z.string()),
    review: reviewSchema.optional(),
    incidents: z
      .array(
        z.object({
          id: uuid(),
          startedAt: epochMs(),
          endedAt: epochMs(),
          open: z.boolean(),
          category: eventCategorySchema,
          severity: severitySchema,
          eventIds: z.array(uuid()),
          types: z.array(z.object({ type: eventTypeSchema, count: count() })),
          title: z.string(),
          undecided: count(),
        }),
      )
      .optional()
      .describe('Flags close in time, grouped (oldest first).'),
    staffUrl: staffLink(),
  })
  .describe('The final report the staff app shows, with evidence replaced by counts and staff links, and without the reviewer-facing explanations.');
export type IntegrationSessionReportDTO = z.infer<typeof integrationSessionReportDtoSchema>;

export const integrationReportQuerySchema = z.object({
  tz: z.string().optional().describe('IANA time zone for times written in sentences, e.g. `Europe/Berlin` (default and fallback for unknown zones: UTC).'),
});

/* ------------------------------------------------------------------ idempotency */

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** Set (to "true") on a response replayed from the idempotency store. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
/** 1–255 characters: letters, digits and `- _ . : ~ + / =` (a random UUID is ideal). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:+/=-]{1,255}$/;
/** How long a stored response is replayed. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
/** A request still marked in progress after this long (e.g. the server restarted mid-request) no longer blocks its key. */
export const IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SEC = 60;

/* ------------------------------------------------------------------ endpoint catalogue */

export const INTEGRATION_OPERATION_IDS = [
  'getOpenApiDocument',
  'listExams',
  'upsertCandidate',
  'listCandidates',
  'assignCandidates',
  'listSessions',
  'getSession',
  'rescheduleSession',
  'getSessionReport',
  'listSessionEvents',
] as const;
export type IntegrationOperationId = (typeof INTEGRATION_OPERATION_IDS)[number];

export interface IntegrationEndpoint {
  operationId: IntegrationOperationId;
  method: 'GET' | 'POST' | 'PUT';
  /** Below /api/v1, in route syntax (`:id`); the OpenAPI document writes `{id}`. */
  path: string;
  /** Scope the API key needs (403 insufficient_scope without it). null: no API key needed. */
  scope: ApiKeyScope | null;
  tag: 'Exams' | 'Candidates' | 'Sessions' | 'Meta';
  summary: string;
  description: string;
  /** Path parameters → description (all are ids: an unknown id, or one of another organisation, is 404). */
  params?: Record<string, string>;
  query?: z.AnyZodObject;
  body?: z.ZodTypeAny;
  responses: { status: 200 | 201; description: string; schema: z.ZodTypeAny | null }[];
  /** Endpoint-specific error codes (the authentication, scope, rate-limit and idempotency errors are added for every endpoint they apply to). */
  errors: { status: 400 | 404 | 409; codes: string[] }[];
  /** Accepts an Idempotency-Key header (every POST and PUT). */
  idempotent?: boolean;
  /** Recorded in the organisation's audit log (actor: the API key). */
  audited?: boolean;
}

const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item) });
const pageOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), total: count().describe('Number of matches over all pages.') });

export const INTEGRATION_ENDPOINTS: readonly IntegrationEndpoint[] = [
  {
    operationId: 'getOpenApiDocument',
    method: 'GET',
    path: '/openapi.json',
    scope: null,
    tag: 'Meta',
    summary: 'This OpenAPI document',
    description: 'The OpenAPI 3.1 description of the integration API (the same as docs/openapi.json for this version). No API key needed: it contains no organisation data.',
    responses: [{ status: 200, description: 'The OpenAPI document.', schema: null }],
    errors: [],
  },
  {
    operationId: 'listExams',
    method: 'GET',
    path: '/exams',
    scope: 'exams:read',
    tag: 'Exams',
    summary: 'List exams',
    description: 'The organisation’s exams, newest first.',
    query: integrationExamsQuerySchema,
    responses: [{ status: 200, description: 'The exams.', schema: listOf(integrationExamDtoSchema) }],
    errors: [{ status: 400, codes: ['validation_failed'] }],
  },
  {
    operationId: 'upsertCandidate',
    method: 'POST',
    path: '/candidates',
    scope: 'candidates:write',
    tag: 'Candidates',
    summary: 'Create or update a candidate',
    description:
      'Upsert by `externalId`: if a candidate with this external id exists, its name (and email, when given) is updated; otherwise a candidate is created. Without `externalId` a new candidate is always created.',
    body: integrationCandidateSchema,
    responses: [
      { status: 201, description: 'Created.', schema: integrationCandidateUpsertDtoSchema },
      { status: 200, description: 'A candidate with this `externalId` existed: updated, or already up to date.', schema: integrationCandidateUpsertDtoSchema },
    ],
    errors: [
      { status: 400, codes: ['validation_failed'] },
      { status: 409, codes: ['quota_exceeded'] },
    ],
    idempotent: true,
    audited: true,
  },
  {
    operationId: 'listCandidates',
    method: 'GET',
    path: '/candidates',
    scope: 'candidates:read',
    tag: 'Candidates',
    summary: 'Find candidates',
    description: 'Candidates, oldest first, optionally filtered by external id or email.',
    query: integrationCandidatesQuerySchema,
    responses: [{ status: 200, description: 'The matching candidates.', schema: pageOf(integrationCandidateDtoSchema) }],
    errors: [{ status: 400, codes: ['validation_failed'] }],
  },
  {
    operationId: 'assignCandidates',
    method: 'POST',
    path: '/exams/:examId/assignments',
    scope: 'assignments:write',
    tag: 'Exams',
    summary: 'Assign candidates to an exam',
    description:
      'Creates an attempt for each candidate and returns their personal exam links. A candidate who already has a not-yet-finished attempt at this exam keeps it (`existing: true`), so retrying is safe. Unknown candidates fail the whole request (nothing is created).',
    params: { examId: 'Exam id.' },
    body: integrationAssignSchema,
    responses: [{ status: 200, description: 'One item per candidate, in the requested order.', schema: listOf(integrationAssignmentDtoSchema) }],
    errors: [
      { status: 400, codes: ['validation_failed'] },
      { status: 404, codes: ['exam_not_found'] },
      { status: 409, codes: ['exam_not_published', 'quota_exceeded'] },
    ],
    idempotent: true,
    audited: true,
  },
  {
    operationId: 'listSessions',
    method: 'GET',
    path: '/sessions',
    scope: 'sessions:read',
    tag: 'Sessions',
    summary: 'List attempts',
    description: 'Attempts (sessions), newest first. `accessLink` is always null in lists.',
    query: integrationSessionsQuerySchema,
    responses: [{ status: 200, description: 'The matching attempts.', schema: pageOf(integrationSessionDtoSchema) }],
    errors: [{ status: 400, codes: ['validation_failed'] }],
  },
  {
    operationId: 'getSession',
    method: 'GET',
    path: '/sessions/:id',
    scope: 'sessions:read',
    tag: 'Sessions',
    summary: 'Get an attempt',
    description: 'Status, times, score, event counts, hold and review of one attempt.',
    params: { id: 'Session id.' },
    responses: [{ status: 200, description: 'The attempt.', schema: integrationSessionDtoSchema }],
    errors: [{ status: 404, codes: ['session_not_found'] }],
  },
  {
    operationId: 'rescheduleSession',
    method: 'PUT',
    path: '/sessions/:id/window',
    scope: 'assignments:write',
    tag: 'Sessions',
    summary: 'Set, change or clear the scheduling window of an attempt',
    description:
      'Only before the exam starts. Both bounds null clears the window. The same rules as on assignment: `endsAt` after `startsAt`, at least 5 minutes long, not in the past, at most two years ahead. An unchanged window records nothing; a change is sent as the `session.rescheduled` webhook. Returns the attempt (with `accessLink` null).',
    params: { id: 'Session id.' },
    body: rescheduleRequestSchema,
    responses: [{ status: 200, description: 'The attempt with its new window.', schema: integrationSessionDtoSchema }],
    errors: [
      { status: 400, codes: ['validation_failed'] },
      { status: 404, codes: ['session_not_found'] },
      { status: 409, codes: ['already_started', 'invalid_state'] },
    ],
    idempotent: true,
    audited: true,
  },
  {
    operationId: 'getSessionReport',
    method: 'GET',
    path: '/sessions/:id/report',
    scope: 'reports:read',
    tag: 'Sessions',
    summary: 'Get the final report of an attempt',
    description: 'The report the staff app shows, without evidence images or the reviewer-facing explanations.',
    params: { id: 'Session id.' },
    query: integrationReportQuerySchema,
    responses: [{ status: 200, description: 'The report.', schema: integrationSessionReportDtoSchema }],
    errors: [{ status: 404, codes: ['session_not_found'] }],
    audited: true,
  },
  {
    operationId: 'listSessionEvents',
    method: 'GET',
    path: '/sessions/:id/events',
    scope: 'events:read',
    tag: 'Sessions',
    summary: 'List the events of an attempt',
    description: 'Proctoring events in chronological order. Unknown event types in `type` match nothing.',
    params: { id: 'Session id.' },
    query: integrationEventsQuerySchema,
    responses: [{ status: 200, description: 'The events.', schema: listOf(integrationEventDtoSchema) }],
    errors: [
      { status: 400, codes: ['validation_failed'] },
      { status: 404, codes: ['session_not_found'] },
    ],
    audited: true,
  },
];

export function integrationEndpoint(operationId: IntegrationOperationId): IntegrationEndpoint {
  const e = INTEGRATION_ENDPOINTS.find((x) => x.operationId === operationId);
  if (!e) throw new Error(`Unknown integration API operation ${operationId}`);
  return e;
}
