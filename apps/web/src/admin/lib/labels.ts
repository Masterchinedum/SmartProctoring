import {
  EVENT_CATALOG,
  type ConnectionStatus,
  type SessionEndReason,
  type EventCategory,
  type EventSource,
  type EventType,
  type HoldReason,
  type IdentityCheckTrigger,
  type IdentityDecision,
  type PeriodKind,
  type QualityIssue,
  type ReviewStatus,
  type SessionStatus,
  type Severity,
  type StaffRole,
} from '@sp/shared';
import { humanizeKey } from './format';

/** Staff-facing wording. Observational, never accusatory. */

export const STATUS_LABELS: Record<SessionStatus, string> = {
  invited: 'Invited',
  ready: 'Ready to start',
  active: 'Active',
  paused: 'Paused',
  on_hold: 'On hold',
  submitted: 'Submitted',
  terminated: 'Terminated',
};

export const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  online: 'Online',
  offline: 'Disconnected',
  never_connected: 'Not connected yet',
};

export const DECISION_LABELS: Record<IdentityDecision, string> = {
  match: 'Same person',
  mismatch: 'Possible different person',
  inconclusive: 'Inconclusive',
  unable_to_verify: 'Could not verify (image quality)',
};

export const DECISION_HELP: Record<IdentityDecision, string> = {
  match: 'The face matched the protected identity reference.',
  mismatch: 'The image was clear enough to compare and the face was not similar to the reference. This is an observation for human review, not a conclusion.',
  inconclusive: 'The image was usable but the similarity was in the grey zone between the match and mismatch thresholds.',
  unable_to_verify: 'The image was not clear enough for a dependable comparison (e.g. lighting, distance, blur, angle). This is NOT evidence of a different person.',
};

export const TRIGGER_LABELS: Record<IdentityCheckTrigger, string> = {
  check_in: 'Check-in',
  resume: 'Resume after pause',
  reconnect: 'Reconnect (new browser)',
  reverify: 'Re-verification',
  periodic: 'Routine sample',
  face_return: 'Face returned to view',
  camera_reconnect: 'Camera reconnected',
  after_multiple_people: 'After multiple people',
  after_obstruction: 'After obstruction',
  follow_up: 'Follow-up sample',
  id_photo: 'ID photo comparison',
  exam_start: 'Exam start',
  track_break: 'Face track interrupted',
  appearance_change: 'Appearance changed',
  server_request: 'Extra sample (server request)',
};

export const PERIOD_LABELS: Record<PeriodKind, string> = {
  check_in: 'Readiness check',
  active: 'Active',
  paused: 'Paused',
  disconnected: 'Disconnected',
  on_hold: 'On hold',
  resume_check: 'Resume check',
};

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  identity_mismatch: 'Possible different person — awaiting review',
  identity_unverifiable: 'Identity could not be verified after repeated attempts',
  id_photo_mismatch: 'Live image may not match the approved ID photo',
  pause_limit: 'Pause exceeded the maximum allowed duration',
  staff: 'Placed on hold by staff',
  id_photo_unverifiable: 'Could not be verified against the approved ID photo (image unclear — not a mismatch)',
};

export const END_REASON_LABELS: Record<SessionEndReason, string> = {
  candidate_submitted: 'Submitted by candidate',
  time_expired: 'Time expired (auto-submitted)',
  staff_submitted: 'Submitted by staff',
  staff_terminated: 'Terminated by staff',
  abandoned: 'Closed after inactivity (no score)',
};

export const CATEGORY_SHORT: Record<EventCategory, string> = {
  integrity: 'Integrity',
  uncertain: 'Uncertain',
  neutral: 'Session change',
  technical: 'Technical',
};

export const SEVERITY_LABELS: Record<Severity, string> = { info: 'Info', low: 'Low', medium: 'Medium', high: 'High' };

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  reviewed: 'Reviewed',
  dismissed: 'Dismissed (false positive)',
};

export const SOURCE_LABELS: Record<EventSource, string> = {
  client_vision: 'Camera analysis (candidate browser)',
  client_browser: 'Exam page (candidate browser)',
  server_identity: 'Identity verification (server)',
  server_system: 'System',
  staff: 'Staff action',
};

export const ROLE_LABELS: Record<StaffRole, string> = { owner: 'Owner', admin: 'Administrator', reviewer: 'Reviewer' };

export const QUALITY_ISSUE_LABELS: Record<QualityIssue, string> = {
  no_face: 'No face found',
  multiple_faces: 'More than one face',
  face_too_small: 'Face too small / far away',
  face_cut_off: 'Face cut off at the edge',
  too_dark: 'Too dark',
  too_bright: 'Too bright',
  low_contrast: 'Low contrast',
  blurry: 'Blurry',
  face_turned: 'Face turned away',
  low_detection_confidence: 'Face unclear',
  low_detail: 'Too low-resolution / compressed',
};

export function qualityIssueLabel(issue: string): string {
  return (QUALITY_ISSUE_LABELS as Record<string, string>)[issue] ?? humanizeKey(issue);
}

