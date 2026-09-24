import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Small in-repo accessibility checker (no third-party rule engine): it reads Chromium's own computed
 * accessibility tree over CDP (the names and roles assistive technology receives) and adds a few DOM
 * checks that are cheap to do reliably:
 *
 *  - every interactive element (button, link, text field, checkbox, radio, select, tab, …) and every
 *    non-decorative image has an accessible name (a placeholder alone does not count); dialogs and
 *    focusable containers are named;
 *  - the page has <html lang>, a document title, a main landmark and a level-1 heading;
 *  - ids are unique and aria-labelledby / aria-describedby / aria-controls point at existing ids;
 *  - visible text meets WCAG 1.4.3 contrast (4.5:1, 3:1 for large text) against its computed
 *    background (text over images / gradients is skipped, disabled controls are exempt).
 *
 * It is deliberately conservative (few false positives) and complements the keyboard walkthroughs in
 * tests/14-accessibility.spec.ts, which exercise focus order, focus management and dialogs.
 */

export interface A11yIssue {
  rule: string;
  detail: string;
}

interface AXValue {
  type: string;
  value?: unknown;
  sources?: { type: string; attribute?: string; value?: { value?: unknown }; superseded?: boolean }[];
}
interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: { name: string; value: AXValue }[];
  backendDOMNodeId?: number;
}

const NEEDS_NAME = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'spinbutton',
  'switch',
  'image',
  'img',
  'dialog',
  'alertdialog',
  'progressbar',
  'tabpanel',
]);
/** Containers that may take focus programmatically without a name (skip-link targets). */
const FOCUSABLE_NO_NAME_OK = new Set(['main', 'RootWebArea', 'heading', 'StaticText', 'paragraph']);

function prop(n: AXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value.value;
}

async function outerHtml(page: Page, backendNodeId: number | undefined): Promise<string> {
  if (!backendNodeId) return '';
  try {
    const cdp = await page.context().newCDPSession(page);
    const r = (await cdp.send('DOM.getOuterHTML', { backendNodeId })) as { outerHTML: string };
    await cdp.detach();
    return r.outerHTML.replace(/\s+/g, ' ').slice(0, 220);
  } catch {
    return '';
  }
}

/** Names / roles from Chromium's accessibility tree. */
export async function axTreeIssues(page: Page): Promise<A11yIssue[]> {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
  await cdp.detach();
  const issues: A11yIssue[] = [];
  let hasMain = false;
  let hasH1 = false;
  let modalOpen = false;
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = String(n.role?.value ?? '');
    const name = String(n.name?.value ?? '').trim();
    if (role === 'main') hasMain = true;
    if ((role === 'dialog' || role === 'alertdialog') && prop(n, 'modal') === true) modalOpen = true;
    if (role === 'heading' && Number(prop(n, 'level')) === 1) hasH1 = true;
    const focusable = prop(n, 'focusable') === true;
    const hidden = prop(n, 'hidden') === true;
    if (hidden) continue;
    // A placeholder is only a fallback name (it disappears while typing): fields need a real label.
    const fromPlaceholder = !!name && n.name?.sources?.some((src) => src.attribute === 'placeholder' && !src.superseded && String(src.value?.value ?? '').trim() === name);
    if (fromPlaceholder) {
      issues.push({ rule: 'label', detail: `${role} labelled only by its placeholder: ${await outerHtml(page, n.backendDOMNodeId)}` });
    }
    if (NEEDS_NAME.has(role) && !name) {
      issues.push({ rule: 'name', detail: `${role} without an accessible name: ${await outerHtml(page, n.backendDOMNodeId)}` });
    } else if (focusable && !name && !NEEDS_NAME.has(role) && !FOCUSABLE_NO_NAME_OK.has(role)) {
      issues.push({ rule: 'name', detail: `focusable ${role || 'element'} without an accessible name: ${await outerHtml(page, n.backendDOMNodeId)}` });
    }
  }
  // While a modal dialog is open the page behind it is inert (hidden from the tree) by design.
  if (!hasMain && !modalOpen) issues.push({ rule: 'landmark', detail: 'no main landmark' });
  if (!hasH1 && !modalOpen) issues.push({ rule: 'heading', detail: 'no level-1 heading' });
  return issues;
}

