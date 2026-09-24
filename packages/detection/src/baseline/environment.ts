import type { Baseline } from '@sp/shared';
import { hammingHex } from '../metrics/hash';
import { round } from '../util/math';

/**
 * Compare the baseline of a new exam period (e.g. after resume) with the previous one and describe
 * NEUTRAL context changes for reviewers: lighting, camera position / angle, background.
 *
 * These notes are context only — the requirements are explicit that changes in background, camera
 * angle or brightness are not evidence of a different person. Identity is decided by the server's face
 * comparison, never here.
 */
export const ENVIRONMENT_THRESHOLDS = {
  /** Luma change (0..255) that counts as brighter / darker. */
  lumaDelta: 25,
  /** Relative luma change that also counts (for dim scenes). */
  lumaRatio: 0.3,
  /** Face centre shift (fraction of frame). */
  centreShift: 0.12,
  /** Face width ratio outside [1/x, x]. */
  widthRatio: 1.3,
  /** Baseline head pose difference (deg) suggesting a different camera angle. */
  angleDeg: 10,
  /** dHash distance (of 64 bits) suggesting a different background / scene. */
  backgroundBits: 20,
} as const;

export function compareEnvironment(prev: Baseline, next: Baseline): { changed: boolean; notes: string[]; details: Record<string, unknown> } {
  const T = ENVIRONMENT_THRESHOLDS;
  const notes: string[] = [];
  const details: Record<string, unknown> = {};

  if (Number.isFinite(prev.luma) && Number.isFinite(next.luma) && (prev.luma > 0 || next.luma > 0)) {
    const d = next.luma - prev.luma;
    const rel = prev.luma > 0 ? d / prev.luma : 0;
    details.lumaBefore = round(prev.luma, 1);
    details.lumaAfter = round(next.luma, 1);
    details.lumaDelta = round(d, 1);
    if (Math.abs(d) >= T.lumaDelta || (Math.abs(rel) >= T.lumaRatio && Math.abs(d) >= 10)) {
      details.lighting = d > 0 ? 'brighter' : 'darker';
      notes.push(d > 0 ? 'Lighting is brighter than in the previous exam period.' : 'Lighting is darker than in the previous exam period.');
    }
  }

  const shift = Math.hypot(next.cx - prev.cx, next.cy - prev.cy);
  const ratio = prev.faceWidth > 0 && next.faceWidth > 0 ? next.faceWidth / prev.faceWidth : 1;
  details.centreShift = round(shift, 3);
  details.faceWidthRatio = round(ratio, 2);
  const positionChanged = shift >= T.centreShift || ratio >= T.widthRatio || ratio <= 1 / T.widthRatio;
  if (positionChanged) {
    details.position = 'differs';
    const closer = ratio >= T.widthRatio ? ' (closer to the camera)' : ratio <= 1 / T.widthRatio ? ' (farther from the camera)' : '';
    notes.push(`The candidate’s position in the camera image differs from the previous exam period${closer}.`);
  }

  const dy = next.yaw - prev.yaw;
  const dp = next.pitch - prev.pitch;
  details.yawDelta = round(dy, 1);
  details.pitchDelta = round(dp, 1);
  if (Math.abs(dy) >= T.angleDeg || Math.abs(dp) >= T.angleDeg) {
    details.angle = 'differs';
    notes.push('The camera angle relative to the candidate differs from the previous exam period.');
  }

  if (prev.dhash && next.dhash) {
    const dist = hammingHex(prev.dhash, next.dhash);
    details.backgroundDistance = dist;
    if (dist >= T.backgroundBits) {
      details.background = 'differs';
      notes.push('The background or surroundings differ from the previous exam period.');
    }
  }

  return { changed: notes.length > 0, notes, details };
}
