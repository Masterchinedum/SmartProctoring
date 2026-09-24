/**
 * Final session report (GET /api/admin/sessions/:id/report).
 *
 * Summarises the whole session from its periods, events, identity checks and notes. Every sentence is
 * observational ("a different face may have appeared ...") — the report never concludes misconduct,
 * never presents "unable to verify" as a different person, and treats environment changes as context.
 *
 * Totals are computed by sweeping the periods: every instant between the first period and the end of
 * the session (or now) is attributed to at most one period kind. Unobserved kinds (on hold, paused,
 * disconnected) take precedence if periods overlap, so unobserved time is never counted as observed.
 * Time not covered by any period (e.g. waiting between the readiness check and pressing "start") is
 * neither observed nor unobserved exam time; it is mentioned in the observations.
 */
import {
  clockUsedMs,
  EVENT_CATALOG,
  EVENT_CATEGORIES,
  SEVERITY_RANK,
  type EndReason,
  type EventCategory,
  type EventDTO,
  type EventType,
  type HoldReason,
  type IdentityCheckDTO,
  type PeriodDTO,
  type PeriodKind,
  type ProctoringPolicy,
  type SessionReportDTO,
  type TimelineItemDTO,
} from '@sp/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { candidates, examSessions, exams, identityReferences, organizations, type IdentityReference } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { loadNoteDTOs, loadSessionSummaries, sessionClock } from './dto.js';
import { capFirst, formatDuration, lcFirst, listJoin, makeClock, pct, plural, type Clock } from './reports-format.js';
import { loadSessionTimeline } from './reports-timeline.js';
import { effectivePolicy } from './session-state.js';

export const NOTABLE_EVENTS_LIMIT = 200;
const MAX_BEHAVIOUR_LINES = 8;

/** Precedence when periods overlap (lower index wins). */
const PERIOD_PRECEDENCE: PeriodKind[] = ['on_hold', 'paused', 'disconnected', 'resume_check', 'check_in', 'active'];
const UNOBSERVED: PeriodKind[] = ['on_hold', 'paused', 'disconnected'];

const END_REASON_TEXT: Record<EndReason, string> = {
  candidate_submitted: 'submitted by the candidate',
  time_expired: 'submitted automatically when the exam time ran out',
  staff_submitted: 'submitted by an administrator',
  staff_terminated: 'ended by an administrator',
};

const HOLD_REASON_TEXT: Record<HoldReason, string> = {
  identity_mismatch: 'a possible different person was observed',
  identity_unverifiable: 'identity could not be verified after several attempts',
  id_photo_mismatch: 'the live image may not match the approved ID photo',
  pause_limit: 'the pause was longer than the exam rules allow',
  staff: 'a staff member placed it on hold',
};

const DETECTOR_LABELS: Record<keyof ProctoringPolicy['detection']['enabled'], string> = {
  absence: 'absence detection',
  multiplePeople: 'multiple-person detection',
  lookingAway: 'looking-away detection',
  movement: 'unusual-movement detection',
  obstruction: 'obstruction detection',
  objects: 'phone and object detection',
  cameraIntegrity: 'camera-integrity checks',
};

const ROUTINE_TRIGGERS = new Set(['periodic', 'face_return', 'after_multiple_people', 'after_obstruction', 'follow_up', 'camera_reconnect']);
const CAMERA_OUTAGE_TYPES: EventType[] = ['camera_disconnected', 'camera_permission_lost', 'camera_frozen', 'camera_covered'];

export interface ReportOptions {
  /** IANA time zone for clock times in sentences (default UTC). */
  timeZone?: string;
}

type ReportCtx = Pick<Ctx, 'db' | 'now' | 'config' | 'keyring'>;

/* ================================================================== period arithmetic */

export interface PeriodTotals {
  firstAt: number | null;
  byKind: Record<PeriodKind, number>;
  observedMs: number;
  unobservedMs: number;
  /** Time between the first period and the end that no period covers. */
  uncoveredMs: number;
}

