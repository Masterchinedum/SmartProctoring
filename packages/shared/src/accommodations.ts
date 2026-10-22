import { z } from 'zod';
import type { ProctoringPolicy } from './policy';

/**
 * Accommodations: approved, per-candidate exceptions to an exam's rules (extra time, rest breaks, no head-turn
 * challenge, assistive technology, behaviour detectors off, a support person, identity verified by staff, no camera).
 *
 * Each one is a documented policy exception: it says which rules it changes, and the session records exactly which
 * settings differed from the exam's own rules (`policyExceptions`), so a reviewer reading the timeline or the report
 * knows that, say, no "looking away" observations were possible. Records hold no diagnosis: the basis is a broad
 * category, and an optional note for administrators.
 */

export const ACCOMMODATION_KINDS = [
  'extra_time',
  'rest_breaks',
  'no_liveness_challenge',
  'assistive_technology',
  'detection_exemptions',
  'support_person',
  'staff_identity_verification',
  'no_camera',
] as const;
export type AccommodationKind = (typeof ACCOMMODATION_KINDS)[number];

/** Why it was granted — deliberately broad (no health or disability details are recorded). */
export const ACCOMMODATION_BASES = ['accessibility', 'technical', 'other'] as const;
export type AccommodationBasis = (typeof ACCOMMODATION_BASES)[number];

export const SUPPORT_PERSON_ROLES = ['reader', 'scribe', 'interpreter', 'assistant', 'other'] as const;
export type SupportPersonRole = (typeof SUPPORT_PERSON_ROLES)[number];

/** The behaviour detectors `detection_exemptions` can turn off (policy.detection.enabled keys). */
export const EXEMPTIBLE_DETECTORS = ['absence', 'lookingAway', 'movement', 'obstruction', 'objects', 'multiplePeople'] as const;
export type ExemptibleDetector = (typeof EXEMPTIBLE_DETECTORS)[number];

const extraTime = z
  .object({
    /** Percent of the exam's duration added (e.g. 25 = time and a quarter). */
    percent: z.number().int().min(0).max(300).default(0),
    /** Minutes added on top. */
    minutes: z.number().int().min(0).max(600).default(0),
  })
  .refine((p) => p.percent > 0 || p.minutes > 0, { message: 'Add a percentage or minutes' });

const restBreaks = z.object({
  /** null = unlimited. */
  maxPauses: z.number().int().min(1).max(50).nullable().default(null),
  /** null = no limit per break. */
  maxPauseMinutes: z.number().int().min(1).max(240).nullable().default(null),
});

const detectionExemptions = z
  .object(Object.fromEntries(EXEMPTIBLE_DETECTORS.map((d) => [d, z.boolean().default(false)])) as Record<ExemptibleDetector, z.ZodDefault<z.ZodBoolean>>)
  .refine((p) => EXEMPTIBLE_DETECTORS.some((d) => p[d]), { message: 'Choose at least one detector' });

const supportPerson = z.object({ role: z.enum(SUPPORT_PERSON_ROLES).default('assistant') });

const staffVerification = z.object({
  /** Also after pauses and reconnections. */
  reverifyOnContinue: z.boolean().default(false),
});

const empty = z.object({}).strict();

export const accommodationSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('extra_time'), params: extraTime }),
  z.object({ kind: z.literal('rest_breaks'), params: restBreaks.default({}) }),
  z.object({ kind: z.literal('no_liveness_challenge'), params: empty.default({}) }),
  z.object({ kind: z.literal('assistive_technology'), params: empty.default({}) }),
  z.object({ kind: z.literal('detection_exemptions'), params: detectionExemptions }),
  z.object({ kind: z.literal('support_person'), params: supportPerson.default({}) }),
  z.object({ kind: z.literal('staff_identity_verification'), params: staffVerification.default({}) }),
  z.object({ kind: z.literal('no_camera'), params: staffVerification.default({}) }),
]);
export type AccommodationSpec = z.infer<typeof accommodationSpecSchema>;
export type AccommodationParams<K extends AccommodationKind> = Extract<AccommodationSpec, { kind: K }>['params'];

