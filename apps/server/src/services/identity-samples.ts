/**
 * Mid-exam identity samples (POST /api/candidate/identity/sample), ARCHITECTURE §4.5.
 *
 *  - Idempotent on sampleId (a replay returns the stored result).
 *  - Each sample is compared with the ACTIVE (immutable) reference.
 *  - One mismatch => ask for a follow-up sample. `mismatchConfirmations` consecutive quality mismatches
 *    => open (or extend) an identity_mismatch event with probe + reference evidence and context, then
 *    hold or flag per policy. Two consecutive matches close it.
 *  - 3 consecutive unable_to_verify / inconclusive => identity_unverifiable (uncertain; NEVER a mismatch),
 *    closed by the next match.
 *  - Server-side feed check: >= 3 consecutive samples with an identical dHash => camera_feed_suspect.
 */
import { randomUUID } from 'node:crypto';
import type { IdentityCheckTrigger, IdentitySampleResponse } from '@sp/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { events, evidence, examSessions, identityChecks, type ExamSession, type IdentityCheck } from '../db/schema.js';
import { invalidState } from '../lib/errors.js';
import { decideIdentity, hammingHex, maxSimilarity, type ImageAnalysis } from '../vision/index.js';
import { assertInControl } from './candidate-state.js';
import { toHoldDTO } from './dto.js';
import { storeEvidence } from './evidence.js';
import { copyEvidence, loadActiveReference, precedingContext, toIdentityResultDTO } from './identity-common.js';
import { holdNow, identityState, withSession, type SessionMutation } from './session-state.js';

export const FOLLOW_UP_MS = 4_000;
export const UNABLE_RETRY_MS = 10_000;
export const UNVERIFIABLE_AFTER = 3;
export const IDENTICAL_SAMPLES_SUSPECT = 3;
export const CLOSE_MISMATCH_AFTER_MATCHES = 2;
const MAX_EVIDENCE_PER_MISMATCH_EVENT = 12;

export interface SampleInput {
  sampleId: string;
  trigger: IdentityCheckTrigger;
  capturedAt: number;
}

function safeHamming(a: string | null, b: string | null): number {
  if (!a || !b) return 64;
  try {
    return hammingHex(a, b);
  } catch {
    return 64;
  }
}

async function replay(ctx: Ctx, sessionId: string, row: IdentityCheck): Promise<IdentitySampleResponse> {
  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, sessionId));
  const stored = (row.response ?? {}) as { followUpInMs?: number | null };
  return { result: toIdentityResultDTO(row), followUpInMs: stored.followUpInMs ?? null, status: s.status, hold: toHoldDTO(s) };
}