/** Sweep periods over [first period start, endAt]; overlapping periods resolved by PERIOD_PRECEDENCE. */
export function periodTotals(periods: PeriodDTO[], endAt: number): PeriodTotals {
  const byKind = Object.fromEntries(PERIOD_PRECEDENCE.map((k) => [k, 0])) as Record<PeriodKind, number>;
  const spans = periods
    .map((p) => ({ kind: p.kind, start: p.startedAt, end: Math.min(p.endedAt ?? endAt, endAt) }))
    .filter((s) => s.end > s.start);
  const firstAt = periods.length ? Math.min(...periods.map((p) => p.startedAt)) : null;
  if (firstAt == null || endAt <= firstAt) return { firstAt, byKind, observedMs: 0, unobservedMs: 0, uncoveredMs: 0 };
  const cuts = [...new Set([firstAt, endAt, ...spans.flatMap((s) => [s.start, s.end])])].filter((t) => t >= firstAt && t <= endAt).sort((a, b) => a - b);
  let uncoveredMs = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const covering = spans.filter((s) => s.start <= a && s.end >= b).map((s) => s.kind);
    if (covering.length === 0) {
      uncoveredMs += b - a;
      continue;
    }
    const kind = PERIOD_PRECEDENCE.find((k) => covering.includes(k))!;
    byKind[kind] += b - a;
  }
  const unobservedMs = UNOBSERVED.reduce((s, k) => s + byKind[k], 0);
  const observedMs = PERIOD_PRECEDENCE.filter((k) => !UNOBSERVED.includes(k)).reduce((s, k) => s + byKind[k], 0);
  return { firstAt, byKind, observedMs, unobservedMs, uncoveredMs };
}

function periodDuration(p: PeriodDTO, endAt: number): number {
  return Math.max(0, Math.min(p.endedAt ?? endAt, endAt) - p.startedAt);
}

function eventDuration(e: EventDTO, endAt: number): number {
  if (e.durationMs != null) return e.durationMs;
  return e.status === 'open' ? Math.max(0, endAt - e.startedAt) : 0;
}

/** Total time covered by a set of events (overlaps merged). */
export function unionDurationMs(evs: EventDTO[], endAt: number): number {
  const spans = evs
    .map((e) => [e.startedAt, e.startedAt + eventDuration(e, endAt)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of spans) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return total;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/* ================================================================== builder */

export async function buildSessionReport(ctx: ReportCtx, sessionId: string, orgId: string, opts: ReportOptions = {}): Promise<SessionReportDTO> {
  const db = ctx.db;
  const [row] = await db
    .select({ session: examSessions, exam: exams, candidate: candidates, org: organizations })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .innerJoin(organizations, eq(organizations.id, examSessions.orgId))
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.orgId, orgId)));
  if (!row) throw notFound('Session not found', 'session_not_found');
  const { session, exam, candidate, org } = row;
  const now = ctx.now();

  const [[summary], timeline, refs, notes] = await Promise.all([
    loadSessionSummaries(ctx, db, { orgId, sessionIds: [sessionId] }),
    loadSessionTimeline(db, sessionId),
    db.select().from(identityReferences).where(eq(identityReferences.sessionId, sessionId)).orderBy(asc(identityReferences.version)),
    loadNoteDTOs(db, { sessionId }),
  ]);
  if (!summary) throw notFound('Session not found', 'session_not_found');
  const policy = effectivePolicy(session, exam, org);
  const { periods, events: evs, checks } = timeline;

  const endAt = session.endedAt ? session.endedAt.getTime() : now;
  const totalsRaw = periodTotals(periods, endAt);
  const clock = makeClock(opts.timeZone ?? 'UTC', totalsRaw.firstAt ?? session.startedAt?.getTime() ?? session.createdAt.getTime());

  const totals: SessionReportDTO['totals'] = {
    wallClockMs: totalsRaw.firstAt != null ? Math.max(0, endAt - totalsRaw.firstAt) : 0,
    observedMs: totalsRaw.observedMs,
    unobservedMs: totalsRaw.unobservedMs,
    activeMs: totalsRaw.byKind.active,
    pausedMs: totalsRaw.byKind.paused,
    disconnectedMs: totalsRaw.byKind.disconnected,
    heldMs: totalsRaw.byKind.on_hold,
    pauseCount: session.pauseCount,
    examTimeUsedMs: Math.round(clockUsedMs(sessionClock(session), now)),
  };

  /* -------------------------------------------------------------- identity */
  const initialRef: IdentityReference | undefined = refs[0];
  const idPhotoCheck = [...checks].reverse().find((c) => c.trigger === 'id_photo');
  const idPhoto = initialRef?.idPhoto ?? (idPhotoCheck ? { decision: idPhotoCheck.decision, similarity: idPhotoCheck.similarity } : null);
  const identity: SessionReportDTO['identity'] = {
    referenceCreatedAt: initialRef ? initialRef.createdAt.getTime() : null,
    checks: checks.length,
    matches: checks.filter((c) => c.decision === 'match').length,
    mismatches: checks.filter((c) => c.decision === 'mismatch').length,
    inconclusive: checks.filter((c) => c.decision === 'inconclusive').length,
    unableToVerify: checks.filter((c) => c.decision === 'unable_to_verify').length,
    idPhoto,
    summary: identitySummary({ clock, session, refs, checks, events: evs, idPhoto, items: timeline.items, endAt }),
  };

  /* -------------------------------------------------------------- event counts */
  const eventCounts = Object.fromEntries(EVENT_CATEGORIES.map((c) => [c, { total: 0, dismissed: 0, reviewed: 0, unreviewed: 0 }])) as SessionReportDTO['eventCounts'];
  for (const e of evs) {
    const c = eventCounts[e.category];
    c.total++;
    c[e.review.status]++;
  }

  const byTypeMap = new Map<EventType, SessionReportDTO['byType'][number]>();
  for (const e of evs) {
    const cur = byTypeMap.get(e.type) ?? { type: e.type, title: EVENT_CATALOG[e.type]?.title ?? e.title, category: e.category, count: 0, totalDurationMs: 0, dismissed: 0 };
    cur.count++;
    cur.totalDurationMs += eventDuration(e, endAt);
    if (e.review.status === 'dismissed') cur.dismissed++;
    byTypeMap.set(e.type, cur);
  }
  const catOrder: Record<EventCategory, number> = { integrity: 0, uncertain: 1, technical: 2, neutral: 3 };
  const byType = [...byTypeMap.values()].sort((a, b) => catOrder[a.category] - catOrder[b.category] || b.count - a.count || (a.type < b.type ? -1 : 1));

  const notableAll = evs
    .filter((e) => (e.category === 'integrity' || e.category === 'uncertain') && e.review.status !== 'dismissed')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  const notableEvents = notableAll.slice(0, NOTABLE_EVENTS_LIMIT);

  /* -------------------------------------------------------------- narrative */
  const observations = buildObservations({ clock, session, exam, periods, events: evs, checks, identity, totals, uncoveredMs: totalsRaw.uncoveredMs, endAt, notableTruncated: notableAll.length - notableEvents.length });
  const limitations = buildLimitations({ clock, periods, events: evs, policy, endAt, evidencePurgedAt: session.evidencePurgedAt?.getTime() ?? null });

  return {
    generatedAt: now,
    session: summary,
    exam: { id: exam.id, title: exam.title, durationSec: exam.durationSec },
    candidate: { id: candidate.id, name: candidate.name, email: candidate.email ?? null, externalId: candidate.externalId ?? null },
    totals,
    periods,
    identity,
    eventCounts,
    byType,
    notableEvents,
    observations,
    reviewerNotes: notes,
    score: session.score ? { points: session.score.points, maxPoints: session.score.maxPoints, autoGraded: session.score.autoGraded } : null,
    limitations,
  };
}

