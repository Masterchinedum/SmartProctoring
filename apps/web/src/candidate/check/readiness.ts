import { QUALITY_GUIDANCE, type CameraState, type FaceObservation, type FrameMetrics } from '@sp/shared';

/**
 * Readiness checklist evaluated live on the camera preview before any check is sent to the server.
 * Only a working camera and exactly one face BLOCK; size / position, lighting and sharpness are WARNINGS with
 * guidance — the server judges whether an image is usable (and guides the candidate live during the check),
 * so a borderline room never stops a genuine candidate at this step. The warning thresholds are a little
 * stricter than the server's identity quality gate (inter-eye ≥ 28 px, face brightness 40..220,
 * |yaw| ≤ 25°) so a frame without warnings is very likely usable there.
 */

export type ReadinessItemId = 'frames' | 'one_face' | 'size_position' | 'lighting' | 'sharpness' | 'real_camera';

export interface ReadinessItem {
  id: ReadinessItemId;
  label: string;
  ok: boolean;
  /** Blocking items must pass (camera frames, exactly one face); others are warnings. */
  required: boolean;
  /** Guidance shown while the item fails. */
  guidance: string;
}

export interface ReadinessInput {
  cameraState: CameraState;
  framesFlowing: boolean;
  faces: FaceObservation[];
  frame: FrameMetrics | null;
  faceRegion: { mean: number; std: number; sharpness: number } | null;
  /** Result of isVirtualCameraLabel(label). */
  virtualCamera: boolean;
}

export const READINESS_THRESHOLDS = {
  minFaceWidth: 0.13,
  maxFaceWidth: 0.75,
  centreX: [0.22, 0.78] as const,
  centreY: [0.18, 0.82] as const,
  faceBrightness: [55, 210] as const,
  minFaceContrast: 12,
  minFrameLuma: 30,
  /** Variance of Laplacian of the face region on the 160×120 analysis frame. */
  minFaceSharpness: 12,
  maxYawDeg: 30,
};

export function plausible(faces: FaceObservation[]): FaceObservation[] {
  return faces.filter((f) => f.score >= 0.5 && f.box.w >= 0.035);
}

export function evaluateReadiness(inp: ReadinessInput): ReadinessItem[] {
  const T = READINESS_THRESHOLDS;
  const live = inp.cameraState === 'live' && inp.framesFlowing;
  const faces = plausible(inp.faces);
  const one = faces.length === 1;
  const face = one ? faces[0] : null;

  let sizeGuidance = QUALITY_GUIDANCE.face_too_small;
  let sizeOk = false;
  if (face) {
    const cx = face.box.x + face.box.w / 2;
    const cy = face.box.y + face.box.h / 2;
    if (face.box.w < T.minFaceWidth) sizeGuidance = QUALITY_GUIDANCE.face_too_small;
    else if (face.box.w > T.maxFaceWidth) sizeGuidance = 'Move back a little so your whole face fits in the picture.';
    else if (face.cutOff || cx < T.centreX[0] || cx > T.centreX[1] || cy < T.centreY[0] || cy > T.centreY[1]) sizeGuidance = QUALITY_GUIDANCE.face_cut_off;
    else if (Math.abs(face.yaw) > T.maxYawDeg) sizeGuidance = QUALITY_GUIDANCE.face_turned;
    else sizeOk = true;
  }

  let lightGuidance = QUALITY_GUIDANCE.too_dark;
  let lightOk = false;
  const brightness = face?.brightness ?? inp.faceRegion?.mean ?? null;
  if (face && brightness != null) {
    if (brightness < T.faceBrightness[0] || (inp.frame && inp.frame.luma < T.minFrameLuma)) lightGuidance = QUALITY_GUIDANCE.too_dark;
    else if (brightness > T.faceBrightness[1]) lightGuidance = QUALITY_GUIDANCE.too_bright;
    else if (inp.faceRegion && inp.faceRegion.std < T.minFaceContrast) lightGuidance = QUALITY_GUIDANCE.low_contrast;
    else lightOk = true;
  } else if (!face) {
    lightGuidance = 'Lighting is checked once your face is visible.';
  }

  const sharpOk = !!face && !!inp.faceRegion && inp.faceRegion.sharpness >= T.minFaceSharpness;

  return [
    {
      id: 'frames',
      label: 'Camera is delivering video',
      ok: live,
      required: true,
      guidance:
        inp.cameraState === 'no_permission'
          ? 'Allow camera access for this page (camera icon in the address bar), then try again.'
          : inp.cameraState === 'muted'
            ? 'The camera is not sending video. Close other applications that may be using it.'
            : 'Waiting for the camera. Check that it is connected and not used by another application.',
    },
    {
      id: 'one_face',
      label: 'Exactly one face is visible',
      ok: live && one,
      required: true,
      guidance: faces.length > 1 ? QUALITY_GUIDANCE.multiple_faces : QUALITY_GUIDANCE.no_face,
    },
    {
      id: 'size_position',
      label: 'Face is close enough and centred',
      ok: live && sizeOk,
      required: false,
      guidance: face ? sizeGuidance : 'Sit in front of the camera so your face is in the middle of the picture.',
    },
    { id: 'lighting', label: 'Lighting is good', ok: live && lightOk, required: false, guidance: lightGuidance },
    {
      id: 'sharpness',
      label: 'Image is sharp',
      ok: live && sharpOk,
      required: false,
      guidance: face ? QUALITY_GUIDANCE.blurry : 'Sharpness is checked once your face is visible.',
    },
    {
      id: 'real_camera',
      label: 'Physical camera',
      ok: !inp.virtualCamera,
      required: false,
      guidance:
        'This looks like a virtual or phone-based camera. Please use your computer’s built-in or USB webcam if you can — the use of a virtual camera is recorded for the administrator.',
    },
  ];
}

/**
 * Smooths the checklist over recent frames so one bad frame does not flip an item: an item counts as
 * passing when it passed in at least `ratio` of the last `window` evaluations.
 */
export class ReadinessSmoother {
  private history: ReadinessItem[][] = [];

  constructor(
    private readonly window = 8,
    private readonly ratio = 0.75,
  ) {}

  push(items: ReadinessItem[]): ReadinessItem[] {
    this.history.push(items);
    if (this.history.length > this.window) this.history.shift();
    return items.map((it) => {
      const passes = this.history.filter((h) => h.find((x) => x.id === it.id)?.ok).length;
      const ok = this.history.length >= Math.min(3, this.window) && passes / this.history.length >= this.ratio;
      return { ...it, ok };
    });
  }

  reset(): void {
    this.history = [];
  }
}

export function allRequiredPass(items: ReadinessItem[]): boolean {
  return items.every((i) => !i.required || i.ok);
}

/** Warnings (non-blocking items) currently failing — shown with their guidance, the candidate may continue. */
export function warnings(items: ReadinessItem[]): ReadinessItem[] {
  return items.filter((i) => !i.required && !i.ok);
}
