import { describe, expect, it } from 'vitest';
import { GAZE_DIRECTIONS } from '@sp/shared';
import { BASELINE, Driver, face, frame, ms, policy, rel, secondFace } from '../testing/fixtures';
import { synthesize } from '../eval/synth';
import { replayTrace } from '../eval/runner';

const near = (v: number | null, expected: number, tol = 0.5) => {
  expect(v).not.toBeNull();
  expect(Math.abs((v as number) - expected)).toBeLessThanOrEqual(tol);
};

describe('candidate_absent', () => {
  it('opens after absenceSec with the real start, closes at the real return, one event', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 22, () => ({ faces: [] }));
    d.run(22, 30);
    const eps = d.final('candidate_absent');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 22, 0.01);
    near(d.openedAt('candidate_absent'), 18, 0.3);
    expect(eps[0].phase).toBe('close');
    expect(eps[0].details.faceReturned).toBe(true);
    expect(eps[0].confidence).toBeGreaterThan(0.5);
    expect(eps[0].confidence).toBeLessThanOrEqual(1);
    expect(d.of('candidate_absent')[0].captureSnapshot).toBe('onset');
  });

  it('a single spurious face frame does not split or end the absence', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 25, (s) => ({ faces: Math.abs(s - 15) < 0.01 || Math.abs(s - 19) < 0.01 ? [face()] : [] }));
    d.run(25, 30);
    expect(d.ids('candidate_absent')).toHaveLength(1);
    near(rel(d.final('candidate_absent')[0].startedAt), 10, 0.01);
    expect(d.identity('face_return')).toHaveLength(1);
  });

  it('a short absence does not flag but still requests a face_return identity sample (≥ 3 s)', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 15, () => ({ faces: [] }));
    d.run(15, 20);
    expect(d.of('candidate_absent')).toHaveLength(0);
    const ret = d.identity('face_return');
    expect(ret).toHaveLength(1);
    expect(ret[0].at).toBeGreaterThanOrEqual(15);
    expect(ret[0].at).toBeLessThan(17);
  });

  it('no face_return for an absence under 3 s', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 12, () => ({ faces: [] }));
    d.run(12, 20);
    expect(d.identity('face_return')).toHaveLength(0);
  });

  it('shows the "we can’t see your face" prompt after ~3 s and clears it on return', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 12, () => ({ faces: [] }));
    d.run(12, 15);
    const p = d.prompts('face_not_visible');
    expect(p.map((x) => x.kind)).toEqual(['candidate_prompt', 'candidate_prompt_clear']);
    near(p[0].at, 8, 0.3);
    near(p[1].at, 12, 0.5);
  });

  it('a person seen by the object detector without a face is face_obstructed, not absence', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 20, (s, i) => ({ faces: [], objects: i % 5 === 0 ? [{ label: 'person', score: 0.85, box: { x: 0.3, y: 0.2, w: 0.4, h: 0.8 } }] : null }));
    d.run(20, 25);
    expect(d.of('candidate_absent')).toHaveLength(0);
    const ob = d.final('face_obstructed');
    expect(ob).toHaveLength(1);
    expect(ob[0].details.reason).toBe('person_without_face');
  });

  it('is not reported while the camera is covered (one root cause → one event)', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 20, () => ({ faces: [], frame: frame({ luma: 8, contrast: 2, diffFromPrev: 0.4 }) }));
    d.run(20, 25);
    expect(d.of('candidate_absent')).toHaveLength(0);
    const c = d.final('camera_covered');
    expect(c).toHaveLength(1);
    near(rel(c[0].startedAt), 5, 0.01);
    near(rel(c[0].endedAt), 20, 0.01);
    near(d.openedAt('camera_covered'), 9, 0.3);
    expect(d.identity('after_obstruction').length).toBe(1);
    expect(d.prompts('camera_covered').map((p) => p.kind)).toEqual(['candidate_prompt', 'candidate_prompt_clear']);
  });
});