/** POST /api/admin/candidates/:id/accommodations */
export const accommodationGrantSchema = z.intersection(
  accommodationSpecSchema,
  z.object({
    basis: z.enum(ACCOMMODATION_BASES),
    /** null / absent: every exam of the candidate. */
    examId: z.string().uuid().nullable().default(null),
    /** Epoch ms; null / absent: no end date. Must be in the future. */
    validUntil: z.number().int().positive().nullable().default(null),
    /** For administrators only (encrypted at rest). Do not record diagnoses. */
    note: z.string().trim().max(2000).default(''),
  }),
);
export type AccommodationGrant = z.infer<typeof accommodationGrantSchema>;

/** POST /api/admin/accommodations/:id/revoke */
export const accommodationRevokeSchema = z.object({ reason: z.string().trim().min(1).max(1000) });

export type AccommodationStatus = 'active' | 'expired' | 'revoked';

export interface AccommodationDTO {
  id: string;
  candidateId: string;
  kind: AccommodationKind;
  params: Record<string, unknown>;
  label: string;
  basis: AccommodationBasis;
  exam: { id: string; title: string } | null;
  validUntil: number | null;
  /** Administrators only (null for reviewers, and when empty). */
  note: string | null;
  status: AccommodationStatus;
  grantedAt: number;
  grantedBy: { id: string; name: string } | null;
  revokedAt: number | null;
  revokedBy: { id: string; name: string } | null;
  revokeReason: string | null;
}

/**
 * An accommodation as applied to one session (snapshot: later changes do not alter a started session). What it
 * changed, not why: the basis stays on the candidate's record, for administrators.
 */
export interface SessionAccommodationDTO {
  id: string;
  kind: AccommodationKind;
  params: Record<string, unknown>;
  label: string;
  grantedAt: number;
}

/** One policy setting that differs from the exam's own rules because of accommodations. */
export interface PolicyExceptionDTO {
  /** Dotted policy path, e.g. 'detection.enabled.lookingAway', or 'durationMs' for extra time. */
  path: string;
  label: string;
  from: unknown;
  to: unknown;
  /** The accommodations that changed it. */
  kinds: AccommodationKind[];
}

export interface SessionAccommodationsDTO {
  items: SessionAccommodationDTO[];
  extraTimeMs: number;
  exceptions: PolicyExceptionDTO[];
}

/* ------------------------------------------------------------------ catalog */

const pct = (n: number) => `${n} %`;
const mins = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
const DETECTOR_LABEL: Record<ExemptibleDetector, string> = {
  absence: 'absence',
  lookingAway: 'looking away',
  movement: 'unusual movement',
  obstruction: 'face covered or out of view',
  objects: 'objects such as phones or books',
  multiplePeople: 'other people in view',
};
const ROLE_LABEL: Record<SupportPersonRole, string> = { reader: 'reader', scribe: 'scribe', interpreter: 'interpreter', assistant: 'assistant', other: 'support person' };

export interface AccommodationInfo {
  title: string;
  /** For staff choosing one: what it changes. */
  description: string;
  /** A short label with its parameters (lists, badges). */
  label(params: Record<string, unknown>): string;
  /** For the candidate (welcome screen): plain, without parameters they do not need. */
  candidateLabel(params: Record<string, unknown>): string;
  /** Report limitation that applies while it is in effect (null: none — e.g. extra time limits no observation). */
  limitation(params: Record<string, unknown>): string | null;
}

