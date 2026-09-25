import { z } from 'zod';

/**
 * Exam proctoring policy ("the exam's rules"). Stored per exam as JSON; every field has a default so
 * partial policies are valid. Server is authoritative; the candidate client receives the full policy
 * (nothing in it is secret) so detectors can use the same thresholds.
 */

export const identityPolicySchema = z
  .object({
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
 *  - balanced: 2-frame routine samples every 12 s, then every 30 s — 0.17 then 0.07 frames/s, about 3x the capacity.
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

export const browserPolicySchema = z.object({
  requireFullscreen: z.boolean().default(true),
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
  /** Head/gaze away (relative to baseline) for this long => looking_away. */
  lookAwaySec: z.number().min(1).default(5),
  /** Yaw offset from baseline (degrees) that counts as "away". */
  lookAwayYawDeg: z.number().min(10).max(80).default(28),
  /** Downward pitch offset from baseline (degrees) that counts as "looking down". */
  lookDownPitchDeg: z.number().min(8).max(60).default(20),
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

export const retentionPolicySchema = z.object({
  /** Days after the session ends before screenshots and identity references are deleted. null = use org default. */
  evidenceDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const proctoringPolicySchema = z.object({
  identity: identityPolicySchema.default({}),
  pause: pausePolicySchema.default({}),
  connection: connectionPolicySchema.default({}),
  browser: browserPolicySchema.default({}),
  detection: detectionPolicySchema.default({}),
  evidence: evidencePolicySchema.default({}),
  retention: retentionPolicySchema.default({}),
});

export type IdentityPolicy = z.infer<typeof identityPolicySchema>;
export type PausePolicy = z.infer<typeof pausePolicySchema>;
export type ConnectionPolicy = z.infer<typeof connectionPolicySchema>;
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;
export type DetectionPolicy = z.infer<typeof detectionPolicySchema>;
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;
export type ProctoringPolicy = z.infer<typeof proctoringPolicySchema>;
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
