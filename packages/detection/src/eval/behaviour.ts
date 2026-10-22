import type { EventType } from '@sp/shared';
import { Rng } from './prng';
import type { ActivityEvent, AttentionScript, AttentionSegment, PersonProfile } from './synth';
import type { RelLabel } from './scenarios';

/**
 * Behaviour scripts for the attention scenarios: where a candidate looks while taking an exam on a laptop (or
 * with an external monitor), with the matching exam-page activity (pointer, clicks, scrolling, typing) — and
 * scripted off-screen behaviour to detect.
 *
 * Geometry (deg, relative to the WORK CENTRE = the middle of the screen the candidate works on; x+ = toward
 * the candidate's left, y+ = up):
 *  - the screen spans ±w horizontally and ±h vertically (a 13–14" laptop at ~50 cm: w ≈ 15, h ≈ 9; a 24–27"
 *    monitor at ~65 cm: w ≈ 22, h ≈ 12);
 *  - the keyboard is 20–35° below the screen centre (laptop), 32–40° below an external monitor;
 *  - reading moves mostly the eyes (the head covers 25–45 % of a shift within the screen), large shifts
 *    (keyboard, notes, a second screen, a person) turn the head 55–85 %.
 * The work centre sits `work` from the calibration pose: the check screen asks the candidate to look at the
 * screen / camera, and with the camera above the screen the working pose is 8–15° lower; with a laptop camera
 * beside an external monitor it is 20–35° to the side when the candidate looked at the camera for the check.
 */

export interface WorkSetup {
  name: string;
  work: { yaw: number; pitch: number };
  screen: { w: number; h: number };
  keyboard: { x: number; y: number };
  person?: Partial<PersonProfile>;
}

export type Typist = 'hunt' | 'touch';

const side = (r: Rng) => (r.chance(0.5) ? 1 : -1);

/** Camera above a laptop screen; the check pose looked at the preview / camera, work is 8–15° lower. */
export function laptopSetup(r: Rng): WorkSetup {
  return {
    name: 'laptop',
    work: { yaw: r.range(-3, 3), pitch: -r.range(8, 15) },
    screen: { w: r.range(14, 16), h: r.range(8, 10) },
    keyboard: { x: r.range(-2, 2), y: -r.range(22, 32) },
  };
}

/** Small laptop held low (on the lap / a low table): the camera looks up at the face, absolute pitch ≈ −20°. */
export function lowLaptopSetup(r: Rng): WorkSetup {
  return {
    name: 'laptop_low',
    work: { yaw: r.range(-3, 3), pitch: -r.range(3, 8) },
    screen: { w: r.range(12, 13), h: r.range(7, 8) },
    keyboard: { x: r.range(-2, 2), y: -r.range(20, 28) },
    person: { pitch: -20 + r.range(-2, 2) },
  };
}

/**
 * Laptop camera beside an external monitor. `calibration: 'camera'`: the check was done looking at the laptop
 * (camera / preview), so the work pose is 20–35° to the side; 'monitor': the check ran on the monitor, so the
 * calibration pose is already the (turned) work pose.
 */
export function externalMonitorSetup(r: Rng, calibration: 'camera' | 'monitor'): WorkSetup {
  const s = side(r);
  const off = r.range(20, 35);
  const base = { screen: { w: r.range(20, 24), h: r.range(11, 13) }, keyboard: { x: -s * r.range(0, 6), y: -r.range(32, 40) } };
  return calibration === 'camera'
    ? { name: 'external_cal_camera', work: { yaw: s * off, pitch: r.range(0, 8) }, ...base }
    : { name: 'external_cal_monitor', work: { yaw: r.range(-2, 2), pitch: r.range(-2, 2) }, ...base, person: { yaw: s * off + r.range(-3, 3), pitch: r.range(-6, 2) } };
}

/** Per-candidate traits. */
interface Traits {
  readHead: number;
  bigHead: number;
  /** Reading speed factor (s per line of full width). */
  lineSec: number;
}

export class ExamScript {
  t: number;
  readonly segs: AttentionSegment[] = [];
  readonly act: ActivityEvent[] = [];
  readonly labels: RelLabel[] = [];
  readonly traits: Traits;
  private nextThink: number;
  private nextSip: number;
  private nextStretch: number;
  private kb: { x: number; y: number };

  constructor(
    private r: Rng,
    readonly setup: WorkSetup,
    readonly typist: Typist,
    start: number,
    opts: { fidget?: boolean } = {},
  ) {
    this.t = start;
    this.traits = { readHead: r.range(0.25, 0.45), bigHead: r.range(0.55, 0.8), lineSec: r.range(1.6, 2.8) };
    this.kb = { ...setup.keyboard };
    this.nextThink = start + r.range(40, 120);
    this.nextSip = start + r.range(120, 360);
    this.nextStretch = start + r.range(300, 700);
    this.fidget = opts.fidget !== false;
  }

