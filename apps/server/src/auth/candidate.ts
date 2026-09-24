/**
 * Candidate authentication: `Authorization: Bearer <accessToken>` (from the invite link) plus the
 * `X-Client-Instance: <clientInstanceId>` header identifying the browser instance.
 */
import type { ProctoringPolicy } from '@sp/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import { candidates, examSessions, exams, organizations, type Candidate, type Exam, type ExamSession, type Organization } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { effectivePolicy } from '../services/session-state.js';

export interface CandidatePrincipal {
  session: ExamSession;
  /** Row version of `session` as loaded (Postgres xmin): optimistic-concurrency guard for single-statement updates. */
  sessionVersion: string;
  exam: Exam;
  org: Organization | null;
  candidate: Candidate;
  policy: ProctoringPolicy;
  /** X-Client-Instance header (validated), or null if absent. */
  instanceId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    candidateAuth: CandidatePrincipal | null;
  }
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const INSTANCE_RE = /^[A-Za-z0-9._:-]{8,100}$/;

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export function instanceIdFrom(req: FastifyRequest): string | null {
  const raw = req.headers['x-client-instance'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  if (!INSTANCE_RE.test(v)) throw badRequest('Invalid X-Client-Instance header', undefined, 'invalid_instance');
  return v;
}

function buildAuthQuery(db: Ctx['db']) {
  return db
    .select({ session: examSessions, exam: exams, org: organizations, candidate: candidates, sessionVersion: sql<string>`${examSessions}.xmin::text` })
    .from(examSessions)
    .innerJoin(exams, eq(exams.id, examSessions.examId))
    .innerJoin(candidates, eq(candidates.id, examSessions.candidateId))
    .leftJoin(organizations, eq(organizations.id, examSessions.orgId))
    .where(eq(examSessions.accessTokenHash, sql.placeholder('tokenHash')))
    .prepare('sp_candidate_auth');
}

/**
 * The most frequent query of the server (every candidate request) as a named prepared statement: built once per
 * database handle, and Postgres plans it once per connection instead of on every request (planning this 4-table
 * join costs several times its execution). With PgBouncer in transaction mode, enable max_prepared_statements.
 */
const authQueries = new WeakMap<object, ReturnType<typeof buildAuthQuery>>();
function authQuery(db: Ctx['db']) {
  let q = authQueries.get(db);
  if (!q) authQueries.set(db, (q = buildAuthQuery(db)));
  return q;
}

export async function resolveCandidateSession(ctx: Ctx, req: FastifyRequest, tokenOverride?: string | null): Promise<CandidatePrincipal> {
  const token = tokenOverride ?? bearerToken(req);
  if (!token || !TOKEN_RE.test(token)) throw new HttpError(401, 'invalid_token', 'This exam link is not valid. Check that you copied the whole link.');
  const rows = await authQuery(ctx.db).execute({ tokenHash: sha256Hex(token) });
  const row = rows[0];
  if (!row) throw new HttpError(401, 'invalid_token', 'This exam link is not valid or has been replaced. Contact your exam administrator.');
  return {
    session: row.session,
    sessionVersion: row.sessionVersion,
    exam: row.exam,
    org: row.org,
    candidate: row.candidate,
    policy: effectivePolicy(row.session, row.exam, row.org),
    instanceId: instanceIdFrom(req),
  };
}

/** preHandler for /api/candidate/* routes. */
export async function candidateAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.candidateAuth = await resolveCandidateSession(req.server.ctx, req);
}

export function getCandidate(req: FastifyRequest): CandidatePrincipal {
  if (!req.candidateAuth) throw new HttpError(401, 'invalid_token', 'Missing exam access token');
  return req.candidateAuth;
}

/** The X-Client-Instance header is mandatory for anything but reading the session. */
export function requireInstanceId(req: FastifyRequest): string {
  const id = getCandidate(req).instanceId;
  if (!id) throw badRequest('Missing X-Client-Instance header', undefined, 'missing_instance');
  return id;
}