export async function processIdentitySample(ctx: Ctx, session: ExamSession, instanceId: string, q: SampleInput, jpeg: Buffer): Promise<IdentitySampleResponse> {
  const [existing] = await ctx.db
    .select()
    .from(identityChecks)
    .where(and(eq(identityChecks.sessionId, session.id), eq(identityChecks.sampleId, q.sampleId)));
  if (existing) return replay(ctx, session.id, existing);

  assertInControl(session, instanceId);
  if (!['active', 'paused', 'on_hold'].includes(session.status)) throw invalidState('Identity samples are only accepted during the exam');

  const active = await loadActiveReference(ctx, ctx.db, session.id);
  if (!active) throw invalidState('No identity reference exists for this exam');
  const analysis: ImageAnalysis = await ctx.vision.analyze(jpeg, { embed: true, faceCrop: true });

  const out = await withSession(ctx, session.id, async (m) => {
    const [dup] = await m.tx
      .select()
      .from(identityChecks)
      .where(and(eq(identityChecks.sessionId, session.id), eq(identityChecks.sampleId, q.sampleId)));
    if (dup) return { row: dup, followUpInMs: ((dup.response ?? {}) as { followUpInMs?: number | null }).followUpInMs ?? null };
    assertInControl(m.session, instanceId);

    const now = m.now;
    const at = Math.min(Number.isFinite(q.capturedAt) ? q.capturedAt : now, now + 5_000);
    const s = m.session;
    const open = await m.openPeriodRow();
    // Late delivery: a sample captured before the current pause/hold is recorded, but drives no actions.
    let recordOnly = false;
    if (s.status !== 'active') {
      if (open && !open.observed && at < open.startedAt.getTime()) recordOnly = true;
      else throw invalidState('The exam is not active');
    }
    const policy = await m.policy();
    const thresholds = await m.thresholds();
    const sim = analysis.embedding ? maxSimilarity(analysis.embedding, active.embeddings) : null;
    const cmp = decideIdentity(sim, analysis.quality, thresholds, 'reference');
    const st = identityState(s);
    const pre = await precedingContext(m.tx, s.id, at, q.trigger);
    const context = {
      precededBy: pre.precededBy,
      periodKind: open?.kind ?? null,
      secondsSincePreviousMatch: st.lastMatchAt ? Math.round((at - st.lastMatchAt) / 1000) : null,
      recentEvents: pre.recentEvents,
      recordOnly,
    };

    const checkId = randomUUID();
    const keep = cmp.decision !== 'match' || policy.evidence.keepMatchingIdentitySamples;
    let probeId: string | null = null;
    let frameId: string | null = null;
    if (keep) {
      const base = { orgId: s.orgId, sessionId: s.id, candidateId: s.candidateId, kind: 'identity_probe' as const, capturedAt: at, identityCheckId: checkId, clientInstanceId: instanceId };
      if (analysis.faceCropJpeg) probeId = (await storeEvidence(ctx, m.tx, { ...base, reason: 'face_crop', data: analysis.faceCropJpeg })).row.id;
      frameId = (await storeEvidence(ctx, m.tx, { ...base, reason: 'frame', data: jpeg })).row.id;
    }
    const [row] = await m.tx
      .insert(identityChecks)
      .values({
        id: checkId,
        sessionId: s.id,
        sampleId: q.sampleId,
        trigger: q.trigger,
        decision: cmp.decision,
        similarity: cmp.similarity,
        confidence: cmp.confidence,
        quality: analysis.quality,
        guidance: cmp.guidance,
        at: new Date(at),
        receivedAt: new Date(now),
        probeEvidenceId: probeId ?? frameId,
        frameEvidenceId: frameId,
        referenceId: active.ref.id,
        dhash: analysis.dhash,
        clientInstanceId: instanceId,
        context,
      })
      .returning();
    m.publishIdentityCheck(row.id);

    let followUpInMs: number | null = null;
    if (!recordOnly) {
      m.set({ lastIdentityDecision: cmp.decision, lastIdentityAt: new Date(at), lastIdentitySimilarity: cmp.similarity });
      followUpInMs = await aggregate(m, row, analysis, { probeId, frameId, active: active.ref.imageEvidenceIds, policyHold: policy.identity.onMismatch === 'hold_for_review', confirmations: thresholds.mismatchConfirmations, maxShots: MAX_EVIDENCE_PER_MISMATCH_EVENT, ctx });
    }
    const response = { followUpInMs };
    await m.tx.update(identityChecks).set({ response }).where(eq(identityChecks.id, row.id));
    return { row: { ...row, response }, followUpInMs };
  });

  const [s] = await ctx.db.select().from(examSessions).where(eq(examSessions.id, session.id));
  return { result: toIdentityResultDTO(out.row), followUpInMs: out.followUpInMs, status: s.status, hold: toHoldDTO(s) };
}

interface AggOpts {
  probeId: string | null;
  frameId: string | null;
  active: string[];
  policyHold: boolean;
  confirmations: number;
  maxShots: number;
  ctx: Ctx;
}

