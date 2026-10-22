import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ALIGNED_WINDOW, GEOMETRY_POINTS, PATCH_SIZE } from './continuity/descriptor';
import { ATTENTION } from './engine/attention';
import { DEFAULT_BASELINE, K } from './engine/context';
import { CONTINUITY } from './engine/detectors/continuity';
import { REPLAY } from './engine/detectors/feed';
import { UNAUTHORIZED_LABELS } from './engine/detectors/objects';
import { ENVIRONMENT_THRESHOLDS } from './baseline/environment';
import { DETECTION_ENGINE_VERSION } from './version';

/** Stable JSON (sorted keys) of the detector parameters. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

describe('detector version', () => {
  it('is bumped when the detector parameters change', () => {
    const params = { K, ATTENTION, REPLAY, CONTINUITY, ENVIRONMENT_THRESHOLDS, UNAUTHORIZED_LABELS, DEFAULT_BASELINE, ALIGNED_WINDOW, GEOMETRY_POINTS, PATCH_SIZE };
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(params))).digest('hex').slice(0, 16);
    // A failure here means detector parameters changed: bump DETECTION_ENGINE_VERSION (version.ts), then update both
    // values below, so events raised by the new parameters are told apart from the old ones.
    expect({ version: DETECTION_ENGINE_VERSION, fingerprint }).toEqual({ version: 'detectors-2026.10.1', fingerprint: 'c69cef7069b2d2ef' });
  });
});
