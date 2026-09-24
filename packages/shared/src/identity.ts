/**
 * Identity verification and liveness types shared between the server (authoritative verification)
 * and the candidate client (guidance UI).
 */

export const IDENTITY_DECISIONS = [
  'match', // similarity above match threshold with a usable image
  'mismatch', // usable image, similarity below mismatch threshold => evidence of a different person
  'inconclusive', // usable image, similarity in the grey zone
  'unable_to_verify', // image not usable (lighting, blur, size, angle, occlusion, no/multiple faces)
] as const;
export type IdentityDecision = (typeof IDENTITY_DECISIONS)[number];

export const IDENTITY_CHECK_TRIGGERS = [
  'check_in', // initial readiness check (reference creation)
  'resume', // resume after formal pause
  'reconnect', // browser reload / new device during active exam
  'reverify', // re-verification after a hold
  'periodic', // routine sample during active exam
  'face_return', // face reappeared after an absence
  'camera_reconnect', // camera restarted / device changed
  'after_multiple_people', // single face again after a multiple-people episode
  'after_obstruction', // face visible again after obstruction / covered lens
  'follow_up', // confirmation sample requested by the server after a non-match
  'id_photo', // comparison against the approved ID photo
] as const;
export type IdentityCheckTrigger = (typeof IDENTITY_CHECK_TRIGGERS)[number];

/** Reasons an image cannot be used for dependable identity comparison. Each maps to candidate guidance. */
export const QUALITY_ISSUES = [
  'no_face',
  'multiple_faces',
  'face_too_small',
  'face_cut_off',
  'too_dark',
  'too_bright',
  'low_contrast',
  'blurry',
  'face_turned',
  'low_detection_confidence',
] as const;
export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export const QUALITY_GUIDANCE: Record<QualityIssue, string> = {
  no_face: 'We can’t see your face. Sit in front of the camera and make sure nothing is covering it.',
  multiple_faces: 'More than one face is visible. Make sure only you are in view of the camera.',
  face_too_small: 'Move closer to the camera so your face fills more of the picture.',
  face_cut_off: 'Center your face in the picture — part of it is outside the camera view.',
  too_dark: 'Your face is too dark. Turn on a light or face a window, and avoid bright light behind you.',
  too_bright: 'The image is too bright. Move away from direct sunlight or turn down a bright light.',
  low_contrast: 'Your face lacks contrast. Add light in front of you (a lamp or window facing you), avoid bright light behind you, and make sure your face is evenly lit.',
  blurry: 'The image is blurry. Hold still, clean the camera lens, and check the camera focus.',
  face_turned: 'Look straight at the screen.',
  low_detection_confidence: 'We can’t see your face clearly. Remove anything covering your face and improve the lighting.',
};

export interface FaceQuality {
  /** Faces detected in the image. */
  faceCount: number;
  /** Detector confidence of the primary face, 0..1. */
  detectionScore: number;
  /** Inter-ocular distance in pixels (proxy for resolution on the face). */
  interEyePx: number;
  /** Face box width relative to image width, 0..1. */
  faceWidthRatio: number;
  /** Mean luminance of the face region 0..255. */
  brightness: number;
  /** Std-dev of luminance of the face region. */
  contrast: number;
  /** Variance of Laplacian on the aligned face crop (higher = sharper). */
  sharpness: number;
  /** Approximate head yaw / pitch from facial landmarks, degrees (0 = frontal). */
  yawDeg: number;
  pitchDeg: number;
  /** True if the face box touches/extends beyond the image edge. */
  cutOff: boolean;
  issues: QualityIssue[];
  usable: boolean;
}

export interface IdentityResultDTO {
  id: string;
  trigger: IdentityCheckTrigger;
  decision: IdentityDecision;
  /** Cosine similarity to the reference (max over reference embeddings), null if not computed. */
  similarity: number | null;
  /** 0..1 confidence in the decision itself. */
  confidence: number;
  quality: FaceQuality | null;
  /** Candidate-facing guidance when decision is unable_to_verify. */
  guidance: string[];
  at: number;
}

/* ---------------------------------------------------------------- liveness */

/** Actions the server can verify from facial landmarks in submitted frames. */
export const LIVENESS_ACTIONS = ['turn_left', 'turn_right', 'look_up', 'look_down'] as const;
export type LivenessAction = (typeof LIVENESS_ACTIONS)[number];

export const LIVENESS_INSTRUCTIONS: Record<LivenessAction | 'center', string> = {
  center: 'Look straight at the screen',
  turn_left: 'Slowly turn your head to your LEFT',
  turn_right: 'Slowly turn your head to your RIGHT',
  look_up: 'Tilt your head UP slightly',
  look_down: 'Tilt your head DOWN slightly',
};

/**
 * Sign conventions (raw, un-mirrored camera image; degrees):
 *  - yaw  > 0 : subject turned to THEIR left  (nose moves toward image right, +x)
 *  - yaw  < 0 : subject turned to THEIR right (nose moves toward image left)
 *  - pitch > 0: subject looking UP;  pitch < 0: looking DOWN
 * Client-side head-pose estimates MUST be converted to this convention before being sent.
 */
export const POSE_CONVENTION = 'yaw+ = subject-left, pitch+ = up, un-mirrored image' as const;

export interface LivenessStep {
  index: number;
  action: LivenessAction | 'center';
  instruction: string;
}

export interface LivenessChallengeDTO {
  challengeId: string;
  /** Server nonce; client echoes it with every frame. */
  nonce: string;
  steps: LivenessStep[];
  /** Epoch ms after which the challenge is void. */
  expiresAt: number;
  /** Minimum absolute yaw/pitch change (degrees) the client should wait for before capturing a step frame. */
  targetYawDeg: number;
  targetPitchDeg: number;
}

export interface LivenessResultDTO {
  passed: boolean;
  /** Per step verification. */
  steps: { index: number; action: LivenessAction | 'center'; passed: boolean; measured: number | null; reason?: string }[];
  reasons: string[];
}
