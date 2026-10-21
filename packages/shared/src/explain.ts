/**
 * Plain-language explanations of events for reviewers: which rule recorded it (with this exam's settings), what
 * was measured, what makes it more or less reliable (poor light, degraded monitoring, a second opinion, a late
 * delivery), what an approved accommodation may explain, and — for uncertain observations — why the system did
 * not conclude more.
 *
 * Pure: built from the event, the session's frozen exam rules and the session's other events, so the staff app and
 * the printed report explain an event identically. Wording follows the catalog rule: describe what was observed,
 * never conclude misconduct.
 */
import type { AccommodationKind } from './accommodations';
import { EVENT_CATALOG, type EventCategory, type EventType, type Severity } from './events';
import type { QualityIssue } from './identity';
import { browserPolicySchema, connectionPolicySchema, detectionPolicySchema, type ProctoringPolicy } from './policy';

export interface ExplainEventInput {
  id: string;
  type: EventType;
  category: EventCategory;
  severity: Severity;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  confidence: number | null;
  details: Record<string, unknown>;
  context: Record<string, unknown>;
  deliveredLate?: boolean;
}

export interface ExplanationFactor {
  /** supports: makes the observation more reliable; weakens: less reliable; explains: an innocent explanation on record; context: neutral background. */
  effect: 'supports' | 'weakens' | 'explains' | 'context';
  text: string;
}

export interface EventExplanation {
  /** The rule that recorded it, with this exam's settings. */
  rule: string | null;
  /** What was measured. */
  measured: string[];
  factors: ExplanationFactor[];
  /** Why the system did not conclude more (uncertain observations): what this is NOT. */
  notConcluded: string | null;
  confidence: { value: number; label: 'High' | 'Moderate' | 'Low' } | null;
}

