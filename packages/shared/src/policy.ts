import { z } from 'zod';

/**
 * Exam proctoring policy ("the exam's rules"). Stored per exam as JSON; every field has a default so
 * partial policies are valid. Server is authoritative; the candidate client receives the full policy
 * (nothing in it is secret) so detectors can use the same thresholds.
 */

export const identityPolicySchema = z
  .object({
    /**
     * Who establishes the candidate's identity. 'automatic' (default): the camera check-in builds a protected face
     * reference and later checks and samples compare against it. 'staff': a staff member verifies the candidate (video
     * call, ID shown, in person) before the exam can start — the check-in confirms the camera only, no face reference
     * is built and no automated identity comparisons are made. Usually an accommodation for one candidate (for example
     * a face covering or a facial difference); forced on when the camera is not used.
     */
    verification: z.enum(['automatic', 'staff']).default('automatic'),
    /** 'staff' verification: also after pauses and reconnections (a staff member confirms before the exam continues). */
    staffReverifyOnContinue: z.boolean().default(false),
    /** Active liveness challenge (random head-turn sequence verified server-side) at check-in and resume. */
    liveness: z.enum(['active', 'off']).default('active'),
    /** Number of randomized liveness actions. */
    livenessSteps: z.number().int().min(2).max(4).default(2),
    /** Compare live candidate to the candidate's approved ID photo (if one exists). */
    idPhotoComparison: z.enum(['off', 'advisory', 'required']).default('advisory'),
    /** Seconds between routine identity samples while the exam is active (after the start-up window). */
    periodicCheckIntervalSec: z.number().int().min(5).max(600).default(15),
    /** Faster sampling right after the exam starts / resumes (swaps are most likely then). */
    startupIntervalSec: z.number().int().min(3).max(120).default(6),
    startupWindowSec: z.number().int().min(0).max(1800).default(180),
    /**
     * Frames per TRIGGERED identity sample (captured within ~0.6 s and decided together): exam start / resume, face
     * track break, appearance change, face return, camera reconnect, after multiple people / obstruction, follow-ups
     * and every server request (a faster look, the watchdog).
     */
    burstSize: z.number().int().min(1).max(5).default(3),
    /** Frames per ROUTINE (periodic) identity sample. Default: burstSize (3). */
    routineBurstSize: z.number().int().min(1).max(5).optional(),
    /**
     * The "Sampling intensity" preset (SAMPLING_PROFILES) the admin UI fills the sampling fields from. A label only: the
     * numeric fields remain the source of truth, and the label is re-derived from them when the policy is resolved
     * ('custom' when they match no preset).
     */
    samplingProfile: z.enum(['maximum', 'balanced', 'custom']).default('maximum'),
    /** What happens when there is strong evidence of a different person. */
    onMismatch: z.enum(['hold_for_review', 'flag_only']).default('hold_for_review'),
    /** Failed "unable to verify" attempts during a check before routing to human review. */
    maxVerificationAttempts: z.number().int().min(1).max(20).default(5),
  })
  // routineBurstSize follows burstSize unless set (an older policy with burstSize 1 keeps one-frame routine samples);
  // the profile label always describes the numbers.
  .transform((p) => {
    const routineBurstSize: number = p.routineBurstSize ?? p.burstSize;
    const samplingProfile: SamplingProfile = samplingProfileOf({ ...p, routineBurstSize });
    return { ...p, routineBurstSize, samplingProfile };
  });

/** The identity-sampling fields a sampling preset sets. */
export interface SamplingValues {
  burstSize: number;
  routineBurstSize: number;
  startupIntervalSec: number;
  startupWindowSec: number;
  periodicCheckIntervalSec: number;
}
export type SamplingField = keyof SamplingValues;
export const SAMPLING_FIELDS: readonly SamplingField[] = ['burstSize', 'routineBurstSize', 'startupIntervalSec', 'startupWindowSec', 'periodicCheckIntervalSec'];
export type SamplingProfile = 'maximum' | 'balanced' | 'custom';

