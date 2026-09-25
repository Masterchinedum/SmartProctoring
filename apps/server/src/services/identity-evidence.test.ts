/**
 * Unit tests of the identity-continuity evidence engine (pure): per-session normalisation, the SPRT accumulator,
 * the multi-frame check assessment and the server-driven cadence. Scores are scripted; the calibration itself
 * (vision/calibration.ts) is tested by the vision module.
 */
import type { FaceQuality, IdentityCheckTrigger } from '@sp/shared';
import { DEFAULT_POLICY } from '@sp/shared';
import { describe, expect, it } from 'vitest';
import { CALIBRATION } from '../vision/index.js';
import {
  accumulate,
  assessCheck,
  CADENCE,
  comparisonLLR,
  EMPTY_ACCUMULATOR,
  frameEvidence,
  identitySampleRequest,
  nextSampleDelayMs,
  periodBaseline,
  poorLightSuspect,
  SAMPLE_WATCHDOG,
  sampleWatchdog,
  windowSum,
  type EvidenceAccumulator,
  type SessionBaseline,
} from './identity-evidence.js';

/* ---------------------------------------------------------------- fixtures */

const GOOD: FaceQuality = { faceCount: 1, detectionScore: 0.93, interEyePx: 62, faceWidthRatio: 0.3, brightness: 125, contrast: 42, sharpness: 320, yawDeg: 2, pitchDeg: -9, cutOff: false, issues: [], usable: true };
/** Somewhat dim / flat light: 'fair' under the calibrated buckets (brightness 50–70, contrast 12–18). */
const FAIR: FaceQuality = { ...GOOD, brightness: 60, contrast: 15, sharpness: 120 };
/** A dim room: usable, but 'poor' (brightness < 50, low contrast, low detector score). */
const POOR: FaceQuality = { ...GOOD, brightness: 34, contrast: 11, sharpness: 60, interEyePx: 29, detectionScore: 0.78 };
const UNUSABLE: FaceQuality = { ...GOOD, brightness: 22, issues: ['too_dark'], usable: false };

/** Deterministic PRNG (mulberry32) and a normal sampler. */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return { u, normal };
}

const BASELINE_78: SessionBaseline = { mean: 0.78, sd: 0.04, n: 8 };
const BASELINE_75: SessionBaseline = { mean: 0.75, sd: 0.04, n: 8 };

function run(samples: { sim: number | null; q: FaceQuality; trigger?: IdentityCheckTrigger }[], baseline: SessionBaseline | null, start: Partial<EvidenceAccumulator> = {}) {
  let acc: EvidenceAccumulator = { ...EMPTY_ACCUMULATOR, window: [], ...start };
  const states: string[] = [];
  let at = 1_000_000;
  let confirmedAfter: number | null = null;
  samples.forEach((s, i) => {
    at += 15_000;
    const r = accumulate(acc, { id: `s${i}`, at, trigger: s.trigger ?? 'periodic', evidence: frameEvidence(s.q, s.sim, baseline) });
    acc = r.acc;
    states.push(acc.state);
    if (r.transition === 'confirmed' && confirmedAfter == null) confirmedAfter = i + 1;
  });
  return { acc, states, confirmedAfter };
}

/* ---------------------------------------------------------------- normalisation */