  private fidget: boolean;

  /* ------------------------------------------------------------------ primitives */

  /** Tag of the next segments (diagnostics: which behaviour a flag came from). */
  tag = 'screen';

  hold(dur: number, x: number, y: number, head?: number, headY?: number): AttentionSegment {
    const g: AttentionSegment = { start: this.t, end: this.t + dur, x, y, head: head ?? this.traits.readHead, ...(headY !== undefined ? { headY } : {}), tag: this.tag };
    this.segs.push(g);
    this.t += dur;
    return g;
  }

  sweep(dur: number, x0: number, y0: number, x1: number, y1: number, head?: number): void {
    this.segs.push({ start: this.t, end: this.t + dur, x: x0, y: y0, x1, y1, head: head ?? this.traits.readHead, tag: this.tag });
    this.t += dur;
  }

  private tagged<T>(tag: string, fn: () => T): T {
    const prev = this.tag;
    this.tag = tag;
    try {
      return fn();
    } finally {
      this.tag = prev;
    }
  }

  private ev(t: number, kind: ActivityEvent['kind']): void {
    this.act.push({ t, kind });
  }

  /** Pointer movement events over [from, to). */
  private pointer(from: number, to: number, every = 0.1): void {
    for (let t = from; t < to; t += every * this.r.range(0.7, 1.3)) this.ev(t, 'pointer');
  }

  private key(t: number, inAnswer = true): void {
    this.ev(t, 'key');
    if (inAnswer) {
      this.ev(t, 'answerKey');
      this.ev(t + 0.01, 'answer');
    }
  }

  label(type: EventType, start: number, end: number, optional = false, note?: string): void {
    this.labels.push({ type, start, end, ...(optional ? { optional } : {}), ...(note ? { note } : {}) });
  }

  /* ------------------------------------------------------------------ reading */

  /** One line of text at height y, `width` = fraction of the screen width. */
  readLine(y: number, width = 0.85): void {
    const { w } = this.setup.screen;
    const x0 = w * width * this.r.range(0.9, 1);
    const x1 = -w * width * this.r.range(0.9, 1);
    const dur = this.traits.lineSec * width * this.r.range(0.8, 1.25);
    const start = this.t;
    this.sweep(dur, x0, y, x1, y + this.r.normal(0, 0.4));
    // Some people move the mouse along while reading.
    if (this.fidget && this.r.chance(0.2)) this.pointer(start + this.r.range(0, dur / 2), start + dur);
  }

  /** Lines evenly spaced between yTop and yBottom (fractions of the half-height h). */
  readBlock(lines: number, yTop: number, yBottom: number, width = 0.85): void {
    const { h } = this.setup.screen;
    for (let i = 0; i < lines; i++) {
      const f = lines === 1 ? 0 : i / (lines - 1);
      this.readLine(h * (yTop + (yBottom - yTop) * f) + this.r.normal(0, 0.5), width * this.r.range(0.7, 1));
    }
  }

  /** A multiple-choice question answered with the mouse. */
  mcq(): void {
    const { w, h } = this.setup.screen;
    const r = this.r;
    // Most stems are a few lines at the top; some are passages that fill the screen (scrolled).
    if (r.chance(0.3)) {
      this.readBlock(r.int(6, 12), 0.85, -0.85);
      const s0 = this.t;
      for (let k = 0; k < r.int(3, 8); k++) this.ev(s0 + k * 0.08, 'scroll');
    } else this.readBlock(r.int(2, 5), 0.75, 0.2);
    const options = r.int(3, 5);
    const optY = (i: number) => -h * (0.05 + (0.75 * i) / Math.max(1, options - 1));
    const long = r.chance(0.3);
    for (let i = 0; i < options; i++) {
      if (long && i === Math.floor(options / 2)) {
        // Scroll to see the remaining options.
        const s0 = this.t;
        for (let k = 0; k < r.int(3, 8); k++) this.ev(s0 + k * 0.08, 'scroll');
        this.hold(r.range(0.4, 0.9), r.range(-3, 3), -h * 0.4);
      }
      this.readLine(optY(i), r.range(0.3, 0.6));
    }
    if (r.chance(0.3)) this.readBlock(r.int(1, 2), 0.5, 0.2); // re-read part of the question
    // Move the pointer to the chosen option and click it.
    const choice = r.int(0, options - 1);
    const ox = w * r.range(0.5, 0.8);
    const move = r.range(0.4, 1.1);
    this.pointer(this.t, this.t + move, 0.06);
    this.hold(move, ox, optY(choice));
    this.ev(this.t, 'click');
    this.ev(this.t + 0.02, 'answer');
    this.hold(r.range(0.3, 0.8), ox, optY(choice));
    // Next.
    if (r.chance(0.85)) {
      const nm = r.range(0.4, 0.9);
      this.pointer(this.t, this.t + nm, 0.06);
      this.hold(nm, -w * 0.75, -h * 0.88);
      this.ev(this.t, 'click');
      this.hold(r.range(0.2, 0.5), -w * 0.75, -h * 0.88);
    }
  }

