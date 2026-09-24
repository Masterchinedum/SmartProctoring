/**
 * Event taxonomy for the proctoring system.
 *
 * Every observation the system makes becomes a ProctoringEvent with a type from this catalog.
 * The catalog (not the client) decides an event's category and default severity, so a tampered
 * client cannot downgrade an integrity observation to "neutral".
 *
 * Wording rule: titles/observations describe what was OBSERVED ("a different face may have
 * appeared"), never a conclusion ("the candidate cheated").
 */

export const EVENT_CATEGORIES = ['integrity', 'uncertain', 'neutral', 'technical'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EVENT_SOURCES = [
  'client_vision', // in-browser camera analysis
  'client_browser', // exam-page browser signals (tab, focus, fullscreen, clipboard)
  'server_identity', // server-side face verification
  'server_system', // lifecycle, connectivity, timers
  'staff', // actions by administrators / reviewers
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const REVIEW_STATUSES = ['unreviewed', 'reviewed', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const EVENT_TYPES = [
  // ---- potential integrity events
  'identity_mismatch',
  'multiple_people',
  'candidate_absent',
  'looking_away',
  'repeated_looking_away',
  'offscreen_attention_pattern',
  'unusual_movement',
  'phone_detected',
  'unauthorized_object',
  'camera_covered',
  'camera_feed_suspect',
  'tab_hidden',
  'window_unfocused',
  'fullscreen_exited',
  'clipboard_attempt',
  'multiple_instances',
  // ---- uncertain observations
  'identity_unverifiable',
  'face_obstructed',
  'lighting_unusable',
  // ---- technical problems
  'camera_disconnected',
  'camera_permission_lost',
  'camera_frozen',
  'reporting_interrupted',
  'monitoring_degraded',
  // ---- neutral session changes
  'session_started',
  'checkin_completed',
  'reference_created',
  'id_photo_compared',
  'identity_verified',
  'pause_requested',
  'pause_denied',
  'session_paused',
  'session_resumed',
  'unobserved_period',
  'camera_changed',
  'environment_changed',
  'additional_display_detected',
  'session_held',
  'hold_released',
  'session_submitted',
  'session_expired',
  'session_terminated',
  'time_extended',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventCatalogEntry {
  category: EventCategory;
  severity: Severity;
  /** Short label for lists. */
  title: string;
  /** Default observation sentence (neutral, factual). Detectors may supply a more specific one. */
  observation: string;
  /** Guidance for reviewers: what this does and does not establish. */
  reviewerNote: string;
  /** Which sources may create this event type. */
  sources: EventSource[];
  /** true if the event represents a span (start/end); false for instantaneous markers. */
  span: boolean;
}

export const EVENT_CATALOG: Record<EventType, EventCatalogEntry> = {
  identity_mismatch: {
    category: 'integrity',
    severity: 'high',
    title: 'Possible different person',
    observation: 'The face in view may belong to a different person than the one who started the exam.',
    reviewerNote:
      'Compare the reference and later images. Changes in clothing, hair, glasses, background or lighting are not evidence of a different person.',
    sources: ['server_identity'],
    span: true,
  },
  multiple_people: {
    category: 'integrity',
    severity: 'high',
    title: 'More than one person in view',
    observation: 'More than one person was visible in the camera view.',
    reviewerNote: 'Check the screenshot for the additional person. Reflections, posters or photos in the background can occasionally be detected as faces.',
    sources: ['client_vision'],
    span: true,
  },
  candidate_absent: {
    category: 'integrity',
    severity: 'medium',
    title: 'Candidate not visible',
    observation: 'No face was visible in the camera view for a sustained period.',
    reviewerNote: 'The candidate may have left, moved out of frame, or the view may have been blocked. An identity check runs when a face returns.',
    sources: ['client_vision'],
    span: true,
  },
  looking_away: {
    category: 'integrity',
    severity: 'low',
    title: 'Sustained looking away',
    observation: 'The candidate’s head or gaze was turned away from the screen for a sustained period.',
    reviewerNote: 'Measured relative to the candidate’s own normal position. Brief glances are ignored.',
    sources: ['client_vision'],
    span: true,
  },
  repeated_looking_away: {
    category: 'integrity',
    severity: 'low',
    title: 'Repeated looking away',
    observation: 'The candidate repeatedly looked away from the screen within a short time window.',
    reviewerNote: 'Each individual look-away was short; the pattern is what was flagged.',
    sources: ['client_vision'],
    span: true,
  },
  offscreen_attention_pattern: {
    category: 'integrity',
    severity: 'medium',
    title: 'Repeated attention to one off-screen direction',
    observation: 'The candidate repeatedly looked toward the same off-screen direction.',
    reviewerNote:
      'May indicate outside materials or another device outside the camera view; the camera cannot show what was there. Review the screenshots.',
    sources: ['client_vision'],
    span: true,
  },
  unusual_movement: {
    category: 'integrity',
    severity: 'low',
    title: 'Unusual movement',
    observation: 'The candidate repeatedly moved out of view or far from their normal position.',
    reviewerNote: 'Compared with the position recorded at the start of the current exam period.',
    sources: ['client_vision'],
    span: true,
  },
  phone_detected: {
    category: 'integrity',
    severity: 'high',
    title: 'Phone visible',
    observation: 'An object resembling a mobile phone was visible in the camera view.',
    reviewerNote: 'Object detection can confuse phones with similar dark rectangular objects; confirm in the screenshot.',
    sources: ['client_vision'],
    span: true,
  },
  unauthorized_object: {
    category: 'integrity',
    severity: 'medium',
    title: 'Other device or material visible',
    observation: 'An object such as a book, laptop or additional screen was visible in the camera view.',
    reviewerNote: 'Confirm in the screenshot whether the object was in use.',
    sources: ['client_vision'],
    span: true,
  },
  camera_covered: {
    category: 'integrity',
    severity: 'medium',
    title: 'Camera view blocked',
    observation: 'The camera image was almost completely dark or uniform, as if the lens was covered.',
    reviewerNote: 'Nothing can be observed while the view is blocked.',
    sources: ['client_vision'],
    span: true,
  },
  camera_feed_suspect: {
    category: 'integrity',
    severity: 'high',
    title: 'Camera feed may be substituted',
    observation: 'The camera feed showed signs of being virtual, replayed or otherwise substituted.',
    reviewerNote: 'Based on the camera device name and/or repeating footage. Details list the specific signal.',
    sources: ['client_vision', 'server_identity'],
    span: true,
  },
  tab_hidden: {
    category: 'integrity',
    severity: 'medium',
    title: 'Left the exam tab',
    observation: 'The exam tab was hidden (the candidate switched to another tab or application, or minimised the browser).',
    reviewerNote: 'The browser reports only that the exam page was hidden, not what was viewed instead.',
    sources: ['client_browser'],
    span: true,
  },
  window_unfocused: {
    category: 'integrity',
    severity: 'low',
    title: 'Exam window lost focus',
    observation: 'The exam window lost keyboard focus while remaining visible.',
    reviewerNote: 'Can be caused by system notifications or another window; the browser does not report what received focus.',
    sources: ['client_browser'],
    span: true,
  },
  fullscreen_exited: {
    category: 'integrity',
    severity: 'low',
    title: 'Left fullscreen',
    observation: 'The exam left required fullscreen mode.',
    reviewerNote: 'Required fullscreen is configured by the exam rules.',
    sources: ['client_browser'],
    span: true,
  },
  clipboard_attempt: {
    category: 'integrity',
    severity: 'low',
    title: 'Copy/paste attempt',
    observation: 'A copy, cut or paste action was attempted on the exam page.',
    reviewerNote: 'Details include the action type; clipboard contents are never recorded.',
    sources: ['client_browser'],
    span: true,
  },
  multiple_instances: {
    category: 'integrity',
    severity: 'medium',
    title: 'Exam opened in another browser',
    observation: 'The same exam session was opened from another browser or device while it was in progress.',
    reviewerNote: 'The newer browser had to pass the identity check before continuing.',
    sources: ['server_system'],
    span: false,
  },
  identity_unverifiable: {
    category: 'uncertain',
    severity: 'medium',
    title: 'Identity could not be verified',
    observation: 'The camera image was not clear enough to reliably confirm the candidate’s identity.',
    reviewerNote: 'This is NOT evidence of a different person. Causes include poor lighting, distance, blur or face angle.',
    sources: ['server_identity'],
    span: true,
  },
  face_obstructed: {
    category: 'uncertain',
    severity: 'low',
    title: 'Face obstructed or unclear',
    observation: 'The candidate’s face was partly covered, cut off at the edge of the image, or too unclear to assess.',
    reviewerNote: 'While obstructed, other checks (gaze, identity) cannot be assessed.',
    sources: ['client_vision'],
    span: true,
  },
  lighting_unusable: {
    category: 'uncertain',
    severity: 'low',
    title: 'Lighting too poor to assess',
    observation: 'The image was too dark or too bright for dependable monitoring.',
    reviewerNote: 'Observations during this period have reduced reliability.',
    sources: ['client_vision'],
    span: true,
  },
  camera_disconnected: {
    category: 'technical',
    severity: 'medium',
    title: 'Camera disconnected',
    observation: 'The camera stopped delivering video.',
    reviewerNote: 'An identity check runs when the camera reconnects.',
    sources: ['client_vision'],
    span: true,
  },
  camera_permission_lost: {
    category: 'technical',
    severity: 'medium',
    title: 'Camera permission lost',
    observation: 'The browser no longer allowed the exam to use the camera.',
    reviewerNote: 'The candidate is prompted to restore camera access.',
    sources: ['client_vision'],
    span: true,
  },
  camera_frozen: {
    category: 'technical',
    severity: 'medium',
    title: 'Camera image frozen',
    observation: 'The camera image stopped changing, as if frozen.',
    reviewerNote: 'Frozen video can be a driver problem or a substituted feed; check whether it coincides with other events.',
    sources: ['client_vision'],
    span: true,
  },
  reporting_interrupted: {
    category: 'technical',
    severity: 'low',
    title: 'Live reporting interrupted',
    observation: 'The candidate’s browser stopped reporting to the server.',
    reviewerNote: 'Events captured during the outage are delivered later with their original timestamps.',
    sources: ['server_system'],
    span: true,
  },
  monitoring_degraded: {
    category: 'technical',
    severity: 'low',
    title: 'Monitoring degraded',
    observation: 'Camera analysis ran slower than required or a detector failed to load.',
    reviewerNote: 'Some detections may have been missed during this period.',
    sources: ['client_vision'],
    span: true,
  },
  session_started: { category: 'neutral', severity: 'info', title: 'Exam started', observation: 'The exam was started.', reviewerNote: '', sources: ['server_system'], span: false },
  checkin_completed: { category: 'neutral', severity: 'info', title: 'Readiness check passed', observation: 'The camera readiness and live-person checks were completed.', reviewerNote: '', sources: ['server_system'], span: false },
  reference_created: {
    category: 'neutral',
    severity: 'info',
    title: 'Identity reference established',
    observation: 'A protected face reference was established for identity continuity checks.',
    reviewerNote: 'The reference is never replaced automatically.',
    sources: ['server_identity'],
    span: false,
  },
  id_photo_compared: {
    category: 'neutral',
    severity: 'info',
    title: 'Compared with approved ID photo',
    observation: 'The live candidate was compared with the approved identity photo.',
    reviewerNote: 'See details for the result. A mismatch is recorded as a separate identity event.',
    sources: ['server_identity'],
    span: false,
  },
  identity_verified: {
    category: 'neutral',
    severity: 'info',
    title: 'Identity confirmed',
    observation: 'The person in view matched the identity reference.',
    reviewerNote: '',
    sources: ['server_identity'],
    span: false,
  },
  pause_requested: { category: 'neutral', severity: 'info', title: 'Pause requested', observation: 'The candidate requested a pause.', reviewerNote: '', sources: ['server_system'], span: false },
  pause_denied: { category: 'neutral', severity: 'info', title: 'Pause denied', observation: 'A pause request was denied.', reviewerNote: '', sources: ['server_system', 'staff'], span: false },
  session_paused: { category: 'neutral', severity: 'info', title: 'Exam paused', observation: 'The exam was paused. Monitoring stopped.', reviewerNote: '', sources: ['server_system'], span: false },
  session_resumed: { category: 'neutral', severity: 'info', title: 'Exam resumed', observation: 'The exam was resumed after the readiness and identity checks.', reviewerNote: '', sources: ['server_system'], span: false },
  unobserved_period: {
    category: 'neutral',
    severity: 'info',
    title: 'Unobserved period',
    observation: 'Monitoring was not running during this period. No observations are made about it.',
    reviewerNote: 'Pauses and disconnections are unobserved; the system makes no claims about what happened during them.',
    sources: ['server_system'],
    span: true,
  },
  camera_changed: { category: 'neutral', severity: 'info', title: 'Camera changed', observation: 'A different camera is being used.', reviewerNote: 'Not a violation by itself.', sources: ['client_vision', 'server_system'], span: false },
  environment_changed: {
    category: 'neutral',
    severity: 'info',
    title: 'Surroundings changed',
    observation: 'The lighting, background or camera angle differs from the previous exam period.',
    reviewerNote: 'Recorded as context only. Environment changes are not evidence of a different person.',
    sources: ['client_vision', 'server_identity'],
    span: false,
  },
  additional_display_detected: {
    category: 'neutral',
    severity: 'info',
    title: 'Additional display connected',
    observation: 'The browser reports that more than one display is connected.',
    reviewerNote: 'The system cannot observe activity on other displays.',
    sources: ['client_browser'],
    span: false,
  },
  session_held: {
    category: 'neutral',
    severity: 'info',
    title: 'Exam on hold',
    observation: 'The exam was put on hold pending verification or administrator review.',
    reviewerNote: '',
    sources: ['server_system', 'staff'],
    span: false,
  },
  hold_released: { category: 'neutral', severity: 'info', title: 'Hold released', observation: 'The hold was released.', reviewerNote: '', sources: ['staff', 'server_system'], span: false },
  session_submitted: { category: 'neutral', severity: 'info', title: 'Exam submitted', observation: 'The exam was submitted.', reviewerNote: '', sources: ['server_system'], span: false },
  session_expired: { category: 'neutral', severity: 'info', title: 'Time expired', observation: 'The exam time ran out and answers were submitted automatically.', reviewerNote: '', sources: ['server_system'], span: false },
  session_terminated: { category: 'neutral', severity: 'info', title: 'Exam terminated', observation: 'The exam was terminated by an administrator.', reviewerNote: '', sources: ['staff'], span: false },
  time_extended: { category: 'neutral', severity: 'info', title: 'Time extended', observation: 'An administrator extended the exam time.', reviewerNote: 'Details include the added minutes and the reason.', sources: ['staff'], span: false },
};

/** Event types a candidate client is allowed to report. Everything else is server-authored. */
export const CLIENT_REPORTABLE_EVENT_TYPES: EventType[] = (Object.keys(EVENT_CATALOG) as EventType[]).filter((t) =>
  EVENT_CATALOG[t].sources.some((s) => s === 'client_vision' || s === 'client_browser'),
);

export function isClientReportable(type: string): type is EventType {
  return (CLIENT_REPORTABLE_EVENT_TYPES as string[]).includes(type);
}

export const CATEGORY_LABELS: Record<EventCategory, string> = {
  integrity: 'Potential integrity event',
  uncertain: 'Uncertain observation',
  neutral: 'Session change',
  technical: 'Technical problem',
};

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };

/** Direction labels used in looking_away / offscreen_attention_pattern details. */
export const GAZE_DIRECTIONS = ['left', 'right', 'up', 'down', 'down_left', 'down_right', 'up_left', 'up_right'] as const;
export type GazeDirection = (typeof GAZE_DIRECTIONS)[number];
