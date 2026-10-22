import { describe, expect, it } from 'vitest';
import { isFrontal } from './VerifyStep';

describe('isFrontal (when the check sends frontal frames)', () => {
  it('follows the calibrated centre, up to the server quality gate’s 30° yaw', () => {
    expect(isFrontal({ yaw: 27, pitch: 0 }, { yaw: 24, pitch: 0 })).toBe(true);
    expect(isFrontal({ yaw: 31, pitch: 0 }, { yaw: 28, pitch: 0 })).toBe(false);
    expect(isFrontal({ yaw: 8, pitch: 0 }, { yaw: 24, pitch: 0 })).toBe(false);
  });

  it('without a centre: within 18° yaw and a pitch margin inside the server gate', () => {
    expect(isFrontal({ yaw: 17, pitch: -5 }, null)).toBe(true);
    expect(isFrontal({ yaw: 19, pitch: -5 }, null)).toBe(false);
    expect(isFrontal({ yaw: 0, pitch: -30 }, null)).toBe(false);
  });
});
