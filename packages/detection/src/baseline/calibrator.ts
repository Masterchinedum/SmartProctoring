import type { Baseline, FaceObservation, FrameObservation } from '@sp/shared';
import { majorityHash } from '../metrics/hash';
import { mad, median } from '../util/math';
import { plausibleFaces } from '../engine/context';

/**
 * Baseline calibration: the candidate's normal head pose / position / lighting for the current exam
 * period (check-in and after every resume). Robust statistics over accepted frames:
 *  - only frames with the camera live, a frame available and exactly ONE plausible, uncut, visible face;
 *  - frames while the candidate moves a lot are rejected (pose differs from the recent running median by
 *    more than maxSpreadDeg, or the face centre jumped);
 *  - only a generous absolute sanity window is applied (|yaw| ≤ 40°, |pitch| ≤ 45°): absolute landmark
 *    pose carries per-person / per-camera offsets (a laptop camera below the eyes reads a pitch of
 *    −20° or more for a candidate looking at the screen), so acceptance relies on stability and spread.
 * result() = medians of yaw / pitch / centre / width / frame luma and a bitwise-majority dHash.
 * ready() once minSamples frames are accepted and their spread (MAD) is within maxSpreadDeg / 2.
 */
export interface BaselineCalibrator {
  add(obs: FrameObservation): void;
  /** 0..1 */
  progress(): number;
  ready(): boolean;
  result(): Baseline | null;
  reset(): void;
}

interface Sample {
  t: number;
  yaw: number;
  pitch: number;
  cx: number;
  cy: number;
  w: number;
  luma: number;
  dhash: string;
}

/** Keep the most recent accepted samples (bounded memory for long calibrations). */
const MAX_SAMPLES = 60;
const RECENT = 5;
/** Absolute sanity window (deg); see the header comment. */
const MAX_ABS_YAW = 40;
const MAX_ABS_PITCH = 45;

export function createBaselineCalibrator(opts?: { minSamples?: number; maxSpreadDeg?: number }): BaselineCalibrator {
  const minSamples = Math.max(1, Math.floor(opts?.minSamples ?? 10));
  const maxSpread = Math.max(1, opts?.maxSpreadDeg ?? 12);
  let samples: Sample[] = [];
  let recent: { yaw: number; pitch: number; cx: number; cy: number }[] = [];

  function accept(face: FaceObservation): boolean {
    if (face.cutOff) return false;
    if (Number.isFinite(face.visibility) && face.visibility < 0.6) return false;
    if (Math.abs(face.yaw) > MAX_ABS_YAW || Math.abs(face.pitch) > MAX_ABS_PITCH) return false;
    return true;
  }

  function spreadOk(list: Sample[]): boolean {
    const yaws = list.map((s) => s.yaw);
    const pitches = list.map((s) => s.pitch);
    return mad(yaws) <= maxSpread / 2 && mad(pitches) <= maxSpread / 2;
  }

  return {
    add(obs) {
      if (!obs || obs.camera !== 'live' || !obs.frame) return;
      const faces = plausibleFaces(obs.faces);
      if (faces.length !== 1) return;
      const f = faces[0];
      if (!accept(f)) return;
      const cx = f.box.x + f.box.w / 2;
      const cy = f.box.y + f.box.h / 2;
      // Motion gate: compare with the median of the last few observed frames (accepted or not).
      const cur = { yaw: f.yaw, pitch: f.pitch, cx, cy };
      const moving =
        recent.length >= 2 &&
        (Math.abs(f.yaw - median(recent.map((r) => r.yaw))) > maxSpread ||
          Math.abs(f.pitch - median(recent.map((r) => r.pitch))) > maxSpread ||
          Math.hypot(cx - median(recent.map((r) => r.cx)), cy - median(recent.map((r) => r.cy))) > 0.08);
      recent.push(cur);
      if (recent.length > RECENT) recent.shift();
      if (moving) return;
      samples.push({ t: obs.t, yaw: f.yaw, pitch: f.pitch, cx, cy, w: f.box.w, luma: obs.frame.luma, dhash: obs.frame.dhash });
      if (samples.length > MAX_SAMPLES) samples.shift();
    },
    progress() {
      return Math.min(1, samples.length / minSamples);
    },
    ready() {
      return samples.length >= minSamples && spreadOk(samples);
    },
    result() {
      if (samples.length < minSamples) return null;
      // Drop pose outliers (> 2.5 MAD-sigma) before taking medians.
      const my = median(samples.map((s) => s.yaw));
      const mp = median(samples.map((s) => s.pitch));
      const sy = Math.max(1, 1.4826 * mad(samples.map((s) => s.yaw), my));
      const sp = Math.max(1, 1.4826 * mad(samples.map((s) => s.pitch), mp));
      const kept = samples.filter((s) => Math.abs(s.yaw - my) <= 2.5 * sy && Math.abs(s.pitch - mp) <= 2.5 * sp);
      const use = kept.length >= Math.ceil(minSamples / 2) ? kept : samples;
      return {
        yaw: round(median(use.map((s) => s.yaw)), 2),
        pitch: round(median(use.map((s) => s.pitch)), 2),
        cx: round(median(use.map((s) => s.cx)), 4),
        cy: round(median(use.map((s) => s.cy)), 4),
        faceWidth: round(median(use.map((s) => s.w)), 4),
        luma: round(median(use.map((s) => s.luma)), 1),
        dhash: majorityHash(use.map((s) => s.dhash)),
        capturedAt: use[use.length - 1].t,
        samples: use.length,
      };
    },
    reset() {
      samples = [];
      recent = [];
    },
  };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