describe('per-session normalisation', () => {
  it('a drop from the person’s own level counts as evidence even above the global mismatch threshold', () => {
    // 0.35 is above CALIBRATION.mismatch (0.30): globally about neutral, for a person whose own frames agree at 0.78 strong.
    expect(0.35).toBeGreaterThan(CALIBRATION.mismatch);
    const global = comparisonLLR(0.35, 'good', null).llr;
    const personal = comparisonLLR(0.35, 'good', BASELINE_78).llr;
    expect(global).toBeLessThan(1.5);
    expect(personal).toBeGreaterThan(3);
    expect(personal).toBeGreaterThan(global + 2);
  });

  it('never makes an ordinary genuine score look different, and relaxes across rooms / cameras', () => {
    for (const b of [null, BASELINE_75, BASELINE_78, { mean: 0.95, sd: 0.01, n: 10 }]) {
      expect(comparisonLLR(0.62, 'good', b).llr).toBeLessThan(-4);
      expect(comparisonLLR(0.55, 'fair', b).llr).toBeLessThan(-4);
    }
    // At a resume in another room the same score is weaker evidence of a different person than mid-exam.
    expect(comparisonLLR(0.42, 'good', BASELINE_78, 'relaxed').llr).toBeLessThan(comparisonLLR(0.42, 'good', BASELINE_78, 'continuous').llr);
    // Poor frames are barely normalised (their own drift is large).
    expect(Math.abs(comparisonLLR(0.35, 'poor', BASELINE_78).llr - comparisonLLR(0.35, 'poor', null).llr)).toBeLessThan(0.5);
  });

  it('ignores baselines from too few frames and a person with a low self-similarity gets a more lenient model', () => {
    expect(comparisonLLR(0.4, 'good', { mean: 0.9, sd: 0.01, n: 2 }).llr).toBe(comparisonLLR(0.4, 'good', null).llr);
    expect(comparisonLLR(0.42, 'good', { mean: 0.6, sd: 0.08, n: 8 }).llr).toBeLessThan(comparisonLLR(0.42, 'good', null).llr);
  });

  it('unusable frames carry no evidence', () => {
    expect(frameEvidence(UNUSABLE, 0.05, BASELINE_78)).toMatchObject({ usable: false, llr: 0, bucket: null });
    expect(frameEvidence(GOOD, null, BASELINE_78)).toMatchObject({ usable: false, llr: 0 });
    expect(frameEvidence(FAIR, 0.6, null).bucket).toBe('fair');
    expect(frameEvidence(POOR, 0.6, null).bucket).toBe('poor');
  });
});

/* ---------------------------------------------------------------- accumulator */

