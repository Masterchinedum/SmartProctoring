import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSoftwareRenderer, offscreenWebgl2Supported, taskCanvas } from './vision';

afterEach(() => vi.unstubAllGlobals());

describe('the canvas MediaPipe tasks draw on', () => {
  it('leaves the choice to MediaPipe where an OffscreenCanvas holds WebGL 2', () => {
    expect(taskCanvas(true)).toBeUndefined();
  });

  it('gives each task a regular canvas of its own where it cannot (WebKitGTK / WPE, no OffscreenCanvas)', () => {
    const a = taskCanvas(false);
    const b = taskCanvas(false);
    expect(a).toBeInstanceOf(HTMLCanvasElement);
    expect(b).toBeInstanceOf(HTMLCanvasElement);
    expect(a).not.toBe(b);
  });

  it('detects WebGL 2 on OffscreenCanvas', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    expect(offscreenWebgl2Supported()).toBe(false);

    const loseContext = vi.fn();
    const withWebgl2 = vi.fn(() => ({ getExtension: () => ({ loseContext }) }));
    vi.stubGlobal('OffscreenCanvas', class { getContext = withWebgl2; });
    expect(offscreenWebgl2Supported()).toBe(true);
    expect(withWebgl2).toHaveBeenCalledWith('webgl2');
    expect(loseContext).toHaveBeenCalled(); // the probe's context is released

    vi.stubGlobal('OffscreenCanvas', class { getContext = () => null; });
    expect(offscreenWebgl2Supported()).toBe(false);

    vi.stubGlobal('OffscreenCanvas', class { getContext = () => { throw new Error('not supported'); }; });
    expect(offscreenWebgl2Supported()).toBe(false);
  });
});

describe('software WebGL renderers', () => {
  it('recognises the software renderers browsers report', () => {
    for (const r of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe, or similar', 'Microsoft Basic Render Driver', null]) {
      expect(isSoftwareRenderer(r)).toBe(true);
    }
    for (const r of ['ANGLE (Intel, Intel(R) UHD Graphics 620, D3D11)', 'Apple GPU', 'Mali-G78']) expect(isSoftwareRenderer(r)).toBe(false);
  });
});
