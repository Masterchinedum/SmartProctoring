import { afterEach, describe, expect, it, vi } from 'vitest';
import { onDisplaysChange, readDisplays, screenInfo } from './displays';
import { checkSystemRequirements, displayRequirement } from './sysreq';

/** A screen as a browser exposes it: Chrome / Edge with the Window Management API (`isExtended`, `change`), or not. */
function fakeScreen(isExtended: boolean | undefined, withChangeEvent = isExtended !== undefined) {
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(target, { width: 1920, height: 1080 });
  if (isExtended !== undefined) target.isExtended = isExtended;
  if (withChangeEvent) target.onchange = null;
  return target as unknown as Screen & EventTarget & { isExtended?: boolean };
}

describe('display helpers', () => {
  it('read what the browser reports: unknown where it cannot tell (Firefox, Safari)', () => {
    expect(readDisplays(fakeScreen(true))).toBe('extended');
    expect(readDisplays(fakeScreen(false))).toBe('single');
    expect(readDisplays(fakeScreen(undefined))).toBe('unknown');
    expect(readDisplays(undefined)).toBe('unknown');
    expect(screenInfo(fakeScreen(true))).toEqual({ width: 1920, height: 1080, isExtended: true });
    expect(screenInfo(fakeScreen(undefined))).toEqual({ width: 1920, height: 1080, isExtended: null });
  });

  it('follow connected and disconnected displays where the browser reports them', () => {
    const scr = fakeScreen(false);
    const fn = vi.fn();
    const off = onDisplaysChange(fn, scr);
    scr.dispatchEvent(new Event('change'));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    scr.dispatchEvent(new Event('change'));
    expect(fn).toHaveBeenCalledTimes(1);
    // No change event (Firefox, Safari): nothing to listen to.
    const none = fakeScreen(undefined);
    const fn2 = vi.fn();
    onDisplaysChange(fn2, none)();
    none.dispatchEvent(new Event('change'));
    expect(fn2).not.toHaveBeenCalled();
  });
});

describe('system check: single display', () => {
  it('without the rule: a warning only when more than one display is reported (as before)', () => {
    expect(displayRequirement('extended', false)).toEqual({
      id: 'single_display',
      label: 'Single display',
      ok: false,
      required: false,
      help: 'More than one display is connected. This is recorded for the exam administrator; consider disconnecting additional displays.',
    });
    expect(displayRequirement('single', false)).toBeNull();
    expect(displayRequirement('unknown', false)).toBeNull();
  });

  it('with the rule: met with one display; more than one says to disconnect; a browser that cannot tell is told so and pointed to Chrome or Edge', () => {
    expect(displayRequirement('single', true)).toMatchObject({ id: 'single_display', ok: true, required: false });
    const extended = displayRequirement('extended', true)!;
    expect(extended).toMatchObject({ ok: false, required: false });
    expect(extended.help).toMatch(/allows only one display: disconnect any additional displays before you start the exam/);
    const unknown = displayRequirement('unknown', true)!;
    expect(unknown).toMatchObject({ ok: false, required: false });
    expect(unknown.help).toMatch(/display check is not available in this browser/);
    expect(unknown.help).toMatch(/use Chrome or Edge/);
    // Never blocks consent and the check-in: the ready screen and the server refuse the start instead.
    for (const r of [extended, unknown]) expect(r.required).toBe(false);
  });
});

describe('checkSystemRequirements: the display item', () => {
  afterEach(() => {
    delete (window.screen as unknown as Record<string, unknown>).isExtended;
  });
  const setExtended = (v: boolean) => Object.defineProperty(window.screen, 'isExtended', { configurable: true, get: () => v });
  const item = async (requireSingleDisplay: boolean) =>
    (await checkSystemRequirements({ requireFullscreen: false, camera: false, requireSingleDisplay })).find((r) => r.id === 'single_display') ?? null;

  it('reads window.screen each time it runs', async () => {
    expect(await item(true)).toMatchObject({ ok: false, help: expect.stringMatching(/not available in this browser/) }); // jsdom: no isExtended
    expect(await item(false)).toBeNull();
    setExtended(true);
    expect(await item(true)).toMatchObject({ ok: false, help: expect.stringMatching(/disconnect any additional displays/) });
    expect(await item(false)).toMatchObject({ ok: false, help: expect.stringMatching(/recorded for the exam administrator/) });
    setExtended(false);
    expect(await item(true)).toMatchObject({ ok: true });
    expect(await item(false)).toBeNull();
  });
});