/**
 * "Sampling intensity" presets (Exams → Policy). Face analysis on the server scales with frames per second per
 * candidate (docs/PERFORMANCE.md §6–7):
 *  - maximum (default): 3-frame samples every 6 s for 3 min after a (re)start, then every 15 s — 0.5 then 0.2 frames/s;
 *  - balanced: 2-frame routine samples every 12 s, then every 30 s — 0.17 then 0.07 frames/s: measured ~2x the
 *    candidates per server at a synchronised start (check-ins are unchanged) and ~2.5x in steady state (§7.7).
 *    Swap detection relies more on the samples taken at once when the face changes (track break, face return, ...),
 *    which keep 3 frames, as do server requests and the exam-start sample.
 */
export const SAMPLING_PROFILES: Readonly<Record<Exclude<SamplingProfile, 'custom'>, Readonly<SamplingValues>>> = Object.freeze({
  maximum: Object.freeze({ burstSize: 3, routineBurstSize: 3, startupIntervalSec: 6, startupWindowSec: 180, periodicCheckIntervalSec: 15 }),
  balanced: Object.freeze({ burstSize: 3, routineBurstSize: 2, startupIntervalSec: 12, startupWindowSec: 180, periodicCheckIntervalSec: 30 }),
});

/** The preset whose sampling fields these are, else 'custom'. */
export function samplingProfileOf(identity: Readonly<SamplingValues>): SamplingProfile {
  for (const [name, preset] of Object.entries(SAMPLING_PROFILES) as [Exclude<SamplingProfile, 'custom'>, SamplingValues][]) {
    if (SAMPLING_FIELDS.every((f) => identity[f] === preset[f])) return name;
  }
  return 'custom';
}

/** Identity-sample triggers that are ROUTINE (policy.identity.routineBurstSize); every other trigger is triggered (burstSize). */
export const ROUTINE_SAMPLE_TRIGGERS: readonly string[] = ['periodic'];

/** Frames per identity sample for a trigger: routineBurstSize for routine samples, burstSize for triggered ones. */
export function burstSizeFor(trigger: string, identity: { burstSize: number; routineBurstSize?: number | null }): number {
  return ROUTINE_SAMPLE_TRIGGERS.includes(trigger) ? (identity.routineBurstSize ?? identity.burstSize) : identity.burstSize;
}

export const pausePolicySchema = z.object({
  allowed: z.boolean().default(true),
  requireReason: z.boolean().default(false),
  requireApproval: z.boolean().default(false),
  /** 'stop' = exam clock stops during pause; 'continue' = clock keeps running. */
  timerBehavior: z.enum(['stop', 'continue']).default('stop'),
  /** null = unlimited */
  maxPauses: z.number().int().min(0).nullable().default(null),
  /** null = unlimited. If exceeded, resume requires administrator approval. */
  maxPauseDurationSec: z.number().int().min(60).nullable().default(null),
});

export const connectionPolicySchema = z.object({
  /** Clock behaviour while the candidate's browser is disconnected without a formal pause. */
  disconnectTimerBehavior: z.enum(['continue', 'stop']).default('continue'),
  /** Seconds without heartbeat before the session is shown as disconnected. */
  heartbeatTimeoutSec: z.number().int().min(10).max(300).default(20),
});

/**
 * Resume policy: how often and how long an exam in progress may be interrupted WITHOUT a formal pause before staff
 * have to decide (formal pauses follow pausePolicySchema). The defaults (no limits) keep the behaviour from before.
 *  - maxReconnects: times the exam may be reopened in a new browser window during the exam (a reload, a crash, another
 *    device: each needs a reconnect check). Checked when the next reconnect check starts; counted when one passes.
 *    Reloading before the exam starts does not count. null = unlimited; 0 = none allowed.
 *  - maxOfflineMinutes: how long the candidate's browser may be disconnected during the exam (no heartbeat), measured
 *    from the last heartbeat (or from when the exam last continued). Enforced by the sweeper and when the candidate
 *    returns. Paused or held exams are not counted. null = unlimited.
 *  - onLimit: 'hold' (default, the less harsh choice) puts the exam on hold for staff review (hold reason
 *    'resume_limit'; releasing it gives the allowance again); 'end' ends it and submits the saved answers (end reason
 *    'resume_limit'). Either way staff can let the candidate continue (release, or reopen for recovery).
 */
