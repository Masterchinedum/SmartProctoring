import { DEFAULT_IDENTITY_THRESHOLDS, identityThresholdsSchema, resolvePolicy, type IdentityThresholds, type ProctoringPolicy } from '@sp/shared';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { organizations, type Organization, type OrgSettings } from '../db/schema.js';
import { DEFAULT_EXTERNAL_VERIFIER_SETTINGS, normalizeExternalVerifierSettings } from '../verifiers/settings.js';

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  evidenceRetentionDays: 30,
  eventRetentionDays: 365,
  defaultPolicy: {},
  privacyContact: '',
  identityThresholds: {
    match: DEFAULT_IDENTITY_THRESHOLDS.match,
    mismatch: DEFAULT_IDENTITY_THRESHOLDS.mismatch,
    idPhotoMatch: DEFAULT_IDENTITY_THRESHOLDS.idPhotoMatch,
    idPhotoMismatch: DEFAULT_IDENTITY_THRESHOLDS.idPhotoMismatch,
    mismatchConfirmations: DEFAULT_IDENTITY_THRESHOLDS.mismatchConfirmations,
  },
  abandonAfterDays: 30,
  alertRecipients: [],
  emailAlerts: { holds: true, pauseRequests: true, highSeverity: true },
  externalVerifier: DEFAULT_EXTERNAL_VERIFIER_SETTINGS,
};

/** Organisation settings with every field filled from defaults. */
export function orgSettings(org: Pick<Organization, 'settings'> | null | undefined): OrgSettings {
  const s = org?.settings ?? {};
  return {
    evidenceRetentionDays: s.evidenceRetentionDays ?? DEFAULT_ORG_SETTINGS.evidenceRetentionDays,
    eventRetentionDays: s.eventRetentionDays ?? DEFAULT_ORG_SETTINGS.eventRetentionDays,
    defaultPolicy: s.defaultPolicy ?? {},
    privacyContact: s.privacyContact ?? '',
    identityThresholds: { ...DEFAULT_ORG_SETTINGS.identityThresholds, ...(s.identityThresholds ?? {}) },
    abandonAfterDays: s.abandonAfterDays ?? DEFAULT_ORG_SETTINGS.abandonAfterDays,
    alertRecipients: Array.isArray(s.alertRecipients) ? s.alertRecipients : [],
    emailAlerts: { ...DEFAULT_ORG_SETTINGS.emailAlerts, ...(s.emailAlerts ?? {}) },
    externalVerifier: normalizeExternalVerifierSettings(s.externalVerifier),
  };
}

/** Identity thresholds for an organisation (validated; falls back to defaults on bad data). */
export function orgThresholds(org: Pick<Organization, 'settings'> | null | undefined): IdentityThresholds {
  const parsed = identityThresholdsSchema.safeParse(orgSettings(org).identityThresholds);
  return parsed.success ? parsed.data : DEFAULT_IDENTITY_THRESHOLDS;
}

/** Effective policy for a new exam: org default policy merged with the exam's own (exam wins, deep per section). */
export function mergePolicy(orgDefault: Record<string, unknown> | undefined, examPolicy: Record<string, unknown> | undefined): ProctoringPolicy {
  const a = (orgDefault ?? {}) as Record<string, Record<string, unknown>>;
  const b = (examPolicy ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key];
    const bv = b[key];
    out[key] = av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av) ? { ...av, ...bv } : (bv ?? av);
  }
  return resolvePolicy(out);
}

export async function loadOrg(db: DbOrTx, orgId: string): Promise<Organization | null> {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return o ?? null;
}

export async function createOrganization(db: DbOrTx, name: string, settings: Partial<OrgSettings> = {}, now = Date.now()): Promise<Organization> {
  const [org] = await db
    .insert(organizations)
    // Only explicit overrides are stored; defaults (e.g. identity thresholds) are filled in by orgSettings()
    // so improved defaults reach organisations that never customised them.
    .values({ name, settings: { ...settings }, createdAt: new Date(now), updatedAt: new Date(now) })
    .returning();
  return org;
}