describe('evidence accumulator (SPRT)', () => {
  it('genuine noise never confirms (5 000 samples across good / dim light, blinks and unusable frames)', () => {
    const r = rng(7);
    const samples = Array.from({ length: 5000 }, () => {
      const x = r.u();
      if (x < 0.05) return { sim: null, q: UNUSABLE };
      if (x < 0.25) return { sim: r.normal(0.56, 0.08), q: POOR };
      if (x < 0.45) return { sim: r.normal(0.62, 0.08), q: FAIR };
      return { sim: r.normal(0.7, 0.07), q: GOOD, trigger: (x < 0.5 ? 'track_break' : 'periodic') as IdentityCheckTrigger };
    });
    for (const baseline of [null, BASELINE_78, BASELINE_75]) {
      const { states } = run(samples, baseline);
      expect(states).not.toContain('confirmed_mismatch');
      expect(states.filter((s) => s === 'suspect').length / states.length).toBeLessThan(0.01);
    }
  });

  it('a different person is confirmed within 2 samples after a track break, 2–3 routine samples otherwise; in poor light only suspected', () => {
    const r = rng(11);
    const genuine = Array.from({ length: 40 }, () => ({ sim: r.normal(0.7, 0.07), q: GOOD }));
    const impostor = (trigger: IdentityCheckTrigger) => Array.from({ length: 6 }, (_, i) => ({ sim: r.normal(0.12, 0.08), q: GOOD, trigger: i === 0 ? trigger : ('server_request' as IdentityCheckTrigger) }));
    const afterBreak = run([...genuine, ...impostor('track_break')], BASELINE_78);
    expect(afterBreak.confirmedAfter).toBe(genuine.length + 2);
    const routine = run([...genuine, ...impostor('periodic')], null);
    expect(routine.confirmedAfter).not.toBeNull();
    expect(routine.confirmedAfter! - genuine.length).toBeLessThanOrEqual(3);
    // An impostor seen only in poor light is 'suspect' within 2 samples (faster sampling, lighting guidance, an uncertain
    // observation for staff) but never confirmed: poor-only evidence is capped below the confirm threshold ...
    const dimImpostor = Array.from({ length: 6 }, (_, i) => ({ sim: r.normal(0.05, 0.05), q: POOR, trigger: (i === 0 ? 'track_break' : 'server_request') as IdentityCheckTrigger }));
    const dim = run([...genuine, ...dimImpostor], BASELINE_78);
    expect(dim.confirmedAfter).toBeNull();
    expect(dim.states.slice(genuine.length, genuine.length + 2)).toContain('suspect');
    expect(dim.states.slice(genuine.length + 2).every((st) => st === 'suspect')).toBe(true);
    expect(poorLightSuspect(dim.acc)).toBe(true);
    expect(windowSum(dim.acc.window)).toBeLessThanOrEqual(CALIBRATION.sprt.maxPoorEvidence);
    // ... until a fair or good frame of the same face arrives.
    const lit = run([...genuine, ...dimImpostor, { sim: 0.12, q: FAIR, trigger: 'server_request' }], BASELINE_78);
    expect(lit.confirmedAfter).toBe(genuine.length + dimImpostor.length + 1);
  });

  it('one sample can never confirm on its own (clamp + weight below the confirm threshold)', () => {
    const one = accumulate({ ...EMPTY_ACCUMULATOR, window: [] }, { id: 'x', at: 1, trigger: 'track_break', evidence: frameEvidence(GOOD, -0.2, BASELINE_78) });
    expect(one.acc.state).toBe('suspect');
    expect(one.sum).toBeLessThan(CALIBRATION.sprt.confirm);
    expect(one.sum).toBeGreaterThanOrEqual(CALIBRATION.sprt.suspect);
  });

  it('a lighting dip then recovery does not alarm and the evidence clears', () => {
    const r = rng(3);
    const before = Array.from({ length: 10 }, () => ({ sim: r.normal(0.72, 0.05), q: GOOD }));
    // The room goes dark for a while: low scores in poor light, some frames unusable.
    const dip = Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? { sim: null, q: UNUSABLE } : { sim: r.normal(0.42, 0.06), q: POOR }));
    const after = Array.from({ length: 4 }, () => ({ sim: r.normal(0.72, 0.05), q: GOOD }));
    const { states, acc } = run([...before, ...dip, ...after], BASELINE_78);
    expect(states).not.toContain('confirmed_mismatch');
    expect(acc.state).toBe('consistent');
    expect(windowSum(acc.window)).toBeLessThanOrEqual(0);
  });

  it('a family-member-like impostor (0.35–0.45 against a ~0.75 baseline) is detected through per-session normalisation', () => {
    const r = rng(5);
    const genuine = Array.from({ length: 20 }, () => ({ sim: r.normal(0.72, 0.05), q: GOOD }));
    const relative = Array.from({ length: 8 }, () => ({ sim: 0.35 + 0.1 * r.u(), q: GOOD }));
    const withBaseline = run([...genuine, ...relative], BASELINE_75);
    expect(withBaseline.confirmedAfter).not.toBeNull();
    expect(withBaseline.confirmedAfter! - genuine.length).toBeLessThanOrEqual(6);
    // The global model alone does not reach a decision on the same scores.
    const globalOnly = run([...genuine, ...relative], null);
    expect(globalOnly.confirmedAfter).toBeNull();
  });

  it('persistent good-quality "inconclusive" scores contribute evidence (they used to be ignored)', () => {
    const grey = Array.from({ length: 4 }, () => ({ sim: 0.36, q: GOOD }));
    expect(run(grey, BASELINE_78).confirmedAfter).toBeLessThanOrEqual(3);
  });

  it('unusable samples never count as a different person', () => {
    const { acc, states } = run(Array.from({ length: 30 }, () => ({ sim: null, q: UNUSABLE })), BASELINE_78);
    expect(new Set(states)).toEqual(new Set(['consistent']));
    expect(acc.unusableStreak).toBe(30);
    expect(acc.window).toHaveLength(0);
  });

  it('a discontinuity drops earlier genuine evidence (it vouched for the person before the break)', () => {
    const genuineThenImpostor = (trigger: IdentityCheckTrigger) =>
      run(
        [
          { sim: 0.49, q: GOOD },
          { sim: 0.5, q: GOOD },
          { sim: 0.1, q: GOOD, trigger },
        ],
        null,
      ).acc;
    const periodic = genuineThenImpostor('periodic');
    const broken = genuineThenImpostor('track_break');
    expect(windowSum(broken.window)).toBeGreaterThan(windowSum(periodic.window));
    expect(broken.window.every((e) => e.llr > 0)).toBe(true);
    expect(broken.state).toBe('suspect');
  });

  it('a confirmed mismatch stays confirmed until two clear genuine samples, then recovers', () => {
    const r = run(
      [
        { sim: 0.1, q: GOOD },
        { sim: 0.1, q: GOOD },
        { sim: 0.7, q: GOOD },
        { sim: 0.1, q: GOOD },
        { sim: 0.72, q: GOOD },
        { sim: 0.74, q: GOOD },
      ],
      BASELINE_78,
    );
    expect(r.states).toEqual(['suspect', 'confirmed_mismatch', 'confirmed_mismatch', 'confirmed_mismatch', 'confirmed_mismatch', 'consistent']);
  });

  it('a late (out-of-order) discontinuity sample takes its place in time and does not drop newer genuine evidence', () => {
    let acc: EvidenceAccumulator = { ...EMPTY_ACCUMULATOR, window: [] };
    // Mild genuine samples (the window keeps them: their sum stays above `sprt.clear`).
    acc = accumulate(acc, { id: 'g1', at: 100_000, trigger: 'periodic', evidence: frameEvidence(GOOD, 0.4, null) }).acc;
    acc = accumulate(acc, { id: 'g2', at: 115_000, trigger: 'periodic', evidence: frameEvidence(GOOD, 0.41, null) }).acc;
    expect(acc.window.map((e) => e.id)).toEqual(['g1', 'g2']);
    expect(windowSum(acc.window)).toBeLessThan(0);
    // A track_break sample captured BEFORE g2, delivered after it.
    const late = accumulate(acc, { id: 'tb', at: 110_000, trigger: 'track_break', evidence: frameEvidence(GOOD, 0.1, null) });
    expect(late.acc.window.map((e) => e.id)).toEqual(['g1', 'tb', 'g2']); // in time order, g1 / g2 kept
    const raw = frameEvidence(GOOD, 0.1, null).llr;
    expect(raw).toBeGreaterThan(0);
    expect(late.acc.window.find((e) => e.id === 'tb')!.llr).toBeCloseTo(raw, 4); // not weighted as a discontinuity
    expect(late.acc.lastSampleAt).toBe(115_000);
    // The same sample in order is a discontinuity: earlier genuine evidence is dropped and it counts more.
    const inOrder = accumulate(acc, { id: 'tb2', at: 120_000, trigger: 'track_break', evidence: frameEvidence(GOOD, 0.1, null) });
    expect(inOrder.acc.window.map((e) => e.id)).toEqual(['tb2']);
    expect(inOrder.acc.window[0].llr).toBeGreaterThan(raw);
  });

  it('old samples leave the window', () => {
    let acc: EvidenceAccumulator = { ...EMPTY_ACCUMULATOR, window: [] };
    acc = accumulate(acc, { id: 'a', at: 0, trigger: 'periodic', evidence: frameEvidence(GOOD, 0.1, null) }).acc;
    const later = accumulate(acc, { id: 'b', at: 11 * 60_000, trigger: 'periodic', evidence: frameEvidence(GOOD, 0.1, null) });
    expect(later.acc.window.map((e) => e.id)).toEqual(['b']);
    expect(later.acc.state).toBe('suspect');
  });
});

