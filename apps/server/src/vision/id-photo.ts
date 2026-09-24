/**
 * Approved ID photo intake: analyse with embedding under a relaxed quality gate (ID photos are often
 * small, scanned, older and tightly cropped) and return staff-facing guidance when rejected.
 */
import type { QualityIssue } from '@sp/shared';
import sharp from 'sharp';
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
  low_detail:
    'The photo is too low-resolution or too heavily compressed to compare reliably (the face template changes under a tiny blur or rescale). Upload the original, higher-quality photo — at least ~300 px across the face region.',
};

/**
 * Minimum cosine similarity between the photo's face template and the templates of three near-identical
 * variants (σ≈1.2 blur, 50 % down-and-up rescale, 3 % crop). Calibrated on public portrait photos: good
 * photos ≥ 0.915 (median 0.975); a 130 px thumbnail saved at JPEG quality 3 and upscaled scored 0.62 and
 * then compared at ≈ 0 with the SAME person — i.e. an unstable template would turn a poor reference photo
 * into a false "possible different person". Such photos are refused at upload instead.
 */
export const ID_PHOTO_MIN_TEMPLATE_STABILITY = 0.85;

export async function processIdPhoto(vision: VisionService, image: Buffer): Promise<IdPhotoResult> {
  const analysis = await vision.analyze(image, { embed: true, faceCrop: true, gate: ID_PHOTO_QUALITY_GATE, enhanceLowLight: false });
  let quality = analysis.quality;
  let accepted = quality.usable && analysis.embedding != null;
  let stability: number | null = null;
  if (accepted && analysis.embedding) {
    stability = await templateStability(vision, image, analysis.embedding).catch(() => null);
    if (stability != null && stability < ID_PHOTO_MIN_TEMPLATE_STABILITY) {
      accepted = false;
      quality = { ...quality, usable: false, issues: [...quality.issues, 'low_detail'] };
    }
  }
  const guidance = accepted ? [] : quality.issues.length ? [...new Set(quality.issues.map((i) => ID_PHOTO_GUIDANCE[i]))] : [ID_PHOTO_GUIDANCE.no_face];
  return { accepted, analysis: { ...analysis, quality }, quality, guidance, templateStability: stability };
}

/** Lowest similarity of the template to those of slightly perturbed copies (1 = perfectly stable). */
export async function templateStability(vision: VisionService, image: Buffer, embedding: Float32Array): Promise<number> {
  const img = sharp(image, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const w = meta.autoOrient?.width ?? meta.width ?? 0;
  const h = meta.autoOrient?.height ?? meta.height ?? 0;
  if (w < 16 || h < 16) return 0;
  const base = await img.toBuffer();
  const half = await sharp(base).resize(Math.max(8, Math.round(w * 0.5)), Math.max(8, Math.round(h * 0.5))).toBuffer();
  const variants = [
    await sharp(base).blur(1.2).jpeg({ quality: 92 }).toBuffer(),
    await sharp(half).resize(w, h).jpeg({ quality: 92 }).toBuffer(),
    await sharp(base)
      .extract({ left: Math.round(w * 0.03), top: Math.round(h * 0.03), width: Math.round(w * 0.94), height: Math.round(h * 0.94) })
      .resize(w, h)
      .jpeg({ quality: 92 })
      .toBuffer(),
  ];
  let min = 1;
  for (const v of variants) {
    const a = await vision.analyze(v, { embed: true, gate: ID_PHOTO_QUALITY_GATE, enhanceLowLight: false });
    const sim = a.embedding ? cosine(embedding, a.embedding) : 0;
    min = Math.min(min, sim);
  }
  return min;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