async function aggregate(m: SessionMutation, row: IdentityCheck, analysis: ImageAnalysis, o: AggOpts): Promise<number | null> {
  const st = identityState(m.session);
  const at = row.at.getTime();
  let followUp: number | null = null;

  // ---- server-side feed integrity: identical frames across samples taken seconds apart
  const identical = safeHamming(st.lastSampleDhash, analysis.dhash) === 0;
  st.identicalDhashStreak = identical ? Math.max(2, st.identicalDhashStreak + 1) : 1;
  st.lastSampleDhash = analysis.dhash;
  if (st.identicalDhashStreak >= IDENTICAL_SAMPLES_SUSPECT && !st.openFeedSuspectEventId) {
    const ev = await m.addEvent({
      type: 'camera_feed_suspect',
      source: 'server_identity',
      open: true,
      startedAt: at,
      confidence: 0.9,
      observation: 'Several identity images taken seconds apart were pixel-identical, which a live camera does not normally produce.',
      details: { signal: 'identical_identity_samples', samples: st.identicalDhashStreak, dhash: analysis.dhash },
      context: { trigger: row.trigger },
    });
    st.openFeedSuspectEventId = ev.id;
    if (o.frameId) await m.tx.update(evidence).set({ eventId: ev.id }).where(eq(evidence.id, o.frameId));
  } else if (st.openFeedSuspectEventId && st.identicalDhashStreak >= IDENTICAL_SAMPLES_SUSPECT) {
    const [cur] = await m.tx.select({ details: events.details }).from(events).where(eq(events.id, st.openFeedSuspectEventId));
    await m.updateEvent(st.openFeedSuspectEventId, { details: { ...(cur?.details ?? {}), samples: st.identicalDhashStreak } });
  } else if (st.openFeedSuspectEventId && !identical) {
    await m.closeEvent(st.openFeedSuspectEventId, at, { closedBy: 'frames_changing' });
    st.openFeedSuspectEventId = null;
  }

  switch (row.decision) {
    case 'match': {
      st.consecutiveMatch += 1;
      st.consecutiveMismatch = 0;
      st.consecutiveUnable = 0;
      st.pendingMismatchCheckIds = [];
      st.lastMatchAt = at;
      st.followUpRequestedAt = null;
      if (st.openUnverifiableEventId) {
        await m.closeEvent(st.openUnverifiableEventId, at, { closedBy: 'identity_match' });
        st.openUnverifiableEventId = null;
      }
      if (st.openMismatchEventId) {
        if (st.consecutiveMatch >= CLOSE_MISMATCH_AFTER_MATCHES) {
          await m.closeEvent(st.openMismatchEventId, at, { closedBy: 'consecutive_matches' });
          st.openMismatchEventId = null;
        } else followUp = FOLLOW_UP_MS; // confirm the return of the original person
      }
      break;
    }
    case 'mismatch': {
      st.consecutiveMismatch += 1;
      st.consecutiveMatch = 0;
      st.consecutiveUnable = 0;
      st.pendingMismatchCheckIds = [...st.pendingMismatchCheckIds, row.id].slice(-20);
      if (st.openUnverifiableEventId) {
        await m.closeEvent(st.openUnverifiableEventId, at, { closedBy: 'clear_image' });
        st.openUnverifiableEventId = null;
      }
      if (st.openMismatchEventId) {
        await extendMismatch(m, st.openMismatchEventId, row, o);
        followUp = null;
      } else if (st.consecutiveMismatch >= o.confirmations) {
        const evId = await openMismatch(m, st.pendingMismatchCheckIds, row, o);
        st.openMismatchEventId = evId;
        st.followUpRequestedAt = null;
        if (o.policyHold) {
          m.setIdentityState(st);
          await holdNow(m, { reason: 'identity_mismatch', source: 'server_identity', details: { eventId: evId, trigger: row.trigger } });
          m.set({ verifiedInstanceId: null });
          return null;
        }
      } else {
        followUp = FOLLOW_UP_MS;
        st.followUpRequestedAt = m.now;
      }
      break;
    }
    default: {
      // unable_to_verify / inconclusive: uncertain, never evidence of a different person.
      st.consecutiveUnable += 1;
      st.consecutiveMatch = 0;
      if (st.consecutiveUnable >= UNVERIFIABLE_AFTER && !st.openUnverifiableEventId) {
        const ev = await m.addEvent({
          type: 'identity_unverifiable',
          source: 'server_identity',
          open: true,
          startedAt: at,
          confidence: row.confidence,
          details: { samples: st.consecutiveUnable, lastDecision: row.decision, issues: row.quality?.issues ?? [], guidance: row.guidance, trigger: row.trigger },
          context: { precededBy: row.context?.precededBy ?? [], periodKind: row.context?.periodKind ?? null },
        });
        st.openUnverifiableEventId = ev.id;
        await m.tx.update(identityChecks).set({ eventId: ev.id }).where(eq(identityChecks.id, row.id));
        if (o.probeId) await m.tx.update(evidence).set({ eventId: ev.id }).where(eq(evidence.id, o.probeId));
      }
      // A pending (unconfirmed) mismatch still needs confirmation; otherwise retry soon with guidance.
      followUp = st.consecutiveMismatch > 0 ? FOLLOW_UP_MS : UNABLE_RETRY_MS;
      break;
    }
  }
  m.setIdentityState(st);
  return followUp;
}

