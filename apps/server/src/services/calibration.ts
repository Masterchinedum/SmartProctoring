/**
 * Calibration by condition and drift (Quality page; packages/shared/src/governance.ts).
 *
 *  - Identity decisions broken down by the conditions that move them: face lighting, camera resolution, browser,
 *    operating system, and the decision configuration / calibration / recogniser model that made them. Grouped in
 *    SQL (one row per combination), User-Agents folded into families here.
 *  - Drift: recent (7 days) against a baseline (the 28 days before), per segment, with a conservative
 *    two-proportion test (compareRates) — identity outcome rates, the share of exams with each kind of flag, and the
 *    share of decided flags reviewers found to be false detections. Version changes inside the windows (a decision
 *    configuration activated, a new calibration, model or browser engine seen) are listed next to the signals,
 *    because they are the first suspects.
 *
 * No candidate demographics exist or are inferred: fairness across people is measured in consented pilots
 * (docs/accuracy/), not on live candidates.
 */
import {
  browserFamily,
  compareRates,
  lightingClass,
  osFamily,
  resolutionClass,
  type CalibrationDTO,
  type CalibrationSegmentDTO,
  type DriftDTO,
  type DriftSignalDTO,
  type IdentityDecision,
} from '@sp/shared';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { decisionConfigs, events, examSessions, identityChecks } from '../db/schema.js';

export const DRIFT_RECENT_DAYS = 7;
export const DRIFT_BASELINE_DAYS = 28;
const DAY = 86_400_000;

type Dim = CalibrationSegmentDTO['dimension'];

type DecisionRow = {
  decision: IdentityDecision;
  brightness: number | null;
  videoHeight: number | null;
  ua: string | null;
  configVersion: number | null;
  calibrationVersion: string | null;
  modelVersion: string | null;
  n: number;
};

/**
 * Identity decisions of the organisation in [from, to), grouped by everything the segments need. The decisions are
 * grouped per session first (identity_checks_at_idx bounds the scan to the window); each session's latest device
 * record (camera resolution, browser) is then looked up once, for those sessions only.
 */
async function decisionRows(db: DbOrTx, orgId: string, from: number, to: number): Promise<DecisionRow[]> {
  const res = await db.execute<DecisionRow>(sql`
    with g as (
      select c.session_id, c.decision,
        round(((c.quality ->> 'brightness')::numeric) / 5) * 5 as brightness,
        c.decision_config_version, c.calibration_version, c.model_version,
        count(*)::int as n
      from identity_checks c
      join exam_sessions s on s.id = c.session_id
      where s.org_id = ${orgId} and c.at >= ${new Date(from)} and c.at < ${new Date(to)} and c.trigger <> 'id_photo'
      group by 1, 2, 3, 4, 5, 6
    ),
    dev as (
      select distinct on (d.session_id) d.session_id, d.video_height, d.user_agent
      from device_records d
      where d.session_id in (select session_id from g)
      order by d.session_id, d.at desc
    )
    select g.decision, g.brightness as "brightness", dev.video_height as "videoHeight", dev.user_agent as "ua",
      g.decision_config_version as "configVersion", g.calibration_version as "calibrationVersion", g.model_version as "modelVersion",
      sum(g.n)::int as n
    from g left join dev on dev.session_id = g.session_id
    group by 1, 2, 3, 4, 5, 6, 7`);
  return res.rows.map((r) => ({ ...r, brightness: r.brightness == null ? null : Number(r.brightness), n: Number(r.n) }));
}

const SEGMENTERS: Record<Dim, (r: DecisionRow) => string> = {
  lighting: (r) => lightingClass(r.brightness),
  resolution: (r) => resolutionClass(r.videoHeight),
  browser: (r) => (r.ua ? browserFamily(r.ua) : 'unknown'),
  os: (r) => (r.ua ? osFamily(r.ua) : 'unknown'),
  decisionConfig: (r) => (r.configVersion != null ? `v${r.configVersion}` : 'unrecorded'),
  calibration: (r) => r.calibrationVersion ?? 'unrecorded',
  model: (r) => r.modelVersion ?? 'unrecorded',
};