describe('multiple_people', () => {
  it('a 1.5 s intrusion flags once, with real start/end, and requests an identity sample after', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 11.5, () => ({ faces: [face(), secondFace()] }));
    d.run(11.5, 20);
    const eps = d.final('multiple_people');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 11.5, 0.01);
    near(d.openedAt('multiple_people'), 11, 0.25);
    expect(eps[0].details.maxFaces).toBe(2);
    const after = d.identity('after_multiple_people');
    expect(after).toHaveLength(1);
    expect(after[0].at).toBeGreaterThan(11.5);
  });

  it('a single-frame extra face and a 0.6 s one do not flag', () => {
    const d = new Driver();
    d.run(0, 10);
    d.tick(10, { faces: [face(), secondFace()] });
    d.run(10.2, 20);
    d.run(20, 20.6, () => ({ faces: [face(), secondFace()] }));
    d.run(20.6, 30);
    expect(d.of('multiple_people')).toHaveLength(0);
  });

  it('a long intrusion is ONE event: open once, a few updates, periodic snapshots capped', () => {
    const d = new Driver({ evidence: { maxScreenshotsPerEvent: 3, periodicScreenshotSec: 20 } });
    d.run(0, 5);
    d.run(5, 125, () => ({ faces: [face(), secondFace()] }));
    d.run(125, 130);
    const all = d.of('multiple_people');
    expect(d.ids('multiple_people')).toHaveLength(1);
    expect(all.filter((u) => u.phase === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.phase === 'close')).toHaveLength(1);
    expect(all.length).toBeLessThanOrEqual(8);
    expect(all.filter((u) => u.captureSnapshot).length).toBe(3);
    const versions = all.map((u) => u.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('two person boxes from the object detector flag (face of the second person not visible)', () => {
    const d = new Driver();
    const persons = [
      { label: 'person', score: 0.85, box: { x: 0.3, y: 0.2, w: 0.4, h: 0.8 } },
      { label: 'person', score: 0.72, box: { x: 0.78, y: 0.1, w: 0.14, h: 0.5 } },
    ];
    d.run(0, 5, (_s, i) => ({ objects: i % 5 === 0 ? [persons[0]] : null }));
    d.run(5, 15, (_s, i) => ({ objects: i % 5 === 0 ? persons : null }));
    d.run(15, 25, (_s, i) => ({ objects: i % 5 === 0 ? [persons[0]] : null }));
    const eps = d.final('multiple_people');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.maxPersons).toBe(2);
    expect(eps[0].details.maxFaces).toBe(0);
    near(rel(eps[0].startedAt), 5, 0.01);
  });

  it('a person box contained in the candidate’s own box is not a second person', () => {
    const d = new Driver();
    const persons = [
      { label: 'person', score: 0.85, box: { x: 0.3, y: 0.2, w: 0.4, h: 0.8 } },
      { label: 'person', score: 0.7, box: { x: 0.35, y: 0.22, w: 0.3, h: 0.4 } },
    ];
    d.run(0, 20, (_s, i) => ({ objects: i % 5 === 0 ? persons : null }));
    expect(d.of('multiple_people')).toHaveLength(0);
  });
});

