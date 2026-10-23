/**
 * Privacy operations: the register of data-subject requests (access, erasure, …) with their legal deadlines, the
 * candidate's withdrawal of consent, the personal-data export, and the retention preview / job health that show
 * deletion is actually happening (docs/PRIVACY.md §5, docs/OPERATIONS.md).
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ requests */

export const PRIVACY_REQUEST_KINDS = ['access', 'erasure', 'rectification', 'restriction', 'objection', 'consent_withdrawal', 'other'] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];

export const PRIVACY_REQUEST_STATUSES = ['open', 'in_progress', 'completed', 'rejected'] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const PRIVACY_REQUEST_CHANNELS = ['email', 'letter', 'phone', 'in_person', 'candidate_app', 'other'] as const;
export type PrivacyRequestChannel = (typeof PRIVACY_REQUEST_CHANNELS)[number];

export const PRIVACY_REQUEST_INFO: Record<PrivacyRequestKind, { label: string; help: string }> = {
  access: { label: 'Access (copy of their data)', help: 'Export the candidate’s data (records and images) and send it to them through a secure channel.' },
  erasure: { label: 'Erasure', help: 'Delete the candidate and everything recorded about them — unless a legal hold or your records obligations require keeping it (then reject with the reason).' },
  rectification: { label: 'Rectification', help: 'Correct the candidate’s name, email or external id (Candidates page).' },
  restriction: { label: 'Restriction of processing', help: 'Place the candidate’s sessions under legal hold while the request is assessed, and do not schedule new exams.' },
  objection: { label: 'Objection', help: 'Assess the objection; offer an alternative arrangement (accommodation: identity verified by staff, or no camera).' },
  consent_withdrawal: { label: 'Consent withdrawn', help: 'The candidate withdrew consent: their exam ended and its face images and templates were deleted. Arrange an alternative assessment.' },
  other: { label: 'Other', help: 'Record what was asked and how it was answered.' },
};

/** Days to answer (GDPR Art. 12(3): one month); an extension needs a reason. */
export const DEFAULT_PRIVACY_RESPONSE_DAYS = 30;
/** At most this many extra days (GDPR: two further months). */
export const MAX_PRIVACY_EXTENSION_DAYS = 60;

export const createPrivacyRequestSchema = z.object({
  kind: z.enum(PRIVACY_REQUEST_KINDS),
  /** The candidate it concerns, when known (the register also covers people without a candidate record). */
  candidateId: z.string().uuid().nullable().optional(),
  /** How to identify the person (name, email, reference) — required: the register outlives an erased candidate. */
  subject: z.string().trim().min(2).max(200),
  channel: z.enum(PRIVACY_REQUEST_CHANNELS).default('email'),
  /** When the request was received (epoch ms; default now). The deadline counts from here. */
  receivedAt: z.number().int().min(0).optional(),
  /** What was asked (encrypted at rest; administrators only). */
  details: z.string().trim().max(4000).optional(),
});
export type CreatePrivacyRequest = z.infer<typeof createPrivacyRequestSchema>;

export const updatePrivacyRequestSchema = z
  .object({
    status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    /** How it was answered; required to complete or reject. */
    resolutionNote: z.string().trim().max(4000).optional(),
    /** Extend the deadline (days beyond the original one, ≤ MAX_PRIVACY_EXTENSION_DAYS) with the reason told to the person. */
    extension: z.object({ days: z.number().int().min(1).max(MAX_PRIVACY_EXTENSION_DAYS), reason: z.string().trim().min(10).max(1000) }).optional(),
  })
  .superRefine((v, c) => {
    if ((v.status === 'completed' || v.status === 'rejected') && !(v.resolutionNote && v.resolutionNote.length >= 5)) {
      c.addIssue({ code: 'custom', path: ['resolutionNote'], message: 'Say how the request was answered (at least 5 characters)' });
    }
  });
export type UpdatePrivacyRequest = z.infer<typeof updatePrivacyRequestSchema>;