function fold(rows: DecisionRow[], dim: Dim): CalibrationSegmentDTO[] {
  const by = new Map<string, CalibrationSegmentDTO>();
  for (const r of rows) {
    const key = SEGMENTERS[dim](r);
    const cur = by.get(key) ?? { dimension: dim, segment: key, samples: 0, match: 0, inconclusive: 0, mismatch: 0, unableToVerify: 0 };
    cur.samples += r.n;
    if (r.decision === 'match') cur.match += r.n;
    else if (r.decision === 'inconclusive') cur.inconclusive += r.n;
    else if (r.decision === 'mismatch') cur.mismatch += r.n;
    else cur.unableToVerify += r.n;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.samples - a.samples);
}

export const CALIBRATION_DIMENSIONS: Dim[] = ['lighting', 'resolution', 'browser', 'os', 'decisionConfig', 'calibration', 'model'];

export async function calibrationBreakdown(db: DbOrTx, orgId: string, from: number, to: number): Promise<CalibrationDTO> {
  const rows = await decisionRows(db, orgId, from, to);
  return { from, to, samples: rows.reduce((a, r) => a + r.n, 0), segments: CALIBRATION_DIMENSIONS.flatMap((d) => fold(rows, d)) };
}

/* ------------------------------------------------------------------ drift */

export async function driftReport(db: DbOrTx, orgId: string, now: number): Promise<DriftDTO> {
  const recent = { from: now - DRIFT_RECENT_DAYS * DAY, to: now };
  const baseline = { from: recent.from - DRIFT_BASELINE_DAYS * DAY, to: recent.from };
  const signals: DriftSignalDTO[] = [];

  // Identity outcome rates, overall and per condition.
  const [rRows, bRows] = await Promise.all([decisionRows(db, orgId, recent.from, recent.to), decisionRows(db, orgId, baseline.from, baseline.to)]);
  for (const dim of ['overall', 'lighting', 'resolution', 'browser'] as const) {
    const rSeg = dim === 'overall' ? [total(rRows)] : fold(rRows, dim);
    const bSeg = dim === 'overall' ? [total(bRows)] : fold(bRows, dim);
    for (const r of rSeg) {
      const b = bSeg.find((x) => x.segment === r.segment);
      if (!b) continue;
      for (const metric of ['unableToVerify', 'mismatch'] as const) {
        const c = compareRates({ n: r.samples, k: r[metric] }, { n: b.samples, k: b[metric] });
        signals.push({ area: 'identity', metric: metric === 'unableToVerify' ? 'unable_to_verify_rate' : 'mismatch_rate', dimension: dim, segment: r.segment, comparison: c });
      }
    }
  }

  // Share of started exams with each kind of flag, and the false-detection share among decided flags.
  const [rFlags, bFlags] = await Promise.all([flagRows(db, orgId, recent.from, recent.to), flagRows(db, orgId, baseline.from, baseline.to)]);
  const [rStarted, bStarted] = await Promise.all([startedSessions(db, orgId, recent.from, recent.to), startedSessions(db, orgId, baseline.from, baseline.to)]);
  for (const r of rFlags) {
    const b = bFlags.find((x) => x.type === r.type);
    if (!b) continue;
    signals.push({ area: 'detector', metric: 'sessions_with_flag', dimension: 'type', segment: r.type, comparison: compareRates({ n: rStarted, k: r.sessions }, { n: bStarted, k: b.sessions }) });
    signals.push({ area: 'detector', metric: 'false_detection_share', dimension: 'type', segment: r.type, comparison: compareRates({ n: r.decided, k: r.falseDetections }, { n: b.decided, k: b.falseDetections }, { minN: 30 }) });
  }

  return {
    recent,
    baseline,
    signals: signals.sort((a, b) => Number(b.comparison.drift) - Number(a.comparison.drift) || Math.abs(b.comparison.z ?? 0) - Math.abs(a.comparison.z ?? 0)),
    changes: await versionChanges(db, orgId, baseline.from, now),
  };
}