/* ================================================================== identity summary */

interface IdentitySummaryInput {
  clock: Clock;
  session: { status: string; startedAt: Date | null };
  refs: IdentityReference[];
  checks: IdentityCheckDTO[];
  events: EventDTO[];
  idPhoto: { decision: string; similarity: number | null } | null;
  items: TimelineItemDTO[];
  endAt: number;
}

/** What happened just before `at` that makes a swap more plausible (factual phrase, or null). */
export function precedingContext(items: TimelineItemDTO[], at: number, clock: Clock, windowMs = 15 * 60_000): string | null {
  let best: { at: number; phrase: string } | null = null;
  const consider = (t: number | null | undefined, phrase: string) => {
    if (t == null || t > at + 1000 || t < at - windowMs) return;
    if (!best || t >= best.at) best = { at: t, phrase };
  };
  for (const i of items) {
    if (i.kind === 'event') {
      const e = i.event;
      if (e.type === 'session_resumed') consider(e.startedAt, `after the resume at ${clock.time(e.startedAt)}`);
      else if (e.type === 'hold_released') consider(e.startedAt, `after the hold was released at ${clock.time(e.startedAt)}`);
      else if (e.type === 'candidate_absent' && e.endedAt != null) consider(e.endedAt, `after the face returned to view at ${clock.time(e.endedAt)}`);
      else if ((e.type === 'camera_disconnected' || e.type === 'camera_permission_lost') && e.endedAt != null) consider(e.endedAt, `after the camera reconnected at ${clock.time(e.endedAt)}`);
      else if (e.type === 'camera_changed') consider(e.startedAt, `after the camera changed at ${clock.time(e.startedAt)}`);
      else if (e.type === 'multiple_people' && e.endedAt != null) consider(e.endedAt, `after more than one person was in view at ${clock.time(e.startedAt)}`);
      else if (e.type === 'multiple_instances') consider(e.startedAt, `after the exam was opened in another browser at ${clock.time(e.startedAt)}`);
    } else if (i.kind === 'period' && i.period.kind === 'disconnected' && i.period.endedAt != null) {
      consider(i.period.endedAt, `after the exam was reopened at ${clock.time(i.period.endedAt)}`);
    }
  }
  return (best as { at: number; phrase: string } | null)?.phrase ?? null;
}

