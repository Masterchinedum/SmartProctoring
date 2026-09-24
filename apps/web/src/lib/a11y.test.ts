import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, countdownAnnouncement, tabKeyTarget } from './a11y';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('countdownAnnouncement', () => {
  const min = 60_000;
  it('announces only when a 10 / 5 / 1 minute mark is crossed', () => {
    expect(countdownAnnouncement(null, 9 * min)).toBeNull(); // first observation
    expect(countdownAnnouncement(10 * min + 400, 10 * min - 100)).toBe('10 minutes remaining.');
    expect(countdownAnnouncement(10 * min - 100, 10 * min - 600)).toBeNull(); // not every tick
    expect(countdownAnnouncement(5 * min + 1, 5 * min)).toBe('5 minutes remaining.');
    expect(countdownAnnouncement(60_300, 59_800)).toBe('1 minute remaining.');
    expect(countdownAnnouncement(30_000, 29_500)).toBeNull();
  });
  it('announces the lowest mark once when several are crossed at once, nothing when time is added or runs out', () => {
    expect(countdownAnnouncement(12 * min, 4 * min)).toBe('5 minutes remaining.');
    expect(countdownAnnouncement(4 * min, 14 * min)).toBeNull(); // extension
    expect(countdownAnnouncement(61_000, 0)).toBeNull(); // time up is announced separately
  });
});

describe('tabKeyTarget', () => {
  const ids = ['a', 'b', 'c'] as const;
  it('wraps with arrows and jumps with Home / End', () => {
    expect(tabKeyTarget(ids, 'a', 'ArrowRight')).toBe('b');
    expect(tabKeyTarget(ids, 'c', 'ArrowRight')).toBe('a');
    expect(tabKeyTarget(ids, 'a', 'ArrowLeft')).toBe('c');
    expect(tabKeyTarget(ids, 'b', 'Home')).toBe('a');
    expect(tabKeyTarget(ids, 'b', 'End')).toBe('c');
    expect(tabKeyTarget(ids, 'b', 'Enter')).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});

/* -------------------------------------------------------------- colour tokens (WCAG 1.4.3 / 1.4.11) */

const styles = read('../styles.css');
const tokens = Object.fromEntries([...styles.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1], m[2]]));
const resolve = (v: string): string => {
  const m = /var\(--([a-z0-9-]+)\)/.exec(v);
  return m ? tokens[m[1]] : v.trim();
};

/** `.cls { background: X; ... color: Y; }` rules of the given class prefix (single-line rules). */
function colourRules(css: string, prefix: string): { cls: string; bg: string; fg: string }[] {
  const out: { cls: string; bg: string; fg: string }[] = [];
  for (const m of css.matchAll(new RegExp(`\\.(${prefix}[a-z_-]*)\\s*\\{([^}]*)\\}`, 'g'))) {
    const bg = /background:\s*([^;]+);/.exec(m[2])?.[1];
    const fg = /(?:^|[\s;])color:\s*([^;]+);/.exec(m[2])?.[1];
    if (bg && fg && /#|var\(/.test(bg) && !/gradient|rgba/.test(bg)) out.push({ cls: m[1], bg: resolve(bg), fg: resolve(fg) });
  }
  return out;
}

describe('colour tokens meet WCAG AA contrast', () => {
  it('text and status colours on the page backgrounds (>= 4.5:1)', () => {
    for (const fg of ['text', 'text-muted', 'primary', 'danger', 'warning', 'success', 'info', 'cat-integrity', 'cat-uncertain', 'cat-neutral', 'cat-technical']) {
      for (const bg of ['bg', 'surface', 'surface-2']) {
        expect(contrastRatio(tokens[fg], tokens[bg]), `--${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('white text on filled buttons / chips (>= 4.5:1)', () => {
    for (const bg of ['primary', 'danger', 'warning', 'success', 'cat-integrity', 'cat-uncertain', 'cat-neutral', 'cat-technical']) {
      expect(contrastRatio('#ffffff', tokens[bg]), `white on --${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('badges and banners (>= 4.5:1)', () => {
    const rules = [...colourRules(styles, 'badge'), ...colourRules(styles, 'banner-')];
    expect(rules.length).toBeGreaterThanOrEqual(12);
    for (const r of rules) expect(contrastRatio(r.fg, r.bg), `.${r.cls}`).toBeGreaterThanOrEqual(4.5);
  });
  it('form-control borders and the focus ring (>= 3:1, WCAG 1.4.11)', () => {
    for (const bg of ['bg', 'surface', 'surface-2']) {
      expect(contrastRatio(tokens['border-strong'], tokens[bg]), `--border-strong on --${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens.focus, tokens[bg]), `--focus on --${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(tokens['focus-on-dark'], '#151b28'), 'focus ring on the staff navigation').toBeGreaterThanOrEqual(3);
  });
  it('the stylesheets respect prefers-reduced-motion', () => {
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
