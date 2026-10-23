import type { DisplayReport } from '@sp/shared';
import { readDisplays } from './displays';
import { fullscreenSupported } from './fullscreen';

/**
 * System requirements check shown on the welcome screen.
 * `required` items block the exam; others are advisory.
 */

export interface RequirementResult {
  id: 'secure_context' | 'camera_api' | 'webassembly' | 'indexeddb' | 'browser' | 'camera_present' | 'fullscreen' | 'single_display' | 'recording_api' | 'screen_capture';
  label: string;
  ok: boolean;
  required: boolean;
  help: string;
}

export interface BrowserInfo {
  name: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Opera' | 'Other';
  version: number;
}

export function detectBrowser(ua: string): BrowserInfo {
  const m = (re: RegExp) => {
    const r = re.exec(ua);
    return r ? Number.parseInt(r[1], 10) : 0;
  };
  if (/Edg\//.test(ua)) return { name: 'Edge', version: m(/Edg\/(\d+)/) };
  if (/OPR\//.test(ua)) return { name: 'Opera', version: m(/OPR\/(\d+)/) };
  if (/Firefox\//.test(ua)) return { name: 'Firefox', version: m(/Firefox\/(\d+)/) };
  if (/(Chrome|Chromium|HeadlessChrome)\//.test(ua)) return { name: 'Chrome', version: m(/(?:Chrome|Chromium|HeadlessChrome)\/(\d+)/) };
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return { name: 'Safari', version: m(/Version\/(\d+)/) };
  return { name: 'Other', version: 0 };
}

const MIN_VERSION: Record<BrowserInfo['name'], number> = { Chrome: 110, Edge: 110, Opera: 96, Firefox: 115, Safari: 16, Other: Number.POSITIVE_INFINITY };

export function isSupportedBrowser(b: BrowserInfo): boolean {
  return b.version >= MIN_VERSION[b.name];
}

async function indexedDbWorks(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return new Promise((resolve) => {
    try {
      const name = `sp-probe-${Math.random().toString(36).slice(2)}`;
      const req = indexedDB.open(name);
      const timer = setTimeout(() => resolve(false), 3000);
      req.onsuccess = () => {
        clearTimeout(timer);
        req.result.close();
        indexedDB.deleteDatabase(name);
        resolve(true);
      };
      req.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

/**
 * The display item. Without the single-display rule: a warning only when the browser reports more than one display
 * (nothing otherwise). With it: always shown — met with one display; more than one is a warning here because the exam
 * cannot be started until it is disconnected (the ready screen and the server refuse the start); a browser that cannot
 * tell (Firefox, Safari) is told the check is not available there. Never `required`: consent and the check-in can go
 * ahead, and the item updates when a display is connected or disconnected.
 */
export function displayRequirement(displays: DisplayReport, requireSingleDisplay: boolean): RequirementResult | null {
  const base = { id: 'single_display', label: 'Single display', required: false } as const;
  if (!requireSingleDisplay) {
    return displays === 'extended'
      ? { ...base, ok: false, help: 'More than one display is connected. This is recorded for the exam administrator; consider disconnecting additional displays.' }
      : null;
  }
  if (displays === 'single') return { ...base, ok: true, help: '' };
  if (displays === 'extended') {
    return {
      ...base,
      ok: false,
      help: 'More than one display is connected. This exam allows only one display: disconnect any additional displays before you start the exam. This check updates by itself.',
    };
  }
  return {
    ...base,
    ok: false,
    help: 'The display check is not available in this browser. This exam allows only one display, so disconnect any additional displays. To have this checked, use Chrome or Edge.',
  };
}

/** The browser can record media (MediaRecorder with at least one video type). */
export function recordingSupported(): boolean {
  if (typeof MediaRecorder !== 'function') return false;
  const probe = (MediaRecorder as unknown as { isTypeSupported?: (t: string) => boolean }).isTypeSupported;
  if (typeof probe !== 'function') return true;
  return ['video/webm', 'video/mp4'].some((t) => {
    try {
      return probe.call(MediaRecorder, t);
    } catch {
      return false;
    }
  });
}

/** The browser can share a screen (desktop browsers; not phones or tablets). */
export function screenCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * `camera: false` — an exam without a camera (an approved arrangement): no camera requirements are checked.
 * `requireSingleDisplay` — the exam allows only one display (displayRequirement).
 * `recording` — what the exam records (policy.recording): the browser must be able to record it, and to share the
 * screen when the screen is recorded; both block (the exam cannot run as configured without them).
 */
export async function checkSystemRequirements(opts: {
  requireFullscreen: boolean;
  camera?: boolean;
  requireSingleDisplay?: boolean;
  recording?: { camera: boolean; screen: boolean } | null;
}): Promise<RequirementResult[]> {
  const browser = detectBrowser(navigator.userAgent);
  const camera = opts.camera !== false;
  const results: RequirementResult[] = [];
  results.push({
    id: 'secure_context',
    label: 'Secure connection (HTTPS)',
    ok: window.isSecureContext === true,
    required: true,
    help: 'Open the exam link exactly as you received it (it must start with https://).',
  });
  if (camera) results.push({
    id: 'camera_api',
    label: 'Camera access supported',
    ok: typeof navigator.mediaDevices?.getUserMedia === 'function',
    required: true,
    help: 'Use a current version of Chrome, Edge, Firefox or Safari on a computer with a webcam.',
  });
  if (camera) results.push({
    id: 'webassembly',
    label: 'WebAssembly supported',
    ok: typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function',
    required: true,
    help: 'Your browser blocks WebAssembly, which the camera check needs. Use a current browser without strict script-blocking extensions.',
  });
  results.push({
    id: 'indexeddb',
    label: 'Local storage for offline safety',
    ok: await indexedDbWorks(),
    required: false,
    help: 'Private/incognito mode may block local storage. Your answers are still saved online, but will not survive a lost connection and a page reload at the same time.',
  });
  results.push({
    id: 'browser',
    label: `Supported browser (${browser.name}${browser.version ? ` ${browser.version}` : ''})`,
    ok: isSupportedBrowser(browser),
    required: false,
    help: 'We recommend a current version of Chrome, Edge, Firefox or Safari. Other browsers may not work reliably.',
  });
  if (camera) {
    let cameraPresent = true;
    try {
      const devices = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
      cameraPresent = devices.some((d) => d.kind === 'videoinput');
    } catch {
      cameraPresent = false;
    }
    results.push({
      id: 'camera_present',
      label: 'Camera connected',
      ok: cameraPresent,
      required: false,
      help: 'No camera was detected. Connect a webcam before you continue.',
    });
  }
  if (opts.recording && (opts.recording.camera || opts.recording.screen)) {
    results.push({
      id: 'recording_api',
      label: 'Recording supported',
      ok: recordingSupported(),
      required: true,
      help: 'This exam is recorded, and this browser cannot record. Use a current version of Chrome, Edge or Firefox on a computer.',
    });
  }
  if (opts.recording?.screen) {
    results.push({
      id: 'screen_capture',
      label: 'Screen sharing supported',
      ok: screenCaptureSupported(),
      required: true,
      help: 'This exam records your screen, which needs a browser on a computer: use a current version of Chrome, Edge or Firefox. Phones and tablets cannot share their screen.',
    });
  }
  if (opts.requireFullscreen) {
    results.push({
      id: 'fullscreen',
      label: 'Fullscreen mode supported',
      ok: fullscreenSupported(),
      required: false,
      help: 'This exam requires fullscreen mode, which your browser does not appear to support. Use a current desktop browser.',
    });
  }
  const display = displayRequirement(readDisplays(), opts.requireSingleDisplay === true);
  if (display) results.push(display);
  return results;
}
