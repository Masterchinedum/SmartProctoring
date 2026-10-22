import {
  EVENT_CATALOG,
  type CalibrationSegmentDTO,
  type DecisionConfigImpactDTO,
  type DecisionThresholds,
  type DriftSignalDTO,
  type EventType,
  type IdentityDecisionVersionsDTO,
  type SessionReportDTO,
} from '@sp/shared';

export const CALIBRATION_DIMENSION_LABELS: Record<CalibrationSegmentDTO['dimension'], string> = {
  lighting: 'Face lighting',
  resolution: 'Camera resolution',
  browser: 'Browser',
  os: 'Operating system',
  decisionConfig: 'Decision configuration',
  calibration: 'Calibration',
  model: 'Recogniser model',
};

export const DRIFT_METRIC_LABELS: Record<DriftSignalDTO['metric'], string> = {
  unable_to_verify_rate: 'Identity: could not verify',
  mismatch_rate: 'Identity: different person',
  sessions_with_flag: 'Exams with this flag',
  false_detection_share: 'Decided flags that were false detections',
};

export function driftSegmentLabel(s: Pick<DriftSignalDTO, 'dimension' | 'segment'>): string {
  if (s.dimension === 'type') return EVENT_CATALOG[s.segment as EventType]?.title ?? s.segment;
  if (s.dimension === 'overall') return 'All';
  return `${CALIBRATION_DIMENSION_LABELS[s.dimension as CalibrationSegmentDTO['dimension']] ?? s.dimension}: ${s.segment}`;
}

export function rate(k: number, n: number): number | null {
  return n > 0 ? k / n : null;
}

export type ThresholdDraft = Record<keyof DecisionThresholds, string>;

/** Field errors of a proposal form (the server validates the same rules). */
export function validateThresholdDraft(d: ThresholdDraft): Partial<Record<keyof DecisionThresholds, string>> {
  const e: Partial<Record<keyof DecisionThresholds, string>> = {};
  const unit = (v: string) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
  for (const k of ['match', 'mismatch', 'idPhotoMatch', 'idPhotoMismatch'] as const) if (!unit(d[k])) e[k] = 'A number between 0 and 1';
  if (!e.match && !e.mismatch && +d.mismatch >= +d.match) e.mismatch = 'Must be lower than the match threshold';
  if (!e.idPhotoMatch && !e.idPhotoMismatch && +d.idPhotoMismatch >= +d.idPhotoMatch) e.idPhotoMismatch = 'Must be lower than the ID-photo match threshold';
  const c = d.mismatchConfirmations.trim();
  if (c === '' || !Number.isInteger(Number(c)) || +c < 1 || +c > 10) e.mismatchConfirmations = 'Whole number, 1–10';
  return e;
}

const NAMES: Record<keyof DecisionThresholds, string> = {
  match: 'Match threshold',
  mismatch: 'Mismatch threshold',
  idPhotoMatch: 'ID-photo match threshold',
  idPhotoMismatch: 'ID-photo mismatch threshold',
  mismatchConfirmations: 'Confirmations',
};

/** "Mismatch threshold 0.24 → 0.20" for every value that differs. */
export function thresholdChanges(from: DecisionThresholds, to: DecisionThresholds): string[] {
  const out = (Object.keys(NAMES) as (keyof DecisionThresholds)[]).filter((k) => from[k] !== to[k]).map((k) => `${NAMES[k]} ${from[k]} → ${to[k]}`);
  return out.length ? out : ['No change in values'];
}

const LABEL: Record<string, string> = { match: 'same person', inconclusive: 'inconclusive', mismatch: 'different person' };

/** One sentence: how many recent samples would be labelled differently, and how. */
export function impactSummary(i: DecisionConfigImpactDTO): string {
  const changed = i.changes.reduce((a, c) => a + c.count, 0);
  if (i.samples === 0) return 'No identity samples in the last 30 days to preview the change on.';
  const pct = ((changed / i.samples) * 100).toFixed(1);
  const parts = i.changes.slice(0, 4).map((c) => `${c.count} ${LABEL[c.from]} → ${LABEL[c.to]}`);
  const photo = i.idPhotoChanges.reduce((a, c) => a + c.count, 0);
  return (
    `Of ${i.samples} identity samples in the last 30 days, ${changed} (${pct} %) would be labelled differently${parts.length ? `: ${parts.join(', ')}` : ''}.` +
    (i.idPhotoComparisons ? ` ID-photo comparisons: ${photo} of ${i.idPhotoComparisons} would change.` : '') +
    ' Labels of single samples only — confirmed decisions also weigh image quality and the samples before them.'
  );
}

/** "Thresholds v2" for an identity check, with the calibration and model in the tooltip. */
export function checkVersionLabel(v: IdentityDecisionVersionsDTO): { label: string; title: string } {
  return {
    label: v.decisionConfig != null ? `thresholds v${v.decisionConfig}` : 'thresholds unrecorded',
    title: `Decision configuration ${v.decisionConfig != null ? `v${v.decisionConfig}` : 'unrecorded'} · calibration ${v.calibration ?? 'unrecorded'} · recogniser ${v.model ?? 'unrecorded'}`,
  };
}

/** "Decision configuration v1 then v2 · calibration webcam-v2.1 · recogniser sface-2021dec-flip" (session report). */
export function reportVersionsLabel(v: NonNullable<SessionReportDTO['identity']['versions']>): string {
  const list = (xs: (string | number)[], prefix = '') => (xs.length ? xs.map((x) => `${prefix}${x}`).join(' then ') : 'unrecorded');
  return `Decision configuration ${list(v.decisionConfigs, 'v')} · calibration ${list(v.calibrations)} · recogniser ${list(v.models)}`;
}
