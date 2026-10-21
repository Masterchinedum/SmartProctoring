/**
 * Accommodations (packages/shared/src/accommodations.ts): approved per-candidate exceptions to exam rules.
 *
 *  - Records (table accommodations) are granted and revoked, never edited, by administrators; each grant / revocation
 *    is audit-logged (never the note, which is encrypted at rest and shown to administrators only).
 *  - A session carries a snapshot (exam_sessions.accommodations) of the ones that apply to it. Until the exam starts
 *    the snapshot follows the records (`refreshSessionAccommodations`, after every grant / revocation, at assignment
 *    and again at start); from the start it is frozen with the policy snapshot, together with the exact list of exam
 *    rules it changed (`exceptions`), so a later grant or revocation never changes a running or finished attempt.
 *  - Extra time is part of exam_sessions.duration_ms (`extraTimeMs` says how much of it).
 */
import {
  ACCOMMODATION_CATALOG,
  accommodationApplies,
  accommodationExtraTimeMs,
  applyAccommodations,
  policyExceptions,
  type AccommodationDTO,
  type AccommodationStatus,
  type PolicyExceptionDTO,
  type ProctoringPolicy,
  type SessionAccommodationsDTO,
} from '@sp/shared';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { accommodations, examSessions, exams, staffUsers, type Accommodation, type ExamSession, type SessionAccommodations } from '../db/schema.js';
import type { Keyring } from '../lib/crypto.js';
import type { SessionMutation } from './session-state.js';

export const accommodationNoteAad = (id: string) => `accommodation-note:${id}`;

/** Statuses of sessions whose accommodations still follow the records (the exam has not started). */
export const UNSTARTED = ['invited', 'ready', 'on_hold'] as const;

export function accommodationStatus(a: Pick<Accommodation, 'revokedAt' | 'validUntil'>, now: number): AccommodationStatus {
  if (a.revokedAt) return 'revoked';
  if (a.validUntil && a.validUntil.getTime() <= now) return 'expired';
  return 'active';
}

/** The records that apply to a candidate's attempt at an exam now (oldest first). */
export async function applicableAccommodations(db: DbOrTx, candidateId: string, examId: string, now: number): Promise<Accommodation[]> {
  const rows = await db
    .select()
    .from(accommodations)
    .where(and(eq(accommodations.candidateId, candidateId), isNull(accommodations.revokedAt), or(isNull(accommodations.examId), eq(accommodations.examId, examId))))
    .orderBy(accommodations.grantedAt);
  return rows.filter((a) => accommodationApplies({ examId: a.examId, validUntil: a.validUntil?.getTime() ?? null, revokedAt: null }, examId, now));
}

/** A session's snapshot of the records that apply (null: none), for an exam of `baseDurationMs`. */
export function sessionSnapshot(rows: readonly Accommodation[], baseDurationMs: number, now: number): SessionAccommodations | null {
  if (!rows.length) return null;
  const items = rows.map((a) => ({ id: a.id, kind: a.kind, params: a.params, basis: a.basis, grantedAt: a.grantedAt.getTime() }));
  return { items, extraTimeMs: accommodationExtraTimeMs(baseDurationMs, items), at: now };
}

/** The session's duration without accommodation extra time (staff extensions are kept). */
export function baseDurationMs(s: Pick<ExamSession, 'durationMs' | 'accommodations'>): number {
  return s.durationMs - (s.accommodations?.extraTimeMs ?? 0);
}

/**
 * Bring an unstarted session's snapshot (and duration) in line with the records. No-op once the exam started: from
 * then on the snapshot is part of the attempt (startExam freezes it).
 */
export async function refreshSessionAccommodations(m: SessionMutation): Promise<void> {
  const s = m.session;
  if (s.startedAt != null || !(UNSTARTED as readonly string[]).includes(s.status)) return;
  const base = baseDurationMs(s);
  const next = sessionSnapshot(await applicableAccommodations(m.tx, s.candidateId, s.examId, m.now), base, m.now);
  const same = JSON.stringify(next?.items ?? []) === JSON.stringify(s.accommodations?.items ?? []) && (next?.extraTimeMs ?? 0) === (s.accommodations?.extraTimeMs ?? 0);
  if (same) return;
  m.set({ accommodations: next, durationMs: base + (next?.extraTimeMs ?? 0) });
}

/**
 * The policy a session runs under: the exam's (`examPolicy`, already merged with the organisation default) with the
 * snapshot's accommodations applied, and the rules they changed.
 */
