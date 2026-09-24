# Security

This document summarises SmartProctoring's threat model, the security controls in the product, the results
of the latest security review and a checklist for operators running it in production. Privacy commitments
(what is collected, retention, candidate rights) are in `docs/PRIVACY.md`; deployment in `docs/OPERATIONS.md`.

Report vulnerabilities privately to the maintainers; do not open public issues for them.

## 1. Threat model

**Assets.** Face images and face templates (biometric data), identity references, event evidence, exam
content and answer keys, candidate personal data, staff accounts, organisation API keys and webhook
secrets, the evidence encryption key, the integrity of the proctoring record (who took the exam, what was
observed).

**Actors and trust.**

| Actor | Authenticates with | Trusted for |
|---|---|---|
| Candidate (browser) | Access link token (256-bit, bearer) + `X-Client-Instance` | Nothing beyond its own session. The client is assumed hostile: it may be modified, replayed or scripted. |
| Accomplice | The candidate's link, if shared | Nothing — must not be able to act as the verified browser or skip identity checks. |
| Reviewer / admin / owner | Staff session cookie (`sp_session`) | Their own organisation only, by role (reviewer < admin < owner). |
| Integration (LMS/HR) | Organisation API key (`sp_live_…`) | Its organisation's exams, candidates, sessions, reports and events — never images or face data. |
| Webhook receiver | Verifies our HMAC signature | Receives notifications only; never images, templates or similarity scores. |
| Other tenants | Their own credentials | Nothing in another organisation (all ids of other orgs are 404). |
| Network attacker / third-party website | — | Nothing (TLS, CSRF and clickjacking defences). |

**Trust boundaries.** Identity decisions run on the server against a reference the client never sees; the
browser only uploads JPEG frames. Behavioural detection runs in the browser and is therefore
*advisory*: a tampered client can suppress its own events (documented limitation), but it cannot forge a
server-side identity match, read other sessions, or change category/severity (they come from the catalog).

## 2. Controls

### Authentication and sessions
* Staff: scrypt password hashes (N=2^15, r=8, p=1, 16-byte salt, parameters stored per hash), uniform
  timing for unknown users (dummy hash), generic error message, `auth.login_failed` audit entries,
  10 login attempts per minute per client IP.
* Staff sessions: opaque 256-bit token in a signed cookie, only `sha256(token)` stored; `HttpOnly`,
  `SameSite=Lax`, `Secure` (default in production), new token at every login (no fixation), sliding idle
  timeout (`STAFF_SESSION_IDLE_MIN`, default 480) and absolute lifetime (`STAFF_SESSION_MAX_HOURS`, default
  168). Logout deletes the server-side session; password change/reset and disabling a user revoke sessions;
  the realtime WebSocket re-validates and closes with 4401.
* Candidates: access token = 256 random bits (only sha256 + an AES-GCM copy for staff re-display stored),
  regenerating a link invalidates the old one immediately. Every write also requires the browser instance
  that passed the camera/identity check (`X-Client-Instance`); a new instance must pass a reconnect check.
  The verified instance id is echoed only to that instance.
* API keys: 256-bit, shown once, sha256 stored, revocation effective on the next request, per-key rate limit,
  every write/report read audited as actor `api_key`. They cannot call the staff API.

### Authorisation
* Every `/api/admin/*` route has `requireStaff(<role>)`; every query is scoped by the staff member's
  organisation (other organisations' ids return 404). Only owners create/modify owners and admins; the last
  owner cannot be removed. Access links are returned only to admins, only on detail views.
* Candidate routes resolve the session from the token; check, evidence, event and question ids are scoped to
  that session.

### CSRF, clickjacking, browser hardening
* State-changing cookie requests and WebSocket upgrades must come from `PUBLIC_URL`'s origin (or the request's
  own host): `Origin` decides; without it, `Sec-Fetch-Site` (cross-site/same-site refused) and `Referer` are
  checked. Logout is protected the same way. Only JSON bodies are parsed for these routes (form posts get
  415, `text/plain` fails validation), and there is no CORS.