describe('looking_away', () => {
  it('sustained head turn: opens after lookAwaySec, direction from the candidate’s perspective', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 18, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(18, 25);
    const eps = d.final('looking_away');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 18, 0.01);
    near(d.openedAt('looking_away'), 15, 0.25);
    expect(eps[0].details.direction).toBe('left');
    expect(GAZE_DIRECTIONS).toContain(eps[0].details.direction);
    expect(d.prompts('look_at_screen').map((p) => p.kind)).toEqual(['candidate_prompt', 'candidate_prompt_clear']);
  });

  it('looking down relative to the baseline pitch', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 20, () => ({ faces: [face({ pitch: -30 })] }));
    d.run(20, 25);
    const eps = d.final('looking_away');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.direction).toBe('down');
  });

  it('eye gaze adds to head pose; head pose alone below threshold does not flag', () => {
    const a = new Driver();
    a.run(0, 20, () => ({ faces: [face({ yaw: 15 })] }));
    expect(a.of('looking_away')).toHaveLength(0);
    const b = new Driver();
    b.run(0, 20, () => ({ faces: [face({ yaw: 15, gazeX: 0.8 })] }));
    expect(b.final('looking_away')).toHaveLength(1);
    // Eyes counter-rotating toward the screen cancel a head turn.
    const c = new Driver();
    c.run(0, 20, () => ({ faces: [face({ yaw: 32, gazeX: -0.6 })] }));
    expect(c.of('looking_away')).toHaveLength(0);
  });

  it('is relative to the candidate’s baseline (camera to the side)', () => {
    const d = new Driver({ baseline: { ...BASELINE, yaw: 25 } });
    d.run(0, 20, () => ({ faces: [face({ yaw: 30 })] }));
    expect(d.of('looking_away')).toHaveLength(0);
    const n = new Driver({ baseline: null });
    n.run(0, 20, () => ({ faces: [face({ yaw: 30 })] }));
    expect(n.final('looking_away')).toHaveLength(1);
  });

  it('brief glances never flag', () => {
    const d = new Driver();
    d.run(0, 120, (s) => ({ faces: [face({ yaw: s % 10 < 0.8 ? 45 : 0 })] }));
    expect(d.of('looking_away')).toHaveLength(0);
    expect(d.of('repeated_looking_away')).toHaveLength(0);
    expect(d.of('offscreen_attention_pattern')).toHaveLength(0);
  });

  it('hysteresis: a 1 s look back inside a long look-away does not split it', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 13, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(13, 14);
    d.run(14, 22, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(22, 30);
    const eps = d.final('looking_away');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 5, 0.01);
    near(rel(eps[0].endedAt), 22, 0.01);
    expect(d.of('looking_away').filter((u) => u.phase === 'close')).toHaveLength(1);
  });

  it('merge gap: a new look-away soon after the previous one re-opens the same event', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 13, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(13, 19); // closed after clearSec, then back within mergeGapSec (10 s)
    d.run(19, 27, () => ({ faces: [face({ yaw: -40 })] }));
    d.run(27, 32);
    const all = d.of('looking_away');
    expect(d.ids('looking_away')).toHaveLength(1);
    expect(all.map((u) => u.phase)).toEqual(['open', 'close', 'update', 'close']);
    const final = d.final('looking_away')[0];
    near(rel(final.startedAt), 5, 0.01);
    near(rel(final.endedAt), 27, 0.01);
    expect(final.details.occurrences).toBe(2);
    expect(all.map((u) => u.version)).toEqual([1, 2, 3, 4]);
  });

  it('beyond the merge gap a separate event is created', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 13, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(13, 30);
    d.run(30, 38, () => ({ faces: [face({ yaw: 40 })] }));
    d.run(38, 45);
    expect(d.ids('looking_away')).toHaveLength(2);
  });

  it('is not evaluated while the face is absent or cut off', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 20, () => ({ faces: [face({ yaw: 45, cutOff: true })] }));
    expect(d.of('looking_away')).toHaveLength(0);
  });
});

