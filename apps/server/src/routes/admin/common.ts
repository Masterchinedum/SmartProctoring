/**
 * Shared helpers for the staff API route files (src/routes/admin/*.ts).
 */
import { DEFAULT_POLICY } from '@sp/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getStaff } from '../../auth/staff.js';
import type { Ctx } from '../../context.js';
import type { DbOrTx } from '../../db/index.js';
import { candidates, examSessions, exams, organizations, type Candidate, type Exam, type ExamSession, type Organization } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import type { Actor } from '../../services/session-actions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * A UUID path parameter. Anything that is not a UUID cannot exist, so it is reported as 404
 * (and never reaches Postgres, which would reject the cast).
 */
export function idParam(req: FastifyRequest, name = 'id', what = 'Resource', code = 'not_found'): string {
  const v = (req.params as Record<string, unknown> | undefined)?.[name];
  if (!isUuid(v)) throw notFound(`${what} not found`, code);
  return v.toLowerCase();
}

/** The staff principal as a session-action actor. */
export function actorOf(req: FastifyRequest): Actor {
  const staff = getStaff(req);
  return { id: staff.id, orgId: staff.orgId, ip: req.ip };
}

/** Escape LIKE/ILIKE wildcards in user input (used with the default `\` escape character). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Query-string list: `a,b` or repeated keys. Empty values are dropped. */
export function listParam(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v == null ? [] : [v];
  return raw
    .flatMap((x) => String(x).split(','))
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Empty query-string values ("?status=") mean "not set". */
export function blankToUndefined(query: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) if (v !== '' && v != null) out[k] = v;
  }
  return out;
}

export const pagingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export interface ScopedSession {
  session: ExamSession;
  exam: Exam;
  candidate: Candidate;
}

/** Load a session of the staff member's organisation (404 otherwise), with its exam and candidate. */
export async function loadScopedSession(db: DbOrTx, orgId: string, sessionId: string): Promise<ScopedSession> {
  const [row] = await db
    .select({ session: examSessions, exam: exams, candidate: candidates })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.orgId, orgId)));
  if (!row) throw notFound('Session not found', 'session_not_found');
  return row;
}

/** 404 unless the session exists in the organisation. */
export async function assertSessionInOrg(db: DbOrTx, orgId: string, sessionId: string): Promise<void> {
  const [row] = await db
    .select({ id: examSessions.id })
    .from(examSessions)
    .where(and(eq(examSessions.id, sessionId), eq(examSessions.orgId, orgId)));
  if (!row) throw notFound('Session not found', 'session_not_found');
}

export async function loadOrgRow(ctx: Pick<Ctx, 'db'>, orgId: string): Promise<Organization> {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw notFound('Organisation not found');
  return org;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Keep only keys the proctoring-policy schema knows (recursively), so stored partial policies never
 * accumulate unknown fields. Values are validated separately (resolvePolicy / mergePolicy throw ZodError).
 */
export function sanitizePolicyInput(input: unknown): Record<string, unknown> {
  const walk = (inp: unknown, tmpl: unknown): unknown => {
    if (!isPlainObject(inp) || !isPlainObject(tmpl)) return inp;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inp)) {
      if (!(k in tmpl) || v === undefined) continue;
      out[k] = isPlainObject(tmpl[k]) ? walk(v, tmpl[k]) : v;
    }
    return out;
  };
  const res = walk(input ?? {}, DEFAULT_POLICY);
  return isPlainObject(res) ? res : {};
}

/** Headers for responses that carry personal data and must never be cached or sniffed. */
export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
}
