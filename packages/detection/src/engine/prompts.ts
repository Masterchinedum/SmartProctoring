import { QUALITY_GUIDANCE, type EngineSignal } from '@sp/shared';

/**
 * Candidate-facing prompts (EngineSignal candidate_prompt / candidate_prompt_clear) with stable keys.
 * Wording is friendly guidance, never an accusation.
 */
export const PROMPTS = {
  face_not_visible: { message: QUALITY_GUIDANCE.no_face, severity: 'warning' },
  multiple_people: { message: QUALITY_GUIDANCE.multiple_faces, severity: 'warning' },
  camera_covered: { message: 'Your camera view seems to be blocked. Please make sure nothing is covering the camera.', severity: 'warning' },
  too_dark: { message: QUALITY_GUIDANCE.too_dark, severity: 'info' },
  too_bright: { message: QUALITY_GUIDANCE.too_bright, severity: 'info' },
  camera_frozen: {
    message: 'Your camera image seems to have stopped updating. Check that the camera is connected and not in use by another app.',
    severity: 'warning',
  },
  face_obstructed: { message: 'Part of your face is hidden or outside the picture. Please center your face and make sure nothing is covering it.', severity: 'info' },
  look_at_screen: { message: 'Please keep facing the exam screen.', severity: 'info' },
  phone_visible: { message: 'A phone may be visible in the camera view. Please put it away unless your exam rules allow it.', severity: 'warning' },
} as const satisfies Record<string, { message: string; severity: 'info' | 'warning' }>;

export type PromptKey = keyof typeof PROMPTS;

export class PromptManager {
  private shown = new Set<PromptKey>();

  set(key: PromptKey, on: boolean, out: EngineSignal[]): void {
    if (on === this.shown.has(key)) return;
    if (on) {
      this.shown.add(key);
      out.push({ kind: 'candidate_prompt', key, message: PROMPTS[key].message, severity: PROMPTS[key].severity });
    } else {
      this.shown.delete(key);
      out.push({ kind: 'candidate_prompt_clear', key });
    }
  }

  isShown(key: PromptKey): boolean {
    return this.shown.has(key);
  }

  clearAll(out: EngineSignal[]): void {
    for (const key of this.shown) out.push({ kind: 'candidate_prompt_clear', key });
    this.shown.clear();
  }
}