export const resumePolicySchema = z.object({
  maxReconnects: z.number().int().min(0).max(100).nullable().default(null),
  maxOfflineMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  onLimit: z.enum(['hold', 'end']).default('hold'),
});

export const browserPolicySchema = z.object({
  requireFullscreen: z.boolean().default(true),
  /**
   * Only one display may be connected (off by default). Browsers report more than one display through the Window
   * Management API (`screen.isExtended`: Chrome and Edge; Firefox and Safari cannot tell). On: the exam cannot be
   * started while the browser reports more than one display (409 `single_display_required`), and a display connected
   * during the exam puts it on hold for staff (hold reason 'additional_display'). Where the browser cannot tell,
   * nothing is blocked and the start records that the display count is unknown. Off: an additional display is only
   * recorded as a neutral event.
   */
  requireSingleDisplay: z.boolean().default(false),
  blockClipboard: z.boolean().default(true),
  flagTabHidden: z.boolean().default(true),
  flagWindowBlur: z.boolean().default(true),
  /** Minimum seconds the window must be unfocused before it is recorded. */
  windowBlurMinSec: z.number().min(0).default(2),
});

export const detectionPolicySchema = z.object({
  enabled: z
    .object({
      absence: z.boolean().default(true),
      multiplePeople: z.boolean().default(true),
      lookingAway: z.boolean().default(true),
      movement: z.boolean().default(true),
      obstruction: z.boolean().default(true),
      objects: z.boolean().default(true),
      cameraIntegrity: z.boolean().default(true),
    })
    .default({}),
  /** No face for this long => candidate_absent. */
  absenceSec: z.number().min(2).default(8),
  /** Additional face/person must persist this long (brief, but more than a single frame). */
  multiplePeopleSec: z.number().min(0.3).default(1.0),
  /**
   * Head/gaze away for this long => looking_away. Angles below are measured from the middle of the candidate's
   * screen: their learned working region (attentionReference 'learned'), else the calibration baseline.
   */
  lookAwaySec: z.number().min(1).default(5),
  /** Sideways offset (degrees) that counts as "away". */
  lookAwayYawDeg: z.number().min(10).max(80).default(28),
  /** Downward offset (degrees) that counts as "looking down" (the keyboard while typing is excused). */
  lookDownPitchDeg: z.number().min(8).max(60).default(20),
  /**
   * Upward offset (degrees) that counts as "looking up". Looking up to think is normal, so this is well above
   * the down threshold (before 2026-09: always lookDownPitchDeg + 5).
   */
  lookUpPitchDeg: z.number().min(10).max(80).default(35),
  /**
   * Looking up (only) must last this long to be a sustained look-away: thinking look-ups last 2–8 s, and a stretch
   * followed by a thinking look-up ~14 s.
   */
  lookUpSec: z.number().min(1).default(15),
  /**
   * Where "away" is measured from. 'learned' (default): the candidate's own working region, learned during the
   * exam from where they look while using the mouse / keyboard (the calibration is the starting point).
   * 'calibration': the calibration baseline only (the behaviour before 2026-09).
   */
  attentionReference: z.enum(['learned', 'calibration']).default('learned'),
  /** Looking down at the keyboard is not "away" while the candidate typed within this long (0 = off). */
  typingExcuseSec: z.number().min(0).max(10).default(3),
  /** A glance shorter than this is ignored entirely. */
  glanceMinSec: z.number().min(0.3).default(1.2),
  /** Number of qualifying glances within the window => repeated_looking_away. */
  repeatedLookAwayCount: z.number().int().min(2).default(5),
  repeatedLookAwayWindowSec: z.number().min(10).default(120),
  /** Same-direction glances within window => offscreen_attention_pattern. */
  sameDirectionCount: z.number().int().min(2).default(4),
  /** Face obstructed/cut off/unclear for this long. */
  obstructionSec: z.number().min(1).default(6),
  /** Object detection: minimum confidence and persistence. */
  phoneMinConfidence: z.number().min(0.1).max(1).default(0.5),
  objectMinConfidence: z.number().min(0.1).max(1).default(0.6),
  objectPersistSec: z.number().min(0.5).default(2),
  /** Camera integrity. */
  frozenSec: z.number().min(2).default(6),
  coveredSec: z.number().min(1).default(4),
  lightingSec: z.number().min(2).default(10),
  /** Unusual movement: exits within window, or far from baseline for this long. */
  movementExitCount: z.number().int().min(2).default(3),
  movementWindowSec: z.number().min(30).default(300),
  farFromBaselineSec: z.number().min(3).default(15),
  /** Episodes of the same type separated by less than this are merged into one event. */
  mergeGapSec: z.number().min(0).default(10),
  /** Condition must be absent this long before an ongoing episode is closed (hysteresis). */
  clearSec: z.number().min(0.5).default(2.5),
});

