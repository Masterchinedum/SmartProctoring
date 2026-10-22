/**
 * Browsers of the suite (Playwright projects) and how each one gets a camera. Kept free of heavy imports: the
 * Playwright config reads it.
 *
 *   E2E_BROWSERS   comma-separated projects to define (default `chromium`): `firefox`, `webkit`, or e.g.
 *                  `chromium,firefox,webkit`. Firefox and WebKit run only the scenarios tagged `@cross-browser`.
 *   E2E_CAMERA     `device` (default for Chromium: Chromium's own fake capture device plays the Y4M fixture) or
 *                  `shim` (an injected canvas-backed getUserMedia plays the same Y4M frames, lib/camera.ts).
 *                  Firefox and WebKit always use the shim: Chromium's `--use-file-for-fake-video-capture` has no
 *                  equivalent there (Firefox's `media.navigator.streams.fake` is a test pattern, not our fixtures).
 */

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type CameraMode = 'device' | 'shim';

const ALL: BrowserName[] = ['chromium', 'firefox', 'webkit'];

/** Tag (in a test's `tag` details) of the scenarios that also run in Firefox and WebKit. */
export const CROSS_BROWSER_TAG = '@cross-browser';

export function selectedBrowsers(value = process.env.E2E_BROWSERS): BrowserName[] {
  const names = (value || 'chromium')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const n of names) if (!ALL.includes(n as BrowserName)) throw new Error(`E2E_BROWSERS: unknown browser "${n}" (expected ${ALL.join(', ')})`);
  return [...new Set(names)] as BrowserName[];
}

export function cameraModeFor(browser: BrowserName, value = process.env.E2E_CAMERA): CameraMode {
  const v = (value || '').trim().toLowerCase();
  if (v && v !== 'device' && v !== 'shim') throw new Error(`E2E_CAMERA must be "device" or "shim" (got "${value}")`);
  if (browser !== 'chromium') {
    if (v === 'device') throw new Error(`E2E_CAMERA=device is Chromium-only (its fake capture device); ${browser} always uses the camera shim`);
    return 'shim';
  }
  return v === 'shim' ? 'shim' : 'device';
}

/**
 * Firefox preferences for every Firefox the suite launches (the staff browser and the candidate browsers). The
 * candidate camera is the shim; the media prefs only make the real API non-interactive should anything bypass it
 * (a test pattern instead of a permission prompt or the developer's own webcam).
 */
export const FIREFOX_PREFS: Record<string, string | number | boolean> = {
  'media.navigator.permission.disabled': true,
  'media.navigator.streams.fake': true,
  // CI runners have no GPU and Firefox blocklists software WebGL there; MediaPipe needs a WebGL context even for
  // its CPU delegate (image input), so allow the software renderer (users' machines have a GPU).
  'webgl.force-enabled': true,
  // WebGL in the content process: out of process (the default) every texture read MediaPipe does is a synchronous
  // round trip to the GPU process, which on a software renderer kept the page's main thread blocked for seconds
  // (camera frames and clicks seconds late in CI).
  'webgl.out-of-process': false,
};
