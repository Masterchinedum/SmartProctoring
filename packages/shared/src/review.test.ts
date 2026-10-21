import { describe, expect, it } from 'vitest';
import { EVENT_CATALOG, type EventType } from './events';
import { explainEvent, secText, type ExplainEventInput } from './explain';
import { groupIncidents, incidentOf, INCIDENT_GAP_MS, type IncidentEventInput } from './incidents';
import { bulkReviewEligible, RESOLUTION_INFO, resolutionsFor, REVIEW_RESOLUTIONS, reviewDecisionLabel, reviewRequestSchema } from './review';

const T0 = Date.parse('2026-10-01T09:00:00Z');

describe('review resolutions', () => {
  it('each implies a status; only a false detection dismisses; inconclusive says nothing about the detector', () => {
    for (const r of REVIEW_RESOLUTIONS) expect(RESOLUTION_INFO[r].status).toBe(r === 'false_detection' ? 'dismissed' : 'reviewed');
    expect(RESOLUTION_INFO.inconclusive.detectionCorrect).toBeNull();
    expect(RESOLUTION_INFO.false_detection.detectionCorrect).toBe(false);
    expect(REVIEW_RESOLUTIONS.filter((r) => RESOLUTION_INFO[r].detectionCorrect === true)).toEqual(['concern', 'no_concern', 'accommodation', 'technical']);
  });

  it('offers resolutions per category: none for session changes or exceptions, no “concern” for technical problems', () => {
    expect(resolutionsFor('integrity')).toEqual(REVIEW_RESOLUTIONS);
    expect(resolutionsFor('technical')).not.toContain('concern');
    expect(resolutionsFor('neutral')).toEqual([]);
    expect(resolutionsFor('exception')).toEqual([]);
  });

  it('accepts a resolution or a plain status (older clients), never contradicting ones', () => {
    expect(reviewRequestSchema.parse({ resolution: 'no_concern' })).toEqual({ resolution: 'no_concern' });
    expect(reviewRequestSchema.parse({ status: 'dismissed' })).toEqual({ status: 'dismissed' });
    expect(reviewRequestSchema.parse({ status: 'dismissed', resolution: 'false_detection' })).toMatchObject({ resolution: 'false_detection' });
    expect(reviewRequestSchema.safeParse({ status: 'reviewed', resolution: 'false_detection' }).success).toBe(false);
    expect(reviewRequestSchema.safeParse({ note: 'x' }).success).toBe(false);
    expect(reviewRequestSchema.safeParse({ resolution: 'guilty' }).success).toBe(false);
  });

  it('labels decisions and limits bulk decisions to technical problems and low severity', () => {
    expect(reviewDecisionLabel('reviewed', 'accommodation')).toBe('Covered by an accommodation');
    expect(reviewDecisionLabel('dismissed', null)).toBe('Dismissed');
    expect(reviewDecisionLabel('unreviewed', null)).toBe('Not reviewed');
    expect(bulkReviewEligible({ category: 'technical', severity: 'medium' })).toBe(true);
    expect(bulkReviewEligible({ category: 'integrity', severity: 'low' })).toBe(true);
    expect(bulkReviewEligible({ category: 'integrity', severity: 'medium' })).toBe(false);
    expect(bulkReviewEligible({ category: 'uncertain', severity: 'medium' })).toBe(false);
  });
});

let n = 0;
function ev(type: EventType, startSec: number, endSec: number | null, review: 'unreviewed' | 'reviewed' | 'dismissed' = 'unreviewed'): IncidentEventInput & ExplainEventInput {
  const c = EVENT_CATALOG[type];
  return {
    id: `e${String(++n).padStart(3, '0')}`,
    type,
    category: c.category,
    severity: c.severity,
    startedAt: T0 + startSec * 1000,
    endedAt: endSec == null ? null : T0 + endSec * 1000,
    durationMs: endSec == null ? null : (endSec - startSec) * 1000,
    confidence: 0.8,
    details: {},
    context: {},
    review: { status: review },
  };
}

describe('incidents', () => {
  it('groups overlapping and nearby flags, keeps distant ones apart, and ignores session changes', () => {
    const phone = ev('phone_detected', 100, 110);
    const look1 = ev('looking_away', 112, 120, 'reviewed');
    const look2 = ev('looking_away', 140, 150); // 20 s after the previous end: same incident
    const dark = ev('lighting_unusable', 145, 200);
    const paused = ev('session_paused', 120, null);
    const later = ev('tab_hidden', 200 + INCIDENT_GAP_MS / 1000 + 1, 240);
    const inc = groupIncidents([later, dark, paused, look2, phone, look1], { now: T0 + 1_000_000 });
    expect(inc).toHaveLength(2);
    expect(inc[0]).toMatchObject({
      id: phone.id,
      startedAt: phone.startedAt,
      endedAt: dark.endedAt,
      category: 'integrity',
      severity: 'high',
      eventIds: [phone.id, look1.id, look2.id, dark.id],
      types: [
        { type: 'phone_detected', count: 1 },
        { type: 'looking_away', count: 2 },
        { type: 'lighting_unusable', count: 1 },
      ],
      title: 'Phone visible · Sustained looking away ×2 · Lighting too poor to assess',
      undecided: 3,
      open: false,
    });
    expect(inc[1]).toMatchObject({ eventIds: [later.id], category: 'integrity', severity: 'medium' });
    expect(incidentOf(inc, look2.id)?.id).toBe(phone.id);
    expect(incidentOf(inc, paused.id)).toBeNull();
  });

  it('extends an incident to now while an event is open; a technical-only incident is technical', () => {
    const cam = ev('camera_disconnected', 0, null);
    const now = T0 + 90_000;
    const [i] = groupIncidents([cam, ev('reporting_interrupted', 50, 80)], { now });
    expect(i).toMatchObject({ category: 'technical', open: true, endedAt: now });
  });

  it('does not let a long-running condition chain every later flag into one incident', () => {
    const dark = ev('lighting_unusable', 0, 600); // ten minutes of poor light
    const early = ev('looking_away', 20, 30);
    const later = ev('phone_detected', 300, 305);
    const inc = groupIncidents([dark, early, later], { now: T0 + 3_600_000 });
    expect(inc.map((i) => i.eventIds)).toEqual([[dark.id, early.id], [later.id]]);
    expect(inc[0].endedAt).toBe(dark.endedAt); // still shows how long the condition lasted
  });

  it('is deterministic regardless of input order', () => {
    const list = [ev('candidate_absent', 0, 20), ev('multiple_people', 5, 9), ev('tab_hidden', 500, 510)];
    const a = groupIncidents(list, { now: T0 });
    const b = groupIncidents([...list].reverse(), { now: T0 });
    expect(b).toEqual(a);
  });
});

