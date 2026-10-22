import { DEFAULT_POLICY, proctoringPolicySchema, SAMPLING_FIELDS, SAMPLING_PROFILES, samplingProfileOf, type ProctoringPolicy } from '@sp/shared';

/**
 * Form metadata for every field of proctoringPolicySchema. The editor renders from this table; a unit
 * test asserts it covers every leaf of DEFAULT_POLICY exactly once.
 */

export type PolicyFieldKind = 'boolean' | 'enum' | 'integer' | 'number' | 'nullableInteger';

export interface PolicyField {
  path: string;
  label: string;
  kind: PolicyFieldKind;
  help?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** For nullable fields: label for the "no value" choice. */
  nullLabel?: string;
}

export interface PolicyGroup {
  id: string;
  title: string;
  description: string;
  /** Rendered collapsed by default. */
  advanced?: boolean;
  fields: PolicyField[];
}

export const POLICY_GROUPS: PolicyGroup[] = [
  {
    id: 'identity',
    title: 'Identity & liveness',
    description:
      'How the candidate’s identity is established at check-in and re-checked after pauses, absences and camera changes. The identity reference is never replaced automatically.',
    fields: [
      {
        path: 'identity.liveness',
        label: 'Live-person check',
        kind: 'enum',
        options: [
          { value: 'active', label: 'Active head-turn challenge (recommended)' },
          { value: 'off', label: 'Off' },
        ],
        help: 'A randomized head-turn sequence verified on the server, so a photo held up to the camera is not accepted.',
      },
      { path: 'identity.livenessSteps', label: 'Liveness steps', kind: 'integer', min: 2, max: 4, help: 'Number of randomized head movements.' },
      {
        path: 'identity.idPhotoComparison',
        label: 'Compare with approved ID photo',
        kind: 'enum',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'advisory', label: 'Advisory (record the result only)' },
          { value: 'required', label: 'Required (hold for review if it does not match)' },
        ],
        help: 'Only applies when the candidate has an approved ID photo.',
      },
      {
        path: 'identity.samplingProfile',
        label: 'Sampling intensity',
        kind: 'enum',
        options: [
          { value: 'maximum', label: 'Maximum accuracy (default)' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'custom', label: 'Custom' },
        ],
        help: 'Fills the sampling fields below. Balanced serves about twice as many candidates per server when everyone starts together, and about 2.5× once the exam is under way: routine samples are taken half as often, with 2 frames instead of 3. A swap that happens without the face leaving view or changing abruptly is confirmed about 8 s later. A swap caught when the face returns, the track is interrupted or the camera reconnects is confirmed as fast, because those samples keep 3 frames.',
      },
      {
        path: 'identity.periodicCheckIntervalSec',
        label: 'Routine identity sample every',
        kind: 'integer',
        min: 5,
        max: 600,
        unit: 's',
        help: 'After the start-up window. Extra samples are also taken when the exam starts or resumes, when the face track is interrupted or its appearance changes abruptly, when a face returns, the camera reconnects, or after obstruction / multiple people.',
      },
      {
        path: 'identity.startupIntervalSec',
        label: 'Start-up identity sample every',
        kind: 'integer',
        min: 3,
        max: 120,
        unit: 's',
        help: 'Faster routine sampling right after the exam starts or resumes (and after a reconnect), when a swap is most likely.',
      },
      {
        path: 'identity.startupWindowSec',
        label: 'Start-up window',
        kind: 'integer',
        min: 0,
        max: 1800,
        unit: 's',
        help: 'How long the faster start-up sampling lasts after the exam starts, resumes or reconnects.',
      },
      {
        path: 'identity.burstSize',
        label: 'Frames per triggered identity sample',
        kind: 'integer',
        min: 1,
        max: 5,
        help: 'Samples taken at once when the exam starts or resumes, the face changes or returns, the camera reconnects, or the server asks for a faster look: distinct camera frames captured within about half a second and decided together (more frames = steadier decisions).',
      },
      {
        path: 'identity.routineBurstSize',
        label: 'Frames per routine identity sample',
        kind: 'integer',
        min: 1,
        max: 5,
        help: 'Frames of the routine samples (every start-up / routine interval above). Fewer frames = less server load; triggered samples are unaffected.',
      },
      {
        path: 'identity.onMismatch',
        label: 'On strong evidence of a different person',
        kind: 'enum',
        options: [
          { value: 'hold_for_review', label: 'Put the exam on hold for review' },
          { value: 'flag_only', label: 'Flag only (exam continues)' },
        ],
      },
      {
        path: 'identity.maxVerificationAttempts',
        label: 'Max “could not verify” attempts per check',
        kind: 'integer',
        min: 1,
        max: 20,
        help: 'After this many unusable images during a check, the session is routed to human review (never labelled a different person).',
      },
    ],
  },
  {
    id: 'alternatives',
    title: 'Alternative arrangements',
    description:
      'Usually set for one candidate as an accommodation (Candidates → Accommodations) rather than for the whole exam. Identity verified by staff replaces the automated face check; without a camera nothing camera-based runs.',
    advanced: true,
    fields: [
      {
        path: 'identity.verification',
        label: 'Identity verification',
        kind: 'enum',
        options: [
          { value: 'automatic', label: 'Automatic face check (recommended)' },
          { value: 'staff', label: 'By a staff member before the exam starts' },
        ],
        help: 'By staff: no face reference is built and no automated identity comparisons are made; a staff member records how they verified each candidate. The live-person and ID-photo checks are switched off.',
      },
      {
        path: 'identity.staffReverifyOnContinue',
        label: 'Staff re-verify after pauses and reconnections',
        kind: 'boolean',
        help: 'Only with identity verified by staff: the exam waits for a staff member after every pause or reconnection.',
      },
      {
        path: 'camera.enabled',
        label: 'Use the camera',
        kind: 'boolean',
        help: 'Off: no camera check, no camera observations and no images; identity is verified by staff. Browser rules still apply.',
      },
    ],
  },
  {
    id: 'pause',
    title: 'Pausing',
    description: 'Candidates can pause and resume later (even after closing the browser). Monitoring stops during a pause; the period is recorded as unobserved.',
    fields: [
      { path: 'pause.allowed', label: 'Allow pausing', kind: 'boolean' },
      { path: 'pause.requireReason', label: 'Require a reason', kind: 'boolean' },
      { path: 'pause.requireApproval', label: 'Require staff approval', kind: 'boolean', help: 'Requests appear under “Needs attention” on the Live dashboard.' },
      {
        path: 'pause.timerBehavior',
        label: 'Exam clock during a pause',
        kind: 'enum',
        options: [
          { value: 'stop', label: 'Stops' },
          { value: 'continue', label: 'Keeps running' },
        ],
      },
      { path: 'pause.maxPauses', label: 'Maximum number of pauses', kind: 'nullableInteger', min: 0, nullLabel: 'Unlimited' },
      {
        path: 'pause.maxPauseDurationSec',
        label: 'Maximum pause duration',
        kind: 'nullableInteger',
        min: 60,
        unit: 's',
        nullLabel: 'Unlimited',
        help: 'If exceeded, resuming requires administrator approval (the session goes on hold).',
      },
    ],
  },
  {
    id: 'connection',
    title: 'Connection',
    description: 'Behaviour when the candidate’s browser stops reporting without a formal pause.',
    fields: [
      {
        path: 'connection.disconnectTimerBehavior',
        label: 'Exam clock while disconnected',
        kind: 'enum',
        options: [
          { value: 'continue', label: 'Keeps running' },
          { value: 'stop', label: 'Stops' },
        ],
      },
      {
        path: 'connection.heartbeatTimeoutSec',
        label: 'Show as disconnected after',
        kind: 'integer',
        min: 10,
        max: 300,
        unit: 's',
        help: 'Seconds without a heartbeat before the session is shown as disconnected and “live reporting interrupted” is recorded.',
      },
    ],
  },
  {
    id: 'resume',
    title: 'Interruptions and recovery',
    description:
      'Limits on interruptions that are not a pause: the exam reopened in a new browser window (after a reload, a crash or on another device) or the connection lost. When a limit is reached, staff decide whether the candidate continues. Pauses follow the pausing rules above.',
    fields: [
      {
        path: 'resume.maxReconnects',
        label: 'Times the exam may be reopened in a new browser window',
        kind: 'nullableInteger',
        min: 0,
        max: 100,
        nullLabel: 'Unlimited',
        help: 'Each time, the candidate repeats the camera and identity check. Reloading the page before the exam starts does not count. 0 = not allowed at all.',
      },
      {
        path: 'resume.maxOfflineMinutes',
        label: 'Longest time the exam may be disconnected',
        kind: 'nullableInteger',
        min: 1,
        max: 1440,
        unit: 'min',
        nullLabel: 'Unlimited',
        help: 'Counted from the last sign of the candidate’s browser during the exam. Paused exams and exams on hold are not counted.',
      },
      {
        path: 'resume.onLimit',
        label: 'When a limit is reached',
        kind: 'enum',
        options: [
          { value: 'hold', label: 'Put the exam on hold for staff to decide (recommended)' },
          { value: 'end', label: 'End the exam and submit the saved answers' },
        ],
        help: 'Either way staff can let the candidate continue: release the hold, or reopen the ended exam for recovery.',
      },
    ],
  },
  {
    id: 'browser',
    title: 'Browser rules',
    description: 'Signals available from the exam page. The system cannot observe other monitors, devices or applications.',
    fields: [
      { path: 'browser.requireFullscreen', label: 'Require fullscreen', kind: 'boolean' },
      { path: 'browser.blockClipboard', label: 'Block copy / paste', kind: 'boolean', help: 'Attempts are recorded; clipboard contents are never read.' },
      { path: 'browser.flagTabHidden', label: 'Record leaving the exam tab', kind: 'boolean' },
      { path: 'browser.flagWindowBlur', label: 'Record window losing focus', kind: 'boolean' },
      { path: 'browser.windowBlurMinSec', label: 'Ignore focus loss shorter than', kind: 'number', min: 0, step: 0.5, unit: 's' },
    ],
  },
  {
    id: 'detectors',
    title: 'Detectors',
    description: 'Camera-based detectors running in the candidate’s browser.',
    fields: [
      { path: 'detection.enabled.absence', label: 'Candidate not visible', kind: 'boolean' },
      { path: 'detection.enabled.multiplePeople', label: 'More than one person', kind: 'boolean' },
      { path: 'detection.enabled.lookingAway', label: 'Looking away (sustained, repeated, same direction)', kind: 'boolean' },
      { path: 'detection.enabled.movement', label: 'Unusual movement', kind: 'boolean' },
      { path: 'detection.enabled.obstruction', label: 'Face obstructed / unclear', kind: 'boolean' },
      { path: 'detection.enabled.objects', label: 'Phone and other devices / materials', kind: 'boolean' },
      { path: 'detection.enabled.cameraIntegrity', label: 'Camera integrity (covered, frozen, lighting, substituted feed)', kind: 'boolean' },
    ],
  },
  {
    id: 'thresholds',
    title: 'Detection thresholds',
    description:
      'Advanced tuning. Defaults are calibrated to avoid flagging brief glances or single bad frames: an observation must persist, repeat, and be confident before it becomes an event. Head-pose thresholds are relative to the candidate’s own normal position.',
    advanced: true,
    fields: [
      { path: 'detection.absenceSec', label: 'No face visible for', kind: 'number', min: 2, step: 1, unit: 's', help: 'Before “Candidate not visible” is recorded.' },
      { path: 'detection.multiplePeopleSec', label: 'Additional person visible for', kind: 'number', min: 0.3, step: 0.1, unit: 's', help: 'Brief, but longer than a single frame.' },
      {
        path: 'detection.attentionReference',
        label: 'Measure looking away from',
        kind: 'enum',
        options: [
          { value: 'learned', label: 'The candidate’s working position, learned during the exam (recommended)' },
          { value: 'calibration', label: 'The calibration at check-in only' },
        ],
        help: 'Candidates look at the screen, not the camera. The learned working position is where this candidate looks while using the mouse and keyboard (from interaction timing only — never what is typed); it starts from the calibration and adapts within the first minute. “Calibration only” was the behaviour before September 2026 and flags more ordinary work (reading the bottom of the screen, a monitor beside the camera).',
      },
      { path: 'detection.lookAwaySec', label: 'Sustained look-away after', kind: 'number', min: 1, step: 0.5, unit: 's' },
      {
        path: 'detection.lookAwayYawDeg',
        label: 'Head turn counted as “away”',
        kind: 'number',
        min: 10,
        max: 80,
        step: 1,
        unit: '°',
        help: 'Sideways, from the middle of the candidate’s screen (their learned working position, or the calibration). A wide screen that the candidate scans with their head widens it automatically.',
      },
      { path: 'detection.lookDownPitchDeg', label: 'Looking down counted as “away”', kind: 'number', min: 8, max: 60, step: 1, unit: '°', help: 'Below the middle of the candidate’s screen. Looking at the keyboard while typing is not counted (see below).' },
      {
        path: 'detection.lookUpPitchDeg',
        label: 'Looking up counted as “away”',
        kind: 'number',
        min: 10,
        max: 80,
        step: 1,
        unit: '°',
        help: 'Above the middle of the candidate’s screen. Looking up to think is normal: looks up need a larger angle, last longer (below) and join glance patterns only when clearly beyond the screen.',
      },
      { path: 'detection.lookUpSec', label: 'Sustained look up after', kind: 'number', min: 1, step: 1, unit: 's', help: 'Thinking look-ups usually last 2–8 s; a stretch followed by one, about 14 s.' },
      {
        path: 'detection.typingExcuseSec',
        label: 'Looking at the keyboard is ignored while typing within',
        kind: 'number',
        min: 0,
        max: 10,
        step: 0.5,
        unit: 's',
        help: 'Looking down at the keyboard is not “away” while the candidate pressed a key this recently. Looking down without typing (a phone, notes) still counts; a look that continues after the typing stops counts from the last keystroke. 0 = off.',
      },
      { path: 'detection.glanceMinSec', label: 'Ignore glances shorter than', kind: 'number', min: 0.3, step: 0.1, unit: 's' },
      { path: 'detection.repeatedLookAwayCount', label: 'Repeated look-away: glances', kind: 'integer', min: 2, help: 'Number of qualifying glances within the window.' },
      { path: 'detection.repeatedLookAwayWindowSec', label: 'Repeated look-away: window', kind: 'number', min: 10, step: 5, unit: 's' },
      { path: 'detection.sameDirectionCount', label: 'Same-direction attention: glances', kind: 'integer', min: 2, help: 'Glances toward the same off-screen spot (for example notes on the desk, a second screen) within the window.' },
      { path: 'detection.obstructionSec', label: 'Face obstructed for', kind: 'number', min: 1, step: 0.5, unit: 's' },
      { path: 'detection.phoneMinConfidence', label: 'Phone: minimum detector confidence', kind: 'number', min: 0.1, max: 1, step: 0.05, help: '0–1. Higher means fewer but more certain detections.' },
      { path: 'detection.objectMinConfidence', label: 'Other objects: minimum detector confidence', kind: 'number', min: 0.1, max: 1, step: 0.05 },
      { path: 'detection.objectPersistSec', label: 'Object must be visible for', kind: 'number', min: 0.5, step: 0.5, unit: 's' },
      { path: 'detection.frozenSec', label: 'Frozen image after', kind: 'number', min: 2, step: 1, unit: 's' },
      { path: 'detection.coveredSec', label: 'Covered lens after', kind: 'number', min: 1, step: 1, unit: 's' },
      { path: 'detection.lightingSec', label: 'Unusable lighting after', kind: 'number', min: 2, step: 1, unit: 's' },
      { path: 'detection.movementExitCount', label: 'Unusual movement: exits from view', kind: 'integer', min: 2 },
      { path: 'detection.movementWindowSec', label: 'Unusual movement: window', kind: 'number', min: 30, step: 10, unit: 's' },
      { path: 'detection.farFromBaselineSec', label: 'Far from normal position for', kind: 'number', min: 3, step: 1, unit: 's' },
      { path: 'detection.mergeGapSec', label: 'Merge repeats closer than', kind: 'number', min: 0, step: 1, unit: 's', help: 'An ongoing issue appears as one event instead of many duplicates.' },
      { path: 'detection.clearSec', label: 'Condition must clear for', kind: 'number', min: 0.5, step: 0.5, unit: 's', help: 'Before an ongoing event is closed (hysteresis).' },
    ],
  },
  {
    id: 'evidence',
    title: 'Evidence',
    description: 'Screenshots are taken only at moments when something was observed. No continuous video is stored.',
    fields: [
      { path: 'evidence.screenshots', label: 'Capture webcam screenshots for events', kind: 'boolean' },
      { path: 'evidence.maxScreenshotsPerEvent', label: 'Max screenshots per event', kind: 'integer', min: 1, max: 20 },
      { path: 'evidence.periodicScreenshotSec', label: 'Extra screenshot during long events every', kind: 'number', min: 5, step: 5, unit: 's' },
      {
        path: 'evidence.keepMatchingIdentitySamples',
        label: 'Keep images of routine identity samples that matched',
        kind: 'boolean',
        help: 'Off by default (data minimisation): only non-matching or notable samples are stored.',
      },
    ],
  },
  {
    id: 'retention',
    title: 'Retention',
    description: 'Screenshots and identity references are deleted this many days after the session ends (unless under legal hold).',
    fields: [
      { path: 'retention.evidenceDays', label: 'Keep evidence for', kind: 'nullableInteger', min: 1, max: 3650, unit: 'days', nullLabel: 'Organisation default' },
    ],
  },
];

