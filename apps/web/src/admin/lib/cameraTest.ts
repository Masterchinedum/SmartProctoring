import type { IdentityEvidenceDTO, IdentityTestResponse } from '@sp/shared';

/**
 * Helpers for the staff camera & identity self-test page (pages/tools/CameraTestPage.tsx): similarity bar
 * geometry, evidence wording, and a rolling probe history summary.
 */

export interface SimilarityScale {
  /** Bar range (cosine similarity). */
  min: number;
  max: number;
  match: number;
  mismatch: number;
}

export const DEFAULT_SCALE: SimilarityScale = { min: 0, max: 1, match: 0.45, mismatch: 0.28 };

/** Position (0..100 %) of a similarity value on the bar. */
export function barPercent(value: number, scale: SimilarityScale = DEFAULT_SCALE): number {
  if (!Number.isFinite(value)) return 0;
  const p = ((value - scale.min) / (scale.max - scale.min)) * 100;
  return Math.max(0, Math.min(100, p));
}

/** Which band a similarity falls in (same rule as the exam: ≥ match → match band, < mismatch → mismatch band). */
export function similarityBand(value: number | null, scale: SimilarityScale = DEFAULT_SCALE): 'match' | 'grey' | 'mismatch' | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= scale.match) return 'match';
  if (value < scale.mismatch) return 'mismatch';
  return 'grey';
}

export const EVIDENCE_STATE_LABELS: Record<IdentityEvidenceDTO['state'], string> = {
  consistent: 'Consistent with the enrolled person',
  monitoring: 'Watching — some uncertainty',
  suspect: 'Suspect — possibly a different person',
  confirmed_mismatch: 'Confirmed — a different person (an exam would raise “possible different person”)',
};

export function evidenceTone(state: IdentityEvidenceDTO['state'] | null | undefined): 'success' | 'info' | 'warning' | 'danger' {
  switch (state) {
    case 'consistent':
      return 'success';
    case 'monitoring':
      return 'info';
    case 'suspect':
      return 'warning';
    case 'confirmed_mismatch':
      return 'danger';
    default:
      return 'info';
  }
}

export interface ProbeRecord {
  at: number;
  similarity: number | null;
  decision: IdentityTestResponse['decision'];
  llr: number | null;
  evidence: IdentityEvidenceDTO | null;
  issues: string[];
  analyzeMs: number;
  roundTripMs: number;
}

export interface ProbeSummary {
  count: number;
  usable: number;
  meanSimilarity: number | null;
  minSimilarity: number | null;
  maxSimilarity: number | null;
  byDecision: Record<string, number>;
  medianRoundTripMs: number | null;
}

export function summarizeProbes(history: readonly ProbeRecord[]): ProbeSummary {
  const sims = history.map((h) => h.similarity).filter((s): s is number => s != null && Number.isFinite(s));
  const byDecision: Record<string, number> = {};
  for (const h of history) {
    const k = h.decision ?? 'none';
    byDecision[k] = (byDecision[k] ?? 0) + 1;
  }
  const rt = history.map((h) => h.roundTripMs).sort((a, b) => a - b);
  return {
    count: history.length,
    usable: sims.length,
    meanSimilarity: sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : null,
    minSimilarity: sims.length ? Math.min(...sims) : null,
    maxSimilarity: sims.length ? Math.max(...sims) : null,
    byDecision,
    medianRoundTripMs: rt.length ? rt[rt.length >> 1] : null,
  };
}

/** Candidate-facing style explanation of a self-test API error (409 codes from routes/admin/tools.ts). */
export function selfTestErrorMessage(err: unknown): string | null {
  const e = err as { status?: number; code?: string; message?: string } | null;
  if (!e) return null;
  if (e.status === 404) return 'This server does not offer the identity self-test yet (POST /api/admin/tools/identity-test).';
  if (e.code === 'not_enrolled') return 'Enrol first: no clear enrolment frame was accepted yet.';
  if (e.code === 'too_many_frames') return 'This test already has the maximum number of enrolment frames. Reset to enrol again.';
  if (e.code === 'too_many_probes') return 'This test reached its probe limit. Reset and enrol again to continue.';
  if (e.status === 413) return 'The camera image is too large for the server.';
  if (e.status === 415) return 'The server did not accept the camera image (JPEG expected).';
  return e.message ?? null;
}