/* ---------------------------------------------------------------- checks */

describe('check assessment (resume / reconnect / reverify)', () => {
  const ev = (sim: number | null, q: FaceQuality, b: SessionBaseline | null = BASELINE_78) => frameEvidence(q, sim, b, 'relaxed');

  it('the genuine candidate passes with a few poor frames among them', () => {
    const frames = [ev(0.66, GOOD), ev(0.3, POOR), ev(null, UNUSABLE), ev(0.61, FAIR), ev(0.58, GOOD)];
    expect(assessCheck(frames).status).toBe('likely_match');
  });

  it('a genuine candidate in a dim room (fair / poor frames only) passes', () => {
    const frames = [ev(0.5, POOR), ev(0.55, FAIR), ev(0.47, POOR), ev(0.52, FAIR)];
    expect(assessCheck(frames).status).toBe('likely_match');
  });

  it('a clearly different person is likely_mismatch, also when some frames are fair / poor', () => {
    const frames = [ev(0.12, GOOD), ev(0.18, FAIR), ev(0.08, POOR), ev(0.15, GOOD)];
    const a = assessCheck(frames);
    expect(a.status).toBe('likely_mismatch');
    expect(a.posterior).toBeGreaterThan(0.5);
  });

  it('waits for enough usable frames, and all-unusable stays pending', () => {
    expect(assessCheck([ev(0.7, GOOD), ev(0.7, GOOD)]).status).toBe('pending');
    // At the collection limit two usable frames are assessed (not pending) — too little evidence to decide either way.
    expect(assessCheck([ev(0.7, GOOD), ev(0.7, GOOD)], { atLimit: true }).status).toBe('uncertain');
    expect(assessCheck([ev(0.7, GOOD), ev(0.7, GOOD), ev(0.68, GOOD)], { atLimit: true }).status).toBe('likely_match');
    expect(assessCheck(Array.from({ length: 10 }, () => ev(null, UNUSABLE))).status).toBe('pending');
  });

  it('poor-light-only evidence of a different person ends uncertain (lighting guidance), never likely_mismatch', () => {
    const dark = assessCheck(Array.from({ length: 10 }, () => ev(0.05, POOR)));
    expect(dark).toMatchObject({ status: 'uncertain', poorLight: true });
    expect(dark.llr).toBeLessThanOrEqual(CALIBRATION.sprt.maxPoorEvidence);
    // Fair / good frames of the same face still decide.
    expect(assessCheck([...Array.from({ length: 4 }, () => ev(0.05, POOR)), ev(0.1, GOOD), ev(0.12, FAIR)]).status).toBe('likely_mismatch');
  });

  it('mixed clear evidence (two people) stays uncertain', () => {
    expect(assessCheck([ev(0.72, GOOD), ev(0.74, GOOD), ev(0.08, GOOD), ev(0.1, GOOD)]).status).toBe('uncertain');
  });
});

