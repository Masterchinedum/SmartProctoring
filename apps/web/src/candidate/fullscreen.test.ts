import { describe, expect, it, vi } from 'vitest';
import { exitFullscreen, fullscreenElement, fullscreenSupported, isFullscreen, onFullscreenChange, requestFullscreen } from './fullscreen';

/** A document whose Fullscreen API looks like a given browser's (jsdom implements none of it). */
function fakeDocument(kind: 'standard' | 'webkit' | 'none') {
  const doc = document.implementation.createHTMLDocument('t');
  const root = doc.documentElement as HTMLElement & Record<string, unknown>;
  let current: Element | null = null;
  const change = (el: Element | null, type: string) => {
    current = el;
    doc.dispatchEvent(new Event(type));
  };
  if (kind === 'standard') {
    Object.defineProperty(doc, 'onfullscreenchange', { value: null, writable: true });
    Object.defineProperty(doc, 'fullscreenElement', { get: () => current });
    root.requestFullscreen = vi.fn(async () => change(root, 'fullscreenchange'));
    Object.defineProperty(doc, 'exitFullscreen', { value: vi.fn(async () => change(null, 'fullscreenchange')) });
  } else if (kind === 'webkit') {
    // Safari 16.0–16.3: prefixed names only (no promise, no standard event).
    Object.defineProperty(doc, 'onwebkitfullscreenchange', { value: null, writable: true });
    Object.defineProperty(doc, 'webkitFullscreenElement', { get: () => current });
    root.webkitRequestFullscreen = vi.fn(() => change(root, 'webkitfullscreenchange'));
    Object.defineProperty(doc, 'webkitExitFullscreen', { value: vi.fn(() => change(null, 'webkitfullscreenchange')) });
  }
  return { doc, root };
}

describe('fullscreen helpers', () => {
  it('use the standard API where it exists', async () => {
    const { doc, root } = fakeDocument('standard');
    const seen: boolean[] = [];
    const off = onFullscreenChange(() => seen.push(isFullscreen(doc)), doc);
    expect(fullscreenSupported(doc)).toBe(true);
    await requestFullscreen(doc);
    expect(root.requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' });
    expect(fullscreenElement(doc)).toBe(root);
    await exitFullscreen(doc);
    expect(isFullscreen(doc)).toBe(false);
    off();
    await requestFullscreen(doc);
    expect(seen).toEqual([true, false]);
  });

  it('fall back to the WebKit-prefixed API (Safari 16.0–16.3)', async () => {
    const { doc, root } = fakeDocument('webkit');
    const seen: boolean[] = [];
    onFullscreenChange(() => seen.push(isFullscreen(doc)), doc);
    expect(fullscreenSupported(doc)).toBe(true);
    await requestFullscreen(doc);
    expect(root.webkitRequestFullscreen).toHaveBeenCalled();
    expect(fullscreenElement(doc)).toBe(root);
    await exitFullscreen(doc);
    expect(seen).toEqual([true, false]);
  });

  it('report a browser without fullscreen (iPhone Safari) as unsupported', async () => {
    const { doc } = fakeDocument('none');
    expect(fullscreenSupported(doc)).toBe(false);
    expect(isFullscreen(doc)).toBe(false);
    await expect(requestFullscreen(doc)).rejects.toThrow(/not supported/);
    await expect(exitFullscreen(doc)).resolves.toBeUndefined();
  });

  it('report each change once in a browser that fires both events (Chrome)', async () => {
    const { doc } = fakeDocument('standard');
    Object.defineProperty(doc, 'onwebkitfullscreenchange', { value: null, writable: true });
    const fn = vi.fn();
    onFullscreenChange(fn, doc);
    doc.dispatchEvent(new Event('fullscreenchange'));
    doc.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