describe('event explanations', () => {
  it('states the rule with this exam’s settings and what was measured', () => {
    const e = { ...ev('looking_away', 0, 9), details: { durationSec: 9, direction: 'down_left', maxYawOffsetDeg: 31.4, maxPitchOffsetDeg: 22 } };
    const x = explainEvent(e, { policy: { detection: { lookAwaySec: 7 } as never, browser: {} as never, connection: {} as never }, now: T0 });
    expect(x.rule).toContain('at least 7 s');
    expect(x.rule).toContain('own normal position');
    expect(x.measured).toEqual(['Lasted 9 s.', 'Direction: down and to the left.', 'Largest turn from the normal position: 31° sideways, 22° up/down (limits 28° sideways, 20° down, 35° up).']);
    expect(x.confidence).toEqual({ value: 0.8, label: 'High' });
  });

  it('weakens camera observations made in poor light or with degraded monitoring, and names coinciding flags', () => {
    const phone = { ...ev('phone_detected', 10, 20), details: { maxScore: 0.55, meanScore: 0.52, detections: 6, detectorRuns: 10 } };
    const dark = ev('lighting_unusable', 0, 30);
    const away = ev('looking_away', 15, 25);
    const x = explainEvent(phone, { events: [phone, dark, away], now: T0 });
    expect(x.measured).toContain('Seen in 6 of 10 detector runs (60 %).');
    expect(x.factors).toEqual(
      expect.arrayContaining([
        { effect: 'weakens', text: 'The detector score stayed close to the minimum; similar-looking objects are a common cause.' },
        { effect: 'weakens', text: 'Lighting too poor to assess at the same time: camera observations in this period are less reliable.' },
        { effect: 'supports', text: 'Also observed at the same time: sustained looking away.' },
      ]),
    );
  });

  it('names accommodations that can explain an observation', () => {
    const x = explainEvent(ev('multiple_people', 0, 5), { accommodations: [{ kind: 'support_person', params: { role: 'reader' } }], now: T0 });
    expect(x.factors).toContainEqual({ effect: 'explains', text: 'An approved support person (reader) may be with the candidate (accommodation).' });
    const y = explainEvent(ev('tab_hidden', 0, 5), { accommodations: [{ kind: 'assistive_technology' }], now: T0 });
    expect(y.factors.some((f) => f.effect === 'explains' && /Assistive technology/.test(f.text))).toBe(true);
    expect(explainEvent(ev('phone_detected', 0, 5), { accommodations: [{ kind: 'assistive_technology' }], now: T0 }).factors.some((f) => f.effect === 'explains')).toBe(false);
  });

  it('explains identity decisions from the sequential evidence and never treats poor images as a different person', () => {
    const mm = {
      ...ev('identity_mismatch', 0, null),
      details: { against: 'reference', samples: 3, windowSamples: 4, minSimilarity: 0.12, maxSimilarity: 0.21, posterior: 0.993, thresholds: { match: 0.42, mismatch: 0.24 }, secondOpinion: { decision: 'match', provider: 'aws_rekognition' } },
      context: { precededBy: ['session_resumed'] },
    };
    const x = explainEvent(mm, { now: T0 });
    expect(x.rule).toMatch(/a single poor frame never does/);
    expect(x.measured).toEqual(['3 of 4 recent samples did not match the identity reference (similarity 0.12–0.21; the same person usually ≥ 0.42).', 'Combined evidence: 99 % probability of a different person under the calibration.']);
    expect(x.factors).toContainEqual({ effect: 'weakens', text: 'Second opinion (aws_rekognition): the same person.' });
    expect(x.factors).toContainEqual({ effect: 'context', text: 'Shortly after the exam resumed from a pause.' });
    const u = explainEvent({ ...ev('identity_unverifiable', 0, 10), details: { samples: 4, issues: ['too_dark', 'face_too_small', 'too_dark'] } }, { now: T0 });
    expect(u.measured).toContain('Image problems: too dark, face too small (too far away).');
    expect(u.notConcluded).toMatch(/never treated as evidence of a different person/);
  });

  it('marks late deliveries and formats durations', () => {
    expect(explainEvent({ ...ev('tab_hidden', 0, 4), deliveredLate: true }, { now: T0 }).factors).toContainEqual({ effect: 'context', text: 'Delivered late after a connection problem; the times shown are when it happened.' });
    expect(secText(4.04)).toBe('4 s');
    expect(secText(120)).toBe('2 min');
    expect(secText(125)).toBe('2 min 5 s');
  });
});