* Response headers on every response: `Content-Security-Policy` (`default-src 'self'`, `script-src 'self'
  'wasm-unsafe-eval'` for self-hosted MediaPipe, `object-src 'none'`, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (the candidate URL contains the token),
  `Permissions-Policy: camera=(self), microphone=()…`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`, HSTS when `COOKIE_SECURE` is on. `/api/*` responses are
  `Cache-Control: no-store`; evidence is `private, no-store` + `Cross-Origin-Resource-Policy: same-origin`.
* The web app renders all user-supplied text as text (no `dangerouslySetInnerHTML`, no markdown), keeps no
  credentials in `localStorage`, and only redirects to in-app `/admin` paths after login.

### Input handling
* zod validation on every body/query; unknown event types rejected; category/severity/title from the catalog.
* Body limits: JSON 2 MB; candidate JPEG 1 MB; ID photo 5 MB; offline-evaluation JSON 10 MB (admin).
  Candidate JPEGs must start with a JPEG signature and declare at most 4096 px per side / 3840×2160 px
  (checked from the frame header before decoding); the decoder additionally refuses > 50 MP.
* Per-session caps: 1,500 evidence items / 300 MB, 30 checks per hour, 5,000 events, 16 KB event details.
* SQL via drizzle with bound parameters only; `LIKE` wildcards escaped; storage keys built from UUIDs and
  validated (no traversal); CSV export neutralises formula prefixes (`= + - @` tab CR) and quotes cells.

### Cryptography
* AES-256-GCM for every blob and template, random 96-bit IV per object, AAD binding each ciphertext to its
  row (`evidence:<id>`, `reference:<id>`, `idphoto:<candidateId>`, `access-token:<sessionId>`,
  `webhook-secret:<id>`, `frame:<id>`), key id embedded for rotation (`EVIDENCE_KEYS_OLD`).
* Constant-time comparison for liveness nonces; tokens/keys are looked up by hash.
* Webhooks: `HMAC-SHA256(secret, t.body)` with timestamp; secrets shown once, stored encrypted.

### Outbound requests (SSRF)
* Webhook URLs must be `https://` in production and resolve to public unicast addresses (IPv4/IPv6 private,
  loopback, link-local/metadata, CGNAT, NAT64/6to4-embedded and documentation ranges refused), checked when
  saved and again at connect time through a pinned DNS lookup (no DNS rebinding); redirects are never
  followed; 10 s timeout; at most 64 KB of the response is read and 200 characters kept.

### Abuse and availability
* Rate limits: candidate endpoints per access token (30–600/min per endpoint), privacy notice 60/min/IP,
  login and password change 10/min/IP, integration API 600/min/key, webhook test/redeliver and test email.
  Limits are kept in memory per server instance.
* Vision work is bounded (concurrency + queue of 256); overload returns `503 vision_busy` with `Retry-After`
  and the candidate client backs off exponentially.

### Privacy and audit
* Every image fetch (screenshots, check frames, identity references, probes, ID photos — all served only by
  `GET /api/admin/evidence/:id`) writes `evidence.view` to the audit log; so do reviews, notes, holds,
  releases, re-enrolments, settings, users, API keys, webhooks and retention purges.
* Webhooks, alert emails and the integration API never contain images, templates or similarity scores.
* Logs never contain access tokens (`/take/<token>`, `?token=`, `Authorization`, cookies are redacted).

## 3. Security review — 2026-09-24

Scope: `apps/server` (auth, all staff/candidate/v1 routes, WebSocket, crypto, storage, webhooks, vision
input), `apps/web` (admin and candidate), deployment files, `pnpm audit --prod`. Findings were verified
against a running instance and with integration tests (`apps/server/test/security.test.ts`).

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | `GET /api/candidate/session` returned the verified browser's `verifiedInstanceId` to anyone with the link; sending it as `X-Client-Instance` let a second device read questions and save answers as the verified browser, with no reconnect/identity check and no `multiple_instances` event. | Fixed (echoed only to that instance) |
| 2 | Medium | Candidate rate limits were keyed on the raw `Authorization` header: `Bearer  <token>` / `bearer <token>` got fresh buckets, so identity samples, check frames and uploads were effectively unlimited. | Fixed (keyed on the parsed token) |
| 3 | Medium | Decompression bomb: a ~290 KB progressive JPEG declaring 49 MP cost ~290 ms CPU and ~150 MB RSS per decode (combined with #2: vision pool saturation, 503 for all candidates). | Fixed (≤ 4096 px/side, ≤ 3840×2160 checked before decoding) |
| 4 | Medium | `TRUST_PROXY=true` (as in `.env.example`) trusts the client-written left-most `X-Forwarded-For` entry: rotating it bypassed the login rate limit (12/12 attempts, no 429) and forged audit-log IPs. | Mitigated (production warning, hop counts refused — Fastify ≥ 5.12 ignores them); operators must set proxy addresses (§4) |
| 5 | Medium | The integration API returned face-similarity scores (event `details.min/maxSimilarity`, report `session.identity.lastSimilarity`, ID-photo similarity, "(lowest similarity 0.00)" in sentences) although documented as never doing so. | Fixed (nulled / removed in `/api/v1`; staff views unchanged) |
| 6 | Low | CSRF defence relied on `Origin` only when present; logout had no check (cross-origin logout worked). | Fixed (`Sec-Fetch-Site`/`Referer` fallback; logout same-origin only) |
| 7 | Medium | A colluding candidate can still copy their own instance id (DevTools) to a second device. | Open — bind the verified instance to a server-issued secret and flag concurrent use (IP/UA change, interleaved heartbeat `seq`) as `multiple_instances` |
| 8 | Medium | Key rotation is incomplete: no re-encryption tool, and long-lived ciphertexts (ID-photo templates, access tokens, webhook secrets, legal-hold evidence) keep needing old keys indefinitely. | Open — add a re-encryption CLI (re-encrypt rows/blobs whose key id ≠ current) |
| 9 | Low | Login throttling is per IP only (no per-account backoff); no MFA/SSO for staff who can view biometric evidence; scrypt N=2^15 is below current guidance (2^17). | Open |
| 10 | Low | Candidate-controlled text (event `observation` ≤ 500 chars, camera label) is forwarded into staff alert emails (escaped) and webhooks — phishing from a trusted sender. | Open — use catalog wording or strip URLs for client-sourced events |
| 11 | Low | Rate-limit counters are in memory per instance (not shared through Redis). | Open |
| 12 | Low | Default staff session lifetime is long (8 h idle / 7 days absolute). | Open — shorter defaults recommended |
| 13 | Low | `POST /api/admin/users` answers `email_taken` for addresses registered in any organisation (cross-tenant enumeration by admins). | Open |
| 14 | Low | `apps/web/index.html` has no `<meta name="referrer" content="no-referrer">` (defence in depth if the SPA is ever served without our headers); production build ships public source maps. | Open |
| 15 | Info | CSP `connect-src` allows any `ws:`/`wss:` host; reviewers receive exam answer keys; candidate links stay valid after the exam ends; unlimited WebSocket connections per staff session; client retry backoff has no jitter. | Open |

Dependencies (`pnpm audit --prod`): **sharp 0.34.5** (high: libvips/libheif CVEs, fixed in ≥ 0.35.4) —
candidate and ID-photo uploads must start with a JPEG signature, and libvips then always selects the JPEG
loader (verified: an AVIF re-labelled with a JPEG signature is rejected by `VipsJpeg`), so the vulnerable
HEIF/GIF/TIFF loaders are not reachable from uploads; upgrade anyway. **@fastify/static 8.3.0** (route-guard
bypass / directory listing, fixed in ≥ 10.1.2) — not exploitable here (no `list`, no `allowedPath`, no guarded
static paths; the root only holds the public web build; traversal attempts return 403); upgrade.
**drizzle-orm 0.44.7** (identifier escaping, fixed in ≥ 0.45.2) — not reachable (no `sql.identifier`,
`.as()` or `sql.raw` with request data); upgrade.

## 4. Production checklist

**TLS and proxy**
- [ ] Terminate TLS in front of the app (camera access requires HTTPS); redirect HTTP to HTTPS; proxy the
      WebSocket `/api/admin/live`.
- [ ] Bind the app to localhost or the private network only (e.g. `127.0.0.1:8080:8080` in Compose) so
      nothing reaches it except through the proxy.
- [ ] `TRUST_PROXY` = the proxy's address(es), e.g. `127.0.0.1`, `loopback,uniquelocal` or the load balancer
      subnet — **not** `true` (unless the proxy overwrites `X-Forwarded-For`). Hop counts are not supported.
- [ ] `PUBLIC_URL` = the exact public origin (used for links and the CSRF origin check); `COOKIE_SECURE=true`.
- [ ] The proxy must pass through (not strip) the app's security headers; if it serves static files itself,
      copy CSP, `Referrer-Policy: no-referrer`, `X-Frame-Options`, `Permissions-Policy` and HSTS. Consider
      HSTS preload once the whole domain is HTTPS-only.

**Secrets and keys**
- [ ] `EVIDENCE_KEY` (32 random bytes) and `SESSION_SECRET` (≥ 32 chars) from a secret manager, never in
      images or the repository; back the evidence key up separately from the database backups.
- [ ] Rotate `EVIDENCE_KEY` by moving the old key to `EVIDENCE_KEYS_OLD`. Until a re-encryption tool exists
      (finding #8), keep old keys for as long as any ID photo, webhook, unfinished session or legal hold
      created under them exists.
- [ ] Rotating `SESSION_SECRET` signs every staff member out. Rotate webhook secrets and API keys on staff
      turnover; revoke unused keys.
- [ ] Remove `BOOTSTRAP_ADMIN_PASSWORD` from the environment after the first start; the owner changes it.

**Database, storage, backups**
- [ ] Postgres role for the app: not a superuser, owner of the application schema only (migrations run at
      start-up), strong password, `sslmode=require` for remote databases; no public exposure of 5432.
- [ ] Encrypted volumes for Postgres (candidate names/emails are not application-encrypted) and the evidence
      store; for S3 use a private bucket, block public access, SSE, and a least-privilege key limited to the
      bucket/prefix (Get/Put/Delete).
- [ ] Backups: Postgres PITR/dumps and evidence snapshots with retention aligned to `evidenceRetentionDays`
      (purged evidence survives in backups until they expire); test restores; keep backups encrypted.

**Abuse and monitoring**
- [ ] With several instances, add rate limiting at the proxy/WAF as well (in-app limits are per instance):
      e.g. `/api/auth/login` ≤ 10/min per IP, `/api/candidate/*` ≤ 20 req/s per IP, request bodies ≤ 5 MB.
- [ ] Alert on bursts of `auth.login_failed`, `evidence.view` by one user, `api_key.created`,
      `user.updated` (role changes), `webhook.auto_disabled`, and on `503 vision_busy` rates.
- [ ] Ship logs to central storage with restricted access; they contain staff emails and IP addresses but
      never tokens.
- [ ] Keep dependencies patched (`pnpm audit --prod` in CI); upgrade sharp, @fastify/static and drizzle-orm
      (§3).

**Accounts and process**
- [ ] Give most staff the reviewer role; limit owners/admins; disable accounts on departure (revokes sessions
      immediately).
- [ ] Shorten staff session lifetimes (`STAFF_SESSION_IDLE_MIN=60`, `STAFF_SESSION_MAX_HOURS=12`) where staff use
      shared or unmanaged devices.
- [ ] Review the audit log regularly (evidence views, re-enrolments, legal holds, settings changes).