describe('repeated_looking_away and offscreen_attention_pattern', () => {
  const glances = (d: Driver, dirs: [number, number][], every = 12, dur = 2, start = 10) => {
    let t = 0;
    d.run(0, start);
    t = start;
    for (const [yaw, pitch] of dirs) {
      d.run(t, t + dur, () => ({ faces: [face({ yaw, pitch: -5 + pitch })] }));
      d.run(t + dur, t + every);
      t += every;
    }
    return t;
  };

  it('5+ short glances in mixed directions → one repeated_looking_away with glance details', () => {
    const d = new Driver();
    const end = glances(d, [
      [42, 0],
      [-42, 0],
      [0, -32],
      [42, 0],
      [-42, 0],
      [0, -32],
    ]);
    d.run(end, end + 60);
    const eps = d.final('repeated_looking_away');
    expect(eps).toHaveLength(1);
    expect(d.of('offscreen_attention_pattern')).toHaveLength(0);
    expect(d.of('looking_away')).toHaveLength(0);
    near(rel(eps[0].startedAt), 10, 0.01);
    // Last glance: starts at 10 + 5*12 = 70, lasts 2 s.
    near(rel(eps[0].endedAt), 72, 0.3);
    expect(eps[0].details.count).toBe(6);
    const g = eps[0].details.glances as { at: number; durationSec: number; direction: string }[];
    expect(g).toHaveLength(6);
    expect(g[0].direction).toBe('left');
    expect(g[1].direction).toBe('right');
    expect(g[2].direction).toBe('down');
    for (const x of g) expect(x.durationSec).toBeGreaterThanOrEqual(1.9);
    // Opened when the 5th glance qualified (58 + 1.2 s), while the candidate was still looking away.
    near(d.openedAt('repeated_looking_away'), 59.2, 0.3);
  });

  it('4 glances are not enough (repeatedLookAwayCount = 5)', () => {
    const d = new Driver();
    const end = glances(d, [
      [42, 0],
      [-42, 0],
      [0, -32],
      [-42, 0],
    ]);
    d.run(end, end + 30);
    expect(d.of('repeated_looking_away')).toHaveLength(0);
  });

  it('same-direction glances → offscreen_attention_pattern (more specific; not double-reported)', () => {
    const d = new Driver();
    const end = glances(
      d,
      [
        [22, -30],
        [24, -34],
        [20, -32],
        [23, -35],
        [22, -31],
      ],
      15,
    );
    d.run(end, end + 80);
    const eps = d.final('offscreen_attention_pattern');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.direction).toBe('down_left');
    expect(eps[0].details.count).toBe(5);
    expect(d.of('repeated_looking_away')).toHaveLength(0);
    near(rel(eps[0].startedAt), 10, 0.01);
    const peaks = d.of('offscreen_attention_pattern').filter((u) => u.captureSnapshot === 'peak');
    expect(peaks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('unusual_movement', () => {
  it('repeated short exits (too short for candidate_absent) within the window', () => {
    const d = new Driver();
    d.run(0, 10);
    let t = 10;
    for (let i = 0; i < 4; i++) {
      d.run(t, t + 3.5, () => ({ faces: [] }));
      d.run(t + 3.5, t + 30);
      t += 30;
    }
    d.run(t, t + 120);
    expect(d.of('candidate_absent')).toHaveLength(0);
    const eps = d.final('unusual_movement');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    // Third exit starts at 70; counted once it lasted 2 s.
    near(d.openedAt('unusual_movement'), 72, 0.3);
    near(rel(eps[0].endedAt), 103.5, 0.3);
    expect(eps[0].details.exitCount).toBe(4);
    expect(eps[0].details.reasons).toEqual(['repeated_exits']);
  });

  it('far from the baseline position for ≥ farFromBaselineSec', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 30, () => ({ faces: [face({ box: { x: 0.72, y: 0.24, w: 0.26, h: 0.4 } })] }));
    d.run(30, 40);
    const eps = d.final('unusual_movement');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.reasons).toEqual(['far_from_baseline']);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 30, 0.01);
    near(d.openedAt('unusual_movement'), 25, 0.3);
  });

  it('a single long absence is not unusual movement', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 30, () => ({ faces: [] }));
    d.run(30, 60);
    expect(d.of('unusual_movement')).toHaveLength(0);
    expect(d.final('candidate_absent')).toHaveLength(1);
  });
});

