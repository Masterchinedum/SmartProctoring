import { describe, expect, it } from 'vitest';
import type { CheckFrameResponse, CheckProgressDTO, FaceQuality, LivenessChallengeDTO } from '@sp/shared';
import { AdaptiveCheck, V1_MAX_FRONTAL_REJECTIONS } from './adaptive';

const quality = { usable: true, issues: [] } as unknown as FaceQuality;
const liveness: LivenessChallengeDTO = {
  challengeId: 'c',
  nonce: 'n',
  steps: [
    { index: 0, action: 'center', instruction: 'Look straight at the screen' },
    { index: 1, action: 'turn_left', instruction: 'Turn left' },
    { index: 2, action: 'turn_right', instruction: 'Turn right' },
  ],
  expiresAt: 0,
  targetYawDeg: 20,
  targetPitchDeg: 12,
};
const res = (accepted: boolean, progress?: Partial<CheckProgressDTO>, extra: Partial<CheckFrameResponse> = {}): CheckFrameResponse => ({
  accepted,
  quality,
  guidance: accepted ? [] : ['Your face is too dark.'],
  ...(progress ? { progress: { frontalAccepted: 0, frontalNeeded: 0, identity: null, steps: [], canComplete: false, ...progress } } : {}),
  ...extra,
});

describe('AdaptiveCheck — v2 (server progress)', () => {
  it('frontalFramesRequired frontal frames, then the steps, then more frontal frames while the server wants them, then complete', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 3, maxFrontalFrames: 10, liveness });
    expect(a.phase(false, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 1, frontalNeeded: 2, identity: 'pending' }), { yaw: 4, pitch: -20 });
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 2, frontalNeeded: 1, identity: 'pending' }), { yaw: 6, pitch: -22 });
    expect(a.phase(false, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 3, frontalNeeded: 2, identity: 'uncertain' }), { yaw: 5, pitch: -21 });
    // The initial frames are sent: the steps come next, the extra frontal frames after them.
    expect(a.phase(false, 0)).toBe('liveness');
    expect(a.frontalCentre()).toEqual({ yaw: 5, pitch: -21 });
    a.stepSentOne(1);
    a.stepResult(1, res(true, { frontalAccepted: 3, frontalNeeded: 2, steps: [{ index: 1, satisfied: true }] }));
    expect(a.isStepSatisfied(1)).toBe(true);
    expect(a.phase(true, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 4, frontalNeeded: 1, identity: 'uncertain' }));
    expect(a.phase(true, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 5, frontalNeeded: 0, identity: 'likely_match', canComplete: true }));
    expect(a.phase(true, 1)).not.toBe('complete'); // a frame still in flight
    expect(a.phase(true, 0)).toBe('complete');
  });

  it('completes as soon as the server says it can (its canComplete accounts for the liveness steps)', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 3, maxFrontalFrames: 10, liveness });
    for (let i = 0; i < 3; i++) {
      a.frontalSentOne();
      a.frontalResult(res(true, { frontalAccepted: i + 1, frontalNeeded: 0, identity: 'likely_mismatch', canComplete: i === 2 }));
    }
    expect(a.phase(false, 0)).toBe('complete');
  });

  it('frames the server cannot use (dim room): the initial frames, the steps, then more frames with guidance up to maxFrontalFrames', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 3, maxFrontalFrames: 5, liveness: null });
    for (let i = 0; i < 5; i++) {
      expect(a.phase(false, 0)).toBe('frontal');
      expect(a.wantsFrontal()).toBe(true);
      a.frontalSentOne();
      a.frontalResult(res(false, { frontalAccepted: 0, frontalNeeded: 3 }));
    }
    expect(a.wantsFrontal()).toBe(false);
    expect(a.phase(false, 0)).toBe('complete');
  });

  it('without liveness: frontal frames until the server can decide', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 3, maxFrontalFrames: 10, liveness: null });
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 1, frontalNeeded: 2 }));
    expect(a.phase(false, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 2, frontalNeeded: 1 }));
    a.frontalResult(res(true, { frontalAccepted: 3, frontalNeeded: 0, canComplete: true }));
    expect(a.phase(false, 0)).toBe('complete');
  });

  it('the server refusing more frames (too_many_frames) completes the check', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 2, liveness });
    a.framesExhausted = true;
    expect(a.phase(false, 0)).toBe('complete');
  });
});

describe('AdaptiveCheck — v1 (no progress: an older server)', () => {
  it('frontalFramesRequired accepted frames, then the steps, then complete', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 2, liveness });
    expect(a.maxFrontal).toBe(10);
    a.frontalSentOne();
    a.frontalResult(res(true));
    expect(a.phase(false, 0)).toBe('frontal');
    a.frontalSentOne();
    a.frontalResult(res(true));
    expect(a.phase(false, 0)).toBe('liveness');
    a.stepSentOne(1);
    a.stepResult(1, res(true, undefined, { stepSatisfied: true }));
    expect(a.isStepSatisfied(1)).toBe(true);
    expect(a.stepSettled(1)).toBe(true);
    expect(a.phase(true, 0)).toBe('complete');
  });

  it('gives up after repeated unusable frontal frames so the server records "unable to verify" with guidance', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 2, liveness });
    for (let i = 0; i < V1_MAX_FRONTAL_REJECTIONS; i++) {
      a.frontalSentOne();
      a.frontalResult(res(false));
    }
    expect(a.frontalGaveUp()).toBe(true);
    expect(a.phase(false, 0)).toBe('complete');
  });

  it('a failed upload (network) can be sent again', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 1, maxFrontalFrames: 1, liveness: null });
    a.frontalSentOne();
    expect(a.wantsFrontal()).toBe(false);
    a.frontalFailed();
    expect(a.wantsFrontal()).toBe(true);
  });
});

describe('AdaptiveCheck.overall', () => {
  it('reflects the server’s running frontal need', () => {
    const a = new AdaptiveCheck({ frontalFramesRequired: 2, maxFrontalFrames: 8, liveness });
    expect(a.overall(0)).toBe(0);
    a.frontalSentOne();
    a.frontalResult(res(true, { frontalAccepted: 1, frontalNeeded: 1 }));
    expect(a.overall(0)).toBeCloseTo(1 / 5, 5);
    expect(a.overall(3)).toBeCloseTo(4 / 5, 5);
  });
});
