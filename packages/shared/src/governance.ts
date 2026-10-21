/**
 * Model governance: versioned identity decision configurations (proposed → approved by a second person → active,
 * with rollback), and the statistics behind calibration views and drift detection.
 *
 * Only the decision thresholds are an organisation's to change. The recogniser model and its calibration ship with
 * the server (face templates are tied to the model that made them, so a model cannot be rolled back independently
 * of the templates); they are stamped on every decision so their effect can be measured.
 */
import { z } from 'zod';
import type { IdentityThresholds } from './policy';

/* ------------------------------------------------------------------ decision configurations */

export const DECISION_CONFIG_STATUSES = ['proposed', 'active', 'retired', 'rejected', 'withdrawn'] as const;
export type DecisionConfigStatus = (typeof DECISION_CONFIG_STATUSES)[number];

/** The identity thresholds a decision configuration applies (policy.ts identityThresholdsSchema documents each). */
export type DecisionThresholds = IdentityThresholds;

/** Every value required (no defaults: a proposal states the complete configuration), with consistent bounds. */
export const decisionThresholdsSchema = z
  .object({
    match: z.number().min(0).max(1),
    mismatch: z.number().min(0).max(1),
    idPhotoMatch: z.number().min(0).max(1),
    idPhotoMismatch: z.number().min(0).max(1),
    mismatchConfirmations: z.number().int().min(1).max(10),
  })
  .superRefine((t, c) => {
    if (!(t.mismatch < t.match)) c.addIssue({ code: 'custom', path: ['mismatch'], message: 'The mismatch threshold must be lower than the match threshold' });
    if (!(t.idPhotoMismatch < t.idPhotoMatch)) c.addIssue({ code: 'custom', path: ['idPhotoMismatch'], message: 'The ID-photo mismatch threshold must be lower than the ID-photo match threshold' });
  });

export const proposeDecisionConfigSchema = z.object({
  thresholds: decisionThresholdsSchema,
  /** Why (evidence, ticket): required — it is what the approver reads. */
  note: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(2000),
});
export const decideDecisionConfigSchema = z.object({ note: z.string().trim().max(2000).optional() });
export const rollbackDecisionConfigSchema = z.object({ note: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(2000) });

export interface DecisionConfigDTO {
  id: string;
  version: number;
  status: DecisionConfigStatus;
  /** The thresholds it applies (the release defaults when `releaseDefaults`). */
  thresholds: DecisionThresholds;
  /** Follows the server release's default thresholds (improved defaults arrive with upgrades). */
  releaseDefaults: boolean;
  note: string;
  /** The version it was proposed from (null for the first one). */
  basedOnVersion: number | null;
  /** Set when this version restores an earlier one. */
  rollbackOfVersion: number | null;
  proposedBy: { id: string; name: string } | null;
  proposedAt: number;
  decidedBy: { id: string; name: string } | null;
  decidedAt: number | null;
  decisionNote: string | null;
  /** Approved by the proposer because the organisation had no other active administrator. */
  selfApproved: boolean;
  activatedAt: number | null;
  retiredAt: number | null;
  /** Exams started while this version was active (version 1: also before versions were recorded). */
  sessions: number;
}

/** GET /api/admin/decision-configs */
export interface DecisionConfigsDTO {
  /** Newest version first. */
  items: DecisionConfigDTO[];
  /** The release defaults of this server (what a version without its own thresholds applies). */
  releaseDefaults: DecisionThresholds;
  /** Server-side identity calibration and recogniser model (ship with the server; stamped on every decision). */
  calibrationVersion: string;
  modelVersion: string;
}

/** What the proposed thresholds would have changed on recent identity samples (labels only; never decides anything). */
export interface DecisionConfigImpactDTO {
  from: number;
  to: number;
  samples: number;
  /** Per-sample labels under the active and the proposed thresholds, and how many would change between them. */
  changes: { from: SampleLabel; to: SampleLabel; count: number }[];
  idPhotoComparisons: number;
  idPhotoChanges: { from: SampleLabel; to: SampleLabel; count: number }[];
}

export type SampleLabel = 'match' | 'inconclusive' | 'mismatch';

/** A similarity's label under thresholds (the per-sample label; confirmed decisions also weigh quality and history). */
export function labelSimilarity(similarity: number, t: { match: number; mismatch: number }): SampleLabel {
  if (similarity >= t.match) return 'match';
  if (similarity < t.mismatch) return 'mismatch';
  return 'inconclusive';
}

/* ------------------------------------------------------------------ segmentation */

export type BrowserFamily = 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Opera' | 'Other';
export type OsFamily = 'Windows' | 'macOS' | 'ChromeOS' | 'Linux' | 'Android' | 'iOS' | 'Other';