export interface PrivacyRequestDTO {
  id: string;
  kind: PrivacyRequestKind;
  status: PrivacyRequestStatus;
  subject: string;
  /** Null when there is no candidate record (or it was erased). */
  candidate: { id: string; name: string } | null;
  channel: PrivacyRequestChannel;
  /** 'candidate' for requests the candidate made in the exam app (consent withdrawal). */
  source: 'staff' | 'candidate';
  receivedAt: number;
  dueAt: number;
  /** Not completed / rejected and past dueAt. */
  overdue: boolean;
  extension: { days: number; reason: string } | null;
  details: string | null;
  assignee: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: number;
  resolutionNote: string | null;
  closedAt: number | null;
  closedBy: { id: string; name: string } | null;
  /** When the candidate's data was exported / erased for this request. */
  exportedAt: number | null;
  erasedAt: number | null;
  /** Related exam session (consent withdrawal). */
  sessionId: string | null;
}

/** GET /api/admin/privacy-requests?status=open|closed|all&candidateId= */
export const privacyRequestListQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  candidateId: z.string().uuid().optional(),
});
export type PrivacyRequestListQuery = z.infer<typeof privacyRequestListQuerySchema>;

/** A request still open that is due within this many days counts as "due soon". */
export const PRIVACY_DUE_SOON_DAYS = 7;

/** POST /api/admin/privacy-requests/:id/erase — the staff member confirmed the candidate and their records go. */
export const erasePrivacyRequestSchema = z.object({ confirm: z.literal(true) });

/** GET /api/admin/privacy-requests */
export interface PrivacyRequestsDTO {
  items: PrivacyRequestDTO[];
  counts: { open: number; overdue: number; dueSoon: number };
}

/* ------------------------------------------------------------------ consent withdrawal (candidate) */

/** POST /api/candidate/consent/withdraw */
export const withdrawConsentSchema = z.object({
  /** The candidate confirmed they understand the exam ends. */
  confirm: z.literal(true),
  reason: z.string().trim().max(500).optional(),
});
export type WithdrawConsentRequest = z.infer<typeof withdrawConsentSchema>;

/* ------------------------------------------------------------------ retention preview and job health */

export interface RetentionPreviewDTO {
  now: number;
  /**
   * Evidence deletions due per day (UTC dates) over the preview window. `evidenceItems`: images; `recordings`: exam
   * recording segments (./recording.ts), deleted together with the images.
   */
  days: { date: string; sessions: number; evidenceItems: number; recordings: number }[];
  /** Due but not yet deleted (the job is behind or failing), excluding legal holds. */
  overdue: { sessions: number; evidenceItems: number; recordings: number; oldestDueAt: number | null };
  /** Ended sessions whose event records (no images) are deleted in the window. */
  eventMetadataSessions: number;
  legalHolds: { sessionId: string; candidateName: string; examTitle: string; endedAt: number | null; evidenceItems: number; recordings: number }[];
  job: RetentionJobStatusDTO;
}

export interface RetentionJobStatusDTO {
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Summary of the last successful run. */
  lastSummary: { sessionsEvidencePurged: number; evidenceItemsPurged: number; sessionsEventMetadataPurged: number; skippedLegalHold: number; failures: number } | null;
  /** True when the last successful run is older than 3 hours (the job runs hourly). */
  stale: boolean;
}

/** A run older than this is reported as stale (the job runs hourly). */
export const RETENTION_STALE_AFTER_MS = 3 * 3600_000;

/** GET /api/admin/retention/preview?days= (1–90, default 30). */
export const retentionPreviewQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

/* ------------------------------------------------------------------ operational checks */

export const OPS_CHECK_STATUSES = ['ok', 'warning', 'failing'] as const;
export type OpsCheckStatus = (typeof OPS_CHECK_STATUSES)[number];

/** `sandbox_purge`: sandbox organisations only (the automatic deletion of their data, ./quotas.ts). */
export const OPS_CHECK_IDS = ['retention_job', 'retention_overdue', 'privacy_requests', 'capacity', 'webhooks', 'email_alerts', 'api_keys', 'sandbox_purge'] as const;
export type OpsCheckId = (typeof OPS_CHECK_IDS)[number];

export interface OpsCheckDTO {
  id: OpsCheckId;
  label: string;
  status: OpsCheckStatus;
  /** One plain sentence: what was found and, when it is not ok, what to do. */
  detail: string;
}

/** GET /api/admin/ops/checks — the organisation's operational health at a glance (admin). */
export interface OpsChecksDTO {
  now: number;
  checks: OpsCheckDTO[];
}