export const evidencePolicySchema = z.object({
  /** Capture webcam screenshots for events. */
  screenshots: z.boolean().default(true),
  maxScreenshotsPerEvent: z.number().int().min(1).max(20).default(4),
  /** Seconds between extra screenshots during a long ongoing event. */
  periodicScreenshotSec: z.number().min(5).default(30),
  /** Store face images for routine identity samples that matched (default: only non-matching / notable). */
  keepMatchingIdentitySamples: z.boolean().default(false),
});

export const cameraPolicySchema = z.object({
  /**
   * false: the exam runs without a camera (usually an accommodation for one candidate): no camera check, no camera
   * monitoring and no images; identity is verified by staff. Browser rules (fullscreen, tab switches…) still apply.
   */
  enabled: z.boolean().default(true),
});

export const retentionPolicySchema = z.object({
  /** Days after the session ends before screenshots and identity references are deleted. null = use org default. */
  evidenceDays: z.number().int().min(1).max(3650).nullable().default(null),
});

/**
 * Recording of the whole exam (off by default). When on, the candidate's browser records from the start of the exam to
 * its end — never during a pause or a hold — in short, individually playable segments that are uploaded to the
 * organisation's evidence storage, encrypted, and deleted with the other evidence (retention, legal hold, erasure):
 *  - the webcam video, whenever recording is on and the exam uses a camera (no camera recording without a camera);
 *  - the microphone (`audio`), together with the webcam video (so also only with a camera);
 *  - the screen (`screen`): the candidate shares their entire screen before the exam starts.
 * The candidate is told before consenting (privacy notice, ./privacy.ts). Readers use recordingPlan(), which applies
 * the camera rule.
 */
export const recordingPolicySchema = z.object({
  enabled: z.boolean().default(false),
  audio: z.boolean().default(true),
  screen: z.boolean().default(true),
});

export const proctoringPolicySchema = z
  .object({
    identity: identityPolicySchema.default({}),
    camera: cameraPolicySchema.default({}),
    pause: pausePolicySchema.default({}),
    connection: connectionPolicySchema.default({}),
    resume: resumePolicySchema.default({}),
    browser: browserPolicySchema.default({}),
    detection: detectionPolicySchema.default({}),
    evidence: evidencePolicySchema.default({}),
    retention: retentionPolicySchema.default({}),
    recording: recordingPolicySchema.default({}),
  })
  .transform(enforceModes);

/**
 * Settings that cannot apply in a mode are switched off, so every reader of a resolved policy (server, candidate
 * client, reports) sees one consistent picture: without a camera nothing camera-based runs and identity is verified
 * by staff; with staff verification no automated face check (live-person, ID photo) runs.
 */