/** Browser family from a User-Agent (order matters: Edge and Opera also say "Chrome"; Chrome also says "Safari"). */
export function browserFamily(ua: string): BrowserFamily {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/(Chrome|Chromium|CriOS)\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return 'Other';
}

export function osFamily(ua: string): OsFamily {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Android/.test(ua)) return 'Android';
  if (/(iPhone|iPad|iPod)/.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'Other';
}

export type ResolutionClass = 'low (≤ 480p)' | 'HD (720p)' | 'Full HD+ (≥ 1080p)' | 'unknown';
export function resolutionClass(videoHeight: number | null | undefined): ResolutionClass {
  if (!videoHeight) return 'unknown';
  if (videoHeight < 600) return 'low (≤ 480p)';
  if (videoHeight < 1000) return 'HD (720p)';
  return 'Full HD+ (≥ 1080p)';
}

export type LightingClass = 'dark' | 'dim' | 'typical' | 'bright' | 'unknown';
/** Face-region brightness (0..255) bands, matching the quality gate's guidance. */
export function lightingClass(brightness: number | null | undefined): LightingClass {
  if (brightness == null || !Number.isFinite(brightness)) return 'unknown';
  if (brightness < 50) return 'dark';
  if (brightness < 85) return 'dim';
  if (brightness <= 190) return 'typical';
  return 'bright';
}

/* ------------------------------------------------------------------ drift statistics */

export interface RateComparison {
  /** Events / trials in the recent window and in the baseline window. */
  recent: { n: number; k: number; rate: number | null };
  baseline: { n: number; k: number; rate: number | null };
  /** recent rate − baseline rate (percentage points as a fraction); null without data. */
  delta: number | null;
  /** Two-proportion z statistic; null when it cannot be computed. */
  z: number | null;
  /** |z| ≥ 3 and the change is at least `minDelta` (2 percentage points by default), with enough data on both sides. */
  drift: boolean;
}

/**
 * Compare a rate (k of n) between a recent and a baseline window with a two-proportion z-test. Conservative on
 * purpose: a drift needs |z| ≥ 3 (≈ 1 in 370 by chance per comparison), a practically relevant change and at least
 * `minN` trials on each side, so a dashboard with dozens of segments does not cry wolf.
 */
export function compareRates(recent: { n: number; k: number }, baseline: { n: number; k: number }, opts: { minN?: number; minDelta?: number; zThreshold?: number } = {}): RateComparison {
  const minN = opts.minN ?? 50;
  const minDelta = opts.minDelta ?? 0.02;
  const zT = opts.zThreshold ?? 3;
  const r = recent.n > 0 ? recent.k / recent.n : null;
  const b = baseline.n > 0 ? baseline.k / baseline.n : null;
  let z: number | null = null;
  if (r != null && b != null) {
    const p = (recent.k + baseline.k) / (recent.n + baseline.n);
    const se = Math.sqrt(p * (1 - p) * (1 / recent.n + 1 / baseline.n));
    z = se > 0 ? (r - b) / se : null;
  }
  const delta = r != null && b != null ? r - b : null;
  const drift = z != null && delta != null && recent.n >= minN && baseline.n >= minN && Math.abs(z) >= zT && Math.abs(delta) >= minDelta;
  return { recent: { ...recent, rate: r }, baseline: { ...baseline, rate: b }, delta, z: z == null ? null : Math.round(z * 100) / 100, drift };
}

/* ------------------------------------------------------------------ calibration and drift DTOs */

export interface CalibrationSegmentDTO {
  dimension: 'lighting' | 'resolution' | 'browser' | 'os' | 'decisionConfig' | 'calibration' | 'model';
  segment: string;
  samples: number;
  match: number;
  inconclusive: number;
  mismatch: number;
  unableToVerify: number;
}

/** GET /api/admin/metrics/calibration?from=&to= — identity decisions by condition and by version. */
export interface CalibrationDTO {
  from: number;
  to: number;
  samples: number;
  segments: CalibrationSegmentDTO[];
}

export interface DriftSignalDTO {
  area: 'identity' | 'detector';
  metric: 'unable_to_verify_rate' | 'mismatch_rate' | 'sessions_with_flag' | 'false_detection_share';
  /** 'overall', a condition dimension, or 'type' (the event type) for detectors. */
  dimension: string;
  segment: string;
  comparison: RateComparison;
}

/** GET /api/admin/metrics/drift — the last 7 days against the 28 days before. */
export interface DriftDTO {
  recent: { from: number; to: number };
  baseline: { from: number; to: number };
  /** Drifting signals first. */
  signals: DriftSignalDTO[];
  /** Version changes in the windows: the first suspects for a drift. */
  changes: { at: number; kind: 'decision_config' | 'calibration' | 'model' | 'engine'; label: string }[];
}