function heldAfter(events: EventDTO[], at: number, endAt: number): boolean {
  return events.some((e) => e.type === 'session_held' && e.startedAt >= at - 1000 && e.startedAt <= endAt && ['identity_mismatch', 'id_photo_mismatch'].includes(String(e.details.reason ?? '')));
}

export function identitySummary(input: IdentitySummaryInput): string {
  const { clock, refs, checks, events } = input;
  const mismatchEvents = events.filter((e) => e.type === 'identity_mismatch');
  const openMismatch = mismatchEvents.filter((e) => e.review.status !== 'dismissed');
  const dismissedMismatch = mismatchEvents.length - openMismatch.length;
  const unverifiable = events.filter((e) => e.type === 'identity_unverifiable' && e.review.status !== 'dismissed');

  if (refs.length === 0 && checks.length === 0) {
    return input.session.status === 'invited'
      ? 'No identity reference has been established yet because the readiness check has not been completed.'
      : 'No identity reference or identity checks are on record for this session.';
  }

  if (openMismatch.length > 0) {
    const first = openMismatch[0];
    const idPhotoCase = first.details.trigger === 'id_photo' || first.details.against === 'id_photo' || checks.some((c) => c.trigger === 'id_photo' && c.decision === 'mismatch' && Math.abs(c.at - first.startedAt) < 5 * 60_000);
    const outcome = heldAfter(events, first.startedAt, input.endAt) ? 'this was held for review' : 'this was flagged for review';
    if (idPhotoCase && refs.length <= 1 && openMismatch.length === 1) {
      const sim = input.idPhoto?.similarity != null ? ` (similarity ${input.idPhoto.similarity.toFixed(2)})` : '';
      return `The person at check-in may not match the approved ID photo${sim}; ${outcome}.`;
    }
    const ctxPhrase = precedingContext(input.items, first.startedAt, clock) ?? `at ${clock.time(first.startedAt)}`;
    const times = openMismatch.length > 1 ? ` on ${plural(openMismatch.length, 'occasion')}, first` : '';
    return `A different face may have appeared${times} ${ctxPhrase}; ${outcome}.`;
  }

  const count = (pred: (c: IdentityCheckDTO) => boolean) => checks.filter((c) => c.decision === 'match' && pred(c)).length;
  const resumes = count((c) => c.trigger === 'resume');
  const reconnects = count((c) => c.trigger === 'reconnect' || c.trigger === 'reverify');
  const routine = count((c) => ROUTINE_TRIGGERS.has(c.trigger));
  const later = [resumes ? plural(resumes, 'resume') : null, reconnects ? plural(reconnects, 'reconnection or re-verification', 'reconnections or re-verifications') : null, routine ? plural(routine, 'routine check') : null].filter(
    (x): x is string => !!x,
  );
  const unable = checks.filter((c) => c.decision === 'unable_to_verify' || c.decision === 'inconclusive').length;
  const photo = input.idPhoto?.decision === 'match' ? ' (and the approved ID photo)' : '';
  let s = refs.length > 0 ? `The person in view matched the identity reference${photo} at check-in` : 'Identity checks were recorded without an identity reference';
  s += later.length ? `, after ${listJoin(later)}` : '; no later identity checks were recorded';
  const extras: string[] = [];
  if (unverifiable.length) {
    const u = unverifiable[0];
    extras.push(`identity could not be verified at ${clock.time(u.startedAt)}${unverifiable.length > 1 ? ` and ${plural(unverifiable.length - 1, 'other time')}` : ''} because the image was not clear enough, which is not evidence of a different person`);
  } else if (unable) {
    extras.push(`${plural(unable, 'check')} could not reach a dependable result because of image quality, which is not evidence of a different person`);
  }
  if (dismissedMismatch) extras.push(`${plural(dismissedMismatch, 'possible-mismatch observation')} ${dismissedMismatch === 1 ? 'was' : 'were'} dismissed on review`);
  if (extras.length) s += `; ${listJoin(extras)}`;
  return `${s}.`;
}

/* ================================================================== observations */

interface ObservationInput {
  clock: Clock;
  session: typeof examSessions.$inferSelect;
  exam: { durationSec: number };
  periods: PeriodDTO[];
  events: EventDTO[];
  checks: IdentityCheckDTO[];
  identity: SessionReportDTO['identity'];
  totals: SessionReportDTO['totals'];
  uncoveredMs: number;
  endAt: number;
  notableTruncated: number;
}