export function withAccommodations(examPolicy: ProctoringPolicy, snap: SessionAccommodations | null | undefined, durationMs?: number): { policy: ProctoringPolicy; exceptions: PolicyExceptionDTO[] } {
  const items = snap?.items ?? [];
  if (!items.length) return { policy: examPolicy, exceptions: [] };
  const policy = applyAccommodations(examPolicy, items);
  const extra = snap?.extraTimeMs ?? 0;
  const exceptions = policyExceptions(examPolicy, policy, items, durationMs != null ? { baseMs: durationMs - extra, extraMs: extra } : undefined);
  return { policy, exceptions };
}

/** SessionAccommodationsDTO from a session row (exceptions: frozen at start, else computed for the exam's policy now). */
export function toSessionAccommodationsDTO(s: Pick<ExamSession, 'accommodations' | 'durationMs'>, examPolicy: ProctoringPolicy | null): SessionAccommodationsDTO | null {
  const snap = s.accommodations;
  if (!snap?.items.length) return null;
  const exceptions = snap.exceptions ?? (examPolicy ? withAccommodations(examPolicy, snap, s.durationMs).exceptions : []);
  return {
    items: snap.items.map((i) => ({ id: i.id, kind: i.kind, params: i.params, label: ACCOMMODATION_CATALOG[i.kind].label(i.params), grantedAt: i.grantedAt })),
    extraTimeMs: snap.extraTimeMs,
    exceptions,
  };
}

/** Report limitations for the accommodations in effect (one sentence each, where one applies). */
export function accommodationLimitations(snap: SessionAccommodations | null | undefined): string[] {
  return (snap?.items ?? []).map((i) => ACCOMMODATION_CATALOG[i.kind].limitation(i.params)).filter((x): x is string => !!x);
}

/** The candidate-facing description of a session's accommodations. */
export function candidateAccommodationLabels(snap: SessionAccommodations | null | undefined): string[] {
  return (snap?.items ?? []).map((i) => ACCOMMODATION_CATALOG[i.kind].candidateLabel(i.params));
}

/* ------------------------------------------------------------------ records → DTO */

export async function toAccommodationDTOs(db: DbOrTx, keyring: Pick<Keyring, 'decryptString'>, rows: Accommodation[], opts: { includeNote: boolean; now: number }): Promise<AccommodationDTO[]> {
  const staffIds = [...new Set(rows.flatMap((r) => [r.grantedBy, r.revokedBy]).filter((x): x is string => !!x))];
  const examIds = [...new Set(rows.map((r) => r.examId).filter((x): x is string => !!x))];
  const [staff, examRows] = await Promise.all([
    staffIds.length ? db.select({ id: staffUsers.id, name: staffUsers.name }).from(staffUsers).where(inArray(staffUsers.id, staffIds)) : Promise.resolve([]),
    examIds.length ? db.select({ id: exams.id, title: exams.title }).from(exams).where(inArray(exams.id, examIds)) : Promise.resolve([]),
  ]);
  const names = new Map(staff.map((s) => [s.id, s.name]));
  const titles = new Map(examRows.map((e) => [e.id, e.title]));
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? 'Former staff member' } : null);
  return rows.map((r) => ({
    id: r.id,
    candidateId: r.candidateId,
    kind: r.kind,
    params: r.params,
    label: ACCOMMODATION_CATALOG[r.kind].label(r.params),
    basis: r.basis,
    exam: r.examId ? { id: r.examId, title: titles.get(r.examId) ?? 'Deleted exam' } : null,
    validUntil: r.validUntil?.getTime() ?? null,
    note: opts.includeNote && r.noteEnc ? keyring.decryptString(r.noteEnc, accommodationNoteAad(r.id)) : null,
    status: accommodationStatus(r, opts.now),
    grantedAt: r.grantedAt.getTime(),
    grantedBy: person(r.grantedBy),
    revokedAt: r.revokedAt?.getTime() ?? null,
    revokedBy: person(r.revokedBy),
    revokeReason: r.revokeReason,
  }));
}

/** Unstarted sessions of a candidate whose snapshot includes one of these records (to report what a revocation reaches). */
export async function sessionsCarrying(db: DbOrTx, candidateId: string, accommodationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: examSessions.id, accommodations: examSessions.accommodations })
    .from(examSessions)
    .where(and(eq(examSessions.candidateId, candidateId), notInArray(examSessions.status, ['submitted', 'terminated'])));
  return rows.filter((r) => r.accommodations?.items.some((i) => i.id === accommodationId)).map((r) => r.id);
}