export const ACCOMMODATION_CATALOG: Record<AccommodationKind, AccommodationInfo> = {
  extra_time: {
    title: 'Extra time',
    description: 'Adds a percentage of the exam’s duration and / or a number of minutes. Applied when the candidate is assigned (and updated until the exam starts).',
    label: (p) => `Extra time: ${[Number(p.percent) ? `+${pct(Number(p.percent))}` : '', Number(p.minutes) ? `+${mins(Number(p.minutes))}` : ''].filter(Boolean).join(', ')}`,
    candidateLabel: (p) => `Extra time (${[Number(p.percent) ? `+${pct(Number(p.percent))}` : '', Number(p.minutes) ? `+${mins(Number(p.minutes))}` : ''].filter(Boolean).join(', ')})`,
    limitation: () => null,
  },
  rest_breaks: {
    title: 'Rest breaks',
    description: 'Pauses are allowed without approval or a reason, and the exam clock stops during them (optionally limited in number and length). Resuming still repeats the camera and identity check.',
    label: (p) =>
      `Rest breaks${p.maxPauses != null ? `, up to ${Number(p.maxPauses)}` : ''}${p.maxPauseMinutes != null ? `, up to ${mins(Number(p.maxPauseMinutes))} each` : ''}`,
    candidateLabel: () => 'Rest breaks: you can pause the exam without asking; the clock stops while you are paused',
    limitation: () => null,
  },
  no_liveness_challenge: {
    title: 'No head-turn challenge',
    description: 'The live-person check (turning the head on request) is skipped at check-in and after pauses. The face is still compared with the identity reference.',
    label: () => 'No head-turn challenge',
    candidateLabel: () => 'No head-turn challenge during camera checks',
    limitation: () => 'The live-person (head-turn) check was not used for this candidate (approved accommodation); identity checks relied on face comparison only.',
  },
  assistive_technology: {
    title: 'Assistive technology',
    description:
      'For screen readers, magnifiers, dictation and similar tools: fullscreen is not required, copy and paste work, switching to another window is not recorded, and a second display is allowed (for example for a magnifier).',
    label: () => 'Assistive technology',
    candidateLabel: () => 'Assistive technology: fullscreen is not required and switching to your tools is not recorded',
    limitation: () => 'Fullscreen was not required and switches to other windows were not recorded for this candidate (approved accommodation for assistive technology).',
  },
  detection_exemptions: {
    title: 'Behaviour detectors off',
    description: 'Turns off chosen camera observations for this candidate — for example “looking away” for a candidate with involuntary eye or head movement, or “face covered” for a candidate who wears a face covering.',
    label: (p) => `Not observed: ${EXEMPTIBLE_DETECTORS.filter((d) => p[d]).map((d) => DETECTOR_LABEL[d]).join(', ')}`,
    candidateLabel: (p) => `Some camera observations are turned off (${EXEMPTIBLE_DETECTORS.filter((d) => p[d]).map((d) => DETECTOR_LABEL[d]).join(', ')})`,
    limitation: (p) =>
      `These observations were turned off for this candidate (approved accommodation): ${EXEMPTIBLE_DETECTORS.filter((d) => p[d]).map((d) => DETECTOR_LABEL[d]).join(', ')}. Their absence from this report is not a finding.`,
  },
  support_person: {
    title: 'Support person present',
    description:
      'An approved reader, scribe, interpreter or assistant may be in the room: other people in view are not recorded. Camera checks still need only the candidate in view — combine with “identity verified by staff” if the support person stays in view throughout.',
    label: (p) => `Support person (${ROLE_LABEL[(p.role as SupportPersonRole) ?? 'assistant'] ?? 'support person'})`,
    candidateLabel: (p) => `Your ${ROLE_LABEL[(p.role as SupportPersonRole) ?? 'assistant'] ?? 'support person'} may be with you`,
    limitation: (p) => `An approved ${ROLE_LABEL[(p.role as SupportPersonRole) ?? 'assistant'] ?? 'support person'} was allowed in the room, so other people in view were not recorded.`,
  },
  staff_identity_verification: {
    title: 'Identity verified by staff',
    description:
      'A staff member verifies the candidate’s identity (video call, ID shown, in person) before the exam starts, instead of the automated face check — for example for a face covering or a facial difference. No face reference is built and no automated identity comparisons are made.',
    label: (p) => `Identity verified by staff${p.reverifyOnContinue ? ' (also after pauses and reconnections)' : ''}`,
    candidateLabel: () => 'A staff member verifies your identity instead of the automated face check',
    limitation: (p) =>
      `Identity was verified by staff instead of automated face comparison (approved accommodation)${p.reverifyOnContinue ? ', at check-in and after each pause or reconnection' : ' at check-in; continuity after pauses and reconnections was not verified automatically'}.`,
  },
  no_camera: {
    title: 'No camera',
    description:
      'The candidate takes the exam without a camera: no camera check, no camera observations and no images. A staff member verifies their identity before the exam starts. Browser rules (fullscreen, tab switches) still apply.',
    label: (p) => `No camera${p.reverifyOnContinue ? ' (staff re-verify after pauses and reconnections)' : ''}`,
    candidateLabel: () => 'You take this exam without a camera; a staff member verifies your identity first',
    limitation: () => 'No camera was used for this candidate (approved accommodation): there are no camera observations, no images and no automated identity checks. Identity was verified by staff.',
  },
};