  /** Where the text being typed is on screen (the text area; the line advances slowly). */
  private textArea(): { x: number; y: number } {
    const { w, h } = this.setup.screen;
    return { x: this.r.range(-w * 0.6, w * 0.6), y: h * this.r.range(-0.45, 0.15) };
  }

  /** A keyboard glance target (the keys being looked for). */
  private kbTarget(): { x: number; y: number } {
    return { x: this.kb.x + this.r.range(-8, 8), y: this.kb.y + this.r.normal(0, 2.5) };
  }

  /** Essay writing for about `sec` seconds. */
  essay(sec: number, extras = true): void {
    const r = this.r;
    const end = this.t + sec;
    this.readBlock(r.int(4, 8), 0.8, 0.1);
    while (this.t < end) {
      if (extras) this.extras();
      if (this.typist === 'hunt') this.huntBurst();
      else this.touchBurst();
      // Pause: re-read what was written, or think.
      if (r.chance(0.35)) this.readBlock(r.int(1, 3), 0.1, -0.4, 0.8);
      else this.hold(r.range(1, 4), this.textArea().x, this.textArea().y);
    }
  }

  /** Hunt-and-peck: keyboard glances of 1–4 s (keys pressed while looking), then a look at the text. */
  private huntBurst(cycleCount?: number): void {
    const r = this.r;
    const cycles = cycleCount ?? r.int(3, 9);
    for (let c = 0; c < cycles; c++) {
      const g = this.kbTarget();
      const dur = r.range(1, 4);
      const start = this.t;
      this.tagged('keyboard', () => this.hold(dur, g.x, g.y, this.traits.bigHead));
      // The first key is found 0.4–0.9 s into the glance, then one every 0.2–0.5 s.
      for (let k = start + r.range(0.4, 0.9); k < start + dur - 0.05; k += r.range(0.2, 0.5)) this.key(k);
      const ta = this.textArea();
      const look = r.range(0.8, 3);
      const ls = this.t;
      this.hold(look, ta.x, ta.y);
      if (r.chance(0.2)) this.key(ls + r.range(0.2, look - 0.1));
    }
  }

  /** Touch typist: eyes on the text while typing; a rare short keyboard glance. */
  private touchBurst(maxDur = 20): void {
    const r = this.r;
    const dur = Math.min(maxDur, r.range(5, 20));
    const ta = this.textArea();
    const start = this.t;
    const { w } = this.setup.screen;
    this.sweep(dur, ta.x, ta.y, Math.max(-w * 0.7, ta.x - r.range(5, 15)), ta.y - r.range(0, 1.5));
    for (let k = start + 0.1; k < start + dur; k += r.range(0.12, 0.25)) this.key(k);
    if (r.chance(0.12)) {
      const g = this.kbTarget();
      const gs = this.t;
      const gd = r.range(0.5, 1.5);
      this.tagged('keyboard', () => this.hold(gd, g.x, g.y, this.traits.bigHead));
      for (let k = gs + 0.2; k < gs + gd; k += r.range(0.15, 0.3)) this.key(k);
    }
  }

  /* ------------------------------------------------------------------ nuisances */

  /** Thinking: up / up-left / up-right for 2–8 s. */
  think(): void {
    const r = this.r;
    const dir = r.pick([0, 1, -1]);
    this.tagged('think', () => this.hold(r.range(2, 8), dir * r.range(10, 25) + r.normal(0, 3), r.range(15, 30), r.range(0.5, 0.8)));
  }

  /** Reach for a glass (short glance down to the side), then drink: head tilted back, eyes forward. */
  sip(): void {
    const r = this.r;
    const s = side(r);
    this.tagged('sip', () => {
      this.hold(r.range(0.5, 1.0), s * r.range(20, 30), -r.range(20, 28), 0.6);
      this.hold(r.range(2, 5), s * r.range(0, 5), r.range(3, 8), 0.8, r.range(2.5, 3.5));
    });
  }