describe('face_obstructed', () => {
  it('face cut off at the edge for ≥ obstructionSec; identity sample after it ends', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 17, () => ({ faces: [face({ cutOff: true, visibility: 0.7 })] }));
    d.run(17, 22);
    const eps = d.final('face_obstructed');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.reason).toBe('cut_off');
    near(d.openedAt('face_obstructed'), 11, 0.3);
    expect(d.identity('after_obstruction')).toHaveLength(1);
  });

  it('low visibility (covered face) flags; lighting problems are reported as lighting instead', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 15, () => ({ faces: [face({ visibility: 0.3 })] }));
    d.run(15, 20);
    expect(d.final('face_obstructed')[0].details.reason).toBe('low_visibility');
    const dark = new Driver();
    dark.run(0, 5);
    dark.run(5, 25, () => ({ faces: [face({ visibility: 0.35, brightness: 28 })], frame: frame({ luma: 26, contrast: 12 }) }));
    dark.run(25, 30);
    expect(dark.of('face_obstructed')).toHaveLength(0);
    expect(dark.final('lighting_unusable')).toHaveLength(1);
  });
});

describe('objects', () => {
  const phone = (score = 0.7) => [{ label: 'cell phone', score, box: { x: 0.2, y: 0.6, w: 0.1, h: 0.15 } }];

  it('phone visible over several detector ticks → phone_detected; null ticks are not absence', () => {
    const d = new Driver();
    d.run(0, 10, (_s, i) => ({ objects: i % 5 === 0 ? [] : null }));
    d.run(10, 15, (_s, i) => ({ objects: i % 5 === 0 ? phone(0.72) : null }));
    d.run(15, 25, (_s, i) => ({ objects: i % 5 === 0 ? [] : null }));
    const eps = d.final('phone_detected');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 15, 0.01);
    near(d.openedAt('phone_detected'), 12, 0.01);
    expect(eps[0].details.label).toBe('cell phone');
    expect(eps[0].details.maxScore).toBe(0.72);
    expect(d.prompts('phone_visible').map((p) => p.kind)).toEqual(['candidate_prompt', 'candidate_prompt_clear']);
  });

  it('single-tick detections (even two, 2 s apart) and sub-threshold scores do not flag', () => {
    const d = new Driver();
    d.run(0, 30, (s, i) => ({ objects: i % 5 === 0 ? (Math.abs(s - 10) < 0.01 || Math.abs(s - 12) < 0.01 ? phone() : Math.abs(s - 20) < 0.01 ? phone() : []) : null }));
    d.run(30, 40, (_s, i) => ({ objects: i % 5 === 0 ? phone(0.4) : null }));
    expect(d.of('phone_detected')).toHaveLength(0);
  });

  it('one missed detection inside a visible period is tolerated (one event)', () => {
    const d = new Driver();
    d.run(0, 20, (s, i) => ({ objects: i % 5 === 0 ? (s >= 5 && s < 15 && Math.abs(s - 9) > 0.01 ? phone() : []) : null }));
    expect(d.ids('phone_detected')).toHaveLength(1);
  });

  it('book / laptop / tv → unauthorized_object with the label', () => {
    const d = new Driver();
    d.run(0, 20, (s, i) => ({ objects: i % 5 === 0 ? (s >= 5 && s < 12 ? [{ label: 'book', score: 0.8, box: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 } }] : []) : null }));
    const eps = d.final('unauthorized_object');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.label).toBe('book');
    // 'book' below objectMinConfidence (0.6) is ignored.
    const low = new Driver();
    low.run(0, 20, (_s, i) => ({ objects: i % 5 === 0 ? [{ label: 'book', score: 0.5, box: { x: 0.1, y: 0.6, w: 0.2, h: 0.2 } }] : null }));
    expect(low.of('unauthorized_object')).toHaveLength(0);
  });

  it('respects enabled.objects = false', () => {
    const d = new Driver({ policy: policy({ enabled: { ...policy().enabled, objects: false } }) });
    d.run(0, 20, (_s, i) => ({ objects: i % 5 === 0 ? phone() : null }));
    expect(d.of('phone_detected')).toHaveLength(0);
  });
});