export function eventTypeTitle(type: string): string {
  return (EVENT_CATALOG as Record<string, { title: string }>)[type]?.title ?? humanizeKey(type);
}

/** Labels for `context.precededBy` entries (event types or free-form keys such as 'face_absence'). */
const CONTEXT_LABELS: Record<string, string> = {
  pause: 'Exam was paused',
  paused: 'Exam was paused',
  session_paused: 'Exam was paused',
  session_resumed: 'Exam was resumed',
  resume: 'Exam was resumed',
  face_absence: 'Face left the camera view',
  face_absent: 'Face left the camera view',
  candidate_absent: 'Face left the camera view',
  camera_reconnect: 'Camera reconnected',
  camera_disconnect: 'Camera disconnected',
  camera_disconnected: 'Camera disconnected',
  camera_change: 'Camera changed',
  camera_changed: 'Camera changed',
  reconnect: 'Browser reconnected',
  disconnection: 'Connection was lost or browser reopened',
  disconnected: 'Connection was lost',
  obstruction: 'Face was obstructed or camera blocked',
  previous_non_match: 'Previous sample did not match',
  unobserved_period: 'Unobserved period',
  reporting_interrupted: 'Live reporting was interrupted',
  multiple_people: 'More than one person was in view',
  face_obstructed: 'Face was obstructed',
  camera_covered: 'Camera view was blocked',
  hold: 'Exam was on hold',
  on_hold: 'Exam was on hold',
  hold_released: 'Hold was released',
  face_track_break: 'Face briefly left the view or the face track jumped',
  track_break: 'Face briefly left the view or the face track jumped',
  appearance_change: 'Face appearance changed abruptly',
  exam_start: 'Exam had just started or resumed',
};

export function contextLabel(key: string): string {
  if (CONTEXT_LABELS[key]) return CONTEXT_LABELS[key];
  if ((EVENT_CATALOG as Record<string, unknown>)[key]) return `Preceded by: ${eventTypeTitle(key)}`;
  return humanizeKey(key);
}

/** Context keys that matter for a possible person swap (highlighted in the comparison view). */
export const SWAP_CONTEXT_TYPES: EventType[] = [
  'session_paused',
  'session_resumed',
  'candidate_absent',
  'camera_disconnected',
  'camera_permission_lost',
  'camera_changed',
  'camera_covered',
  'face_obstructed',
  'multiple_people',
  'reporting_interrupted',
  'unobserved_period',
  'multiple_instances',
];

export function decisionCategory(decision: IdentityDecision): EventCategory {
  if (decision === 'mismatch') return 'integrity';
  if (decision === 'match') return 'neutral';
  return 'uncertain';
}

/**
 * Human wording for known enum values inside event details/context/audit metadata (quality issues,
 * triggers, decisions, period kinds, event types, other snake_case codes). Returns null when the value
 * is not a string (or list of strings) so the caller can fall back to generic formatting.
 */
export function describeDetailValue(key: string, value: unknown): string | null {
  const k = key.toLowerCase();
  const one = (v: string): string => {
    if (/issue/.test(k)) return qualityIssueLabel(v);
    if (/trigger/.test(k)) return (TRIGGER_LABELS as Record<string, string>)[v] ?? humanizeKey(v);
    if (/decision/.test(k)) return (DECISION_LABELS as Record<string, string>)[v] ?? humanizeKey(v);
    if (/periodkind|^during$/.test(k)) return (PERIOD_LABELS as Record<string, string>)[v] ?? humanizeKey(v);
    if ((EVENT_CATALOG as Record<string, unknown>)[v]) return eventTypeTitle(v);
    if (/^[a-z]+(_[a-z]+)+$/.test(v)) return humanizeKey(v);
    return v;
  };
  if (typeof value === 'string') return one(value);
  if (Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string')) {
    const mapped = (value as string[]).map(one);
    return mapped.join(mapped.every((s) => /[.!?]$/.test(s)) ? ' ' : ', ');
  }
  return null;
}

/**
 * Reviewer guidance for an event: the catalog note, except where the event's details say the generic note would
 * mislead. A check that ran out of attempts with CLEAR images that never matched convincingly (a look-alike, or a
 * large change in appearance) is not an image-quality problem, so "this is NOT evidence of a different person" is
 * replaced by a prompt to compare the images.
 */
export function reviewerGuidance(event: { type: string; details?: Record<string, unknown> | null }): string | null {
  const d = event.details ?? {};
  if (event.type === 'identity_unverifiable' && d.lastReason === 'inconclusive' && d.qualityOnly === false) {
    return 'The images were clear enough to compare but never matched the reference convincingly. Compare the reference and the check images side by side: consider a different person who resembles the candidate, and a large change in appearance (glasses, hair, weight, age of the reference). Release, re-verify or escalate as appropriate.';
  }
  return (EVENT_CATALOG as Record<string, { reviewerNote?: string }>)[event.type]?.reviewerNote ?? null;
}