  /** Stretch: head back and to a side for 3–8 s. */
  stretch(): void {
    const r = this.r;
    this.tagged('stretch', () => this.hold(r.range(3, 8), side(r) * r.range(5, 15), r.range(20, 35), 0.9));
  }

  /** Insert thinking / sipping / stretching when due. */
  extras(): void {
    const r = this.r;
    if (this.t >= this.nextThink) {
      this.think();
      this.nextThink = this.t + r.range(60, 180);
    }
    if (this.t >= this.nextSip) {
      this.sip();
      this.nextSip = this.t + r.range(240, 480);
    }
    if (this.t >= this.nextStretch) {
      this.stretch();
      this.nextStretch = this.t + r.range(480, 900);
    }
  }

  /** Normal exam-taking until `until`: multiple-choice questions, then an essay. */
  exam(until: number, mcqShare = 0.45): void {
    const mcqEnd = this.t + (until - this.t) * mcqShare;
    while (this.t < mcqEnd) {
      this.extras();
      this.mcq();
    }
    this.essay(Math.max(0, until - this.t));
  }

  /** Normal work for about `sec` seconds, in small units (reading with the mouse, or typing when `typing`). */
  work(sec: number, typing = false): void {
    const r = this.r;
    const end = this.t + sec;
    const { w, h } = this.setup.screen;
    while (this.t < end) {
      this.extras();
      if (typing && this.typist === 'hunt') this.huntBurst(1);
      else if (typing) this.touchBurst(Math.min(20, Math.max(3, end - this.t)));
      else if (r.chance(0.3)) {
        // Point at something and click it.
        const x = w * r.range(-0.8, 0.8);
        const y = h * r.range(-0.9, 0.2);
        const m = r.range(0.4, 1.0);
        this.pointer(this.t, this.t + m, 0.06);
        this.hold(m, x, y);
        this.ev(this.t, 'click');
        this.ev(this.t + 0.02, 'answer');
      } else this.readLine(h * r.range(-0.8, 0.8), r.range(0.4, 0.9));
    }
  }

  /* ------------------------------------------------------------------ off-screen behaviour (labelled) */

  /**
   * Repeated glances at one off-screen spot (notes, a second screen, a phone on the desk): `count` glances of
   * `dur` s with `gap` s of work in between. No typing during a glance unless `typeDuring`.
   */
  glances(spot: { x: number; y: number; head: number }, count: number, dur: () => number, gap: () => number, opts: { typeDuring?: boolean; typingBetween?: boolean; pattern?: EventType } = {}): { first: number; last: number } {
    const r = this.r;
    let first = 0;
    let last = 0;
    for (let i = 0; i < count; i++) {
      const d = dur();
      const g = this.tagged('offscreen', () => this.hold(d, spot.x + r.normal(0, 2), spot.y + r.normal(0, 1.5), spot.head));
      if (opts.typeDuring) for (let k = g.start + 0.3; k < g.end; k += r.range(0.15, 0.3)) this.key(k);
      if (i === 0) first = g.start;
      last = g.end;
      // A glance of ≥ lookAwaySec (5 s) is also a sustained look-away: allowed (optional), not required.
      if (d >= 4) this.label('looking_away', g.start, g.end, true, 'long glance');
      if (i < count - 1) this.work(gap(), !!opts.typingBetween);
    }
    this.label(opts.pattern ?? 'offscreen_attention_pattern', first, last, false);
    this.label('repeated_looking_away', first, last, true);
    if ((opts.pattern ?? 'offscreen_attention_pattern') !== 'offscreen_attention_pattern') this.label('offscreen_attention_pattern', first, last, true);
    return { first, last };
  }

  /** One sustained off-screen look (labelled looking_away; required when ≥ minRequired s). */
  look(spot: { x: number; y: number; head: number }, dur: number, minRequired = 6, note?: string): AttentionSegment {
    const g = this.tagged('offscreen', () => this.hold(dur, spot.x, spot.y, spot.head));
    this.label('looking_away', g.start, g.end, dur < minRequired, note);
    return g;
  }

  /** The script as synth input. */
  attention(calibrateSec: number, r: Rng): AttentionScript {
    return {
      work: this.setup.work,
      calibrateSec,
      segments: this.segs,
      // Blendshape eye-look values: per-person gain; looking down reads strongly (eyelids lower).
      gazeGain: { x: r.range(0.8, 1.3), y: r.range(0.9, 1.6) },
      gazeBias: { x: r.normal(0, 0.05), y: -0.08 + r.normal(0, 0.05) },
    };
  }
}

export { side as randomSide };