export const ALL_POLICY_FIELDS: PolicyField[] = POLICY_GROUPS.flatMap((g) => g.fields);

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Immutable set: returns a copy with `path` set to `value`. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const recur = (node: unknown, i: number): unknown => {
    const base = node != null && typeof node === 'object' ? (node as Record<string, unknown>) : {};
    if (i === keys.length - 1) return { ...base, [keys[i]]: value };
    return { ...base, [keys[i]]: recur(base[keys[i]], i + 1) };
  };
  return recur(obj, 0) as T;
}

/** Leaf paths of a plain object (used to check the form covers the whole schema). */
export function leafPaths(obj: unknown, prefix = ''): string[] {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

/** Fill defaults for a stored/partial policy (never throws; invalid input falls back to defaults). */
export function normalizePolicy(input: unknown): ProctoringPolicy {
  const r = proctoringPolicySchema.safeParse(input ?? {});
  return r.success ? r.data : DEFAULT_POLICY;
}

export type PolicyValidation = { ok: true; policy: ProctoringPolicy } | { ok: false; errors: Record<string, string> };

export function validatePolicy(p: unknown): PolicyValidation {
  const r = proctoringPolicySchema.safeParse(p);
  if (r.success) return { ok: true, policy: r.data };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) errors[issue.path.join('.')] = issue.message;
  return { ok: false, errors };
}