/* ---------------------------------------------------------------- cadence */

describe('cadence', () => {
  const policy = DEFAULT_POLICY.identity;
  const acc = (state: EvidenceAccumulator['state'], unusableStreak = 0) => ({ state, unusableStreak });

  it('start-up interval right after (re)start, then the periodic interval', () => {
    expect(nextSampleDelayMs(policy, { activeSince: 0, acc: acc('consistent') }, 10_000)).toBe(policy.startupIntervalSec * 1000);
    expect(nextSampleDelayMs(policy, { activeSince: 0, acc: acc('consistent') }, policy.startupWindowSec * 1000 + 1)).toBe(policy.periodicCheckIntervalSec * 1000);
  });

  it('faster while monitoring / suspect / after an unusable sample', () => {
    const late = policy.startupWindowSec * 1000 + 1;
    expect(nextSampleDelayMs(policy, { activeSince: 0, acc: acc('suspect') }, late)).toBe(CADENCE.suspectMs);
    expect(nextSampleDelayMs(policy, { activeSince: 0, acc: acc('monitoring') }, late)).toBe(CADENCE.monitoringMs);
    expect(nextSampleDelayMs(policy, { activeSince: 0, acc: acc('consistent', 1) }, late)).toBe(CADENCE.unusableMs);
  });

  it('watchdog: a server_request when no sample came for 3 intervals; "unanswered" after 6 intervals (at least 1 min)', () => {
    const late = policy.startupWindowSec * 1000 + 1;
    const iv = policy.periodicCheckIntervalSec * 1000;
    const st = (lastSampleAt: number) => ({ activeSince: 0, evidence: { state: 'consistent' as const, lastSampleAt, unusableStreak: 0 } });
    expect(sampleWatchdog(policy, st(late), late + 3 * iv)).toBe('ok');
    expect(sampleWatchdog(policy, st(late), late + 3 * iv + 1)).toBe('request');
    expect(sampleWatchdog(policy, st(late), late + Math.max(SAMPLE_WATCHDOG.observeAfterIntervals * iv, SAMPLE_WATCHDOG.minObserveMs) + 1)).toBe('unanswered');
    // No sample since the period began: measured from its start (the start-up interval applies).
    expect(sampleWatchdog(policy, { activeSince: 0, evidence: null }, 3 * policy.startupIntervalSec * 1000 + 1)).toBe('request');
    expect(sampleWatchdog(policy, { activeSince: 0, evidence: null }, 50_000)).toBe('request');
    expect(sampleWatchdog(policy, { activeSince: 0, evidence: null }, SAMPLE_WATCHDOG.minObserveMs + 1)).toBe('unanswered');
    expect(sampleWatchdog(policy, { activeSince: null, evidence: null }, 1e9)).toBe('ok');
    // identitySampleRequest asks for it (with the policy), for the fast heartbeat too.
    expect(identitySampleRequest('active', { sampleRequest: null, ...st(late) }, 3, late + 3 * iv + 1)).toBeNull();
    expect(identitySampleRequest('active', { sampleRequest: null, ...st(late) }, 3, late + 3 * iv + 1, policy)).toEqual({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    expect(identitySampleRequest('paused', { sampleRequest: null, ...st(late) }, 3, late + 10 * iv, policy)).toBeNull();
  });

  it('identitySampleRequest: exam_start until a sample arrives; server_request while suspect and late', () => {
    expect(identitySampleRequest('active', { sampleRequest: { trigger: 'exam_start', since: 5 } }, 3, 10)).toEqual({ trigger: 'exam_start', inMs: 0, burstSize: 3 });
    expect(identitySampleRequest('paused', { sampleRequest: { trigger: 'exam_start', since: 5 } }, 3, 10)).toBeNull();
    expect(identitySampleRequest('active', { sampleRequest: null, evidence: { state: 'suspect', lastSampleAt: 0 } }, 3, 1000)).toBeNull();
    expect(identitySampleRequest('active', { sampleRequest: null, evidence: { state: 'suspect', lastSampleAt: 0 } }, 3, CADENCE.lateAfterMs)).toEqual({ trigger: 'server_request', inMs: 0, burstSize: 3 });
    expect(identitySampleRequest('active', { sampleRequest: null, evidence: { state: 'consistent', lastSampleAt: 0 } }, 3, 60_000)).toBeNull();
  });
});

/* ---------------------------------------------------------------- period baseline (after a resume) */

describe('period baseline', () => {
  const f = (similarity: number | null, usable = true, bucket: 'good' | 'fair' | 'poor' = 'good') => ({ usable, similarity, bucket });

  it("is measured from the check's usable frames, with the reference's bucket", () => {
    const b = periodBaseline([f(0.7), f(0.72), f(null, false), f(0.68)], 'fair')!;
    expect(b).toMatchObject({ n: 3, bucket: 'fair', calibrationVersion: CALIBRATION.version });
    expect(b.mean).toBeCloseTo(0.7, 4);
    expect(b.sd).toBeCloseTo(0.02, 4);
  });

  it("needs at least 3 usable frames and a level inside the band the continuous model covers (else 'relaxed')", () => {
    expect(periodBaseline([f(0.7), f(0.72)], 'good')).toBeNull();
    expect(periodBaseline([f(0.5), f(0.52), f(0.51)], 'good')).toBeNull(); // far below: another day, room or camera
    expect(periodBaseline([f(0.7), f(0.72), f(0.71)], 'good')).not.toBeNull();
  });

  it("continuous against the period's own level: a drop from it is evidence, the level itself is not", () => {
    const pb = periodBaseline([f(0.7), f(0.72), f(0.71), f(0.7)], 'good')!;
    expect(comparisonLLR(0.7, 'good', pb, 'continuous').llr).toBeLessThan(-2);
    expect(comparisonLLR(0.4, 'good', pb, 'continuous').llr).toBeGreaterThan(comparisonLLR(0.4, 'good', { ...BASELINE_78, bucket: 'good' }, 'relaxed').llr);
  });
});