export const ACCOMMODATION_BASIS_LABEL: Record<AccommodationBasis, string> = {
  accessibility: 'Accessibility / disability',
  technical: 'Technical',
  other: 'Other',
};

/* ------------------------------------------------------------------ application */

type Spec = Pick<AccommodationSpec, 'kind' | 'params'> | { kind: AccommodationKind; params: Record<string, unknown> };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The exam's resolved policy with accommodations applied. Order does not matter: each one only relaxes rules
 * (turns observations off, allows breaks, moves identity to staff), so combining two never re-enables anything.
 */
export function applyAccommodations(policy: ProctoringPolicy, items: readonly Spec[]): ProctoringPolicy {
  if (!items.length) return policy;
  const p = clone(policy) as ProctoringPolicy & { detection: { enabled: Record<string, boolean> } };
  for (const a of items) {
    const params = (a.params ?? {}) as Record<string, unknown>;
    switch (a.kind) {
      case 'rest_breaks': {
        // Never stricter than the exam: a limit only applies where the exam's own rule is tighter (null = no limit).
        const generous = (exam: number | null, granted: number | null) => (exam === null || granted === null ? null : Math.max(exam, granted));
        const examMax = p.pause.allowed ? p.pause.maxPauses : 0;
        const examLen = p.pause.allowed ? p.pause.maxPauseDurationSec : 0;
        p.pause = {
          ...p.pause,
          allowed: true,
          requireApproval: false,
          requireReason: false,
          timerBehavior: 'stop',
          maxPauses: generous(examMax, params.maxPauses == null ? null : Number(params.maxPauses)),
          maxPauseDurationSec: generous(examLen, params.maxPauseMinutes == null ? null : Number(params.maxPauseMinutes) * 60),
        };
        break;
      }
      case 'no_liveness_challenge':
        p.identity = { ...p.identity, liveness: 'off' };
        break;
      case 'assistive_technology':
        p.browser = { ...p.browser, requireFullscreen: false, blockClipboard: false, flagWindowBlur: false, requireSingleDisplay: false };
        break;
      case 'detection_exemptions':
        for (const d of EXEMPTIBLE_DETECTORS) if (params[d]) p.detection.enabled[d] = false;
        break;
      case 'support_person':
        p.detection.enabled.multiplePeople = false;
        break;
      case 'staff_identity_verification':
        p.identity = { ...p.identity, verification: 'staff', staffReverifyOnContinue: p.identity.staffReverifyOnContinue || params.reverifyOnContinue === true };
        break;
      case 'no_camera':
        p.camera = { ...p.camera, enabled: false };
        p.identity = { ...p.identity, verification: 'staff', staffReverifyOnContinue: p.identity.staffReverifyOnContinue || params.reverifyOnContinue === true };
        break;
      case 'extra_time':
        break; // the session's duration, not a policy setting (extraTimeMs)
    }
  }
  return enforceModesOf(p);
}

/** The modes' invariants (policy.ts enforceModes) without re-validating the whole policy. */
function enforceModesOf(p: ProctoringPolicy): ProctoringPolicy {
  if (p.camera.enabled && p.identity.verification === 'automatic') return p;
  p.identity = { ...p.identity, verification: 'staff', liveness: 'off', idPhotoComparison: 'off' };
  if (!p.camera.enabled) {
    p.detection = { ...p.detection, enabled: Object.fromEntries(Object.keys(p.detection.enabled).map((k) => [k, false])) as ProctoringPolicy['detection']['enabled'] };
    p.evidence = { ...p.evidence, screenshots: false, keepMatchingIdentitySamples: false };
  }
  return p;
}

/** Extra exam time from `extra_time` accommodations, for an exam of `baseDurationMs` (several add up). */
export function accommodationExtraTimeMs(baseDurationMs: number, items: readonly Spec[]): number {
  let extra = 0;
  for (const a of items) {
    if (a.kind !== 'extra_time') continue;
    const params = a.params as Record<string, unknown>;
    extra += Math.round((baseDurationMs * Number(params.percent ?? 0)) / 100) + Number(params.minutes ?? 0) * 60_000;
  }
  return extra;
}