function enforceModes<P extends { identity: { verification: 'automatic' | 'staff'; liveness: 'active' | 'off'; idPhotoComparison: 'off' | 'advisory' | 'required' }; camera: { enabled: boolean }; detection: { enabled: Record<string, boolean> }; evidence: { screenshots: boolean; keepMatchingIdentitySamples: boolean } }>(p: P): P {
  if (p.camera.enabled && p.identity.verification === 'automatic') return p;
  const identity = { ...p.identity, verification: 'staff' as const, liveness: 'off' as const, idPhotoComparison: 'off' as const };
  if (p.camera.enabled) return { ...p, identity };
  return {
    ...p,
    identity,
    detection: { ...p.detection, enabled: Object.fromEntries(Object.keys(p.detection.enabled).map((k) => [k, false])) },
    evidence: { ...p.evidence, screenshots: false, keepMatchingIdentitySamples: false },
  };
}

export type IdentityPolicy = z.infer<typeof identityPolicySchema>;
export type PausePolicy = z.infer<typeof pausePolicySchema>;
export type ConnectionPolicy = z.infer<typeof connectionPolicySchema>;
export type ResumePolicy = z.infer<typeof resumePolicySchema>;
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;
export type DetectionPolicy = z.infer<typeof detectionPolicySchema>;
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;
export type CameraPolicy = z.infer<typeof cameraPolicySchema>;
export type RecordingPolicy = z.infer<typeof recordingPolicySchema>;
export type ProctoringPolicy = z.infer<typeof proctoringPolicySchema>;

/** What an exam records (policy.recording with the camera rule applied): camera video, microphone, screen. */
export interface RecordingPlan {
  /** Anything at all (false: the exam records nothing). */
  any: boolean;
  /** Webcam video (recording on and the exam uses a camera). */
  camera: boolean;
  /** Microphone audio, recorded together with the webcam video. */
  audio: boolean;
  /** The candidate's entire screen. */
  screen: boolean;
}

export function recordingPlan(policy: { recording?: Partial<RecordingPolicy> | null; camera?: { enabled?: boolean } | null }): RecordingPlan {
  const r = policy.recording;
  const on = r?.enabled === true;
  const camera = on && policy.camera?.enabled !== false;
  const audio = camera && r?.audio !== false;
  const screen = on && r?.screen !== false;
  return { any: camera || screen, camera, audio, screen };
}
export type ProctoringPolicyInput = z.input<typeof proctoringPolicySchema>;

/** Parse (and fill defaults for) a stored/partial policy. */
export function resolvePolicy(input: unknown): ProctoringPolicy {
  return proctoringPolicySchema.parse(input ?? {});
}

export const DEFAULT_POLICY: ProctoringPolicy = resolvePolicy({});

/**
 * Server-side identity decision thresholds (cosine similarity, SFace 128-d with flip TTA, probe/burst template vs
 * gallery template). Org-configurable. Defaults = CALIBRATION in apps/server/src/vision/calibration.ts
 * (webcam-v2.0, docs/accuracy/identity-v2.md): at 0.45 / 0.30 no non-family impostor burst matched, 1.6 % of
 * family-member bursts did, and 0.04 % of good/fair genuine bursts from another day were labelled mismatch.
 */
export const identityThresholdsSchema = z.object({
  /** >= match => same person. */
  match: z.number().default(0.45),
  /** < mismatch => evidence of a different person (only if quality gate passed and the evidence is strong). Between = inconclusive. */
  mismatch: z.number().default(0.3),
  /** ID photos are older / different capture; slightly more lenient. */
  idPhotoMatch: z.number().default(0.42),
  idPhotoMismatch: z.number().default(0.24),
  /** Consecutive quality mismatches required before raising identity_mismatch during an active exam. */
  mismatchConfirmations: z.number().int().min(1).default(2),
});
export type IdentityThresholds = z.infer<typeof identityThresholdsSchema>;
export const DEFAULT_IDENTITY_THRESHOLDS: IdentityThresholds = identityThresholdsSchema.parse({});
