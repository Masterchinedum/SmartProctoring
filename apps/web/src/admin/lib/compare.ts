import type { TimelineItemDTO } from '@sp/shared';

export interface PrecedingFact {
  key: 'paused' | 'face_left' | 'camera' | 'disconnected' | 'hold' | 'multiple_people';
  question: string;
  /** Latest matching item before the reference time, or null if none in the window. */
  item: TimelineItemDTO | null;
}

const FACT_DEFS: { key: PrecedingFact['key']; question: string; match: (i: TimelineItemDTO) => boolean }[] = [
  {
    key: 'paused',
    question: 'Was the exam paused just before?',
    match: (i) =>
      (i.kind === 'period' && i.period.kind === 'paused') || (i.kind === 'event' && (i.event.type === 'session_paused' || i.event.type === 'session_resumed')),
  },
  {
    key: 'face_left',
    question: 'Did the face leave the camera view?',
    match: (i) => i.kind === 'event' && (i.event.type === 'candidate_absent' || i.event.type === 'face_obstructed' || i.event.type === 'camera_covered'),
  },
  {
    key: 'camera',
    question: 'Did the camera disconnect or change?',
    match: (i) =>
      i.kind === 'event' &&
      (i.event.type === 'camera_disconnected' || i.event.type === 'camera_changed' || i.event.type === 'camera_permission_lost' || i.event.type === 'camera_frozen'),
  },
  {
    key: 'disconnected',
    question: 'Was the connection lost or the exam reopened in another browser?',
    match: (i) =>
      (i.kind === 'period' && i.period.kind === 'disconnected') ||
      (i.kind === 'event' && (i.event.type === 'reporting_interrupted' || i.event.type === 'multiple_instances')) ||
      (i.kind === 'identity_check' && i.check.trigger === 'reconnect'),
  },
  {
    key: 'multiple_people',
    question: 'Was more than one person in view?',
    match: (i) => i.kind === 'event' && i.event.type === 'multiple_people',
  },
  {
    key: 'hold',
    question: 'Was the exam on hold?',
    match: (i) => (i.kind === 'period' && i.period.kind === 'on_hold') || (i.kind === 'event' && i.event.type === 'session_held'),
  },
];

/** For each swap-relevant question, the latest item that started at or before `at`. */
export function precedingFacts(items: TimelineItemDTO[], at: number): PrecedingFact[] {
  const before = items.filter((i) => i.at <= at).sort((a, b) => b.at - a.at);
  return FACT_DEFS.map((d) => ({ key: d.key, question: d.question, item: before.find(d.match) ?? null }));
}

/** Position of a similarity value on a 0..1 scale, clamped, as a percentage. */
export function scalePosition(v: number, min = 0, max = 1): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

/** Signed offset label relative to a reference time: "−3m 05s", "+12s", "0s". */
export function offsetLabel(at: number, ref: number): string {
  const d = Math.round((at - ref) / 1000);
  if (d === 0) return '0s';
  const sign = d < 0 ? '−' : '+';
  const abs = Math.abs(d);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return m > 0 ? `${sign}${m}m ${String(s).padStart(2, '0')}s` : `${sign}${s}s`;
}