/** Confidence is meaningful for camera/identity analysis, not for browser signals or technical states. */
function showsConfidence(e: EventDTO): boolean {
  return (e.source === 'client_vision' || e.source === 'server_identity') && (e.category === 'integrity' || e.category === 'uncertain');
}

function describeEvent(e: EventDTO, clock: Clock, endAt: number): string {
  const title = EVENT_CATALOG[e.type]?.title ?? e.title;
  const dur = eventDuration(e, endAt);
  const conf = showsConfidence(e) ? pct(e.confidence) : null;
  const span = EVENT_CATALOG[e.type]?.span !== false && dur > 0;
  const ongoing = e.status === 'open' ? ' (still ongoing)' : '';
  return `${title} at ${clock.time(e.startedAt)}${span ? ` for ${formatDuration(dur)}${ongoing}` : ''}${conf ? ` (confidence ${conf})` : ''}.`;
}

function reviewPhrase(e: EventDTO): string {
  if (e.review.status === 'reviewed') return 'marked as reviewed';
  if (e.review.status === 'dismissed') return 'dismissed on review';
  return 'not yet reviewed';
}

export function buildObservations(input: ObservationInput): string[] {
  const { clock, session, periods, events: evs, identity, totals, endAt } = input;
  const out: string[] = [];
  const firstCheckIn = periods.find((p) => p.kind === 'check_in');

  // Overall lifecycle.
  if (!session.startedAt) {
    if (session.status === 'invited') out.push(firstCheckIn ? `A readiness check was started at ${clock.time(firstCheckIn.startedAt)} but not completed; the exam has not started.` : 'The candidate has not completed the readiness check; the exam has not started.');
    else if (session.status === 'ready') out.push('The readiness check was completed but the exam has not been started.');
    else if (session.endedAt) out.push(`The session was ${session.endReason ? END_REASON_TEXT[session.endReason] : 'ended'} at ${clock.time(session.endedAt.getTime())} before the exam started.`);
    else if (session.status === 'on_hold') out.push('The session is on hold; the exam has not started.');
  } else {
    const started = `The exam started at ${clock.time(session.startedAt.getTime())}`;
    if (session.endedAt) out.push(`${started} and was ${session.endReason ? END_REASON_TEXT[session.endReason] : 'ended'} at ${clock.time(session.endedAt.getTime())}.`);
    else out.push(`${started} and is ${session.status === 'on_hold' ? 'on hold' : session.status === 'paused' ? 'paused' : 'in progress'} (report generated before the end of the exam).`);
    const allowed = session.durationMs;
    out.push(`Exam time used: ${formatDuration(totals.examTimeUsedMs)} of ${formatDuration(allowed)}${allowed !== input.exam.durationSec * 1000 ? ` (the exam allows ${formatDuration(input.exam.durationSec * 1000)}; the difference is extended time)` : ''}.`);
  }
  for (const e of evs.filter((x) => x.type === 'time_extended')) {
    const minutes = typeof e.details.minutes === 'number' ? e.details.minutes : null;
    const note = str(e.details.note);
    out.push(`An administrator extended the exam time${minutes != null ? ` by ${plural(minutes, 'minute')}` : ''} at ${clock.time(e.startedAt)}${note ? ` (“${note}”)` : ''}.`);
  }

  const active = periods.filter((p) => p.kind === 'active');
  if (active.length) out.push(`Monitoring ran for ${formatDuration(totals.activeMs)} of active exam time across ${plural(active.length, 'active period')}.`);
  if (input.uncoveredMs >= 60_000 && session.startedAt) {
    out.push(`${formatDuration(input.uncoveredMs)} fell outside any exam period (for example between the readiness check and the start of the exam); no exam time was used and no observations were made then.`);
  }

  // Pauses, disconnections and holds, in order.
  for (const p of periods) {
    const dur = formatDuration(periodDuration(p, endAt));
    const at = clock.time(p.startedAt);
    const open = p.endedAt == null && !session.endedAt;
    if (p.kind === 'paused') {
      const reason = str(p.reason);
      const timer = p.meta.timerBehavior === 'continue' ? 'the exam clock kept running' : p.meta.timerBehavior === 'stop' ? 'the exam clock was stopped' : null;
      const extra = [reason ? `reason given: “${reason}”` : null, timer].filter(Boolean).join('; ');
      const resumed = p.endedAt != null ? resumedAfter(evs, p.endedAt, clock) : '';
      out.push(open ? `Paused since ${at} (${dur} so far${extra ? `; ${extra}` : ''}); this period is not observed.` : `Paused at ${at} for ${dur}${extra ? ` (${extra})` : ''}${resumed}; this period was not observed.`);
    } else if (p.kind === 'disconnected') {
      out.push(
        open
          ? `The candidate’s browser has been disconnected since ${at} (${dur} so far); this period is not observed.`
          : `The candidate’s browser was disconnected from ${at} to ${clock.time(p.endedAt ?? endAt)} (${dur}); this period was not observed.`,
      );
    } else if (p.kind === 'on_hold') {
      const reason = p.reason && p.reason in HOLD_REASON_TEXT ? HOLD_REASON_TEXT[p.reason as HoldReason] : null;
      const resolution = holdResolution(p, evs, input.checks, clock, endAt, open);
      out.push(`The exam was on hold from ${at} ${open ? `(${dur} so far)` : `for ${dur}`}${reason ? ` because ${reason}` : ''}; ${resolution}. This period was not observed.`);
    }
  }

  // Identity outcomes.
  out.push(identity.summary);
  if (identity.checks > 0) {
    const parts = [
      identity.matches ? `${identity.matches} matched` : null,
      identity.mismatches ? `${identity.mismatches} suggested a possible different person` : null,
      identity.inconclusive ? `${identity.inconclusive} inconclusive` : null,
      identity.unableToVerify ? `${identity.unableToVerify} unable to verify (image not clear enough)` : null,
    ].filter((x): x is string => !!x);
    out.push(`${plural(identity.checks, 'identity check')} ${identity.checks === 1 ? 'was' : 'were'} recorded: ${listJoin(parts)}.`);
  }
  if (identity.idPhoto) {
    const sim = identity.idPhoto.similarity != null ? ` (similarity ${identity.idPhoto.similarity.toFixed(2)})` : '';
    const text: Record<string, string> = {
      match: 'The live candidate matched the approved ID photo',
      mismatch: 'The live candidate may not match the approved ID photo',
      inconclusive: 'The comparison with the approved ID photo was inconclusive',
      unable_to_verify: 'The comparison with the approved ID photo could not be completed because the image was not clear enough',
    };
    out.push(`${text[identity.idPhoto.decision] ?? 'The approved ID photo was compared'}${sim}.`);
  }
  for (const e of evs.filter((x) => x.type === 'identity_mismatch')) {
    const sim = typeof e.details.minSimilarity === 'number' ? ` (lowest similarity ${e.details.minSimilarity.toFixed(2)})` : typeof e.details.similarity === 'number' ? ` (similarity ${e.details.similarity.toFixed(2)})` : '';
    const dur = eventDuration(e, endAt);
    out.push(`A different face may have appeared at ${clock.time(e.startedAt)}${dur > 0 ? ` for ${formatDuration(dur)}` : ''}${sim}; ${reviewPhrase(e)}.`);
  }
  for (const e of evs.filter((x) => x.type === 'identity_unverifiable' && x.review.status !== 'dismissed')) {
    const dur = eventDuration(e, endAt);
    out.push(`Identity could not be verified at ${clock.time(e.startedAt)}${dur > 0 ? ` for ${formatDuration(dur)}` : ''} because the image was not clear enough; this is not evidence of a different person.`);
  }

  // Most significant behavioural / technical observations (grouped by type).
  out.push(...behaviourLines(evs, clock, endAt));
  if (input.notableTruncated > 0) out.push(`The report lists the ${NOTABLE_EVENTS_LIMIT} most significant events; ${input.notableTruncated} further events are available in the session’s event list.`);

  // Delivery delays.
  const outages = evs.filter((e) => e.type === 'reporting_interrupted');
  const late = evs.filter((e) => e.deliveredLate);
  if (outages.length) {
    out.push(
      `Live reporting from the candidate’s browser was interrupted ${plural(outages.length, 'time')} (${formatDuration(unionDurationMs(outages, endAt))} in total)${late.length ? `; ${plural(late.length, 'event')} captured during outages ${late.length === 1 ? 'was' : 'were'} delivered later with ${late.length === 1 ? 'its' : 'their'} original timestamps` : ''}.`,
    );
  } else if (late.length) {
    out.push(`${capFirst(plural(late.length, 'event'))} ${late.length === 1 ? 'was' : 'were'} delivered late (buffered by the candidate’s browser) and ${late.length === 1 ? 'keeps its' : 'keep their'} original timestamps.`);
  }

  // Neutral context.
  const camChanges = evs.filter((e) => e.type === 'camera_changed').length;
  const envChanges = evs.filter((e) => e.type === 'environment_changed').length;
  if (camChanges || envChanges) {
    const parts = [camChanges ? `the camera changed ${plural(camChanges, 'time')}` : null, envChanges ? `the surroundings (lighting, background or camera angle) changed ${plural(envChanges, 'time')}` : null].filter(
      (x): x is string => !!x,
    );
    out.push(`${capFirst(listJoin(parts))}; these changes are recorded as context only and are not evidence of a different person.`);
  }
  const displays = evs.find((e) => e.type === 'additional_display_detected');
  if (displays) out.push(`At ${clock.time(displays.startedAt)} the browser reported more than one connected display; activity on other displays cannot be observed.`);
  return out;
}

