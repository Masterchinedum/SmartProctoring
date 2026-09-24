/**
 * Approved ID photo intake: analyse with embedding under a relaxed quality gate (ID photos are often
 * small, scanned, older and tightly cropped) and return staff-facing guidance when rejected.
 */
import type { QualityIssue } from '@sp/shared';
import { ID_PHOTO_QUALITY_GATE } from './quality';
import type { IdPhotoResult, VisionService } from './types';

/** Guidance for the staff member uploading the photo (not the candidate). */
export const ID_PHOTO_GUIDANCE: Record<QualityIssue, string> = {
  no_face: 'No face was found in the photo. Upload a clear, front-facing photo of the candidate.',
  multiple_faces: 'More than one face is visible. Crop the photo so only the candidate’s face is shown.',
  face_too_small: 'The face is too small. Upload a higher-resolution photo or crop closer to the face.',
  face_cut_off: 'Part of the face is cut off. Upload a photo showing the whole face.',
  too_dark: 'The photo is too dark. Upload a better-lit photo.',
  too_bright: 'The photo is overexposed. Upload a photo without glare or strong light.',
  low_contrast: 'The photo is washed out. Upload a clearer photo.',
  blurry: 'The photo is blurry. Upload a sharper photo.',
  face_turned: 'The face is turned away. Upload a front-facing photo.',
  low_detection_confidence: 'The face is not clearly visible (covered, obscured or very low quality). Upload a clearer photo.',
};

export async function processIdPhoto(vision: VisionService, image: Buffer): Promise<IdPhotoResult> {
  const analysis = await vision.analyze(image, { embed: true, faceCrop: true, gate: ID_PHOTO_QUALITY_GATE });
  const quality = analysis.quality;
  const accepted = quality.usable && analysis.embedding != null;
  const guidance = accepted ? [] : quality.issues.length ? [...new Set(quality.issues.map((i) => ID_PHOTO_GUIDANCE[i]))] : [ID_PHOTO_GUIDANCE.no_face];
  return { accepted, analysis, quality, guidance };
}
