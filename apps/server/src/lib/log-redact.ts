/**
 * Logger configuration that never writes candidate credentials to the logs.
 *
 * The candidate access token is a bearer credential. It travels as `Authorization: Bearer …` on API calls,
 * as a `?token=` query parameter (privacy notice) and — whenever this server also serves the web app — as a
 * path segment of every page load (`GET /take/<token>`). All three are redacted here.
 */
import { ACCESS_LINK_PATH } from '@sp/shared';
import type { FastifyServerOptions } from 'fastify';

export const REDACTED = '[redacted]';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `/take/<token>` (ACCESS_LINK_PATH), up to the next `/`, `?` or `#`. */
const TAKE_PATH_RE = new RegExp(`(${escapeRe(ACCESS_LINK_PATH)})[^/?#]+`, 'gi');
const TOKEN_PARAM_RE = /([?&](?:token|access_token)=)[^&#]*/gi;

/** Remove access tokens from a request URL (path segment after /take/ and token query parameters). */
export function redactUrl(url: string): string {
  return url.replace(TAKE_PATH_RE, `$1${REDACTED}`).replace(TOKEN_PARAM_RE, `$1${REDACTED}`);
}

/** Header paths redacted wherever a request / headers object might be logged. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-client-instance"]',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

/** Fastify/pino logger options used by buildApp (tests may add a `stream`). */
export function appLoggerOptions(level: string) {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: {
      // Only these request fields are logged; no headers, and the URL without access tokens.
      req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url ?? ''),
        host: req.hostname,
        remoteAddress: req.ip,
      }),
    },
  } satisfies FastifyServerOptions['logger'];
}