function resumedAfter(evs: EventDTO[], at: number, clock: Clock): string {
  const resumed = evs.find((e) => e.type === 'session_resumed' && Math.abs(e.startedAt - at) <= 60_000);
  return resumed ? ` and resumed at ${clock.time(resumed.startedAt)} after the readiness and identity checks` : '';
}

function holdResolution(p: PeriodDTO, evs: EventDTO[], checks: IdentityCheckDTO[], clock: Clock, endAt: number, open: boolean): string {
  const end = p.endedAt ?? endAt;
  const within = (e: EventDTO) => e.startedAt >= p.startedAt && e.startedAt <= end + 1000;
  const released = evs.find((e) => e.type === 'hold_released' && within(e));
  const terminated = evs.find((e) => e.type === 'session_terminated' && within(e));
  const submitted = evs.find((e) => (e.type === 'session_submitted' || e.type === 'session_expired') && within(e));
  const parts: string[] = [];
  if (released) {
    const reEnroll = released.details.reEnroll === true;
    const requireCheck = released.details.requireCheck !== false;
    parts.push(
      `a staff member released the hold at ${clock.time(released.startedAt)}${reEnroll ? ' and authorised a new identity reference' : requireCheck ? ' and required a fresh identity check' : ''}`,
    );
    const reverify = checks.find((c) => (c.trigger === 'reverify' || c.trigger === 'check_in') && c.at >= released.startedAt && c.at <= end + 60_000);
    if (reverify) parts.push(reverify.decision === 'match' ? `the candidate passed the identity check at ${clock.time(reverify.at)}` : `the identity check at ${clock.time(reverify.at)} returned “${reverify.decision.replace(/_/g, ' ')}”`);
  }
  if (terminated) parts.push(`the exam was ended by an administrator at ${clock.time(terminated.startedAt)}`);
  else if (submitted) parts.push(`the exam was submitted at ${clock.time(submitted.startedAt)}`);
  if (parts.length === 0) return open ? 'it is still on hold' : 'the hold ended';
  return listJoin(parts);
}