describe('camera integrity', () => {
  it('frozen feed (identical frames) flags after frozenSec; a still scene with sensor noise does not', () => {
    const d = new Driver();
    d.run(0, 5, () => ({ frame: frame({ dhash: 'aaaaaaaaaaaaaaaa' }) }));
    d.run(5, 20, () => ({ frame: frame({ dhash: 'aaaaaaaaaaaaaaaa', diffFromPrev: 0 }) }));
    d.run(20, 25, () => ({ frame: frame({ dhash: 'aaaaaaaaaaaaaaab' }) }));
    const eps = d.final('camera_frozen');
    expect(eps).toHaveLength(1);
    near(d.openedAt('camera_frozen'), 11, 0.3);
    near(rel(eps[0].endedAt), 20, 0.01);
    const still = new Driver();
    still.run(0, 60, () => ({ frame: frame({ dhash: 'aaaaaaaaaaaaaaaa', diffFromPrev: 0.8 }) }));
    expect(still.of('camera_frozen')).toHaveLength(0);
  });

  it('dark frame → lighting_unusable (too_dark) after lightingSec; a one-frame dark frame does nothing', () => {
    const d = new Driver();
    d.run(0, 5);
    d.tick(5, { frame: frame({ luma: 5, contrast: 1 }), faces: [] });
    d.run(5.2, 10);
    d.run(10, 25, () => ({ frame: frame({ luma: 28, contrast: 14 }), faces: [face({ brightness: 30 })] }));
    d.run(25, 30);
    const eps = d.final('lighting_unusable');
    expect(eps).toHaveLength(1);
    expect(eps[0].details.condition).toBe('too_dark');
    near(d.openedAt('lighting_unusable'), 20, 0.3);
    expect(d.of('camera_covered')).toHaveLength(0);
    expect(d.of('candidate_absent')).toHaveLength(0);
    expect(d.prompts('too_dark')[0]?.kind).toBe('candidate_prompt');
  });

  it('camera disconnect ≥ 2 s → camera_disconnected; closes on return with a camera_reconnect sample', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 20, () => ({ camera: 'ended', frame: null, faces: [] }));
    d.run(20, 30);
    const eps = d.final('camera_disconnected');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 20, 0.01);
    near(d.openedAt('camera_disconnected'), 12, 0.01);
    expect(d.of('candidate_absent')).toHaveLength(0);
    const rc = d.identity('camera_reconnect');
    expect(rc).toHaveLength(1);
    expect(rc[0].at).toBeGreaterThanOrEqual(20);
    expect(d.engine.status().state).toBe('ok');
  });

  it('sparse ticks: the host only reports the change and the recovery', () => {
    const d = new Driver();
    d.run(0, 10);
    d.tick(10, { camera: 'muted', frame: null, faces: [] });
    d.tick(40, {});
    const eps = d.final('camera_disconnected');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
    near(rel(eps[0].endedAt), 40, 0.01);
  });

  it('permission lost', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 20, () => ({ camera: 'no_permission', frame: null, faces: [] }));
    expect(d.engine.status().state).toBe('off');
    d.run(20, 25);
    expect(d.final('camera_permission_lost')).toHaveLength(1);
  });

  it('low analysis throughput → monitoring_degraded', () => {
    const d = new Driver();
    d.run(0, 10);
    d.run(10, 40, () => ({ fps: 1 }), 1);
    d.run(40, 50);
    const eps = d.final('monitoring_degraded');
    expect(eps).toHaveLength(1);
    near(rel(eps[0].startedAt), 10, 0.01);
  });
});