/** DOM checks: lang, title, ids and id references, text contrast. */
export async function domIssues(page: Page): Promise<A11yIssue[]> {
  return page.evaluate(() => {
    const issues: { rule: string; detail: string }[] = [];
    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      const tid = el.getAttribute('data-testid');
      return `<${el.tagName.toLowerCase()}${cls}${tid ? ` data-testid=${tid}` : ''}> "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)}"`;
    };
    if (!document.documentElement.lang) issues.push({ rule: 'lang', detail: '<html> has no lang attribute' });
    if (!document.title.trim()) issues.push({ rule: 'title', detail: 'empty document title' });

    const ids = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    for (const [id, n] of ids) if (n > 1 && id) issues.push({ rule: 'duplicate-id', detail: `id "${id}" used ${n} times` });
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
        for (const ref of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(ref)) issues.push({ rule: 'idref', detail: `${attr}="${ref}" does not exist (${describe(el)})` });
        }
      }
    }

    /* ---------------- contrast */
    type RGBA = [number, number, number, number];
    const parse = (s: string): RGBA | null => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const c = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [c(0), c(1), c(2), a];
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    /** Composited background behind `el`, or null when an image / gradient is involved. */
    const background = (el: Element): RGBA | null => {
      const layers: RGBA[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        if (n.tagName === 'VIDEO' || n.tagName === 'IMG') return null;
        const c = parse(cs.backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let out: RGBA = [255, 255, 255, 1];
      for (const l of layers.reverse()) out = over(l, out);
      return out;
    };
    const seen = new Set<string>();
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TITLE', 'SVG', 'VIDEO'].includes(el.tagName)) continue;
      const text = Array.from(el.childNodes).filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent ?? '').join('').trim();
      if (!text) continue;
      if (el.closest('[inert]')) continue;
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled, [aria-disabled="true"], label.btn.disabled')) continue;
      if (!(el as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // visually hidden text
      const cs = getComputedStyle(el);
      if (cs.clip && cs.clip !== 'auto' && /rect\(0/.test(cs.clip)) continue;
      const bg = background(el);
      const fg0 = parse(cs.color);
      if (!bg || !fg0) continue;
      let opacity = 1;
      for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity || 1);
      const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity], bg);
      const size = Number.parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      const r = ratio(fg, bg);
      if (r + 0.01 < need) {
        const key = `${describe(el)}|${r.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({ rule: 'contrast', detail: `${r.toFixed(2)}:1 < ${need}:1 ${describe(el)} color ${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(',')})` });
      }
    }
    return issues;
  });
}

/** Runs every check and fails with a readable list. */
export async function expectNoA11yIssues(page: Page, where: string, opts: { ignore?: RegExp[] } = {}): Promise<void> {
  const all = [...(await axTreeIssues(page)), ...(await domIssues(page))];
  const issues = all.filter((i) => !(opts.ignore ?? []).some((re) => re.test(`${i.rule}: ${i.detail}`)));
  expect(issues.map((i) => `${i.rule}: ${i.detail}`), `accessibility issues on ${where}`).toEqual([]);
}

/* ------------------------------------------------------------------ keyboard helpers */

/** Is `locator` the focused element? */
export async function isFocused(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => el === document.activeElement).catch(() => false);
}

/** A short description of the focused element (for messages). */
export function describeFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return '<body>';
    const tid = el.getAttribute('data-testid');
    return `<${el.tagName.toLowerCase()}${tid ? ` data-testid=${tid}` : ''}${el.id ? ` id=${el.id}` : ''}> ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 50)}`;
  });
}

/**
 * Press Tab (or Shift+Tab) until `target` has the focus — proves it is reachable with the keyboard in
 * the natural tab order. Fails after `max` presses.
 */
export async function tabTo(page: Page, target: Locator, opts: { max?: number; back?: boolean } = {}): Promise<number> {
  const max = opts.max ?? 60;
  for (let i = 0; i <= max; i++) {
    if (await isFocused(target)) return i;
    await page.keyboard.press(opts.back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`could not reach ${target} with ${opts.back ? 'Shift+Tab' : 'Tab'} in ${max} presses (focus is on ${await describeFocus(page)})`);
}

/** Focus stays inside `container` while pressing Tab / Shift+Tab `presses` times each. */
export async function expectFocusTrapped(page: Page, container: Locator, presses = 12): Promise<void> {
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key);
      const inside = await container.evaluate((c) => c.contains(document.activeElement));
      expect(inside, `focus left the dialog after ${key} x${i + 1} (now on ${await describeFocus(page)})`).toBe(true);
    }
  }
}

/** Records the text of the app's live announcer regions (install before the page loads). */
export const RECORD_ANNOUNCEMENTS = `(() => {
  if (window.__spAnnouncements) return;
  window.__spAnnouncements = [];
  const seen = new WeakMap();
  const record = (region) => {
    const text = (region.textContent || '').trim();
    if (!text) { seen.set(region, ''); return; }
    if (seen.get(region) === text) return;
    seen.set(region, text);
    window.__spAnnouncements.push({ kind: region.getAttribute('data-testid'), text, t: Date.now() });
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      const region = el && el.closest ? el.closest('[data-testid="announcer-polite"], [data-testid="announcer-assertive"]') : null;
      if (region) record(region);
      else if (el && el.querySelectorAll) el.querySelectorAll('[data-testid="announcer-polite"], [data-testid="announcer-assertive"]').forEach(record);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

export function announcements(page: Page): Promise<{ kind: string; text: string; t: number }[]> {
  return page.evaluate(() => (window as unknown as { __spAnnouncements?: { kind: string; text: string; t: number }[] }).__spAnnouncements ?? []);
}