function behaviourLines(evs: EventDTO[], clock: Clock, endAt: number): string[] {
  const relevant = evs.filter(
    (e) => e.review.status !== 'dismissed' && e.category !== 'neutral' && !['identity_mismatch', 'identity_unverifiable', 'reporting_interrupted'].includes(e.type),
  );
  const groups = new Map<EventType, EventDTO[]>();
  for (const e of relevant) groups.set(e.type, [...(groups.get(e.type) ?? []), e]);
  const catRank: Record<EventCategory, number> = { integrity: 0, uncertain: 1, technical: 2, neutral: 3 };
  const ranked = [...groups.entries()]
    .map(([type, list]) => ({ type, list, severity: Math.max(...list.map((e) => SEVERITY_RANK[e.severity])), total: list.reduce((s, e) => s + eventDuration(e, endAt), 0), category: list[0].category }))
    .sort((a, b) => catRank[a.category] - catRank[b.category] || b.severity - a.severity || b.total - a.total || b.list.length - a.list.length);
  const lines: string[] = [];
  for (const g of ranked.slice(0, MAX_BEHAVIOUR_LINES)) {
    if (g.list.length === 1) {
      lines.push(describeEvent(g.list[0], clock, endAt));
      continue;
    }
    const title = EVENT_CATALOG[g.type]?.title ?? g.list[0].title;
    const longest = [...g.list].sort((a, b) => eventDuration(b, endAt) - eventDuration(a, endAt))[0];
    const span = EVENT_CATALOG[g.type]?.span !== false && g.total > 0;
    const conf = g.list.filter(showsConfidence).map((e) => e.confidence).filter((c): c is number => c != null);
    const confText = conf.length ? `, confidence up to ${pct(Math.max(...conf))}` : '';
    lines.push(
      span
        ? `${title}: ${plural(g.list.length, 'time')}, ${formatDuration(g.total)} in total; the longest began at ${clock.time(longest.startedAt)} and lasted ${formatDuration(eventDuration(longest, endAt))}${confText}.`
        : `${title}: ${plural(g.list.length, 'time')}, first at ${clock.time(g.list[0].startedAt)}${confText}.`,
    );
  }
  if (ranked.length > MAX_BEHAVIOUR_LINES) {
    const rest = ranked.slice(MAX_BEHAVIOUR_LINES).map((g) => lcFirst(EVENT_CATALOG[g.type]?.title ?? g.type));
    lines.push(`Other observations: ${listJoin(rest)} (see the event list).`);
  }
  return lines;
}