/** Human labels for the policy settings accommodations change (paths of applyAccommodations). */
export const EXCEPTION_PATH_LABEL: Record<string, string> = {
  durationMs: 'Exam duration',
  'pause.allowed': 'Pausing allowed',
  'pause.requireApproval': 'Pauses need approval',
  'pause.requireReason': 'Pauses need a reason',
  'pause.timerBehavior': 'Clock during pauses',
  'pause.maxPauses': 'Maximum number of pauses',
  'pause.maxPauseDurationSec': 'Maximum pause length (s)',
  'identity.verification': 'Identity verification',
  'identity.staffReverifyOnContinue': 'Staff re-verify after pauses / reconnections',
  'identity.liveness': 'Live-person check',
  'identity.idPhotoComparison': 'ID photo comparison',
  'camera.enabled': 'Camera used',
  'browser.requireFullscreen': 'Fullscreen required',
  'browser.requireSingleDisplay': 'Single display required',
  'browser.blockClipboard': 'Copy and paste blocked',
  'browser.flagWindowBlur': 'Switching windows recorded',
  'detection.enabled.absence': 'Absence observed',
  'detection.enabled.multiplePeople': 'Other people in view observed',
  'detection.enabled.lookingAway': 'Looking away observed',
  'detection.enabled.movement': 'Unusual movement observed',
  'detection.enabled.obstruction': 'Face covered / out of view observed',
  'detection.enabled.objects': 'Objects observed',
  'detection.enabled.cameraIntegrity': 'Camera problems observed',
  'evidence.screenshots': 'Camera screenshots',
  'evidence.keepMatchingIdentitySamples': 'Keep matching identity images',
};

/** Which accommodation kinds can change a policy path (attribution of exceptions). */
const KINDS_FOR_PATH: [prefix: string, kinds: AccommodationKind[]][] = [
  ['pause.', ['rest_breaks']],
  ['identity.liveness', ['no_liveness_challenge', 'staff_identity_verification', 'no_camera']],
  ['identity.idPhotoComparison', ['staff_identity_verification', 'no_camera']],
  ['identity.', ['staff_identity_verification', 'no_camera']],
  ['camera.', ['no_camera']],
  ['browser.', ['assistive_technology']],
  ['detection.enabled.multiplePeople', ['support_person', 'detection_exemptions', 'no_camera']],
  ['detection.enabled.', ['detection_exemptions', 'no_camera']],
  ['evidence.', ['no_camera']],
];

function leaves(v: unknown, prefix = ''): [string, unknown][] {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k));
  return [[prefix, v]];
}

/** Every setting accommodations changed: the exam's value and the applied one, attributed to the kinds present. */
export function policyExceptions(examPolicy: ProctoringPolicy, applied: ProctoringPolicy, items: readonly Spec[], durations?: { baseMs: number; extraMs: number }): PolicyExceptionDTO[] {
  const present = new Set(items.map((i) => i.kind));
  const before = new Map(leaves(examPolicy));
  const out: PolicyExceptionDTO[] = [];
  if (durations && durations.extraMs > 0) out.push({ path: 'durationMs', label: EXCEPTION_PATH_LABEL.durationMs, from: durations.baseMs, to: durations.baseMs + durations.extraMs, kinds: ['extra_time'] });
  for (const [path, to] of leaves(applied)) {
    const from = before.get(path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    const kinds = (KINDS_FOR_PATH.find(([prefix]) => path.startsWith(prefix))?.[1] ?? []).filter((k) => present.has(k));
    out.push({ path, label: EXCEPTION_PATH_LABEL[path] ?? path, from, to, kinds });
  }
  return out;
}

/** The exam's own rules from an applied policy and its exceptions (each changed setting set back to its exam value). */
export function revertExceptions(policy: ProctoringPolicy, exceptions: readonly PolicyExceptionDTO[]): ProctoringPolicy {
  const p = clone(policy) as unknown as Record<string, unknown>;
  for (const e of exceptions) {
    if (e.path === 'durationMs') continue;
    const keys = e.path.split('.');
    let node = p;
    for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>;
    node[keys[keys.length - 1]] = e.from;
  }
  return p as unknown as ProctoringPolicy;
}

/** Whether an accommodation record applies to an exam at a time. */
export function accommodationApplies(a: { examId: string | null; validUntil: number | null; revokedAt: number | null }, examId: string, at: number): boolean {
  return a.revokedAt == null && (a.validUntil == null || a.validUntil > at) && (a.examId == null || a.examId === examId);
}