export interface ExplainContext {
  /** The session's resolved exam rules (frozen at start); defaults when unknown. */
  policy?: Pick<ProctoringPolicy, 'detection' | 'browser' | 'connection'> | null;
  /** The session's other events (for coinciding conditions). */
  events?: readonly ExplainEventInput[];
  /** Approved accommodations applied to the session. */
  accommodations?: readonly { kind: AccommodationKind; params?: Record<string, unknown> }[];
  now?: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** "8 s", "2 min", "2 min 5 s". */
export function secText(sec: number): string {
  const s = Math.round(sec * 10) / 10;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}
const pct = (x: number) => `${Math.round(x * 100)} %`;
const sim = (x: number) => x.toFixed(2);
const DIRECTION: Record<string, string> = {
  left: 'to the left',
  right: 'to the right',
  up: 'upwards',
  down: 'downwards',
  down_left: 'down and to the left',
  down_right: 'down and to the right',
  up_left: 'up and to the left',
  up_right: 'up and to the right',
};
const dirText = (d: unknown) => DIRECTION[String(d)] ?? String(d);
const ISSUE: Record<QualityIssue, string> = {
  no_face: 'no face found',
  multiple_faces: 'more than one face',
  face_too_small: 'face too small (too far away)',
  face_cut_off: 'face partly outside the picture',
  too_dark: 'too dark',
  too_bright: 'too bright',
  low_contrast: 'low contrast (uneven light)',
  blurry: 'blurred',
  face_turned: 'face turned away',
  low_detection_confidence: 'face unclear',
  low_detail: 'too little detail (low resolution or heavy compression)',
};
const issuesText = (v: unknown) =>
  Array.isArray(v) && v.length ? [...new Set(v.map((i) => ISSUE[i as QualityIssue] ?? String(i).replace(/_/g, ' ')))].join(', ') : null;

function confidenceOf(c: number | null): EventExplanation['confidence'] {
  if (c == null) return null;
  return { value: c, label: c >= 0.8 ? 'High' : c >= 0.6 ? 'Moderate' : 'Low' };
}

function overlaps(a: ExplainEventInput, b: ExplainEventInput, now: number): boolean {
  const aEnd = a.endedAt ?? now;
  const bEnd = b.endedAt ?? now;
  return a.startedAt <= bEnd && b.startedAt <= aEnd;
}

/** Event types whose reliability poor light / obstruction / degraded monitoring reduces (camera analysis). */
const CAMERA_BASED = new Set<EventType>([
  'identity_mismatch',
  'multiple_people',
  'candidate_absent',
  'looking_away',
  'repeated_looking_away',
  'offscreen_attention_pattern',
  'unusual_movement',
  'phone_detected',
  'unauthorized_object',
]);

/** Accommodations that can innocently explain an observation. */
function accommodationFactors(type: EventType, acc: ExplainContext['accommodations']): ExplanationFactor[] {
  const out: ExplanationFactor[] = [];
  for (const a of acc ?? []) {
    if (a.kind === 'support_person' && (type === 'multiple_people' || type === 'looking_away' || type === 'repeated_looking_away' || type === 'offscreen_attention_pattern')) {
      const role = str(a.params?.role);
      out.push({ effect: 'explains', text: `An approved support person${role ? ` (${role})` : ''} may be with the candidate (accommodation).` });
    }
    if (
      a.kind === 'assistive_technology' &&
      (type === 'tab_hidden' || type === 'window_unfocused' || type === 'fullscreen_exited' || type === 'clipboard_attempt' || type === 'looking_away' || type === 'repeated_looking_away' || type === 'offscreen_attention_pattern')
    ) {
      out.push({ effect: 'explains', text: 'Assistive technology is approved for this candidate (accommodation); screen readers, magnifiers or dictation software can cause this.' });
    }
  }
  return out;
}

function coincidingFactors(ev: ExplainEventInput, ctx: ExplainContext, now: number): ExplanationFactor[] {
  const out: ExplanationFactor[] = [];
  const others = (ctx.events ?? []).filter((o) => o.id !== ev.id && overlaps(ev, o, now));
  const seen = new Set<EventType>();
  for (const o of others) {
    if (seen.has(o.type)) continue;
    seen.add(o.type);
    const title = EVENT_CATALOG[o.type]?.title ?? o.type;
    if (CAMERA_BASED.has(ev.type) && (o.type === 'lighting_unusable' || o.type === 'face_obstructed' || o.type === 'monitoring_degraded' || o.type === 'camera_frozen')) {
      out.push({ effect: 'weakens', text: `${title} at the same time: camera observations in this period are less reliable.` });
    } else if (o.type === 'camera_disconnected' || o.type === 'camera_permission_lost' || o.type === 'reporting_interrupted') {
      out.push({ effect: 'weakens', text: `${title} at the same time: a technical problem may explain part of this.` });
    } else if (o.category === 'integrity' && ev.category !== 'technical') {
      out.push({ effect: 'supports', text: `Also observed at the same time: ${title.toLowerCase()}.` });
    }
  }
  return out;
}

function ruleFor(ev: ExplainEventInput, ctx: ExplainContext): { rule: string | null; measured: string[]; factors: ExplanationFactor[]; notConcluded: string | null } {
  const det = detectionPolicySchema.parse(ctx.policy?.detection ?? {});
  const br = browserPolicySchema.parse(ctx.policy?.browser ?? {});
  const conn = connectionPolicySchema.parse(ctx.policy?.connection ?? {});
  const d = ev.details ?? {};
  const measured: string[] = [];
  const factors: ExplanationFactor[] = [];
  const duration = num(d.durationSec) ?? (ev.durationMs != null ? ev.durationMs / 1000 : null);
  const lasted = duration != null ? `Lasted ${secText(duration)}${ev.endedAt == null ? ' so far' : ''}.` : null;
  if (lasted && EVENT_CATALOG[ev.type]?.span) measured.push(lasted);
  let rule: string | null = null;
  let notConcluded: string | null = null;

  switch (ev.type) {
    case 'looking_away': {
      rule = `Recorded when the head or gaze stays turned away from the screen for at least ${secText(det.lookAwaySec)} (looking up: ${secText(det.lookUpSec)}), measured against the candidate’s own normal position, not a fixed one. Glances shorter than ${secText(det.glanceMinSec)} are ignored.`;
      if (d.direction) measured.push(`Direction: ${dirText(d.direction)}.`);
      const yaw = num(d.maxYawOffsetDeg);
      const pitch = num(d.maxPitchOffsetDeg);
      if (yaw != null || pitch != null) measured.push(`Largest turn from the normal position: ${[yaw != null ? `${Math.round(yaw)}° sideways` : '', pitch != null ? `${Math.round(pitch)}° up/down` : ''].filter(Boolean).join(', ')} (limits ${det.lookAwayYawDeg}° sideways, ${det.lookDownPitchDeg}° down, ${det.lookUpPitchDeg}° up).`);
      if (det.typingExcuseSec > 0) factors.push({ effect: 'context', text: `Looking down at the keyboard within ${secText(det.typingExcuseSec)} of typing is never counted.` });
      break;
    }
    case 'repeated_looking_away': {
      rule = `Recorded when the candidate looks away ${det.repeatedLookAwayCount} or more times (each at least ${secText(det.glanceMinSec)}) within ${secText(det.repeatedLookAwayWindowSec)}. Each look on its own was too short to be recorded; the pattern is what was recorded.`;
      const n = num(d.count);
      if (n != null) measured.push(`${n} looks away within the window${num(d.maxGlanceSec) != null ? `, the longest ${secText(num(d.maxGlanceSec)!)}` : ''}.`);
      break;
    }
    case 'offscreen_attention_pattern': {
      rule = `Recorded when the candidate looks towards the same off-screen direction ${det.sameDirectionCount} or more times within ${secText(det.repeatedLookAwayWindowSec)}.`;
      const n = num(d.count);
      if (n != null) measured.push(`${n} looks ${dirText(d.direction)}.`);
      factors.push({ effect: 'context', text: 'The camera cannot show what was in that direction; the screenshots may.' });
      break;
    }
    case 'candidate_absent': {
      rule = `Recorded when no face is visible for at least ${secText(det.absenceSec)}.`;
      if (d.faceReturned === true) factors.push({ effect: 'context', text: 'A face returned afterwards; an identity check ran when it did (see the identity tab).' });
      break;
    }
    case 'multiple_people': {
      rule = `Recorded when a second face or person stays in view for at least ${secText(det.multiplePeopleSec)}.`;
      const faces = num(d.maxFaces);
      const persons = num(d.maxPersons);
      if (faces != null || persons != null) measured.push(`Up to ${Math.max(faces ?? 0, persons ?? 0)} people at once${Array.isArray(d.sources) && d.sources.length ? ` (found by: ${d.sources.join(', ').replace(/_/g, ' ')})` : ''}.`);
      factors.push({ effect: 'context', text: 'Photos, posters or reflections can be detected as faces; check the screenshot.' });
      break;
    }
    case 'phone_detected':
    case 'unauthorized_object': {
      const min = ev.type === 'phone_detected' ? det.phoneMinConfidence : det.objectMinConfidence;
      rule = `Recorded when the object detector finds ${ev.type === 'phone_detected' ? 'a phone' : `${str(d.label) ? `a ${d.label}` : 'such an object'}`} with a score of at least ${sim(min)} for ${secText(det.objectPersistSec)} or more.`;
      const max = num(d.maxScore);
      const hits = num(d.detections);
      const runs = num(d.detectorRuns);
      if (max != null) measured.push(`Highest detector score ${sim(max)}${num(d.meanScore) != null ? ` (average ${sim(num(d.meanScore)!)})` : ''}.`);
      if (hits != null && runs) measured.push(`Seen in ${hits} of ${runs} detector runs (${pct(hits / runs)}).`);
      if (max != null && max < min + 0.1) factors.push({ effect: 'weakens', text: 'The detector score stayed close to the minimum; similar-looking objects are a common cause.' });
      break;
    }
    case 'camera_covered':
      rule = `Recorded when the image stays almost uniformly dark or flat for at least ${secText(det.coveredSec)}, as if the lens were covered.`;
      break;
    case 'camera_frozen':
      rule = `Recorded when the camera image stops changing for at least ${secText(det.frozenSec)}.`;
      factors.push({ effect: 'context', text: 'A frozen image is usually a camera or driver problem; it matters more when it coincides with other events.' });
      break;
    case 'lighting_unusable':
      rule = `Recorded when the image is too dark or too bright for dependable analysis for at least ${secText(det.lightingSec)}.`;
      notConcluded = 'This is about image quality only. Other observations during this period are less reliable; it says nothing about the candidate’s conduct.';
      break;
    case 'face_obstructed':
      rule = `Recorded when the face is partly covered, cut off at the edge of the image or too unclear for at least ${secText(det.obstructionSec)}.`;
      notConcluded = 'While the face is unclear, looking away and identity cannot be assessed — no conclusion is drawn about this period.';
      break;
    case 'unusual_movement': {
      rule = `Recorded when the candidate leaves the view ${det.movementExitCount} or more times within ${secText(det.movementWindowSec)}, or stays far from their normal position for ${secText(det.farFromBaselineSec)}.`;
      const exits = num(d.exitCount);
      if (exits != null) measured.push(`${exits} times out of view within the window.`);
      break;
    }
    case 'camera_feed_suspect':
      if (d.signal === 'virtual_camera_label') {
        rule = 'Recorded when the camera’s device name matches known virtual-camera or screen-capture software.';
        if (str(d.cameraLabel)) measured.push(`Camera name: “${d.cameraLabel}”.`);
        factors.push({ effect: 'context', text: 'Some legitimate tools (e.g. camera vendor software) register virtual cameras; the name is shown so you can judge.' });
      } else if (d.signal === 'repeating_footage') {
        rule = 'Recorded when the video repeats itself exactly, as a replayed recording would.';
        if (num(d.repeatLagSec) != null) measured.push(`Footage repeated after ${secText(num(d.repeatLagSec)!)}.`);
      } else {
        rule = 'Recorded when the camera feed shows signs of being substituted.';
      }
      break;
    case 'tab_hidden':
      rule = br.flagTabHidden ? 'The browser reported that the exam page was hidden (another tab or application was in front, or the browser was minimised).' : null;
      factors.push({ effect: 'context', text: 'The browser does not tell us what was viewed instead.' });
      break;
    case 'window_unfocused':
      rule = `The browser reported that the exam window lost keyboard focus for at least ${secText(br.windowBlurMinSec)} while still visible.`;
      factors.push({ effect: 'context', text: 'System notifications and other windows taking focus are common causes.' });
      break;
    case 'fullscreen_exited':
      rule = 'The exam requires fullscreen and the browser left it.';
      break;
    case 'clipboard_attempt':
      rule = `A ${str(d.action) ?? 'copy, cut or paste'} action was attempted on the exam page${br.blockClipboard ? ' (blocked by the exam rules)' : ''}. Clipboard contents are never recorded.`;
      break;
    case 'multiple_instances':
      rule = 'Recorded when the same exam session is used from another browser or device while it is in progress.';
      if (str(d.signal)) measured.push(`Signal: ${String(d.signal).replace(/_/g, ' ')}.`);
      break;
    case 'identity_mismatch': {
      const t = (d.thresholds ?? {}) as { match?: number; mismatch?: number };
      if (d.against === 'id_photo') {
        rule = `At check-in the live face is compared with the approved ID photo; a similarity below ${t.mismatch != null ? sim(t.mismatch) : 'the mismatch threshold'} is recorded as a possible different person.`;
        if (num(d.similarity) != null) measured.push(`Similarity to the ID photo: ${sim(num(d.similarity)!)}${t.match != null ? ` (same person usually ≥ ${sim(t.match)})` : ''}.`);
      } else if (num(d.samples) != null) {
        rule = 'Identity samples during the exam are weighed together: each non-matching sample adds evidence and each matching one removes it. A possible different person is recorded only when the combined evidence passes the confirmation level — a single poor frame never does.';
        const n = num(d.samples)!;
        const w = num(d.windowSamples);
        const lo = num(d.minSimilarity);
        const hi = num(d.maxSimilarity);
        measured.push(`${n}${w != null ? ` of ${w}` : ''} recent samples did not match the identity reference${lo != null && hi != null ? ` (similarity ${sim(lo)}–${sim(hi)}${t.match != null ? `; the same person usually ≥ ${sim(t.match)}` : ''})` : ''}.`);
        if (num(d.posterior) != null) measured.push(`Combined evidence: ${pct(num(d.posterior)!)} probability of a different person under the calibration.`);
      } else {
        const purpose = str(d.purpose);
        rule = `At the ${purpose === 'resume' ? 'resume' : purpose === 'reconnect' ? 'reconnect' : 're-verification'} check the face is compared with the identity reference from check-in.`;
        if (num(d.similarity) != null) measured.push(`Similarity to the reference: ${sim(num(d.similarity)!)}.`);
      }
      const second = d.secondOpinion as { decision?: string; provider?: string } | undefined;
      if (second?.decision) factors.push({ effect: second.decision === 'match' ? 'weakens' : 'supports', text: `Second opinion${second.provider ? ` (${second.provider})` : ''}: ${second.decision === 'match' ? 'the same person' : second.decision === 'mismatch' ? 'a different person' : 'inconclusive'}.` });
      if (d.needsHumanReview) factors.push({ effect: 'weakens', text: 'The automated checks disagreed; a person should decide.' });
      factors.push({ effect: 'context', text: 'Changes in clothing, hair, glasses, background or lighting are not evidence of a different person.' });
      break;
    }
    case 'identity_unverifiable': {
      if (d.reason === 'poor_light_suspect') {
        rule = 'Recorded when identity samples in poor light look less similar than usual. Poor light lowers similarity for everyone, so this is capped below a “possible different person”.';
        if (num(d.similarity) != null) measured.push(`Latest similarity: ${sim(num(d.similarity)!)}.`);
      } else if (d.reason === 'second_opinion_disagrees') {
        rule = 'Recorded when the internal identity check and the second opinion disagree.';
      } else {
        rule = 'Recorded when several identity samples in a row were too poor to compare.';
        if (num(d.samples) != null) measured.push(`${num(d.samples)} unusable samples in a row.`);
      }
      const issues = issuesText(d.issues);
      if (issues) measured.push(`Image problems: ${issues}.`);
      notConcluded = 'Poor or conflicting images are never treated as evidence of a different person. Compare the images yourself; the candidate was given guidance to improve the conditions.';
      break;
    }
    case 'camera_disconnected':
    case 'camera_permission_lost':
      rule = ev.type === 'camera_disconnected' ? 'Recorded when the camera stops delivering video.' : 'Recorded when the browser withdraws permission to use the camera.';
      factors.push({ effect: 'context', text: 'Nothing is observed while the camera is unavailable; an identity check runs when it returns.' });
      break;
    case 'reporting_interrupted':
      rule = `Recorded when the candidate’s browser stops reporting for more than ${secText(conn.heartbeatTimeoutSec)}.`;
      factors.push({ effect: 'context', text: 'Observations made during the outage arrive later with their original times.' });
      break;
    case 'monitoring_degraded': {
      rule = 'Recorded when camera analysis runs too slowly or a detector fails to load.';
      const fps = num(d.meanFps);
      if (fps != null) measured.push(`Analysis rate ${fps.toFixed(1)} frames/s${num(d.requiredFps) != null ? ` (needs ${num(d.requiredFps)})` : ''}.`);
      notConcluded = 'Some detections may have been missed or delayed in this period; the absence of events here proves nothing.';
      break;
    }
    default:
      rule = null;
  }
  return { rule, measured, factors, notConcluded };
}

export function explainEvent(ev: ExplainEventInput, ctx: ExplainContext = {}): EventExplanation {
  const now = ctx.now ?? Date.now();
  const base = ruleFor(ev, ctx);
  const factors: ExplanationFactor[] = [...base.factors, ...coincidingFactors(ev, ctx, now), ...accommodationFactors(ev.type, ctx.accommodations)];
  if (ev.deliveredLate) factors.push({ effect: 'context', text: 'Delivered late after a connection problem; the times shown are when it happened.' });
  const preceded = Array.isArray(ev.context?.precededBy) ? (ev.context.precededBy as string[]) : [];
  if (preceded.includes('session_resumed')) factors.push({ effect: 'context', text: 'Shortly after the exam resumed from a pause.' });
  if (preceded.includes('reconnect') || preceded.includes('instance_takeover')) factors.push({ effect: 'context', text: 'Shortly after the browser reconnected.' });
  return { rule: base.rule, measured: base.measured, factors, notConcluded: base.notConcluded, confidence: confidenceOf(ev.confidence) };
}