function total(rows: DecisionRow[]): CalibrationSegmentDTO {
  const t = fold(rows.map((r) => ({ ...r, calibrationVersion: 'all' })), 'calibration')[0];
  return { ...(t ?? { samples: 0, match: 0, inconclusive: 0, mismatch: 0, unableToVerify: 0 }), dimension: 'calibration', segment: 'all' };
}

async function flagRows(db: DbOrTx, orgId: string, from: number, to: number) {
  return db
    .select({
      type: events.type,
      sessions: sql<number>`count(distinct ${events.sessionId})::int`,
      decided: sql<number>`count(*) filter (where ${events.reviewStatus} <> 'unreviewed' and ${events.resolution} is distinct from 'inconclusive')::int`,
      falseDetections: sql<number>`count(*) filter (where ${events.reviewStatus} = 'dismissed')::int`,
    })
    .from(events)
    .where(and(eq(events.orgId, orgId), gte(events.startedAt, new Date(from)), lt(events.startedAt, new Date(to)), sql`${events.category} in ('integrity', 'uncertain', 'technical')`))
    .groupBy(events.type);
}

async function startedSessions(db: DbOrTx, orgId: string, from: number, to: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(examSessions)
    .where(and(eq(examSessions.orgId, orgId), isNotNull(examSessions.startedAt), gte(examSessions.startedAt, new Date(from)), lt(examSessions.startedAt, new Date(to))));
  return r?.n ?? 0;
}

/** When a decision configuration was activated, and when a calibration, recogniser model or browser engine was first seen. */
async function versionChanges(db: DbOrTx, orgId: string, from: number, to: number): Promise<DriftDTO['changes']> {
  const configs = await db
    .select({ version: decisionConfigs.version, at: decisionConfigs.activatedAt, rollbackOf: decisionConfigs.rollbackOfVersion })
    .from(decisionConfigs)
    .where(and(eq(decisionConfigs.orgId, orgId), isNotNull(decisionConfigs.activatedAt), gte(decisionConfigs.activatedAt, new Date(from))));
  const firstSeen = async (col: typeof identityChecks.calibrationVersion | typeof identityChecks.modelVersion) =>
    db
      .select({ v: col, at: sql<Date>`min(${identityChecks.at})` })
      .from(identityChecks)
      .innerJoin(examSessions, eq(examSessions.id, identityChecks.sessionId))
      .where(and(eq(examSessions.orgId, orgId), isNotNull(col)))
      .groupBy(col);
  const [cal, model, engines] = await Promise.all([
    firstSeen(identityChecks.calibrationVersion),
    firstSeen(identityChecks.modelVersion),
    db
      .select({ v: events.engineVersion, at: sql<Date>`min(${events.startedAt})` })
      .from(events)
      .where(and(eq(events.orgId, orgId), isNotNull(events.engineVersion)))
      .groupBy(events.engineVersion),
  ]);
  const inWindow = (at: Date | string | null) => at != null && new Date(at).getTime() >= from && new Date(at).getTime() <= to;
  return [
    ...configs.filter((c) => inWindow(c.at)).map((c) => ({ at: c.at!.getTime(), kind: 'decision_config' as const, label: c.rollbackOf ? `Decision configuration v${c.version} (restores v${c.rollbackOf})` : `Decision configuration v${c.version}` })),
    ...cal.filter((c) => inWindow(c.at)).map((c) => ({ at: new Date(c.at).getTime(), kind: 'calibration' as const, label: `Calibration ${c.v}` })),
    ...model.filter((c) => inWindow(c.at)).map((c) => ({ at: new Date(c.at).getTime(), kind: 'model' as const, label: `Recogniser model ${c.v}` })),
    ...engines.filter((c) => inWindow(c.at)).map((c) => ({ at: new Date(c.at).getTime(), kind: 'engine' as const, label: `Browser detectors ${c.v}` })),
  ].sort((a, b) => a.at - b.at);
}
