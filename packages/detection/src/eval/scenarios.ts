import type { EventType } from '@sp/shared';
import { Rng } from './prng';
import type { Segment, SynthSpec } from './synth';

/** Label in seconds from the trace start (converted to epoch ms by the runner). */
export interface RelLabel {
  type: EventType;
  start: number;
  end: number;
  optional?: boolean;
  note?: string;
}

export interface BuiltScenario {
  spec: SynthSpec;
  labels: RelLabel[];
  /** Camera device label reported via setCameraInfo (default: a normal webcam). */
  cameraLabel?: string;
}

export interface Scenario {
  name: string;
  description: string;
  /** Detections this scenario primarily measures (for the doc table). */
  measures: EventType[] | 'false_alerts';
  build(seed: number): BuiltScenario;
}

const lbl = (type: EventType, start: number, end: number, extra?: Partial<RelLabel>): RelLabel => ({ type, start, end, ...extra });

/**
 * Labelled synthetic scenarios. Each seed jitters timing / magnitudes and changes the random noise
 * (pose jitter, dropped faces, one-frame extra face / phone / dark frame, brief glances), so several
 * seeds give different traces of the same situation. Every scenario starts with ≥ 25 s of normal
 * behaviour (the runner calibrates the baseline from the first 5 s, like check-in).
 */