/* ================================================================== limitations */

interface LimitationInput {
  clock: Clock;
  periods: PeriodDTO[];
  events: EventDTO[];
  policy: ProctoringPolicy;
  endAt: number;
  evidencePurgedAt: number | null;
}

export const FIXED_LIMITATIONS = {
  scope: 'The system cannot observe other monitors, other devices, or the room outside the camera’s view; it reports only what the camera and the exam page show.',
  probabilistic:
    'Detection is probabilistic: events are observations with a confidence level, not conclusions. Some events may be missed and some may be raised in error, so each should be reviewed with its evidence.',
  unableToVerify: '“Unable to verify” means an image was not clear enough for a dependable comparison; it is not evidence of a different person.',
  environment: 'Changes in clothing, hairstyle, glasses, background, lighting or camera angle are recorded as context only and are not evidence of a different person.',
} as const;

const PERIOD_NOUN: Partial<Record<PeriodKind, string>> = { paused: 'pause', disconnected: 'disconnection', on_hold: 'hold' };

export function buildLimitations(input: LimitationInput): string[] {
  const { clock, periods, events: evs, policy, endAt } = input;
  const out: string[] = [FIXED_LIMITATIONS.scope];

  const unobserved = periods.filter((p) => UNOBSERVED.includes(p.kind));
  if (unobserved.length) {
    const list = unobserved.map((p) => `${PERIOD_NOUN[p.kind] ?? p.kind} at ${clock.time(p.startedAt)} (${formatDuration(periodDuration(p, endAt))}${p.endedAt == null ? ', ongoing' : ''})`);
    out.push(`No observations were made during unobserved periods: ${listJoin(list)}.`);
  } else {
    out.push('There were no unobserved periods (pauses, disconnections or holds).');
  }
  out.push(FIXED_LIMITATIONS.probabilistic, FIXED_LIMITATIONS.unableToVerify, FIXED_LIMITATIONS.environment);

  const dur = (types: EventType[]) => unionDurationMs(evs.filter((e) => types.includes(e.type)), endAt);
  const degraded = dur(['monitoring_degraded']);
  if (degraded > 0) out.push(`Camera analysis was degraded for ${formatDuration(degraded)} on this device; some detections may have been missed during that time.`);
  const lighting = dur(['lighting_unusable']);
  if (lighting > 0) out.push(`Lighting was too poor for dependable monitoring for ${formatDuration(lighting)}.`);
  const obstructed = dur(['face_obstructed']);
  if (obstructed > 0) out.push(`The face was obstructed or unclear for ${formatDuration(obstructed)}; gaze and identity could not be assessed during that time.`);
  const camera = dur(CAMERA_OUTAGE_TYPES);
  if (camera > 0) out.push(`The camera provided no usable image for ${formatDuration(camera)} in total (disconnected, covered, frozen or without permission).`);
  const reporting = dur(['reporting_interrupted']);
  if (reporting > 0) out.push(`Live reporting was interrupted for ${formatDuration(reporting)}; observations captured during the outage were delivered later with their original timestamps.`);

  const disabled = (Object.keys(DETECTOR_LABELS) as (keyof typeof DETECTOR_LABELS)[]).filter((k) => policy.detection.enabled[k] === false).map((k) => DETECTOR_LABELS[k]);
  if (disabled.length) out.push(`The exam rules turned off ${listJoin(disabled)}, so ${disabled.length === 1 ? 'this was' : 'these were'} not monitored.`);
  if (policy.identity.liveness === 'off') out.push('The live-person check was turned off by the exam rules.');
  const browserOff = [policy.browser.flagTabHidden ? null : 'leaving the exam tab', policy.browser.flagWindowBlur ? null : 'the exam window losing focus'].filter((x): x is string => !!x);
  if (browserOff.length) out.push(`The exam rules turned off recording of ${listJoin(browserOff)}.`);
  if (!policy.evidence.screenshots) out.push('Screenshots were turned off by the exam rules, so events have no images.');
  if (input.evidencePurgedAt != null) out.push(`Screenshots and identity images were deleted on ${clock.dateTime(input.evidencePurgedAt)} under the retention policy; the event records remain.`);
  return out;
}
