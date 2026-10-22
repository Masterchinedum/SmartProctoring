/**
 * Correlation for logs: every request has an id (`reqId` on each of its log lines, `X-Request-Id` on its response),
 * and once authenticated its log lines also name the exam session, staff user or API key.
 *
 * An incoming `X-Request-Id` (set by a reverse proxy, e.g. nginx `$request_id`, or by an integration) is kept when
 * it is a plain token, so one id follows the request through the proxy logs and ours; anything else is replaced.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Fastify `genReqId`: the caller's X-Request-Id when it is a plain token, else a new UUID. */
export function requestIdFor(req: IncomingMessage): string {
  const h = req.headers[REQUEST_ID_HEADER];
  return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
}

/** Tag every later log line of this request — handler logs and Fastify's "request completed" line — with `fields`. */
export function bindRequestLog(req: FastifyRequest, reply: FastifyReply, fields: Record<string, string>): void {
  const child = req.log.child(fields);
  req.log = child;
  reply.log = child;
}
