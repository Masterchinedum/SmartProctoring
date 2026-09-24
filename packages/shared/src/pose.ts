/**
 * Head pose from five facial landmarks — shared by the browser (MediaPipe landmarks reduced to five
 * points) and the server (YuNet landmarks) so both sides use identical conventions and math.
 *
 * Points in UN-MIRRORED image pixel (or normalized) coordinates:
 *   [0] eye centre on the image-left  (subject's right eye)
 *   [1] eye centre on the image-right (subject's left eye)
 *   [2] nose tip
 *   [3] mouth corner on the image-left
 *   [4] mouth corner on the image-right
 * Eyes/mouth corners are re-ordered by x internally, so callers may pass either order.
 *
 * Model: the nose tip protrudes ~2 cm in front of the eye plane, eye centres ~6.4 cm apart. When the
 * head yaws by θ the nose shifts relative to the eye midpoint by ≈ 0.31·tan(θ) inter-ocular
 * distances; a flat photograph rotated in front of the camera produces no such parallax, which is
 * what the liveness check relies on.
 *
 * Conventions (POSE_CONVENTION): yaw > 0 = subject turned to THEIR left (nose toward image right);
 * pitch > 0 = looking up; roll = eye-line angle (clockwise positive in image coordinates).
 */

export interface Pt { x: number; y: number }

export interface FivePointPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Raw nose offset from eye midpoint along the eye line, in inter-ocular distances. */
  yawRatio: number;
  /** Nose depth below the eye line relative to the eye-to-mouth distance (frontal ≈ 0.54). */
  pitchRatio: number;
  /** Inter-ocular distance in input units. */
  interOcular: number;
}

const YAW_K = 0.31;
const PITCH_FRONTAL = 0.54;
const PITCH_DEG_PER_UNIT = 235;
const DEG = 180 / Math.PI;

export function poseFromFivePoints(points: readonly Pt[]): FivePointPose {
  if (points.length < 5) throw new Error('poseFromFivePoints needs 5 points');
  const [a, b, nose, m1, m2] = points;
  const [el, er] = a.x <= b.x ? [a, b] : [b, a];
  const [ml, mr] = m1.x <= m2.x ? [m1, m2] : [m2, m1];
  const ex = er.x - el.x;
  const ey = er.y - el.y;
  const iod = Math.hypot(ex, ey) || 1e-6;
  const roll = Math.atan2(ey, ex);
  const cx = (el.x + er.x) / 2;
  const cy = (el.y + er.y) / 2;
  const c = Math.cos(-roll);
  const s = Math.sin(-roll);
  const rot = (p: Pt): Pt => ({ x: c * (p.x - cx) - s * (p.y - cy), y: s * (p.x - cx) + c * (p.y - cy) });
  const n = rot(nose);
  const mouth = rot({ x: (ml.x + mr.x) / 2, y: (ml.y + mr.y) / 2 });
  const yawRatio = n.x / iod;
  const faceH = mouth.y > iod * 0.2 ? mouth.y : iod * 0.9;
  const pitchRatio = n.y / faceH;
  const yawDeg = Math.atan(yawRatio / YAW_K) * DEG;
  const pitchDeg = Math.max(-70, Math.min(70, (PITCH_FRONTAL - pitchRatio) * PITCH_DEG_PER_UNIT));
  return { yawDeg, pitchDeg, rollDeg: roll * DEG, yawRatio, pitchRatio, interOcular: iod };
}
