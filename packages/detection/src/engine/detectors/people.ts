import { Debouncer, Hysteresis } from '../debounce';
import { K, type DetectorHost, type TickContext } from '../context';
import { dur, Span, type FlushReason } from '../span';
import { clamp01, round } from '../../util/math';

const KEY = 'multiple_people';

/**
 * multiple_people — ≥ 2 plausible faces (face landmarker, every tick) OR ≥ 2 distinct 'person' boxes
 * (object detector, ~1 Hz, score ≥ objectMinConfidence) persisting ≥ multiplePeopleSec. Short intrusions
 * (≥ ~1 s) are flagged; a single-frame blip is not (the face path needs ≥ 3 supporting ticks, the person
 * path ≥ 2 object-detector ticks). Both paths feed one episode (startedAt = earliest start, endedAt =
 * latest end). When the episode ends an identity sample 'after_multiple_people' is requested (it fires
 * once exactly one usable face is visible).
 */
export class MultiplePeopleDetector {
  private faces: Debouncer;
  private persons: Debouncer;
  private open = false;
  private epStart = 0;
  private faceStart: number | null = null;
  private personStart: number | null = null;
  private faceEnd: number | null = null;
  private personEnd: number | null = null;
  private maxFaces = 0;
  private maxPersons = 0;
  private peakPending = false;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    const onsetMs = p.multiplePeopleSec * 1000;
    this.faces = new Debouncer({ onsetMs, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 600, minTicks: 3 });
    this.persons = new Debouncer({ onsetMs: Math.max(onsetMs, 900), clearMs: Math.max(p.clearSec * 1000, 2500), minFraction: 0.6, gapTolMs: 2500, minTicks: 2 });
  }

  get isOpen(): boolean {
    return this.open;
  }

  step(ctx: TickContext): void {
    if (!this.host.policy.enabled.multiplePeople) return;
    const t = ctx.t;
    if (!this.open && !this.faces.active && !this.persons.active && this.faces.runStart === null && this.persons.runStart === null) {
      this.maxFaces = 0;
      this.maxPersons = 0;
    }
    const vf = ctx.visionOk ? ctx.faceCount >= 2 : null;
    const secondScore = ctx.faceCount >= 2 ? ctx.faces[1].score : 1;
    if (vf) {
      if (ctx.faceCount > this.maxFaces) {
        if (this.open) this.peakPending = true;
        this.maxFaces = ctx.faceCount;
      }
    }
    const ef = this.faces.step(t, vf, secondScore);
    let ep = null;
    if (ctx.objectsRan) {
      const n = ctx.persons ?? 0;
      const vp = ctx.visionOk ? n >= 2 : null;
      if (vp && n > this.maxPersons) {
        if (this.open) this.peakPending = true;
        this.maxPersons = n;
      }
      const best = ctx.objects ? Math.max(0, ...ctx.objects.filter((o) => o.label === 'person').map((o) => o.score)) : 1;
      ep = this.persons.step(t, vp, best || 1);
    } else ep = this.persons.expire(t, 6000);
    if (ef?.kind === 'onset') {
      this.faceStart = ef.startedAt;
      this.faceEnd = null;
    }
    if (ep?.kind === 'onset') {
      this.personStart = ep.startedAt;
      this.personEnd = null;
    }
    if (ef?.kind === 'clear') this.faceEnd = ef.endedAt;
    if (ep?.kind === 'clear') this.personEnd = ep.endedAt;
    const anyActive = this.faces.active || this.persons.active;
    if (!this.open && anyActive) {
      const starts = [this.faces.active ? this.faceStart : null, this.persons.active ? this.personStart : null].filter((x): x is number => x !== null);
      this.begin(Math.min(...starts), t);
    } else if (this.open && !anyActive) {
      this.end(Math.max(this.faceEnd ?? -Infinity, this.personEnd ?? -Infinity, this.epStart), t);
    } else if (this.open) {
      const u = this.host.book.touch(KEY, t, this.material(), () => this.data(t, null), { peak: this.peakPending });
      if (u) {
        if (u.captureSnapshot === 'peak') this.peakPending = false;
        this.host.episodes.push(u);
      }
    }
  }

  flush(t: number, reason: FlushReason): void {
    if (this.open) {
      const d = this.data(t, t);
      d.details.closedBy = reason;
      const u = this.host.book.end(KEY, this.faces.firstOff ?? this.persons.firstOff ?? t, t, d);
      if (u) this.host.episodes.push(u);
      this.open = false;
      this.host.prompts.set('multiple_people', false, this.host.signals);
    }
    this.reset();
  }

  reset(): void {
    this.faces.reset();
    this.persons.reset();
    this.open = false;
    this.faceStart = this.personStart = this.faceEnd = this.personEnd = null;
    this.maxFaces = 0;
    this.maxPersons = 0;
    this.peakPending = false;
  }

  private material(): string {
    return `${this.maxFaces}|${this.maxPersons}`;
  }

  private begin(startedAt: number, t: number): void {
    const { update } = this.host.book.begin(KEY, 'multiple_people', startedAt, t, this.data(t, null), this.material());
    this.epStart = update.startedAt;
    this.open = true;
    this.host.episodes.push(update);
    this.host.prompts.set('multiple_people', true, this.host.signals);
  }

  private end(endedAt: number, t: number): void {
    const u = this.host.book.end(KEY, endedAt, t, this.data(t, endedAt));
    if (u) this.host.episodes.push(u);
    this.open = false;
    this.host.prompts.set('multiple_people', false, this.host.signals);
    this.host.identity.arm('after_multiple_people');
  }

  private data(t: number, endedAt: number | null) {
    const durationSec = round(((endedAt ?? t) - this.epStart) / 1000, 1);
    const sources: string[] = [];
    if (this.maxFaces >= 2) sources.push('faces');
    if (this.maxPersons >= 2) sources.push('person_detector');
    const people = Math.max(this.maxFaces, this.maxPersons, 2);
    const conf = Math.max(this.faces.active || this.maxFaces >= 2 ? this.faces.confidence(t) : 0, this.persons.active || this.maxPersons >= 2 ? this.persons.confidence(t) : 0);
    const observation =
      endedAt === null
        ? `${people} people are visible in the camera view.`
        : `Up to ${people} people were visible in the camera view for ${dur(durationSec)}.`;
    return {
      confidence: clamp01(conf || 0.6),
      details: { durationSec, maxFaces: this.maxFaces, maxPersons: this.maxPersons, sources },
      observation,
    };
  }
}

