import {
  ACCOMMODATION_CATALOG,
  ACCOMMODATION_KINDS,
  accommodationGrantSchema,
  EXEMPTIBLE_DETECTORS,
  type AccommodationBasis,
  type AccommodationKind,
  type AccommodationStatus,
  type ExemptibleDetector,
  type PolicyExceptionDTO,
  type SupportPersonRole,
} from '@sp/shared';
import { formatDuration } from './format';

/** Accommodations in the staff app: the grant form's state and its request body, and readable exception values. */

export interface GrantDraft {
  kind: AccommodationKind;
  percent: string;
  minutes: string;
  maxPauses: string;
  maxPauseMinutes: string;
  detectors: Record<ExemptibleDetector, boolean>;
  role: SupportPersonRole;
  reverifyOnContinue: boolean;
  /** '' = every exam. */
  examId: string;
  basis: AccommodationBasis;
  /** yyyy-mm-dd ('' = no end date); the accommodation ends at the end of that day (local time). */
  validUntil: string;
  note: string;
}

export function emptyGrant(kind: AccommodationKind = 'extra_time'): GrantDraft {
  return {
    kind,
    percent: '25',
    minutes: '',
    maxPauses: '',
    maxPauseMinutes: '',
    detectors: Object.fromEntries(EXEMPTIBLE_DETECTORS.map((d) => [d, false])) as Record<ExemptibleDetector, boolean>,
    role: 'reader',
    reverifyOnContinue: false,
    examId: '',
    basis: 'accessibility',
    validUntil: '',
    note: '',
  };
}

const intOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function paramsOf(d: GrantDraft): Record<string, unknown> {
  switch (d.kind) {
    case 'extra_time':
      return { percent: Number(d.percent || 0), minutes: Number(d.minutes || 0) };
    case 'rest_breaks':
      return { maxPauses: intOrNull(d.maxPauses), maxPauseMinutes: intOrNull(d.maxPauseMinutes) };
    case 'detection_exemptions':
      return { ...d.detectors };
    case 'support_person':
      return { role: d.role };
    case 'staff_identity_verification':
    case 'no_camera':
      return { reverifyOnContinue: d.reverifyOnContinue };
    default:
      return {};
  }
}

/** End of the chosen day in local time, as epoch ms (null: no end date). */
export function endOfDay(date: string): number | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

/** The request body for a draft, or the first problem in words. */
export function grantBody(d: GrantDraft, now = Date.now()): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const validUntil = endOfDay(d.validUntil);
  if (validUntil != null && validUntil <= now) return { ok: false, error: 'The end date must be in the future.' };
  const body = { kind: d.kind, params: paramsOf(d), basis: d.basis, examId: d.examId || null, validUntil, note: d.note.trim() };
  const r = accommodationGrantSchema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join('.');
    const what: Record<string, string> = {
      'params.percent': 'Extra time percentage (0–300)',
      'params.minutes': 'Extra minutes (0–600)',
      'params.maxPauses': 'Number of breaks (1–50, or empty for no limit)',
      'params.maxPauseMinutes': 'Break length (1–240 minutes, or empty for no limit)',
    };
    // Cross-field rules (e.g. "Add a percentage or minutes") are reported on params itself: the message says it all.
    return { ok: false, error: what[field] ? `${what[field]}: ${issue.message}` : issue.message };
  }
  return { ok: true, body };
}

export const ACCOMMODATION_OPTIONS = ACCOMMODATION_KINDS.map((k) => ({ value: k, label: ACCOMMODATION_CATALOG[k].title }));

export const STATUS_CLASS: Record<AccommodationStatus, string> = { active: 'badge badge-success', expired: 'badge', revoked: 'badge badge-neutral' };
export const STATUS_LABEL: Record<AccommodationStatus, string> = { active: 'Active', expired: 'Expired', revoked: 'Revoked' };

/** A policy exception's value in words (on / off, durations, "no limit"). */
export function formatExceptionValue(e: Pick<PolicyExceptionDTO, 'path'>, v: unknown): string {
  if (e.path === 'durationMs' && typeof v === 'number') return formatDuration(v);
  if (e.path === 'pause.maxPauseDurationSec') return v == null ? 'No limit' : formatDuration(Number(v) * 1000);
  if (e.path === 'pause.maxPauses') return v == null ? 'No limit' : String(v);
  if (e.path === 'identity.verification') return v === 'staff' ? 'By staff' : 'Automatic (face check)';
  if (e.path === 'identity.liveness') return v === 'off' ? 'Off' : 'Head-turn challenge';
  if (e.path === 'pause.timerBehavior') return v === 'stop' ? 'Stops' : 'Keeps running';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v == null) return '—';
  return String(v);
}

/** Short labels for lists and badges (no parameters). */
export function kindsSummary(kinds: readonly AccommodationKind[]): string {
  return kinds.map((k) => ACCOMMODATION_CATALOG[k].title).join(', ');
}