describe('camera feed', () => {
  it('virtual camera label opens immediately and closes when the camera changes; camera_changed marker', () => {
    const d = new Driver();
    const o = d.cameraInfo(0, 'OBS Virtual Camera', 'hash-obs');
    expect(o.episodes).toHaveLength(1);
    expect(o.episodes[0]).toMatchObject({ type: 'camera_feed_suspect', phase: 'open', details: { signal: 'virtual_camera_label' } });
    d.run(0, 10);
    const c = d.cameraInfo(10, 'Integrated Camera', 'hash-int');
    const types = c.episodes.map((u) => `${u.type}:${u.phase}`);
    expect(types).toContain('camera_feed_suspect:close');
    expect(types).toContain('camera_changed:close');
    const marker = c.episodes.find((u) => u.type === 'camera_changed')!;
    expect(marker.startedAt).toBe(marker.endedAt);
    expect(marker.version).toBe(1);
    d.run(10, 15);
    expect(d.identity('camera_reconnect')).toHaveLength(1);
  });

  it('first setCameraInfo is not a change; a phone-as-webcam app is flagged with lower confidence', () => {
    const d = new Driver();
    const o = d.cameraInfo(0, 'DroidCam Source 3', 'hash-droid');
    expect(o.episodes.filter((u) => u.type === 'camera_changed')).toHaveLength(0);
    const e = o.episodes.find((u) => u.type === 'camera_feed_suspect')!;
    expect(e.confidence).toBeLessThan(0.6);
  });

  it('replayed footage is detected; a still scene with noise is not', () => {
    const replay = synthesize({ seed: 3, durationSec: 240, segments: [{ kind: 'replay', start: 60, end: 240, loopSec: 20 }] });
    const r = replayTrace(replay.observations);
    const sus = r.preds.filter((p) => p.type === 'camera_feed_suspect');
    expect(sus).toHaveLength(1);
    expect(sus[0].details.signal).toBe('repeating_footage');
    expect(sus[0].startedAt).toBeGreaterThanOrEqual(replay.t0 + 60_000);
    const still = synthesize({ seed: 3, durationSec: 300, noise: { briefGlancePerMin: 0 }, segments: [{ kind: 'still', start: 0, end: 300 }] });
    const s = replayTrace(still.observations);
    expect(s.preds.filter((p) => p.type === 'camera_feed_suspect' || p.type === 'camera_frozen')).toHaveLength(0);
  });
});

describe('baseline recalibration and policy switches', () => {
  it('after a camera change the engine re-calibrates the normal position from steady frames', () => {
    const d = new Driver();
    d.cameraInfo(0, 'Integrated Camera', 'a');
    d.run(0, 5);
    d.cameraInfo(5, 'USB Camera', 'b');
    // New camera is mounted to the side: the candidate's normal yaw is now ~30°.
    d.run(5, 40, () => ({ faces: [face({ yaw: 30 })] }));
    expect(d.engine.getBaseline()!.yaw).toBeCloseTo(30, 0);
    const noRecal = new Driver({ recalibrateOnCameraChange: false });
    noRecal.cameraInfo(0, 'Integrated Camera', 'a');
    noRecal.cameraInfo(5, 'USB Camera', 'b');
    noRecal.run(5, 40, () => ({ faces: [face({ yaw: 30 })] }));
    expect(noRecal.engine.getBaseline()!.yaw).toBe(BASELINE.yaw);
    expect(noRecal.final('looking_away')).toHaveLength(1);
  });

  it('respects enabled.* switches', () => {
    const p = policy({ enabled: { absence: false, multiplePeople: false, lookingAway: false, movement: true, obstruction: true, objects: true, cameraIntegrity: false } });
    const d = new Driver({ policy: p });
    d.run(0, 5);
    d.run(5, 20, () => ({ faces: [] }));
    d.run(20, 30, () => ({ faces: [face({ yaw: 45 }), secondFace()] }));
    d.run(30, 45, () => ({ frame: frame({ luma: 8, contrast: 2 }), faces: [] }));
    for (const t of ['candidate_absent', 'multiple_people', 'looking_away', 'camera_covered'] as const) expect(d.of(t)).toHaveLength(0);
    expect(d.cameraInfo(50, 'OBS Virtual Camera', 'x').episodes.filter((u) => u.type === 'camera_feed_suspect')).toHaveLength(0);
  });

  it('respects policy thresholds (absenceSec, multiplePeopleSec)', () => {
    const d = new Driver({ policy: policy({ absenceSec: 4, multiplePeopleSec: 3 }) });
    d.run(0, 5);
    d.run(5, 10, () => ({ faces: [] }));
    d.run(10, 15);
    d.run(15, 17, () => ({ faces: [face(), secondFace()] }));
    d.run(17, 20);
    expect(d.final('candidate_absent')).toHaveLength(1);
    expect(d.of('multiple_people')).toHaveLength(0);
  });
});

