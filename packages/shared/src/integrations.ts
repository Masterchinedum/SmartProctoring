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
import type { AssignmentDTO, EventDTO, HoldDTO, SessionReportDTO } from './api';
import { candidateInputSchema } from './api';
import { SEVERITIES, type EventCategory, type EventType, type Severity } from './events';
import type { SessionEndReason, SessionStatus } from './session';

/* =================================================================== API keys */

/** Key format: `sp_live_` + 32 random bytes base64url (43 chars). Shown once at creation. */
export const API_KEY_PREFIX = 'sp_live_';
export const API_KEY_PATTERN = /^sp_live_[A-Za-z0-9_-]{43}$/;

export interface ApiKeyDTO {
  id: string;
  name: string;
  /** First characters of the key (e.g. `sp_live_AbCdEfGh`) so staff can recognise it; never the full key. */
  prefix: string;
  scope: 'integration';
  createdAt: number;
  createdBy: { id: string; name: string } | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1).max(100) });

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
  'session.terminated', // ended without submission (staff, or closed automatically after inactivity)
  'identity.mismatch', // convenience: a possible different person was observed (sent regardless of minSeverity)
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
  'session.terminated': 'Exam ended without submission',
  'identity.mismatch': 'Possible different person',
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
  /** session.held / session.released: the hold reason; session.terminated: e.g. 'abandoned_after_inactivity'. */
  reason: string | null;
  /** session.pause_requested only. */
  pauseRequest?: { id: string | null; reason: string | null };
  /** session.released only. */
  requireCheck?: boolean;
  /** session.submitted only (null when nothing could be graded). */
  score?: { points: number; maxPoints: number; autoGraded: boolean } | null;
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

export interface IntegrationExamDTO {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  durationSec: number;
}

export interface IntegrationCandidateDTO {
  id: string;
  name: string;
  email: string | null;
  externalId: string | null;
  createdAt: number;
}

/** POST /api/v1/candidates — upsert by externalId (when given). */
export const integrationCandidateSchema = candidateInputSchema;

export const integrationAssignSchema = z
  .object({
    candidateIds: z.array(z.string().max(100)).max(1000).optional(),
    externalIds: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
  })
  .refine((v) => (v.candidateIds?.length ?? 0) + (v.externalIds?.length ?? 0) > 0, { message: 'Provide candidateIds and/or externalIds' });

export interface IntegrationAssignmentDTO extends AssignmentDTO {
  externalId: string | null;
}

export interface IntegrationSessionDTO {
  id: string;
  status: SessionStatus;
  endReason: SessionEndReason | null;
  exam: { id: string; title: string };
  candidate: { id: string; name: string; email: string | null; externalId: string | null };
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  remainingMs: number;
  timerRunning: boolean;
  pauseCount: number;
  score: { points: number; maxPoints: number; autoGraded: boolean } | null;
  /** Event counts (dismissed events excluded from the category counts). */
  counts: { integrity: number; uncertain: number; technical: number; unreviewed: number; open: number; highSeverity: number };
  hold: HoldDTO | null;
  /** The candidate's access link (null once unavailable). */
  accessLink: string | null;
  staffUrl: string;
}

/** EventDTO without evidence references (evidence images are staff-only); `evidenceCount` says how many exist. */
export type IntegrationEventDTO = Omit<EventDTO, 'evidence'> & { evidenceCount: number; staffUrl: string };

/** The staff session report with evidence references replaced by counts and staff links. */
export type IntegrationSessionReportDTO = Omit<SessionReportDTO, 'notableEvents'> & { notableEvents: IntegrationEventDTO[]; staffUrl: string };
