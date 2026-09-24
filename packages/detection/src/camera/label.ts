/**
 * Camera device-label heuristics. The label comes from MediaDeviceInfo.label (available after the
 * camera permission is granted). A label is only a hint: real virtual-camera software can be renamed,
 * so this complements (never replaces) the replay/frozen checks.
 */

export type CameraLabelKind = 'virtual' | 'phone_as_webcam' | 'none';

export interface CameraLabelClassification {
  kind: CameraLabelKind;
  /** 0..1 confidence that the feed may be substituted (0 for 'none'). */
  confidence: number;
  /** The matched product name, for details. */
  match: string | null;
}

/** Software that injects arbitrary video (files, scenes, filters) as a camera. */
const VIRTUAL_PATTERNS: [RegExp, string][] = [
  [/\bobs\b|obs[- ]?(virtual|camera|cam)/i, 'OBS Virtual Camera'],
  [/many\s*cam/i, 'ManyCam'],
  [/snap\s*camera/i, 'Snap Camera'],
  [/xsplit/i, 'XSplit VCam'],
  [/e2e\s*soft|\bvcam\b/i, 'e2eSoft VCam'],
  [/split\s*cam/i, 'SplitCam'],
  [/cam\s*twist/i, 'CamTwist'],
  [/logi(tech)?\s*capture/i, 'Logi Capture'],
  [/nvidia\s*broadcast/i, 'NVIDIA Broadcast'],
  [/you\s*cam/i, 'CyberLink YouCam'],
  [/chroma\s*cam/i, 'ChromaCam'],
  [/\bmmhmm\b/i, 'mmhmm'],
  [/alter\s*cam/i, 'AlterCam'],
  [/webcamoid/i, 'Webcamoid'],
  [/fake[_\s-]?(device|camera|webcam)/i, 'Fake video capture device'],
  [/virtual/i, 'Virtual camera'],
];

/** Apps that stream a phone's camera — usually a real camera, but on another device, so lower confidence. */
const PHONE_PATTERNS: [RegExp, string][] = [
  [/droid\s*cam/i, 'DroidCam'],
  [/iriun/i, 'Iriun Webcam'],
  [/\bcamo\b|reincubate/i, 'Camo'],
  [/epoc\s*cam/i, 'EpocCam'],
  [/\bivcam\b/i, 'iVCam'],
];

export function classifyCameraLabel(label: string | null | undefined): CameraLabelClassification {
  const l = (label ?? '').trim();
  if (!l) return { kind: 'none', confidence: 0, match: null };
  // Phone apps first: e.g. "DroidCam Virtual Camera" is a phone app despite containing "Virtual".
  for (const [re, name] of PHONE_PATTERNS) if (re.test(l)) return { kind: 'phone_as_webcam', confidence: 0.45, match: name };
  for (const [re, name] of VIRTUAL_PATTERNS) if (re.test(l)) return { kind: 'virtual', confidence: name === 'Virtual camera' ? 0.75 : 0.9, match: name };
  return { kind: 'none', confidence: 0, match: null };
}

/**
 * True when the device label matches known virtual-camera software (OBS, ManyCam, Snap Camera, XSplit,
 * e2eSoft VCam, SplitCam, CamTwist, Logi Capture, NVIDIA Broadcast, "Virtual…", Chrome's fake capture
 * device, …) or a phone-as-webcam app (DroidCam, Iriun, Camo, EpocCam, iVCam — reported with lower
 * confidence by classifyCameraLabel).
 */
export function isVirtualCameraLabel(label: string): boolean {
  return classifyCameraLabel(label).kind !== 'none';
}