/**
 * face_obstructed — face present but cut off at the image edge or with low visibility (covered / too
 * unclear), or a 'person' is detected without a face, for ≥ obstructionSec. Not evaluated while the
 * lighting is the root cause (lighting_unusable) or the camera is covered/frozen. When it ends an
 * identity sample 'after_obstruction' is requested.
 */
export class ObstructionDetector {
  readonly span: Span;
  private prompt = new Hysteresis(2500, 1500);
  private counts = { cut_off: 0, low_visibility: 0, person_without_face: 0 };
  private minVis = 1;

  constructor(private host: DetectorHost) {
    const p = host.policy;
    this.span = new Span(host, 'face_obstructed', 'face_obstructed', { onsetMs: p.obstructionSec * 1000, clearMs: p.clearSec * 1000, minFraction: 0.7, gapTolMs: 1000, minTicks: 3 }, {
      material: () => this.reason(),
      describe: (d) => {
        const reason = this.reason();
        const what =
          reason === 'cut_off'
            ? 'The face was partly outside the camera image'
            : reason === 'person_without_face'
              ? 'A person was visible but their face could not be seen'
              : 'The face was partly covered or too unclear to assess';
        return {
          details: { durationSec: d.durationSec, reason, reasonCounts: { ...this.counts }, minVisibility: round(this.minVis, 2) },
          observation: d.phase === 'close' ? `${what} for ${dur(d.durationSec)}.` : `${what.replace(' was ', ' is ').replace(' were ', ' are ')}.`,
        };
      },
    });
    this.span.onEnd = (_e, _t, closedBy) => {
      if (!closedBy) host.identity.arm('after_obstruction');
    };
  }

  step(ctx: TickContext): void {
    if (!this.host.policy.enabled.obstruction) return;
    let v: boolean | null = null;
    let reason: keyof ObstructionDetector['counts'] | null = null;
    let vis = 1;
    if (ctx.visionOk && !ctx.lightingBad) {
      if (ctx.faceCount >= 1 && ctx.primary) {
        const f = ctx.primary;
        vis = Number.isFinite(f.visibility) ? f.visibility : 1;
        if (f.cutOff) reason = 'cut_off';
        else if (vis < K.obstructedVisibility) reason = 'low_visibility';
        v = reason !== null;
      } else if (!ctx.frameDark) {
        v = ctx.personVisible;
        if (v) reason = 'person_without_face';
      }
    }
    if (v && reason) {
      if (!this.span.deb.active && this.span.deb.runStart === null) {
        this.counts = { cut_off: 0, low_visibility: 0, person_without_face: 0 };
        this.minVis = 1;
      }
      this.counts[reason]++;
      this.minVis = Math.min(this.minVis, vis);
    }
    this.span.feed(ctx.t, v, 1);
    const ch = this.prompt.step(ctx.t, v);
    if (ch) this.host.prompts.set('face_obstructed', ch === 'on', this.host.signals);
  }

  get active(): boolean {
    return this.span.active;
  }

  reason(): 'cut_off' | 'low_visibility' | 'person_without_face' {
    const c = this.counts;
    if (c.person_without_face >= c.cut_off && c.person_without_face >= c.low_visibility && c.person_without_face > 0) return 'person_without_face';
    return c.cut_off >= c.low_visibility ? 'cut_off' : 'low_visibility';
  }

  flush(t: number, reason: FlushReason): void {
    this.span.flush(t, reason);
    this.host.prompts.set('face_obstructed', false, this.host.signals);
    this.reset();
  }

  reset(): void {
    this.span.reset();
    this.prompt.reset();
    this.counts = { cut_off: 0, low_visibility: 0, person_without_face: 0 };
    this.minVis = 1;
  }
}
