/**
 * Postgres schema (drizzle). All timestamps are timestamptz (JS Date); DTOs convert to epoch ms.
 * After editing this file run `pnpm --filter @sp/server db:generate` to produce a SQL migration in ./drizzle.
 */
import { sql } from 'drizzle-orm';
import type { EvidenceAccumulator, SessionBaseline } from '../services/identity-evidence.js';
import type { ExternalVerifierStoredSettings } from '../verifiers/settings.js';
import {
  bigserial,
  boolean,
  check,
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
  AccommodationBasis,
  AccommodationKind,
  AnswerValue,
  ApiKeyScope,
  CandidateCommand,
  ExamVersionChangesDTO,
  ExamVersionQuestionDTO,
  ExamVersionReason,
  CheckPurpose,
  ConnectionStatus,
  DecisionConfigStatus,
  DecisionThresholds,
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
  MfaRequirement,
  MonitoringStatus,
  OrgKind,
  OrgQuotas,
  PeriodKind,
  PolicyExceptionDTO,
  PrivacyRequestChannel,
  PrivacyRequestKind,
  PrivacyRequestStatus,
  ProctoringPolicyInput,
  QuestionType,
  RecordingStream,
  ReviewResolution,
  ReviewSlaSettings,
  ReviewStatus,
  SessionEndReason,
  SessionReviewOutcome,
  SessionReviewState,
  SessionStatus,
  Severity,
  SsoAssignableRole,
  SsoClaimMapping,
  SsoProviderKind,
  SsoRoleMapping,
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
  /** Optional external second-opinion face verifier (src/verifiers/settings.ts; key pair stored encrypted). */
  externalVerifier: ExternalVerifierStoredSettings;
  /** Who must use two-step sign-in (services/mfa.ts). */
  requireMfa: MfaRequirement;
  /** Service-level targets for review work (review queue, overdue holds). */
  reviewSla: ReviewSlaSettings;
  /**
   * Version of the active decision configuration (services/decision-configs.ts), mirrored here with its thresholds
   * (identityThresholds) so the decision paths read one row. 1 until a configuration was approved.
   */
  decisionConfigVersion: number;
  /**
   * Storage location for new evidence images (data residency; a name from the server's STORAGE_LOCATIONS, `default`
   * when unset). Owner only. Existing images stay where they are until `storage:move` moves them.
   */
  evidenceLocation: string;
  /** Staff other than owners must sign in with single sign-on (services/sso/*). */
  requireSso: boolean;
}

export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    /**
     * `production` (default) or `sandbox` (packages/shared/src/quotas.ts): set by the server operator only
     * (`org:create` / `org:set`), never by staff. A sandbox's data is deleted automatically (services/sandbox-purge.ts).
     */
    kind: text('kind').$type<OrgKind>().notNull().default('production'),
    /**
     * Operator-set limits (services/quotas.ts): a missing key = the kind's default (production: none; sandbox:
     * SANDBOX_DEFAULT_QUOTAS), null = no limit.
     */
    quotas: jsonb('quotas').$type<Partial<OrgQuotas>>().notNull().default({}),
    /** Sandbox: days after its last use before data is deleted (null = DEFAULT_SANDBOX_PURGE_DAYS). */
    sandboxPurgeDays: integer('sandbox_purge_days'),
    settings: jsonb('settings').$type<Partial<OrgSettings>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('organizations_kind_check', sql`${t.kind} in ('production', 'sandbox')`)],
);

/**
 * Exam sessions created per organisation and calendar month (UTC), for the sessionsPerMonth quota and the usage shown
 * in Settings (services/quotas.ts). A counter, not a count of exam_sessions rows: sessions deleted later (an erased
 * candidate, the sandbox clean-up) still count for the month they were created in. Incremented in the transaction
 * that creates the sessions. One row per month is kept (usage history).
 */
export const orgUsage = pgTable(
  'org_usage',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** YYYY-MM (UTC). */
    month: text('month').notNull(),
    sessionsCreated: integer('sessions_created').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.month] })],
);

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
    /** Two-step sign-in (services/mfa.ts): the TOTP secret, encrypted (AAD totp:<userId>); null when off. */
    totpSecretEnc: bytea('totp_secret_enc'),
    /** The last TOTP time step accepted: a code is never accepted twice (replay). */
    totpLastStep: integer('totp_last_step'),
    mfaEnabledAt: ts('mfa_enabled_at'),
    /** A secret being set up, not active until confirmed (AAD totp-pending:<userId>). */
    totpPendingEnc: bytea('totp_pending_enc'),
    totpPendingAt: ts('totp_pending_at'),
    /** Created by SCIM provisioning or at a first single sign-on (just-in-time); null = created in the staff app. */
    provisionedVia: text('provisioned_via').$type<'scim' | 'sso'>(),
    /** The SCIM client's own identifier for this account (SCIM `externalId`). */
    scimExternalId: text('scim_external_id'),
    /** Deleted through SCIM (the account is disabled and SCIM answers 404 for it; re-created by a SCIM POST). */
    scimDeletedAt: ts('scim_deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('staff_users_email_uq').on(sql`lower(${t.email})`), index('staff_users_org_idx').on(t.orgId)],
);