export const SCENARIOS: Scenario[] = [
  {
    name: 'clean_30min',
    description: '30-minute session of normal exam behaviour with realistic noise (false alerts per hour).',
    measures: 'false_alerts',
    build: (seed) => ({ spec: { seed, durationSec: 1800 }, labels: [] }),
  },
  {
    name: 'noisy_frames',
    description: '10 minutes with frequent single bad frames: one-frame extra face, phone, dark frame, dropped faces (must not flag).',
    measures: 'false_alerts',
    build: (seed) => ({
      spec: { seed, durationSec: 600, noise: { extraFaceBlipPerMin: 2, phoneBlipPerMin: 2, darkFramePerMin: 2, dropFaceProb: 0.03, briefGlancePerMin: 2 } },
      labels: [],
    }),
  },
  {
    name: 'brief_glances',
    description: '25 brief glances (0.3–0.9 s) in random directions over 5 minutes (must not flag).',
    measures: 'false_alerts',
    build: (seed) => {
      const r = new Rng(seed * 31 + 1);
      const segments: Segment[] = [];
      let s = 25;
      for (let i = 0; i < 25; i++) {
        const d = r.range(0.3, 0.9);
        const [yaw, pitch] = r.pick([
          [42, 0],
          [-42, 0],
          [0, -34],
          [25, -30],
          [-25, -30],
          [0, 30],
        ]);
        segments.push({ kind: 'look', start: s, end: s + d, yaw, pitch });
        s += r.range(8, 12);
      }
      return { spec: { seed, durationSec: 300, noise: { briefGlancePerMin: 0 }, segments }, labels: [] };
    },
  },
  {
    name: 'fidgety_candidate',
    description: '20 minutes of a restless candidate: pose jitter ±7°, frequent brief glances and reading posture (false-alert stress test).',
    measures: 'false_alerts',
    build: (seed) => ({
      spec: { seed, durationSec: 1200, noise: { poseJitterDeg: 7, gazeJitter: 0.12, briefGlancePerMin: 3, readingPerMin: 1.5, dropFaceProb: 0.01 } },
      labels: [],
    }),
  },
  {
    name: 'sub_threshold_look',
    description: 'Head turned ~20° (below the 28° threshold) for 30 s, e.g. looking at the side of a wide screen (must not flag).',
    measures: 'false_alerts',
    build: (seed) => {
      const r = new Rng(seed * 31 + 23);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'look', start: at, end: at + 30, yaw: (r.chance(0.5) ? 1 : -1) * r.range(18, 21) }] }, labels: [] };
    },
  },
  {
    name: 'glances_below_min',
    description: '8 look-aways of 0.8–1.0 s (just under glanceMinSec) within 90 s (must not flag).',
    measures: 'false_alerts',
    build: (seed) => {
      const r = new Rng(seed * 31 + 24);
      const segments: Segment[] = [];
      for (let i = 0; i < 8; i++) {
        const st = 30 + i * 11 + r.range(-1.5, 1.5);
        segments.push({ kind: 'look', start: st, end: st + r.range(0.8, 1.0), yaw: r.pick([42, -42]) });
      }
      return { spec: { seed, durationSec: 150, noise: { briefGlancePerMin: 0 }, segments }, labels: [] };
    },
  },
  {
    name: 'multi_face_0_6s',
    description: 'A second face for 0.6 s — shorter than multiplePeopleSec (1 s) — must not flag.',
    measures: 'false_alerts',
    build: (seed) => {
      const r = new Rng(seed * 31 + 25);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 90, segments: [{ kind: 'extraFace', start: at, end: at + 0.6 }] }, labels: [] };
    },
  },
  {
    name: 'phone_low_score',
    description: 'Phone-like object at detector score 0.3–0.42 (below phoneMinConfidence) for 10 s — must not flag.',
    measures: 'false_alerts',
    build: (seed) => {
      const r = new Rng(seed * 31 + 26);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 90, segments: [{ kind: 'object', start: at, end: at + 10, label: 'cell phone', score: r.range(0.3, 0.38) }] }, labels: [] };
    },
  },
  {
    name: 'near_threshold_look_6s',
    description: 'Head turned ~34° (just above the 28° threshold, with ±3.5° jitter) for 6 s (just above lookAwaySec).',
    measures: ['looking_away'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 27);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 120, segments: [{ kind: 'look', start: at, end: at + 6, yaw: (r.chance(0.5) ? 1 : -1) * r.range(33, 35) }] },
        labels: [lbl('looking_away', at, at + 6)],
      };
    },
  },
  {
    name: 'look_away_8s',
    description: 'Head turned ~42° to one side for 8 s.',
    measures: ['looking_away'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 2);
      const at = r.range(35, 45);
      const side = r.chance(0.5) ? 1 : -1;
      return {
        spec: { seed, durationSec: 120, segments: [{ kind: 'look', start: at, end: at + 8, yaw: side * r.range(38, 46) }] },
        labels: [lbl('looking_away', at, at + 8)],
      };
    },
  },
  {
    name: 'look_down_10s',
    description: 'Looking down (~32°) for 10 s, e.g. at notes on the desk.',
    measures: ['looking_away'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 3);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 120, segments: [{ kind: 'look', start: at, end: at + 10, pitch: -r.range(29, 36), gazeY: -0.2 }] },
        labels: [lbl('looking_away', at, at + 10)],
      };
    },
  },
  {
    name: 'repeated_glances',
    description: '6 look-aways of 1.6–3 s within 90 s in mixed directions (≤ 2 per direction).',
    measures: ['repeated_looking_away'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 4);
      const dirs: [number, number][] = [
        [42, 0],
        [-42, 0],
        [0, -34],
        [42, 0],
        [-42, 0],
        [0, -34],
      ];
      const segments: Segment[] = [];
      let first = 0;
      let lastEnd = 0;
      dirs.forEach(([yaw, pitch], i) => {
        const st = 30 + i * 15 + r.range(-2, 2);
        const d = r.range(1.6, 3.0);
        if (i === 0) first = st;
        lastEnd = st + d;
        segments.push({ kind: 'look', start: st, end: st + d, yaw, pitch });
      });
      return { spec: { seed, durationSec: 180, segments }, labels: [lbl('repeated_looking_away', first, lastEnd)] };
    },
  },
  {
    name: 'same_direction_glances',
    description: '5 look-aways of 1.6–2.6 s toward the same spot (down and to one side) within 100 s.',
    measures: ['offscreen_attention_pattern'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 5);
      const side = r.chance(0.5) ? 1 : -1;
      const segments: Segment[] = [];
      let first = 0;
      let lastEnd = 0;
      for (let i = 0; i < 5; i++) {
        const st = 30 + i * 20 + r.range(-3, 3);
        const d = r.range(1.6, 2.6);
        if (i === 0) first = st;
        lastEnd = st + d;
        segments.push({ kind: 'look', start: st, end: st + d, yaw: side * r.range(20, 26), pitch: -r.range(30, 36) });
      }
      return { spec: { seed, durationSec: 200, segments }, labels: [lbl('offscreen_attention_pattern', first, lastEnd)] };
    },
  },
  {
    name: 'absence_12s',
    description: 'Candidate leaves the camera view for 12 s and returns.',
    measures: ['candidate_absent'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 6);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'absent', start: at, end: at + 12 }] }, labels: [lbl('candidate_absent', at, at + 12)] };
    },
  },
  {
    name: 'short_exits',
    description: '4 short exits (3–5 s, too short for "candidate absent") within 3 minutes.',
    measures: ['unusual_movement'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 7);
      const segments: Segment[] = [];
      let first = 0;
      let lastEnd = 0;
      [30, 75, 125, 175].forEach((b, i) => {
        const st = b + r.range(-4, 4);
        const d = r.range(3, 5);
        if (i === 0) first = st;
        lastEnd = st + d;
        segments.push({ kind: 'absent', start: st, end: st + d });
      });
      return { spec: { seed, durationSec: 260, segments }, labels: [lbl('unusual_movement', first, lastEnd)] };
    },
  },
  {
    name: 'far_from_baseline',
    description: 'Candidate sits far to the side of their normal position for 25 s.',
    measures: ['unusual_movement'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 8);
      const at = r.range(35, 45);
      const cx = r.chance(0.5) ? 0.84 : 0.16;
      return { spec: { seed, durationSec: 150, segments: [{ kind: 'move', start: at, end: at + 25, cx }] }, labels: [lbl('unusual_movement', at, at + 25)] };
    },
  },
  {
    name: 'multi_face_1_5s',
    description: 'A second face enters the view for 1.5 s (short intrusion must flag).',
    measures: ['multiple_people'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 9);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 90, segments: [{ kind: 'extraFace', start: at, end: at + 1.5 }] }, labels: [lbl('multiple_people', at, at + 1.5)] };
    },
  },
  {
    name: 'multi_face_30s',
    description: 'A second face is in view for 30 s.',
    measures: ['multiple_people'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 10);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'extraFace', start: at, end: at + 30 }] }, labels: [lbl('multiple_people', at, at + 30)] };
    },
  },
  {
    name: 'background_person',
    description: 'Another person in the background (person box, face too small to detect) for 25 s.',
    measures: ['multiple_people'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 11);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'persons', start: at, end: at + 25, count: 2 }] }, labels: [lbl('multiple_people', at, at + 25)] };
    },
  },
  {
    name: 'phone_5s',
    description: 'A phone is visible for 5 s (detector score 0.55–0.8, occasional misses).',
    measures: ['phone_detected'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 12);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 90, segments: [{ kind: 'object', start: at, end: at + 5, label: 'cell phone', score: r.range(0.6, 0.8) }] },
        labels: [lbl('phone_detected', at, at + 5)],
      };
    },
  },
  {
    name: 'book_15s',
    description: 'A book is visible for 15 s.',
    measures: ['unauthorized_object'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 13);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 90, segments: [{ kind: 'object', start: at, end: at + 15, label: 'book', score: r.range(0.68, 0.85) }] },
        labels: [lbl('unauthorized_object', at, at + 15)],
      };
    },
  },
  {
    name: 'covered_lens',
    description: 'Lens covered for 15 s.',
    measures: ['camera_covered'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 14);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'covered', start: at, end: at + 15 }] }, labels: [lbl('camera_covered', at, at + 15)] };
    },
  },
  {
    name: 'frozen_feed',
    description: 'Video frozen (identical frames) for 20 s.',
    measures: ['camera_frozen'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 15);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'frozen', start: at, end: at + 20 }] }, labels: [lbl('camera_frozen', at, at + 20)] };
    },
  },
  {
    name: 'dark_room',
    description: 'Room lights off for 40 s (frame luma ~28, face ~30; face detection intermittent).',
    measures: ['lighting_unusable'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 16);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 150, segments: [{ kind: 'dark', start: at, end: at + 40 }] }, labels: [lbl('lighting_unusable', at, at + 40)] };
    },
  },
  {
    name: 'replay_loop',
    description: 'From 60 s the camera feed is a 20-s recording (with motion) played in a loop.',
    measures: ['camera_feed_suspect'],
    build: (seed) => ({
      spec: { seed, durationSec: 300, segments: [{ kind: 'replay', start: 60, end: 300, loopSec: 20 }] },
      labels: [lbl('camera_feed_suspect', 60, 300, { note: 'detectable only once the loop repeats' })],
    }),
  },
  {
    name: 'still_person',
    description: 'A very still candidate for 5 minutes (static scene with sensor noise; must not look frozen or replayed).',
    measures: 'false_alerts',
    build: (seed) => ({
      spec: { seed, durationSec: 300, noise: { briefGlancePerMin: 0, readingPerMin: 0 }, segments: [{ kind: 'still', start: 0, end: 300 }] },
      labels: [],
    }),
  },
  {
    name: 'camera_disconnect',
    description: 'Camera track ends for 20 s, then reconnects.',
    measures: ['camera_disconnected'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 17);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'camera', start: at, end: at + 20, state: 'ended' }] }, labels: [lbl('camera_disconnected', at, at + 20)] };
    },
  },
  {
    name: 'permission_lost',
    description: 'Camera permission revoked for 15 s.',
    measures: ['camera_permission_lost'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 18);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 120, segments: [{ kind: 'camera', start: at, end: at + 15, state: 'no_permission' }] },
        labels: [lbl('camera_permission_lost', at, at + 15)],
      };
    },
  },
  {
    name: 'face_cut_off',
    description: 'Face partly outside the image for 12 s.',
    measures: ['face_obstructed'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 19);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'cutoff', start: at, end: at + 12 }] }, labels: [lbl('face_obstructed', at, at + 12)] };
    },
  },
  {
    name: 'face_covered',
    description: 'Face covered by a hand / object (low landmark visibility) for 10 s.',
    measures: ['face_obstructed'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 20);
      const at = r.range(35, 45);
      return {
        spec: { seed, durationSec: 120, segments: [{ kind: 'occluded', start: at, end: at + 10, visibility: r.range(0.25, 0.4) }] },
        labels: [lbl('face_obstructed', at, at + 10)],
      };
    },
  },
  {
    name: 'person_without_face',
    description: 'Person visible to the object detector but no face (e.g. standing, face out of frame) for 12 s.',
    measures: ['face_obstructed'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 21);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 120, segments: [{ kind: 'personNoFace', start: at, end: at + 12 }] }, labels: [lbl('face_obstructed', at, at + 12)] };
    },
  },
  {
    name: 'virtual_camera',
    description: 'The active camera is "OBS Virtual Camera".',
    measures: ['camera_feed_suspect'],
    build: (seed) => ({ spec: { seed, durationSec: 90 }, labels: [lbl('camera_feed_suspect', 0, 90)], cameraLabel: 'OBS Virtual Camera' }),
  },
  {
    name: 'low_fps',
    description: 'Analysis throughput drops to 1 fps for 40 s.',
    measures: ['monitoring_degraded'],
    build: (seed) => {
      const r = new Rng(seed * 31 + 22);
      const at = r.range(35, 45);
      return { spec: { seed, durationSec: 150, segments: [{ kind: 'lowFps', start: at, end: at + 40, fps: 1 }] }, labels: [lbl('monitoring_degraded', at, at + 40)] };
    },
  },
];