const SAMPLING_PATHS = new Set(SAMPLING_FIELDS.map((f) => `identity.${f}`));

/**
 * Set a field the way the editor does: choosing a sampling intensity preset fills the sampling fields; editing one of
 * those fields by hand makes the intensity follow the numbers ('custom' unless they match a preset again).
 */
export function applyPolicyChange(p: ProctoringPolicy, path: string, value: unknown): ProctoringPolicy {
  if (path === 'identity.samplingProfile') {
    const preset = value === 'maximum' || value === 'balanced' ? SAMPLING_PROFILES[value] : null;
    return { ...p, identity: { ...p.identity, ...(preset ?? {}), samplingProfile: value as ProctoringPolicy['identity']['samplingProfile'] } };
  }
  const next = setPath(p, path, value);
  if (!SAMPLING_PATHS.has(path) || typeof value !== 'number') return next;
  return { ...next, identity: { ...next.identity, samplingProfile: samplingProfileOf(next.identity) } };
}

/** Paths whose value differs from DEFAULT_POLICY. */
export function changedFromDefault(p: ProctoringPolicy): string[] {
  return ALL_POLICY_FIELDS.filter((f) => getPath(p, f.path) !== getPath(DEFAULT_POLICY, f.path)).map((f) => f.path);
}

/** Display a value for a policy field (used for "default: …" hints and summaries). */
export function formatPolicyValue(field: PolicyField, value: unknown): string {
  if (value === null || value === undefined) return field.nullLabel ?? '—';
  if (field.kind === 'boolean') return value ? 'On' : 'Off';
  if (field.kind === 'enum') return field.options?.find((o) => o.value === value)?.label ?? String(value);
  return `${value}${field.unit ? (field.unit === '°' ? '°' : ` ${field.unit}`) : ''}`;
}

/**
 * Parse text typed into a numeric policy input. Returns `{ value }` (null = empty for nullable
 * fields) or `{ error }`. Range checks mirror the schema so errors show before saving.
 */
export function parsePolicyNumber(field: PolicyField, raw: string): { value: number | null } | { error: string } {
  const text = raw.trim();
  if (text === '') {
    if (field.kind === 'nullableInteger') return { value: null };
    return { error: 'Required' };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { error: 'Enter a number' };
  if ((field.kind === 'integer' || field.kind === 'nullableInteger') && !Number.isInteger(n)) return { error: 'Enter a whole number' };
  if (field.min != null && n < field.min) return { error: `Minimum ${field.min}` };
  if (field.max != null && n > field.max) return { error: `Maximum ${field.max}` };
  return { value: n };
}