/** Single-use recovery codes for two-step sign-in (sha256 of the normalised code; a code is used once). */
export const staffRecoveryCodes = pgTable(
  'staff_recovery_codes',
  {
    id: id(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    usedAt: ts('used_at'),
  },
  (t) => [index('staff_recovery_codes_user_idx').on(t.staffUserId)],
);

/**
 * The second step of a sign-in with two-step sign-in: created when the password was right, carried by a signed
 * httpOnly cookie (sha256 of its token stored), valid for 5 minutes and a few attempts.
 */
export const staffLoginChallenges = pgTable(
  'staff_login_challenges',
  {
    id: id(),
    tokenHash: text('token_hash').notNull(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
  },
  (t) => [uniqueIndex('staff_login_challenges_token_uq').on(t.tokenHash), index('staff_login_challenges_user_idx').on(t.staffUserId)],
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
    /** How the session was signed in: password (+ two-step sign-in) or single sign-on. */
    authMethod: text('auth_method').$type<'password' | 'sso'>().notNull().default('password'),
    /** The identity provider of a single sign-on session. */
    ssoProviderId: uuid('sso_provider_id'),
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

/* ------------------------------------------------------------------ single sign-on and SCIM (services/sso/*, services/scim.ts) */

/** An organisation's identity provider (OpenID Connect or SAML 2.0). Changed by owners only. */
export const identityProviders = pgTable(
  'identity_providers',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SsoProviderKind>().notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    oidcIssuer: text('oidc_issuer'),
    oidcClientId: text('oidc_client_id'),
    /** OIDC client secret, AES-GCM encrypted (AAD `sso-client-secret:<id>`); null for a public client (PKCE only). */
    oidcClientSecretEnc: bytea('oidc_client_secret_enc'),
    oidcScopes: text('oidc_scopes').notNull().default('openid email profile'),
    /** Refuse ID tokens whose email_verified claim is not true. */
    oidcRequireVerifiedEmail: boolean('oidc_require_verified_email').notNull().default(true),
    samlEntityId: text('saml_entity_id'),
    samlSsoUrl: text('saml_sso_url'),
    /** The identity provider's signing certificates (PEM). */
    samlCertificates: jsonb('saml_certificates').$type<string[]>().notNull().default([]),
    claimMapping: jsonb('claim_mapping').$type<SsoClaimMapping>().notNull().default({}),
    /** Just-in-time accounts at the first sign-in of an unknown address of a claimed domain. */
    jitEnabled: boolean('jit_enabled').notNull().default(false),
    jitDefaultRole: text('jit_default_role').$type<SsoAssignableRole>().notNull().default('reviewer'),
    /** Group (claim / attribute value) -> role for just-in-time accounts; the highest matching role wins. */
    roleMappings: jsonb('role_mappings').$type<SsoRoleMapping[]>().notNull().default([]),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('identity_providers_org_idx').on(t.orgId)],
);

/** Email domains claimed by identity providers: a domain signs in through one provider on the whole server. */
export const ssoDomains = pgTable(
  'sso_domains',
  {
    /** Lower case, e.g. `example.edu`. */
    domain: text('domain').primaryKey(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
  },
  (t) => [index('sso_domains_provider_idx').on(t.providerId)],
);

/** The identity (OIDC `sub` / SAML NameID) a staff account is linked to at a provider: set at the first single sign-on. */
export const staffSsoIdentities = pgTable(
  'staff_sso_identities',
  {
    id: id(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    /** The address the provider asserted at the last sign-in. */
    email: text('email').notNull(),
    createdAt: createdAt(),
    lastLoginAt: ts('last_login_at'),
  },
  (t) => [uniqueIndex('staff_sso_identities_subject_uq').on(t.providerId, t.subject), uniqueIndex('staff_sso_identities_user_uq').on(t.staffUserId, t.providerId)],
);

/** What the identity provider asserted (mapped through the provider's claim mapping). */
export interface SsoAttemptIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  groups: string[];
}

/**
 * A single sign-on in progress (10 minutes): created when the browser is sent to the provider, bound to that browser by
 * a signed cookie (sha256 stored), used once. OIDC: state (sha256), nonce, PKCE verifier. SAML: the AuthnRequest ID;
 * the ACS (a cross-site POST that carries no cookies) stores the validated identity and the browser then completes the
 * sign-in with its cookie (GET /api/auth/sso/complete).
 */
export const ssoLoginAttempts = pgTable(
  'sso_login_attempts',
  {
    id: id(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    status: text('status').$type<'pending' | 'validated' | 'done' | 'failed'>().notNull().default('pending'),
    browserHash: text('browser_hash').notNull(),
    stateHash: text('state_hash'),
    nonce: text('nonce'),
    codeVerifier: text('code_verifier'),
    samlRequestId: text('saml_request_id'),
    /** The SAML identity validated at the ACS, waiting for the browser (status 'validated'). */
    identity: jsonb('identity').$type<SsoAttemptIdentity>(),
    returnTo: text('return_to').notNull().default('/admin'),
    ip: text('ip'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    uniqueIndex('sso_login_attempts_state_uq').on(t.stateHash),
    uniqueIndex('sso_login_attempts_saml_request_uq').on(t.samlRequestId),
    index('sso_login_attempts_expires_idx').on(t.expiresAt),
  ],
);

/** SAML assertion IDs already used (replay protection), kept until the assertion would have expired. */
export const ssoSamlAssertions = pgTable(
  'sso_saml_assertions',
  {
    providerId: uuid('provider_id')
      .notNull()
      .references(() => identityProviders.id, { onDelete: 'cascade' }),
    assertionId: text('assertion_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.assertionId] }), index('sso_saml_assertions_expires_idx').on(t.expiresAt)],
);

/** SCIM bearer token of an organisation (only sha256 stored; at most one active token per organisation). */
export const scimTokens = pgTable(
  'scim_tokens',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Display prefix: `sp_scim_` + the first 6 characters of the random part. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    uniqueIndex('scim_tokens_hash_uq').on(t.tokenHash),
    uniqueIndex('scim_tokens_active_org_uq')
      .on(t.orgId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
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
    /** The version attempts get when they start (services/exam-versions.ts); null until the exam is first published. */
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('exams_org_idx').on(t.orgId)],
);

/**
 * Immutable snapshots of an exam: what candidates see (title, instructions, questions, options) and how it is graded
 * (answer keys, points), plus the duration and the exam's own rules. A new version is written when a published exam
 * changes; an attempt pins the current version when it starts (exam_sessions.exam_version_id) and keeps it, so later
 * edits never change a running or finished attempt. Never updated or deleted on its own (cascades with the exam).
 */
export const examVersions = pgTable(
  'exam_versions',
  {
    id: id(),
    examId: uuid('exam_id')
      .notNull()
      .references(() => exams.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    instructions: text('instructions').notNull(),
    durationSec: integer('duration_sec').notNull(),
    policy: jsonb('policy').$type<ProctoringPolicyInput>().notNull(),
    questions: jsonb('questions').$type<ExamVersionQuestionDTO[]>().notNull(),
    /** sha256 of the canonical snapshot (null for versions written by the upgrade migration). */
    contentHash: text('content_hash'),
    changes: jsonb('changes').$type<ExamVersionChangesDTO>().notNull(),
    reason: text('reason').$type<ExamVersionReason>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('exam_versions_exam_number_uq').on(t.examId, t.number)],
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

/* ------------------------------------------------------------------ accommodations */

/**
 * Approved per-candidate exceptions to exam rules (packages/shared/src/accommodations.ts, services/accommodations.ts).
 * Never edited: a change is a revocation plus a new grant, so the record of what applied when stays intact.
 */
export const accommodations = pgTable(
  'accommodations',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'cascade' }),
    /** null: every exam of the candidate. */
    examId: uuid('exam_id').references(() => exams.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AccommodationKind>().notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    basis: text('basis').$type<AccommodationBasis>().notNull(),
    /** Administrators' note, encrypted (AAD accommodation-note:<id>); null when empty. */
    noteEnc: bytea('note_enc'),
    validUntil: ts('valid_until'),
    grantedBy: uuid('granted_by'),
    grantedAt: ts('granted_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [index('accommodations_candidate_idx').on(t.candidateId), index('accommodations_org_idx').on(t.orgId)],
);
export type Accommodation = typeof accommodations.$inferSelect;

/** An accommodation as applied to a session (exam_sessions.accommodations). */
export interface SessionAccommodationItem {
  id: string;
  kind: AccommodationKind;
  params: Record<string, unknown>;
  basis: AccommodationBasis;
  grantedAt: number;
}

/**
 * The accommodations of a session: recomputed while it has not started (so grants and revocations reach it), frozen
 * when it starts. `extraTimeMs` is included in exam_sessions.duration_ms.
 */
export interface SessionAccommodations {
  items: SessionAccommodationItem[];
  extraTimeMs: number;
  at: number;
  /** The exam rules the accommodations changed, recorded when the exam starts (until then computed on read). */
  exceptions?: PolicyExceptionDTO[];
}

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
  /** v2: identity-continuity evidence accumulator over mid-exam samples (services/identity-evidence.ts). */
  evidence: EvidenceAccumulator;
  /** When the current observed active period began (start / resume / reconnect / hold release): start-up cadence. */
  activeSince: number | null;
  /** The server wants a sample with this trigger (e.g. exam_start) since `since`; cleared when one arrives. */
  sampleRequest: { trigger: IdentityCheckTrigger; since: number } | null;
  /** Bursts whose frames are still arriving (identity_sample_frames). */
  pendingBursts: PendingBurst[];
  /**
   * Optional external second opinion (identity-external.ts): a suspected swap about to be confirmed waits for it
   * (the confirming identity check), and a provider's "same person" holds off borderline confirmations until `until`.
   */
  secondOpinionPending: { checkId: string; since: number } | null;
  secondOpinionVeto: { checkId: string; until: number } | null;
  /**
   * Per-session normalisation of mid-exam samples: 'continuous' while the conditions are those of the enrolment, or
   * of the period's own baseline (`periodBaseline`); 'relaxed' after a resume / reconnect / reverify check that left
   * too few usable frames to measure one (another day, room or camera is possible).
   */
  normalisation: 'continuous' | 'relaxed';
  /**
   * The current active period began with a passed resume / reconnect / reverify check: the genuine similarity of that
   * check's usable frames to the reference (mean / sd / n; `bucket` = the reference's bucket, as in the enrolment
   * baseline). Mid-exam samples of the period are normalised 'continuous' against it instead of the enrolment
   * baseline. null / absent: the enrolment baseline.
   */
  periodBaseline?: (SessionBaseline & { checkId?: string; at?: number }) | null;
  /** Open identity_unverifiable observation (details.reason 'no_samples'): server requests for a sample went unanswered. */
  openNoSamplesEventId?: string | null;
  /** Server receipt time of the latest identity sample (frame) while active — the watchdog's measure of silence. */
  lastSampleReceivedAt?: number | null;
  /**
   * The routine interval the client was last told (nextSampleInMs; longer than the policy's while the server was
   * busy, identity-evidence.ts loadAwareDelayMs): the watchdog never calls samples overdue before it has passed.
   */
  cadenceMs?: number | null;
}

/** A burst of identity frames being collected (IdentitySampleQuery burstId / burstIndex / burstSize). */
export interface PendingBurst {
  id: string;
  size: number;
  trigger: IdentityCheckTrigger;
  /** Server receipt time of the first frame (the burst is decided on the frames received after BURST_TIMEOUT_MS). */
  firstReceivedAt: number;
  /** Distinct burstIndex values received. */
  indexes: number[];
}

export type SessionMonitoring = MonitoringStatus & { at: number; fps?: number; cameraState?: string; visibility?: string; fullscreen?: boolean };

export interface SessionScore {
  points: number;
  maxPoints: number;
  autoGraded: boolean;
  gradedAt: number;
  perQuestion: { questionId: string; points: number; maxPoints: number; correct: boolean | null }[];
  /** The answer keys / points the score uses: the attempt's own version, or a later one after a regrade. */
  keysVersionId?: string | null;
  /** Explicit regrades (POST /api/admin/exams/:id/regrade), oldest first: the score before each one. */
  regrades?: { at: number; by: string; reason: string; keysFromVersionId: string; keysFromVersion: number; previous: { points: number; maxPoints: number } }[];
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
    /** The exam version this attempt is pinned to: set when it starts, never changed afterwards. */
    examVersionId: uuid('exam_version_id').references(() => examVersions.id),
    candidateId: uuid('candidate_id')
      .notNull()
      .references(() => candidates.id, { onDelete: 'cascade' }),
    /** sha256 hex of the candidate access token. */
    accessTokenHash: text('access_token_hash').notNull(),
    /** AES-GCM encrypted access token so staff can re-copy the link. */
    accessTokenEnc: bytea('access_token_enc'),
    status: text('status').$type<SessionStatus>().notNull().default('invited'),
    endReason: text('end_reason').$type<SessionEndReason>(),
    /** Approved accommodations (see SessionAccommodations); null: none applied. */
    accommodations: jsonb('accommodations').$type<SessionAccommodations>(),
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
    /**
     * First time the exam start was deferred because the server was at capacity (admission at exam start,
     * candidate-actions.ts); cleared when the exam starts. Bounds how long a candidate can be kept waiting.
     */
    startDeferredSince: ts('start_deferred_since'),
    /**
     * Scheduling window (packages/shared/src/scheduling.ts; either bound may be null = open): the exam can be started
     * only inside it, the check-in may begin CHECK_IN_LEAD_MS earlier. Changed only before the exam starts.
     */
    windowStartsAt: ts('window_starts_at'),
    windowEndsAt: ts('window_ends_at'),
    /**
     * Reconnect checks passed during the exam (the exam reopened in a new browser window) since it started, or since
     * staff released a resume-limit hold / reopened the exam (policy.resume.maxReconnects).
     */
    reconnectCount: integer('reconnect_count').notNull().default(0),
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
    // Exams started in a time range per organisation (decision configuration usage, drift denominators).
    index('exam_sessions_org_started_idx').on(t.orgId, t.startedAt),
    index('exam_sessions_exam_idx').on(t.examId),
    index('exam_sessions_candidate_idx').on(t.candidateId),
    index('exam_sessions_exam_version_idx').on(t.examVersionId),
    // Sweeper look-ups (jobs/sweeper.ts). Neither index contains a column the routine heartbeat writes
    // (last_heartbeat_at, monitoring, ...), so heartbeat updates stay HOT (no index maintenance per heartbeat).
    index('exam_sessions_online_idx').on(t.status).where(sql`${t.connection} = 'online'`),
    index('exam_sessions_running_idx').on(t.status).where(sql`${t.runningSince} is not null`),
    // Resume-policy look-up of disconnected exams (jobs/sweeper.ts, maxOfflineMinutes); same HOT-friendly shape.
    index('exam_sessions_offline_idx').on(t.status).where(sql`${t.connection} = 'offline'`),
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
    /**
     * Genuine self-similarity measured at enrolment (leave-one-out scores of the gallery frames), used to normalise
     * later scores per session. Null for references created before identity v2 (global calibration only).
     */
    baseline: jsonb('baseline').$type<SessionBaseline | null>(),
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
    /** 'face': camera, live-person and identity frames. 'attest': identity verified by staff — no frames (StartCheckResponse.mode). */
    mode: text('mode').$type<'face' | 'attest'>().notNull().default('face'),
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
    /** What made the decision (model governance): the organisation's decision configuration version … */
    decisionConfigVersion: integer('decision_config_version'),
    /** … the server's identity calibration (vision/calibration.ts) and recogniser model (vision/embeddings.ts). Null before 0011. */
    calibrationVersion: text('calibration_version'),
    modelVersion: text('model_version'),
  },
  (t) => [
    uniqueIndex('identity_checks_sample_uq').on(t.sessionId, t.sampleId),
    index('identity_checks_session_idx').on(t.sessionId, t.at),
    index('identity_checks_event_idx').on(t.eventId),
    // Organisation-wide time ranges (calibration by condition, drift).
    index('identity_checks_at_idx').on(t.at),
  ],
);

/**
 * Frames of identity-sample bursts (POST /api/candidate/identity/sample with burstId). A burst is decided as ONE
 * sample (identity_checks row) once all its frames arrived or BURST_TIMEOUT_MS after its first frame; the frames'
 * embeddings are only kept (encrypted, AAD `sample-frame:<id>`) until then.
 */
export const identitySampleFrames = pgTable(
  'identity_sample_frames',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    /** Client sample id of this frame (idempotency). */
    sampleId: text('sample_id').notNull(),
    burstId: text('burst_id').notNull(),
    burstIndex: integer('burst_index').notNull(),
    burstSize: integer('burst_size').notNull(),
    trigger: text('trigger').$type<IdentityCheckTrigger>().notNull(),
    capturedAt: ts('captured_at').notNull(),
    receivedAt: ts('received_at').notNull(),
    analysis: jsonb('analysis').$type<FrameAnalysisSummary>().notNull(),
    similarity: doublePrecision('similarity'),
    /** Per-frame label (the burst decision is on the identity_checks row). */
    decision: text('decision').$type<IdentityDecision>().notNull(),
    llr: doublePrecision('llr'),
    /** Encrypted embedding; null once the burst was decided (or purged). */
    embeddingEnc: bytea('embedding_enc'),
    probeEvidenceId: uuid('probe_evidence_id'),
    frameEvidenceId: uuid('frame_evidence_id'),
    /** The identity_checks row of the burst decision (null while the burst is being collected). */
    identityCheckId: uuid('identity_check_id'),
    clientInstanceId: text('client_instance_id'),
    /** Stored response for idempotent replays of the same sampleId. */
    response: jsonb('response').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('identity_sample_frames_sample_uq').on(t.sessionId, t.sampleId), index('identity_sample_frames_burst_idx').on(t.sessionId, t.burstId)],
);
export type IdentitySampleFrame = typeof identitySampleFrames.$inferSelect;

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
    /** What the reviewer concluded (services/review.ts); null for undecided events and older plain-status decisions. */
    resolution: text('resolution').$type<ReviewResolution>(),
    /** Version of the browser detectors that raised it (@sp/detection DETECTION_ENGINE_VERSION); null for server events. */
    engineVersion: text('engine_version'),
  },
  (t) => [
    index('events_session_started_idx').on(t.sessionId, t.startedAt),
    index('events_category_idx').on(t.category),
    index('events_review_idx').on(t.reviewStatus),
    index('events_org_received_idx').on(t.orgId, t.receivedAt),
    index('events_type_idx').on(t.type),
    // Undecided flags (review queue, review-backlog metrics): small even when the events table is large.
    index('events_undecided_flags_idx')
      .on(t.orgId, t.sessionId, t.firstReceivedAt)
      .where(sql`${t.reviewStatus} = 'unreviewed' and ${t.category} in ('integrity', 'uncertain', 'technical')`),
    // Flags by start time per organisation (drift: share of exams with each kind of flag).
    index('events_org_flags_started_idx')
      .on(t.orgId, t.startedAt)
      .where(sql`${t.category} in ('integrity', 'uncertain', 'technical')`),
  ],
);

/** `recording`: a segment of the exam recording (policy.recording; its metadata in recording_segments). */
export type EvidenceKind = 'event_screenshot' | 'identity_probe' | 'identity_reference' | 'id_photo' | 'liveness_frame' | 'recording';

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
    /**
     * Storage location holding the blob (config STORAGE_LOCATIONS; null = `default`): where it was written, or moved to
     * by `storage:move` (services/storage-move.ts). Reads and deletes always go there (lib/storage.ts storageAt).
     */
    storageLocation: text('storage_location'),
    byteSize: integer('byte_size').notNull(),
    /** sha256 of the plaintext (the JPEG, or the recording segment). */
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
    // An organisation's evidence per location (Settings counts; storage:move walks each source location in id order).
    index('evidence_org_location_idx').on(t.orgId, t.storageLocation, t.id).where(sql`${t.purgedAt} IS NULL`),
    // Locations still holding evidence, checked at start-up (all null — the default location — until one is used).
    index('evidence_location_idx').on(t.storageLocation).where(sql`${t.storageLocation} IS NOT NULL AND ${t.purgedAt} IS NULL`),
  ],
);

/**
 * Segments of an exam recording (policy.recording; services/recordings.ts). Each segment is a complete media file
 * stored as an evidence row (kind `recording`: encrypted blob in the organisation's storage location, retention,
 * legal hold, erasure, export, storage:move and rekey as for images); this row says which stream it belongs to and
 * when it plays. Kept as a tombstone with its purged evidence row until event retention deletes that row (cascade).
 */
export const recordingSegments = pgTable(
  'recording_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    /** The media blob (evidence.kind = 'recording'). */
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade' }),
    stream: text('stream').$type<RecordingStream>().notNull(),
    /** Counts from 0 per stream and recording browser instance. */
    seq: integer('seq').notNull(),
    startedAt: ts('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    /** As the browser produced it, e.g. video/webm;codecs=vp8,opus (evidence.content_type holds the container type). */
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** The browser instance (page load) that recorded it. */
    clientInstanceId: text('client_instance_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Re-uploads of the same segment (after an ambiguous failure, or by a reloaded page) are recognised.
    uniqueIndex('recording_segments_upload_uq').on(t.sessionId, t.stream, t.clientInstanceId, t.seq),
    // A session's segments in time order (staff player, report, export).
    index('recording_segments_session_idx').on(t.sessionId, t.startedAt),
    index('recording_segments_evidence_idx').on(t.evidenceId),
    check('recording_segments_stream_check', sql`${t.stream} in ('camera', 'screen')`),
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

/**
 * Every review decision on an event, oldest first (who, what, why; whether it changed another reviewer's decision).
 * The event row holds the current decision; this is its history — reviewer disagreement and an exportable trail.
 */
export const eventReviews = pgTable(
  'event_reviews',
  {
    id: id(),
    /** Insertion order (decisions in the same millisecond keep their order). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    orgId: uuid('org_id').notNull(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id').references(() => staffUsers.id, { onDelete: 'set null' }),
    status: text('status').$type<ReviewStatus>().notNull(),
    resolution: text('resolution').$type<ReviewResolution>(),
    note: text('note'),
    previousStatus: text('previous_status').$type<ReviewStatus>().notNull(),
    previousResolution: text('previous_resolution').$type<ReviewResolution>(),
    previousReviewerId: uuid('previous_reviewer_id'),
    /** Changed a decision another reviewer had made (a disagreement). */
    overrides: boolean('overrides').notNull().default(false),
    /** Part of a bulk or incident decision. */
    bulk: boolean('bulk').notNull().default(false),
    at: ts('at').notNull(),
  },
  (t) => [index('event_reviews_event_idx').on(t.eventId, t.at), index('event_reviews_org_at_idx').on(t.orgId, t.at), index('event_reviews_session_idx').on(t.sessionId)],
);
export type EventReview = typeof eventReviews.$inferSelect;

/**
 * The review of a session as a whole (review queue): who is on it, escalation, and the final outcome. A row exists
 * once someone assigned, escalated or resolved it; sessions with undecided flags or on hold need review without one.
 */
export const sessionReviews = pgTable(
  'session_reviews',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => examSessions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    state: text('state').$type<SessionReviewState>().notNull().default('open'),
    assigneeId: uuid('assignee_id').references(() => staffUsers.id, { onDelete: 'set null' }),
    assignedAt: ts('assigned_at'),
    assignedBy: uuid('assigned_by'),
    escalatedAt: ts('escalated_at'),
    escalatedBy: uuid('escalated_by'),
    escalationNote: text('escalation_note'),
    outcome: text('outcome').$type<SessionReviewOutcome>(),
    outcomeNote: text('outcome_note'),
    resolvedAt: ts('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('session_reviews_org_state_idx').on(t.orgId, t.state), index('session_reviews_assignee_idx').on(t.assigneeId)],
);
export type SessionReview = typeof sessionReviews.$inferSelect;

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    orgId: uuid('org_id'),
    at: ts('at').notNull(),
    actorType: text('actor_type').$type<'staff' | 'candidate' | 'system' | 'api_key' | 'scim'>().notNull(),
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

/* ------------------------------------------------------------------ privacy operations */

/**
 * The register of data-subject requests (access, erasure, consent withdrawal, …) with their legal deadlines
 * (services/privacy-requests.ts, docs/PRIVACY.md §5). A row outlives the candidate it concerns (candidate_id is set to
 * null when the candidate is erased; `subject` still says who it was about), so the organisation can show it answered.
 */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<PrivacyRequestKind>().notNull(),
    status: text('status').$type<PrivacyRequestStatus>().notNull().default('open'),
    /** Who the request is about (name, email, reference), as given: the register must outlive an erased candidate. */
    subject: text('subject').notNull(),
    candidateId: uuid('candidate_id').references(() => candidates.id, { onDelete: 'set null' }),
    /** The exam session it arose from (consent withdrawal). */
    sessionId: uuid('session_id').references(() => examSessions.id, { onDelete: 'set null' }),
    channel: text('channel').$type<PrivacyRequestChannel>().notNull(),
    /** 'candidate': made in the exam app (consent withdrawal); 'staff': recorded by a staff member. */
    source: text('source').$type<'staff' | 'candidate'>().notNull(),
    receivedAt: ts('received_at').notNull(),
    /** receivedAt + DEFAULT_PRIVACY_RESPONSE_DAYS + extension days. */
    dueAt: ts('due_at').notNull(),
    extensionDays: integer('extension_days'),
    extensionReason: text('extension_reason'),
    /** What was asked, encrypted (AAD privacy-request:<id>); null when empty. Administrators only. */
    detailsEnc: bytea('details_enc'),
    assigneeId: uuid('assignee_id').references(() => staffUsers.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    resolutionNote: text('resolution_note'),
    closedAt: ts('closed_at'),
    closedBy: uuid('closed_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    /** The candidate's data was exported / erased for this request. */
    exportedAt: ts('exported_at'),
    erasedAt: ts('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('privacy_requests_org_status_due_idx').on(t.orgId, t.status, t.dueAt), index('privacy_requests_candidate_idx').on(t.candidateId)],
);
export type PrivacyRequest = typeof privacyRequests.$inferSelect;

/** Summary of a retention run kept in job_status.last_summary (RetentionJobStatusDTO.lastSummary). */
export interface RetentionRunSummary {
  sessionsEvidencePurged: number;
  evidenceItemsPurged: number;
  sessionsEventMetadataPurged: number;
  skippedLegalHold: number;
  failures: number;
}

/** Summary of a sandbox clean-up run kept in job_status.last_summary (services/sandbox-purge.ts). */
export interface SandboxPurgeRunSummary {
  organisations: number;
  sessionsDeleted: number;
  evidenceItemsPurged: number;
  candidatesDeleted: number;
  skippedLegalHold: number;
  failures: number;
}

/**
 * The last run of a cluster-wide background job, whichever instance ran it (retention: services/retention.ts), so
 * staff and monitoring can see that deletion is actually happening (GET /api/admin/retention/preview, /ops/checks).
 */
export const jobStatus = pgTable('job_status', {
  name: text('name').primaryKey(),
  lastStartedAt: ts('last_started_at'),
  lastFinishedAt: ts('last_finished_at'),
  lastSuccessAt: ts('last_success_at'),
  /** The error of the last run, null when it succeeded. */
  lastError: text('last_error'),
  lastSummary: jsonb('last_summary').$type<RetentionRunSummary | SandboxPurgeRunSummary>(),
  updatedAt: updatedAt(),
});
export type JobStatusRow = typeof jobStatus.$inferSelect;

/**
 * Versioned identity decision configurations (model governance, services/decision-configs.ts): proposed with a
 * reason, approved by a second administrator, active one at a time, retired when replaced; rollback restores an
 * earlier one as a new version. `thresholds` null = the release defaults of the running server.
 */
export const decisionConfigs = pgTable(
  'decision_configs',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: text('status').$type<DecisionConfigStatus>().notNull(),
    thresholds: jsonb('thresholds').$type<DecisionThresholds | null>(),
    note: text('note').notNull(),
    basedOnVersion: integer('based_on_version'),
    rollbackOfVersion: integer('rollback_of_version'),
    proposedBy: uuid('proposed_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    proposedAt: ts('proposed_at').notNull(),
    decidedBy: uuid('decided_by').references(() => staffUsers.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    /** Approved by its proposer because the organisation had no other active administrator. */
    selfApproved: boolean('self_approved').notNull().default(false),
    activatedAt: ts('activated_at'),
    retiredAt: ts('retired_at'),
  },
  (t) => [
    uniqueIndex('decision_configs_version_uq').on(t.orgId, t.version),
    // One active configuration and at most one open proposal per organisation.
    uniqueIndex('decision_configs_active_uq').on(t.orgId).where(sql`${t.status} = 'active'`),
    uniqueIndex('decision_configs_proposed_uq').on(t.orgId).where(sql`${t.status} = 'proposed'`),
  ],
);
export type DecisionConfig = typeof decisionConfigs.$inferSelect;

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
    /**
     * What the key may do (API_KEY_SCOPES, canonical order). Always set explicitly on insert; keys that existed before
     * scopes (migration 0015) were given every scope of that time, i.e. the full access they had.
     */
    scopes: jsonb('scopes').$type<ApiKeyScope[]>().notNull().default([]),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    /** After this time the key is refused (401 api_key_expired); null = never expires. */
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.orgId, t.createdAt)],
);

/**
 * `Idempotency-Key` records of the integration API (services/idempotency.ts): one row per (organisation, key), deleted
 * after 24 h by the `api-idempotency` job. While the first request runs `statusCode` is null (a concurrent repeat gets
 * 409 idempotency_key_in_use); once it succeeded, its response is stored — encrypted, since it can contain candidates'
 * exam links (AAD `api-idempotency:<id>`) — and replayed for repeats of the same request.
 */
export const apiIdempotencyKeys = pgTable(
  'api_idempotency_keys',
  {
    id: id(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** sha256 of the method, path, query string and canonical JSON body. */
    requestHash: text('request_hash').notNull(),
    /** HTTP status of the stored response; null while the first request is in progress. */
    statusCode: integer('status_code'),
    responseEnc: bytea('response_enc'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [uniqueIndex('api_idempotency_keys_org_key_uq').on(t.orgId, t.key), index('api_idempotency_keys_created_idx').on(t.createdAt)],
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
export type ExamVersion = typeof examVersions.$inferSelect;
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
export type RecordingSegmentRow = typeof recordingSegments.$inferSelect;
export type Answer = typeof answers.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type DeviceRecord = typeof deviceRecords.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ApiIdempotencyKey = typeof apiIdempotencyKeys.$inferSelect;
export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type EmailAlert = typeof emailAlerts.$inferSelect;
export type IdentityProvider = typeof identityProviders.$inferSelect;
export type SsoLoginAttempt = typeof ssoLoginAttempts.$inferSelect;
export type ScimToken = typeof scimTokens.$inferSelect;