describe('identity sampling', () => {
  it('periodic samples every identityIntervalSec while exactly one usable face is visible', () => {
    const d = new Driver({ identityIntervalSec: 20 });
    d.run(0, 65);
    const p = d.identity('periodic');
    expect(p.map((x) => Math.round(x.at))).toEqual([20, 40, 60]);
  });

  it('periodic samples wait while there is no usable single face', () => {
    const d = new Driver({ identityIntervalSec: 20 });
    d.run(0, 18);
    d.run(18, 26, () => ({ faces: [face({ yaw: 45 })] }));
    d.run(26, 30);
    const p = d.identity('periodic');
    expect(p).toHaveLength(1);
    expect(p[0].at).toBeGreaterThanOrEqual(26.5);
  });
});

describe('flush and status', () => {
  it('flush closes open episodes with closedBy, clears prompts, and nothing merges across it', () => {
    const d = new Driver();
    d.run(0, 5);
    d.run(5, 16, () => ({ faces: [] }));
    const f = d.flush(16, 'pause');
    const closed = f.episodes.find((u) => u.type === 'candidate_absent')!;
    expect(closed.phase).toBe('close');
    expect(closed.details.closedBy).toBe('pause');
    near(rel(closed.endedAt), 16, 0.01);
    expect(f.signals.some((s) => s.kind === 'candidate_prompt_clear' && s.key === 'face_not_visible')).toBe(true);
    expect(d.engine.status().state).toBe('off');
    d.run(20, 25);
    d.run(25, 36, () => ({ faces: [] }));
    d.run(36, 40);
    expect(d.ids('candidate_absent')).toHaveLength(2);
  });

  it('status reflects the situation', () => {
    const d = new Driver();
    expect(d.engine.status().state).toBe('off');
    d.run(0, 5);
    expect(d.engine.status()).toMatchObject({ state: 'ok', faces: 1, label: 'Candidate in view', open: [] });
    d.run(5, 17, () => ({ faces: [] }));
    const s = d.engine.status();
    expect(s.state).toBe('attention');
    expect(s.label).toMatch(/^No face visible \(1[12] s\)$/);
    expect(s.open).toContain('candidate_absent');
    d.run(17, 25, () => ({ faces: [face(), secondFace()] }));
    expect(d.engine.status().label).toBe('2 people in view');
    d.run(25, 40);
    d.run(40, 50, () => ({ faces: [face({ yaw: 40 })] }));
    expect(d.engine.status().lookDirection).toBe('left');
    d.run(50, 55, () => ({ camera: 'ended', frame: null, faces: [] }));
    expect(d.engine.status().state).toBe('off');
  });

  it('baseline defaults until set; getBaseline returns a copy', () => {
    const d = new Driver({ baseline: null });
    expect(d.engine.getBaseline()).toBeNull();
    d.engine.setBaseline(BASELINE);
    const b = d.engine.getBaseline()!;
    b.yaw = 99;
    expect(d.engine.getBaseline()!.yaw).toBe(BASELINE.yaw);
  });

  it('ignores out-of-order observations', () => {
    const d = new Driver();
    d.run(0, 5);
    const out = d.engine.ingest({ t: ms(1), camera: 'live', frame: frame(), faces: [], objects: null });
    expect(out.episodes).toHaveLength(0);
  });

  it('every emitted update has a UUID-shaped id, version ≥ 1 and confidence in [0,1]', () => {
    const d = new Driver({ idFactory: undefined });
    d.run(0, 5);
    d.run(5, 20, () => ({ faces: [] }));
    d.run(20, 25);
    for (const { update } of d.updates) {
      expect(update.episodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(update.version).toBeGreaterThanOrEqual(1);
      expect(update.confidence).toBeGreaterThanOrEqual(0);
      expect(update.confidence).toBeLessThanOrEqual(1);
      if (update.observation) expect(update.observation.length).toBeLessThanOrEqual(500);
    }
  });
});
