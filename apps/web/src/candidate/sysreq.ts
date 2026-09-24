/**
 * System requirements check shown on the welcome screen.
 * `required` items block the exam; others are advisory.
 */

export interface RequirementResult {
  id: 'secure_context' | 'camera_api' | 'webassembly' | 'indexeddb' | 'browser' | 'camera_present' | 'fullscreen' | 'single_display';
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

export async function checkSystemRequirements(opts: { requireFullscreen: boolean }): Promise<RequirementResult[]> {
  const browser = detectBrowser(navigator.userAgent);
  const results: RequirementResult[] = [];
  results.push({
    id: 'secure_context',
    label: 'Secure connection (HTTPS)',
    ok: window.isSecureContext === true,
    required: true,
    help: 'Open the exam link exactly as you received it (it must start with https://).',
  });
  results.push({
    id: 'camera_api',
    label: 'Camera access supported',
    ok: typeof navigator.mediaDevices?.getUserMedia === 'function',
    required: true,
    help: 'Use a current version of Chrome, Edge, Firefox or Safari on a computer with a webcam.',
  });
  results.push({
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
  if (opts.requireFullscreen) {
    results.push({
      id: 'fullscreen',
      label: 'Fullscreen mode supported',
      ok: typeof document.documentElement.requestFullscreen === 'function',
      required: false,
      help: 'This exam requires fullscreen mode, which your browser does not appear to support. Use a current desktop browser.',
    });
  }
  const extended = (window.screen as Screen & { isExtended?: boolean }).isExtended;
  if (extended === true) {
    results.push({
      id: 'single_display',
      label: 'Single display',
      ok: false,
      required: false,
      help: 'More than one display is connected. This is recorded for the exam administrator; consider disconnecting additional displays.',
    });
  }
  return results;
}