async function openMismatch(m: SessionMutation, pendingIds: string[], row: IdentityCheck, o: AggOpts): Promise<string> {
  const rows = pendingIds.length ? await m.tx.select().from(identityChecks).where(inArray(identityChecks.id, pendingIds)) : [row];
  const sims = rows.map((r) => r.similarity).filter((x): x is number => x != null);
  const startedAt = Math.min(...rows.map((r) => r.at.getTime()));
  const precededBy = [...new Set(rows.flatMap((r) => r.context?.precededBy ?? []))];
  const ev = await m.addEvent({
    type: 'identity_mismatch',
    source: 'server_identity',
    open: true,
    startedAt,
    confidence: rows.reduce((a, r) => a + r.confidence, 0) / Math.max(1, rows.length),
    observation: precededBy.includes('face_absence')
      ? 'A different face may have appeared after the candidate left and returned to the camera view.'
      : precededBy.includes('camera_reconnect') || precededBy.includes('camera_disconnect')
        ? 'A different face may have appeared after the camera was reconnected.'
        : 'The face in view may belong to a different person than the one who started the exam.',
    details: {
      against: 'reference',
      samples: rows.length,
      minSimilarity: sims.length ? Math.min(...sims) : null,
      maxSimilarity: sims.length ? Math.max(...sims) : null,
      identityCheckIds: rows.map((r) => r.id),
      triggers: [...new Set(rows.map((r) => r.trigger))],
    },
    context: { precededBy, trigger: rows[0]?.trigger ?? row.trigger, periodKind: row.context?.periodKind ?? null },
  });
  await m.tx.update(identityChecks).set({ eventId: ev.id }).where(inArray(identityChecks.id, rows.map((r) => r.id)));
  const probeIds = rows.flatMap((r) => [r.probeEvidenceId, r.frameEvidenceId]).filter((x): x is string => !!x);
  if (probeIds.length) await m.tx.update(evidence).set({ eventId: ev.id }).where(inArray(evidence.id, probeIds));
  if (o.active.length) {
    const refs = await m.tx.select().from(evidence).where(inArray(evidence.id, o.active));
    for (const r of refs) await copyEvidence(o.ctx, m.tx, r, { kind: 'identity_reference', eventId: ev.id });
  }
  return ev.id;
}

async function extendMismatch(m: SessionMutation, eventId: string, row: IdentityCheck, o: AggOpts): Promise<void> {
  const [cur] = await m.tx.select().from(events).where(eq(events.id, eventId));
  if (!cur) return;
  const d = cur.details as { samples?: number; minSimilarity?: number | null; maxSimilarity?: number | null; identityCheckIds?: string[] };
  const sim = row.similarity;
  await m.updateEvent(eventId, {
    details: {
      ...cur.details,
      samples: (d.samples ?? 0) + 1,
      minSimilarity: sim != null ? Math.min(d.minSimilarity ?? sim, sim) : (d.minSimilarity ?? null),
      maxSimilarity: sim != null ? Math.max(d.maxSimilarity ?? sim, sim) : (d.maxSimilarity ?? null),
      identityCheckIds: [...(d.identityCheckIds ?? []), row.id].slice(-50),
      lastSampleAt: row.at.getTime(),
    },
  });
  await m.tx.update(identityChecks).set({ eventId }).where(eq(identityChecks.id, row.id));
  const [{ n }] = await m.tx.select({ n: sql<number>`count(*)::int` }).from(evidence).where(eq(evidence.eventId, eventId));
  const ids = [o.probeId, o.frameId].filter((x): x is string => !!x);
  if (ids.length && n < o.maxShots) await m.tx.update(evidence).set({ eventId }).where(inArray(evidence.id, ids));
}

